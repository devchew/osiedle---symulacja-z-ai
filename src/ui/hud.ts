import './ui.css';
import { formatClock } from '../core/time';
import type { DayPhase, SimControls, World } from '../types';
import { el, moodEmoji, setText } from './dom';

export const SPEEDS = [1, 2, 4, 8] as const;

const PHASE_ICON: Record<DayPhase, string> = { morning: '🌅', day: '☀️', evening: '🌇', night: '🌙' };
const PHASE_LABEL: Record<DayPhase, string> = { morning: 'Ranek', day: 'Dzień', evening: 'Wieczór', night: 'Noc' };

export interface Hud {
  update(): void;
  destroy(): void;
}

/** top-centre bar: clock, day, phase, pause and speed controls, help popover; Space = pause, 1–4 = speed, H / ? = help */
export function createHud(root: HTMLElement, controls: SimControls, world: World): Hud {
  root.classList.add('ui-panel', 'ui-hud');
  root.replaceChildren();

  const phaseIcon = el('span', 'hud-phase');
  const day = el('span', 'hud-day');
  const clock = el('span', 'hud-clock');
  const timeBox = el('div', 'hud-time', [phaseIcon, el('div', 'hud-time-text', [clock, day])]);

  const pauseBtn = el('button', 'hud-btn hud-pause');
  pauseBtn.type = 'button';
  pauseBtn.addEventListener('click', () => {
    controls.setPaused(!controls.paused);
    update();
  });

  const speedBtns = SPEEDS.map((s, i) => {
    const b = el('button', 'hud-btn hud-speed', [`${s}×`]);
    b.type = 'button';
    b.title = `Prędkość ${s}× (klawisz ${i + 1})`;
    b.addEventListener('click', () => {
      controls.setSpeed(s);
      if (controls.paused) controls.setPaused(false);
      update();
    });
    return b;
  });
  const controlsBox = el('div', 'hud-controls', [pauseBtn, ...speedBtns]);

  const pop = el('span', 'hud-stat');
  const mood = el('span', 'hud-stat');
  const statsBox = el('div', 'hud-stats', [pop, mood]);

  // help: small popover with keys and gestures
  const helpBtn = el('button', 'hud-btn hud-help-btn', ['?']);
  helpBtn.type = 'button';
  helpBtn.title = 'Sterowanie (H)';
  helpBtn.setAttribute('aria-haspopup', 'dialog');
  helpBtn.setAttribute('aria-expanded', 'false');
  const help = el('div', 'hud-help');
  help.id = 'hud-help';
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'Sterowanie');
  helpBtn.setAttribute('aria-controls', help.id);
  help.hidden = true;
  const HELP: [string, string][] = [
    ['Spacja', 'pauza / wznów'],
    ['1–4', 'prędkość 1× · 2× · 4× · 8×'],
    ['przeciągnij', 'przesuń widok'],
    ['WASD / strzałki', 'przesuń widok'],
    ['kółko / szczypnięcie', 'przybliż i oddal'],
    ['klik', 'szczegóły postaci'],
    ['dwuklik', 'śledź postać kamerą'],
    ['Esc', 'zamknij panel'],
  ];
  help.append(
    el('h3', 'hud-help-title', ['Sterowanie']),
    el(
      'dl',
      'hud-help-list',
      HELP.flatMap(([k, v]) => [el('dt', '', k.split(' / ').flatMap((part, i) => (i ? [' / ', el('kbd', '', [part])] : [el('kbd', '', [part])]))), el('dd', '', [v])]),
    ),
    el('p', 'hud-help-note', ['Postacie żyją same — Ty tylko obserwujesz.']),
  );
  let helpOpen = false;
  const setHelp = (open: boolean): void => {
    helpOpen = open;
    help.hidden = !open;
    helpBtn.setAttribute('aria-expanded', String(open));
    helpBtn.classList.toggle('is-active', open);
  };
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHelp(!helpOpen);
  });
  const onDocDown = (e: PointerEvent): void => {
    if (helpOpen && !help.contains(e.target as Node) && e.target !== helpBtn) setHelp(false);
  };
  document.addEventListener('pointerdown', onDocDown);

  root.append(timeBox, controlsBox, statsBox, helpBtn, help);

  let lastKey = '';
  function update(): void {
    const t = controls.time();
    setText(phaseIcon, PHASE_ICON[t.phase]);
    phaseIcon.title = PHASE_LABEL[t.phase];
    setText(clock, formatClock(t));
    setText(day, `Dzień ${t.day}`);

    const key = `${controls.paused}|${controls.speed}`;
    if (key !== lastKey) {
      lastKey = key;
      setText(pauseBtn, controls.paused ? '▶' : '⏸');
      pauseBtn.title = controls.paused ? 'Wznów (spacja)' : 'Pauza (spacja)';
      pauseBtn.setAttribute('aria-pressed', String(controls.paused));
      pauseBtn.classList.toggle('is-active', controls.paused);
      speedBtns.forEach((b, i) => {
        const active = SPEEDS[i] === controls.speed;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      root.classList.toggle('is-paused', controls.paused);
    }

    const n = world.agents.length;
    setText(pop, `👥 ${n}`);
    pop.title = 'Liczba mieszkańców';
    if (n > 0) {
      const avg = world.agents.reduce((s, a) => s + a.mood, 0) / n;
      setText(mood, `${moodEmoji(avg)} ${Math.round(avg)}`);
      mood.title = 'Średni nastrój';
    } else setText(mood, '');
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (e.key === 'Escape' && helpOpen) {
      setHelp(false);
      return;
    }
    if (e.key === '?' || e.code === 'KeyH') {
      setHelp(!helpOpen);
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      controls.setPaused(!controls.paused);
      update();
      return;
    }
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx >= 0) {
      controls.setSpeed(SPEEDS[idx]);
      update();
    }
  };
  window.addEventListener('keydown', onKey);

  update();
  return {
    update,
    destroy() {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown);
      root.replaceChildren();
    },
  };
}
