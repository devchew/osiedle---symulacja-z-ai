import './ui.css';
import { formatClock } from '../core/time';
import type { DayPhase, Season, SimControls, World } from '../types';
import { el, isTypingTarget, moodEmoji, setText } from './dom';
import type { WeatherOfFn } from './extras';
import '../realtime/realtime.css';

export const SPEEDS = [1, 2, 4, 8] as const;

const PHASE_ICON: Record<DayPhase, string> = { morning: '🌅', day: '☀️', evening: '🌇', night: '🌙' };
const PHASE_LABEL: Record<DayPhase, string> = { morning: 'Ranek', day: 'Dzień', evening: 'Wieczór', night: 'Noc' };
const WEEKDAY_LABEL = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
const SEASON_LABEL: Record<Season, string> = { winter: 'zima', spring: 'wiosna', summer: 'lato', autumn: 'jesień' };

export interface HudButton {
  id: string;
  icon: string;
  title: string;
  onClick(): void;
}

export interface HudOptions {
  /** extra toggle buttons (stats, diaries…) placed before the help button */
  buttons?: HudButton[];
  /** current weather, when the simulation provides it */
  weatherOf?: WeatherOfFn;
  /** live view of a server world: no pause/speed, place + real weather + "NA ŻYWO" instead */
  live?: HudLive;
  /** resident count next to the mood (default true; the public views hide it) */
  showPopulation?: boolean;
  /** help popover rows and note (default: HELP_KEYS) */
  help?: { keys: [string, string][]; note?: string };
}

export interface HudLive {
  /** place name, e.g. "Kamienica" */
  place(): string;
  /** city whose real weather the place follows */
  city(): string;
  temperature(): number | null;
  /** AI dialogue / diaries active on the server */
  ai(): boolean;
  /** tooltip of the live badge */
  tooltip(): string;
}

export interface Hud {
  update(): void;
  /** highlights an extra button while its panel is open */
  setActive(id: string, active: boolean): void;
  /** small dot on an extra button (e.g. unread diary entries) */
  setBadge(id: string, on: boolean, title?: string): void;
  destroy(): void;
  /** shows another world (live view) */
  setWorld(world: World): void;
}

export const HELP_KEYS: [string, string][] = [
  ['Spacja', 'pauza / wznów'],
  ['1–4', 'prędkość 1× · 2× · 4× · 8×'],
  ['T', 'statystyki: relacje, nastrój'],
  ['P', 'pamiętniki mieszkańców (← → dni)'],
  ['B', 'projekty budowlane (altana, warzywnik)'],
  ['przeciągnij', 'przesuń widok'],
  ['WASD / strzałki', 'przesuń widok'],
  ['kółko / szczypnięcie', 'przybliż i oddal'],
  ['klik', 'szczegóły postaci'],
  ['dwuklik', 'śledź postać kamerą'],
  ['[ / ]', 'poprzednia / następna postać'],
  ['Tab', 'przejście po przyciskach i liście mieszkańców'],
  ['Esc', 'zamknij panel'],
];

