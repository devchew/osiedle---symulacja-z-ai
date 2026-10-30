import './ui.css';
import './replayBar.css';
import { formatClock, timeFromTick } from '../core/time';
import { el, setText } from './dom';

// Controls of the replay view (live view, issue #5): play / pause, speed, a scrubber over the
// recorded window, the time shown and a way back to the live world. Pure DOM; the playback itself
// is src/live/replayPlayer.ts and the wiring is src/live/liveApp.ts.

export interface ReplayBarState {
  tick: number;
  fromTick: number;
  toTick: number;
  playing: boolean;
  /** ticks per real second */
  speed: number;
}

export interface ReplayBarOptions {
  /** [ticks per real second, label, title] */
  speeds: readonly (readonly [number, string, string])[];
  onPlayPause(): void;
  onSpeed(ticksPerSecond: number): void;
  onSeek(tick: number): void;
  onExit(): void;
}

export interface ReplayBar {
  readonly root: HTMLElement;
  setOpen(open: boolean): void;
  update(state: ReplayBarState): void;
}

/** "5 h 20 min temu" for a number of minutes before the live moment */
export function agoText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'przed chwilą';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h > 0 ? `${h} h ` : ''}${rest > 0 || h === 0 ? `${rest} min ` : ''}temu`.replace('  ', ' ');
}

export function createReplayBar(opts: ReplayBarOptions): ReplayBar {
  const root = el('div', 'ui-panel ui-replay');
  root.hidden = true;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Powtórka ostatnich 24 godzin');

  const pill = el('span', 'rp-pill', ['⏪ POWTÓRKA']);
  const play = el('button', 'rp-btn rp-play');
  play.type = 'button';
  play.addEventListener('click', () => opts.onPlayPause());

  const speedBtns = opts.speeds.map(([tps, label, title]) => {
    const b = el('button', 'rp-btn rp-speed', [label]);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => opts.onSpeed(tps));
    return { tps, b };
  });
  const speeds = el('div', 'rp-speeds', speedBtns.map((s) => s.b));

  const live = el('button', 'rp-btn rp-live', ['↩ Wróć na żywo']);
  live.type = 'button';
  live.title = 'Zakończ powtórkę i wróć do świata na żywo';
  live.addEventListener('click', () => opts.onExit());

  const range = el('input', 'rp-range');
  range.type = 'range';
  range.step = '1';
  range.setAttribute('aria-label', 'Moment powtórki');
  let dragging = false;
  range.addEventListener('pointerdown', () => (dragging = true));
  range.addEventListener('pointerup', () => (dragging = false));
  range.addEventListener('change', () => (dragging = false));
  range.addEventListener('input', () => opts.onSeek(Number(range.value)));
  const time = el('span', 'rp-time');
  time.setAttribute('aria-live', 'off');
  const note = el('span', 'rp-note', ['Tylko podgląd: to już się wydarzyło, nie dzieje się teraz.']);

  root.append(pill, play, speeds, live, el('div', 'rp-scrub', [range, time]), note);

  return {
    root,
    setOpen(open) {
      root.hidden = !open;
      document.body.classList.toggle('is-replay', open);
    },
    update(s) {
      if (root.hidden) return;
      setText(play, s.playing ? '⏸' : '▶');
      play.title = s.playing ? 'Wstrzymaj powtórkę' : s.tick >= s.toTick ? 'Odtwórz od początku' : 'Wznów powtórkę';
      play.setAttribute('aria-label', play.title);
      for (const { tps, b } of speedBtns) {
        const on = tps === s.speed;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      range.min = String(s.fromTick);
      range.max = String(s.toTick);
      if (!dragging) range.value = String(s.tick);
      const t = timeFromTick(s.tick);
      time.replaceChildren(el('b', undefined, [formatClock(t)]), ` · ${s.tick >= s.toTick ? 'teraz' : agoText(s.toTick - s.tick)}`);
      range.setAttribute('aria-valuetext', `${formatClock(t)}, ${agoText(s.toTick - s.tick)}`);
    },
  };
}
