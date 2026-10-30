// What the TV news shows, decoupled from the simulation's headline rotation (world/news.ts rotates by
// game ticks, which is far too fast for reading when ticks run fast). Real-time presentation state lives
// here, in render/, so the simulation stays deterministic: a headline is held on screen until it has
// been scrolled through (and for a minimum time), then replaced by the newest one the simulation has aired.

import type { NewsItem } from '../world/news';

/** a headline stays at least this long (s, wall clock) */
export const MIN_SHOW_S = 15;
/** pause before the marquee starts moving */
export const START_PAUSE_S = 2;
/** pause once the end of the headline is visible */
export const END_PAUSE_S = 1.5;
/** marquee speed in px/s at ui scale 1 */
export const SCROLL_SPEED = 28;

export interface TickerState {
  shown: NewsItem | null;
  /** wall-clock ms when `shown` appeared */
  since: number;
  /** newest headline from the simulation that differs from `shown` */
  pending: NewsItem | null;
  /** px the shown headline has to travel to reveal its end (0 = fits the band); set by the renderer */
  dist: number;
  /** px/s the renderer scrolls with (set together with `dist`) */
  speed: number;
}

export function createTicker(): TickerState {
  return { shown: null, since: 0, pending: null, dist: 0, speed: SCROLL_SPEED };
}

/** seconds the headline is held on air: scrolled through once, but never shorter than MIN_SHOW_S */
export function holdSeconds(dist: number, speed: number): number {
  if (dist <= 0) return MIN_SHOW_S;
  return Math.max(MIN_SHOW_S, START_PAUSE_S + dist / speed + END_PAUSE_S);
}

/** marquee offset in px after `elapsedS` seconds: waits, scrolls once, then rests at the end */
export function scrollOffset(elapsedS: number, dist: number, speed: number): number {
  if (dist <= 0) return 0;
  return Math.min(dist, Math.max(0, elapsedS - START_PAUSE_S) * speed);
}

/**
 * advances the presentation and returns the headline to show; `incoming` is what the simulation airs
 * now (null = nobody watches, which resets the ticker). Idempotent for the same `nowMs`.
 */
export function presentHeadline(st: TickerState, incoming: NewsItem | null, nowMs: number): NewsItem | null {
  if (!incoming) {
    st.shown = null;
    st.pending = null;
    st.dist = 0;
    return null;
  }
  if (!st.shown) {
    show(st, incoming, nowMs);
    return st.shown;
  }
  st.pending = incoming.title === st.shown.title ? null : incoming;
  if (st.pending && (nowMs - st.since) / 1000 >= holdSeconds(st.dist, st.speed)) show(st, st.pending, nowMs);
  return st.shown;
}

function show(st: TickerState, item: NewsItem, nowMs: number): void {
  st.shown = item;
  st.pending = null;
  st.since = nowMs;
  st.dist = 0;
}

/** the renderer's single ticker (one TV picture for the whole estate; survives world swaps in live) */
export const ticker: TickerState = createTicker();
