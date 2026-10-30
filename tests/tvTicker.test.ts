import { describe, expect, it } from 'vitest';
import {
  END_PAUSE_S,
  MIN_SHOW_S,
  START_PAUSE_S,
  createTicker,
  holdSeconds,
  presentHeadline,
  scrollOffset,
} from '../src/render/tvTicker';
import type { NewsItem } from '../src/world/news';

const news = (title: string): NewsItem => ({ title, source: 'Osiedle', real: false });
const A = news('Pierwsza wiadomość');
const B = news('Druga wiadomość');
const C = news('Trzecia wiadomość');

describe('TV ticker presentation', () => {
  it('starts every headline from the first word, after a pause', () => {
    expect(scrollOffset(0, 400, 28)).toBe(0);
    expect(scrollOffset(START_PAUSE_S, 400, 28)).toBe(0);
    expect(scrollOffset(START_PAUSE_S + 1, 400, 28)).toBeCloseTo(28);
  });

  it('scrolls the whole headline once and rests at the end', () => {
    const dist = 400;
    const end = START_PAUSE_S + dist / 28;
    expect(scrollOffset(end + 5, dist, 28)).toBe(dist);
    expect(holdSeconds(dist, 28)).toBeCloseTo(end + END_PAUSE_S);
    expect(scrollOffset(3, 0, 28)).toBe(0);
  });

  it('holds a short headline for the minimum time only', () => {
    expect(holdSeconds(0, 28)).toBe(MIN_SHOW_S);
    const st = createTicker();
    presentHeadline(st, A, 0);
    expect(presentHeadline(st, B, (MIN_SHOW_S - 1) * 1000)).toBe(A);
    expect(presentHeadline(st, B, MIN_SHOW_S * 1000)).toBe(B);
    expect(st.since).toBe(MIN_SHOW_S * 1000);
  });

  it('keeps a long headline on air until it has been scrolled through', () => {
    const st = createTicker();
    presentHeadline(st, A, 0);
    st.dist = 1000;
    const hold = holdSeconds(1000, 28);
    expect(hold).toBeGreaterThan(MIN_SHOW_S);
    expect(presentHeadline(st, B, (hold - 0.5) * 1000)).toBe(A);
    expect(presentHeadline(st, B, hold * 1000)).toBe(B);
    expect(st.dist).toBe(0);
  });

  it('skips headlines the simulation changed meanwhile and shows only the newest', () => {
    const st = createTicker();
    presentHeadline(st, A, 0);
    presentHeadline(st, B, 1000);
    presentHeadline(st, C, 2000);
    expect(presentHeadline(st, C, MIN_SHOW_S * 1000)).toBe(C);
  });

  it('is idempotent within a frame and resets when the TV goes off', () => {
    const st = createTicker();
    presentHeadline(st, A, 0);
    expect(presentHeadline(st, B, MIN_SHOW_S * 1000)).toBe(B);
    expect(presentHeadline(st, B, MIN_SHOW_S * 1000)).toBe(B);
    expect(presentHeadline(st, null, 20000)).toBeNull();
    expect(presentHeadline(st, A, 21000)).toBe(A);
    expect(st.since).toBe(21000);
  });
});
