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

/** top-centre bar: clock, day, phase, pause and speed controls; Space = pause, 1–4 = speed */
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

  root.append(timeBox, controlsBox, statsBox);

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
      root.replaceChildren();
    },
  };
}
