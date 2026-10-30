import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { findGenderedForms } from '../src/social/diaryAi';
import {
  CHRONICLE_DAYS,
  CHRONICLE_MAX_ITEMS,
  CHRONICLE_VIEW_ITEMS,
  chronicleFacts,
  classifyEvent,
  collectEvents,
  createChronicle,
  plural,
  proceduralSummary,
  rewindChronicle,
  toView,
} from '../src/social/chronicle';
import type { SimEvent, SimEventKind } from '../src/types';

const ev = (tick: number, text: string, kind: SimEventKind = 'info', agentIds: number[] = [0, 1]): SimEvent => ({ tick, kind, text, agentIds });
const dateOf = (tick: number): string => new Date(Date.UTC(2026, 9, 1) + Math.floor(tick / 1440) * 86_400_000).toISOString().slice(0, 10);

describe('classifyEvent', () => {
  it('recognises the important events and ranks them', () => {
    const kind = (e: SimEvent) => classifyEvent(e)?.kind;
    expect(kind(ev(1, 'Ola i Kuba są parą 💕', 'relationship'))).toBe('couple');
    expect(kind(ev(1, 'Ola i Kuba się rozstają 💔', 'relationship'))).toBe('breakup');
    expect(kind(ev(1, 'Ola ↔ Kuba: kłótnia o politykę 💢', 'relationship'))).toBe('quarrel');
    expect(kind(ev(1, 'Ola i Kuba się przyjaźnią 🤝', 'relationship'))).toBe('friends');
    expect(kind(ev(1, 'Ola naprawia lodówkę 🔧✨', 'use'))).toBe('breakdown');
    expect(kind(ev(1, 'Nadciąga burza ⛈️'))).toBe('weather');
    expect(kind(ev(1, 'Wspólny obiad: Ola, Kuba, Ewa 🍽️', 'info', [0, 1, 2]))).toBe('together');
    expect(classifyEvent(ev(1, 'Ola i Kuba są parą 💕', 'relationship'))!.weight).toBeGreaterThan(classifyEvent(ev(1, 'Zaczyna padać 🌧️'))!.weight);
  });

  it('skips noise: sleeping, plain conversations, TV news', () => {
    expect(classifyEvent(ev(1, 'Ola idzie spać', 'use', [0]))).toBeNull();
    expect(classifyEvent(ev(1, 'Ola ↔ Kuba: miła rozmowa o pogodzie', 'conversation'))).toBeNull();
    expect(classifyEvent(ev(1, '📰 Ola: Kuba łowi pięknego karpia'))).toBeNull();
  });
});

