import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { EXCHANGE_GAP, LINE_TTL } from '../src/social/conversation';
import { MIN_SHOW_MS, createBubblePresenter, readingTimeMs } from '../src/render/bubbles';
import { createProceduralProvider } from '../src/social/dialogueProvider';
import type { Bubble, DialogueLine } from '../src/types';

// Conversations are short exchanges (issue #26): the live view (1 tick = 1 real minute) must not
// keep one line hanging over a resident for many minutes.

describe('conversation pace', () => {
  it('lines come in exchanges: the reply in the same minute, a little later, then a short pause', () => {
    const world = createWorld(42, { agentCount: 6 });
    /** conversation id -> ticks of its lines */
    const lineTicks = new Map<number, number[]>();
    const seen = new Map<number, number>();
    let replies = 0;
    for (let t = 0; t < 2 * 1440; t++) {
      tickWorld(world);
      for (const c of world.conversations) {
        const before = seen.get(c.id) ?? 0;
        const fresh = c.lines.slice(before);
        seen.set(c.id, c.lines.length);
        const ticks = lineTicks.get(c.id) ?? [];
        for (const _ of fresh) ticks.push(world.tick);
        lineTicks.set(c.id, ticks);
        if (fresh.length === 2) {
          // opener and reply in one minute: the reply shows later within it
          const [opener, reply] = fresh.map((l) => world.agents.find((a) => a.id === l.speakerId)!.bubble!);
          expect(reply.at ?? 0).toBeGreaterThan(opener.at ?? 0);
          replies++;
        }
        for (const id of c.participants) {
          const b = world.agents.find((a) => a.id === id)!.bubble;
          if (b?.kind === 'speech' && c.lines.some((l) => l.text === b.text)) expect(b.ttl).toBeLessThanOrEqual(LINE_TTL);
        }
      }
    }
    expect(replies).toBeGreaterThan(20);
    const all = [...lineTicks.values()].filter((t) => t.length >= 2);
    expect(all.length).toBeGreaterThan(8);
    for (const ticks of all) {
      for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeLessThanOrEqual(EXCHANGE_GAP[1]);
      // a chat lasts minutes, not hours
      expect(ticks[ticks.length - 1] - ticks[0]).toBeLessThanOrEqual(15);
    }
  });
});

describe('conversation pace with an async (AI) provider', () => {
  it('asks for the reply as soon as the opener arrives: both land before the next minute, the reply later', async () => {
    const world = createWorld(42, { agentCount: 6 });
    const proc = createProceduralProvider();
    world.dialogue = { name: 'async', nextLine: (ctx, rng) => Promise.resolve(proc.nextLine(ctx, rng) as DialogueLine) };
    let checked = 0;
    for (let t = 0; t < 1440 && checked < 3; t++) {
      tickWorld(world);
      const waiting = world.conversations.filter((c) => c.pending && c.lines.length % 2 === 0);
      const before = new Map(waiting.map((c) => [c.id, c.lines.length]));
      await new Promise((r) => setTimeout(r, 0));
      for (const c of waiting) {
        if (!world.conversations.includes(c) || c.lines.length - before.get(c.id)! < 2) continue;
        const [opener, reply] = c.lines.slice(-2).map((l) => world.agents.find((a) => a.id === l.speakerId)!.bubble!);
        expect(reply.at!).toBeGreaterThan(opener.at!);
        expect(c.pending).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(3);
  });
});

describe('bubble presenter (real time)', () => {
  const line = (text: string, ttl = LINE_TTL, at?: number): Bubble => ({ kind: 'speech', text, ttl, tone: 'neutral', ...(at ? { at } : {}) });

  it('shows a bubble from its `at` and hides it after the reading time while the tick lasts a minute', () => {
    const p = createBubblePresenter();
    const b = line('Dzień dobry!', 3, 0.2);
    expect(p.present(1, b, 10, 0.1, 0)).toBeNull();
    expect(p.present(1, b, 10, 0.2, 12_000)?.bubble.text).toBe('Dzień dobry!');
    expect(p.present(1, b, 10, 0.25, 12_000 + readingTimeMs(b.text) - 1000)).not.toBeNull();
    expect(p.present(1, b, 10, 0.4, 12_000 + readingTimeMs(b.text) + 10)).toBeNull();
    // still the same bubble in the next minute (ttl lower): stays hidden
    expect(p.present(1, { ...b, ttl: 2 }, 11, 0, 60_000)).toBeNull();
    // the same words said again (ttl back up) show again
    expect(p.present(1, { ...b, ttl: 3, at: undefined }, 13, 0, 180_000)).not.toBeNull();
  });

  it('never shows a line longer than the reading time', () => {
    for (const text of ['Hej', 'A to ciekawe, nie słyszałem tego wcześniej, opowiadaj dalej proszę!'.repeat(3)]) {
      expect(readingTimeMs(text)).toBeGreaterThanOrEqual(3500);
      expect(readingTimeMs(text)).toBeLessThanOrEqual(9000);
    }
  });

  it('at fast speed holds each bubble for the minimum time, then jumps to the latest', () => {
    const p = createBubblePresenter();
    expect(p.present(1, line('Raz'), 1, 0, 0)?.bubble.text).toBe('Raz');
    // two newer lines within MIN_SHOW_MS: the first one stays
    expect(p.present(1, line('Dwa'), 2, 0, 200)?.bubble.text).toBe('Raz');
    expect(p.present(1, line('Trzy'), 3, 0, 400)?.bubble.text).toBe('Raz');
    expect(p.present(1, line('Trzy', 2), 4, 0, MIN_SHOW_MS + 1)?.bubble.text).toBe('Trzy');
  });

  it('lingers briefly after the simulation drops a bubble, then fades out', () => {
    const p = createBubblePresenter();
    p.present(1, line('Pa!'), 1, 0, 0);
    const lingering = p.present(1, null, 2, 0, 300);
    expect(lingering?.bubble.text).toBe('Pa!');
    expect(p.present(1, null, 2, 0, MIN_SHOW_MS - 100)!.fade).toBeLessThan(1);
    expect(p.present(1, null, 3, 0, MIN_SHOW_MS + 1)).toBeNull();
  });

  it('keeps the "…" of a pending AI line while it is there', () => {
    const p = createBubblePresenter();
    const dots: Bubble = { kind: 'thought', text: '…', ttl: 200 };
    expect(p.present(1, dots, 1, 0, 0)).not.toBeNull();
    expect(p.present(1, { ...dots, ttl: 190 }, 11, 0, 600_000)?.fade).toBe(1);
  });
});