/** top-centre bar: clock, day, phase, pause and speed controls, help popover; Space = pause, 1–4 = speed, H / ? = help */
export function createHud(root: HTMLElement, controls: SimControls, initialWorld: World, opts: HudOptions = {}): Hud {
  let world = initialWorld;
  root.classList.add('ui-panel', 'ui-hud');
  root.replaceChildren();

  const phaseIcon = el('span', 'hud-phase');
  const weather = el('span', 'hud-weather');
  weather.hidden = true;
  const day = el('span', 'hud-day');
  const clock = el('span', 'hud-clock');
  const timeBox = el('div', 'hud-time', [phaseIcon, el('div', 'hud-time-text', [clock, day]), weather]);

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
  const liveView = opts.live;
  controlsBox.hidden = !!liveView;

  // live view of a server world: place, real temperature + city, AI indicator
  const lvPlace = el('span', 'hud-lv-place');
  const lvTemp = el('span', 'hud-live-temp');
  const lvCity = el('span', 'hud-live-place');
  const lvAi = el('span', 'hud-lv-ai', ['✨ AI']);
  lvAi.title = 'Rozmowy i pamiętniki pisze AI (na serwerze)';
  lvAi.hidden = true;
  const lvBadge = el('div', 'hud-live', [el('span', 'hud-live-pill', ['⏱ NA ŻYWO']), el('div', 'hud-live-info', [lvTemp, lvCity])]);
  const lvBox = el('div', 'hud-lv', [el('div', 'hud-lv-head', [lvPlace, lvAi]), lvBadge]);

  const pop = el('span', 'hud-stat');
  pop.hidden = opts.showPopulation === false;
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
  const HELP = opts.help?.keys ?? HELP_KEYS;
  help.append(
    el('h3', 'hud-help-title', ['Sterowanie']),
    el(
      'dl',
      'hud-help-list',
      HELP.flatMap(([k, v]) => [el('dt', '', k.split(' / ').flatMap((part, i) => (i ? [' / ', el('kbd', '', [part])] : [el('kbd', '', [part])]))), el('dd', '', [v])]),
    ),
    el('p', 'hud-help-note', [opts.help?.note ?? 'Postacie żyją same — Ty tylko obserwujesz.']),
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

  const extraBtns = new Map<string, HTMLButtonElement>();
  const extras = (opts.buttons ?? []).map((b) => {
    const btn = el('button', `hud-btn hud-icon-btn hud-${b.id}-btn`, [b.icon]);
    btn.type = 'button';
    btn.title = b.title;
    btn.setAttribute('aria-label', b.title);
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.panel = b.id;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      b.onClick();
    });
    extraBtns.set(b.id, btn);
    return btn;
  });
  const toolsBox = el('div', 'hud-tools', [...extras, helpBtn]);

  root.append(timeBox, ...(liveView ? [lvBox] : []), controlsBox, statsBox, toolsBox, help);
  root.classList.toggle('is-live-view', !!liveView);
  let lastKey = '';
  function update(): void {
    const t = controls.time();
    setText(phaseIcon, PHASE_ICON[t.phase]);
    phaseIcon.title = PHASE_LABEL[t.phase];
    setText(clock, formatClock(t));
    setText(day, t.weekday === undefined ? `Dzień ${t.day}` : `Dzień ${t.day} · ${WEEKDAY_LABEL[t.weekday]}`);
    day.title = t.season ? SEASON_LABEL[t.season] : '';
    const w = opts.weatherOf?.(world);
    weather.hidden = !w;
    if (w) {
      setText(weather, w.icon);
      weather.title = w.label;
      weather.setAttribute('aria-label', `Pogoda: ${w.label}`);
    }

    if (liveView) {
      setText(lvPlace, liveView.place());
      const temp = liveView.temperature();
      setText(lvTemp, temp != null ? `${Math.round(temp)}°C` : '');
      lvTemp.hidden = temp == null;
      setText(lvCity, liveView.city());
      lvAi.hidden = !liveView.ai();
      lvBadge.title = liveView.tooltip();
    }

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
    if (isTypingTarget(e)) return;
    if (e.key === 'Escape' && helpOpen) {
      setHelp(false);
      return;
    }
    if (e.key === '?' || e.code === 'KeyH') {
      setHelp(!helpOpen);
      return;
    }
    if (liveView) return;
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
    setActive(id, active) {
      const b = extraBtns.get(id);
      if (!b) return;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    },
    setBadge(id, on, title) {
      const b = extraBtns.get(id);
      const btn = opts.buttons?.find((x) => x.id === id);
      if (!b || !btn) return;
      b.classList.toggle('has-badge', on);
      b.title = on && title ? `${btn.title} — ${title}` : btn.title;
      b.setAttribute('aria-label', b.title);
    },
    setWorld(w) {
      world = w;
      update();
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown);
      root.replaceChildren();
    },
  };
}