describe('collectEvents', () => {
  it('adds only events newer than lastTick (no duplicates on a second pass) and groups them by day', () => {
    const store = createChronicle();
    const events = [ev(10, 'Ola i Kuba są parą 💕', 'relationship'), ev(1500, 'Ola i Kuba się rozstają 💔', 'relationship')];
    expect(collectEvents(store, events, 1500, dateOf)).toBe(2);
    expect(collectEvents(store, events, 1500, dateOf)).toBe(0);
    expect(store.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(store.lastTick).toBe(1500);
  });

  it('keeps the last 14 days and at most 60 items per day, dropping the least important', () => {
    const store = createChronicle();
    const events: SimEvent[] = [];
    for (let d = 0; d < 20; d++) events.push(ev(d * 1440 + 5, 'Ola i Kuba są parą 💕', 'relationship'));
    collectEvents(store, events, 20 * 1440, dateOf);
    expect(store.days).toHaveLength(CHRONICLE_DAYS);
    expect(store.days[0].date).toBe(dateOf(6 * 1440));

    const busy = createChronicle();
    const many: SimEvent[] = [ev(1, 'Ola i Kuba są parą 💕', 'relationship')];
    for (let i = 0; i < 100; i++) many.push(ev(2 + i, 'Zaczyna padać 🌧️'));
    collectEvents(busy, many, 200, dateOf);
    expect(busy.days[0].items).toHaveLength(CHRONICLE_MAX_ITEMS);
    expect(busy.days[0].items.some((i) => i.kind === 'couple')).toBe(true);
  });

  it('rewinds to an older world tick and replays the same events afterwards', () => {
    const store = createChronicle();
    const events = [ev(10, 'Ola i Kuba są parą 💕', 'relationship'), ev(1500, 'Ola i Kuba się rozstają 💔', 'relationship')];
    collectEvents(store, events, 1500, dateOf);
    rewindChronicle(store, 100);
    expect(store.lastTick).toBe(100);
    expect(store.days.map((d) => d.date)).toEqual(['2026-10-01']);
    collectEvents(store, events, 1500, dateOf);
    expect(store.days.flatMap((d) => d.items)).toHaveLength(2);
  });
});

describe('summaries and view', () => {
  it('counts what happened in Polish, with correct plural forms', () => {
    expect([1, 2, 5, 12, 22, 25].map((n) => plural(n, 'awaria', 'awarie', 'awarii'))).toEqual(['awaria', 'awarie', 'awarii', 'awarii', 'awarie', 'awarii']);
    const items = [ev(1, 'Ola i Kuba są parą 💕', 'relationship'), ev(2, 'Ewa psuje kuchenkę 🔧'), ev(3, 'Ewa naprawia kuchenkę 🔧✨', 'use'), ev(4, 'Nadciąga burza ⛈️')].map((e) => classifyEvent(e)!);
    expect(proceduralSummary(items)).toBe('Najważniejsze: 1 nowa para, 2 awarie, burza.');
    expect(proceduralSummary([])).toMatch(/^Spokojny dzień/);
    expect(findGenderedForms(proceduralSummary(items))).toEqual([]);
  });

  it('serves days newest first, the most important items chronologically, and strips emoji from AI facts', () => {
    const store = createChronicle();
    const events: SimEvent[] = [ev(1, 'Ola i Kuba są parą 💕', 'relationship'), ev(1441, 'Ola i Kuba się rozstają 💔', 'relationship')];
    for (let i = 0; i < 30; i++) events.push(ev(1442 + i, 'Zaczyna padać 🌧️'));
    collectEvents(store, events, 1500, dateOf);
    store.days[1].ai = 'Spokojny dzień nad jeziorem.';
    const view = toView(store, 'dom', 1500);
    expect(view.days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-01']);
    expect(view.days[0]).toMatchObject({ summarySource: 'ai', summary: 'Spokojny dzień nad jeziorem.', total: 31 });
    expect(view.days[0].items).toHaveLength(CHRONICLE_VIEW_ITEMS);
    expect(view.days[0].items.some((i) => i.kind === 'breakup')).toBe(true);
    expect(view.days[1]).toMatchObject({ summarySource: 'procedural', total: 1 });
    expect(chronicleFacts(store.days[0])).toEqual(['Ola i Kuba są parą']);
  });
});

describe('simulation', () => {
  it('a week of a world gives a sensible chronicle without gendered forms', () => {
    const w = createWorld(1912);
    const store = createChronicle();
    for (let i = 0; i < 7 * 1440; i++) {
      tickWorld(w);
      collectEvents(store, w.events, w.tick, dateOf);
    }
    expect(store.days.length).toBeGreaterThanOrEqual(7);
    const kinds = new Set(store.days.flatMap((d) => d.items.map((i) => i.kind)));
    for (const k of ['together', 'breakdown', 'moment'] as const) expect(kinds.has(k)).toBe(true);
    for (const d of store.days) {
      expect(d.items.length).toBeLessThanOrEqual(CHRONICLE_MAX_ITEMS);
      expect(findGenderedForms(proceduralSummary(d.items))).toEqual([]);
      // everything kept is shown with its own Polish text: no sleeping or TV news
      for (const i of d.items) expect(i.text).not.toMatch(/idzie spać|wstaje z łóżka|^📰/);
    }
  });
});
