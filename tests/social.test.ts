import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';
import { createRelationships, relationshipLabel } from '../src/social/relationships';
import {
  TOPICS,
  chatAcceptanceChance,
  conversationDelta,
  describeConversation,
  startConversation,
  willAcceptChat,
} from '../src/social/conversation';
import {
  FAREWELLS,
  GREETINGS,
  REACTIONS,
  SMALL_TALK,
  THINGS,
  TOPIC_LINES,
  createProceduralProvider,
} from '../src/social/dialogueProvider';
import type { Agent, DialogueLine, Rng, Tone, Traits } from '../src/types';

function makeAgent(id: number, name: string, traits: Partial<Traits> = {}, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    color: '#f00',
    traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0, ...traits },
    needs: { hunger: 70, energy: 70, fun: 60, social: 50, hygiene: 70, comfort: 70 },
    mood: 60,
    pos: { x: 0, y: 0 },
    prevPos: { x: 0, y: 0 },
    facing: 1,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
    ...extra,
  };
}

function randomAgent(id: number, rng: Rng): Agent {
  const names = ['Ola', 'Bartek', 'Maksymilian', 'Kasia', 'Zuzanna', 'Tomek'];
  const t = () => rng.range(-1, 1);
  const a = makeAgent(id, rng.pick(names), { sociability: t(), activity: t(), neatness: t(), cheerfulness: t() });
  a.mood = rng.range(0, 100);
  for (const k of Object.keys(a.needs) as (keyof Agent['needs'])[]) a.needs[k] = rng.range(0, 100);
  return a;
}

const lines = (tone: Tone, n: number): DialogueLine[] => Array.from({ length: n }, (_, i) => ({ speakerId: i % 2, text: 'x', tone }));

describe('relationships', () => {
  it('is symmetric and clamped', () => {
    const r = createRelationships();
    expect(r.get(1, 2)).toBe(0);
    expect(r.adjust(2, 1, 30)).toBe(30);
    expect(r.get(1, 2)).toBe(30);
    expect(r.get(2, 1)).toBe(30);
    r.adjust(1, 2, 500);
    expect(r.get(2, 1)).toBe(100);
    r.adjust(2, 1, -1000);
    expect(r.get(1, 2)).toBe(-100);
    expect(r.adjust(3, 3, 10)).toBe(0);
    r.adjust(5, 4, 3);
    expect(r.all()).toEqual([
      { a: 1, b: 2, value: -100 },
      { a: 4, b: 5, value: 3 },
    ]);
  });
  it('labels span the range', () => {
    expect(relationshipLabel(-100)).toBe('wrogowie');
    expect(relationshipLabel(0)).toBe('znajomi');
    expect(relationshipLabel(100)).toBe('najlepsi przyjaciele');
    const labels = new Set<string>();
    for (let v = -100; v <= 100; v++) labels.add(relationshipLabel(v));
    expect(labels.size).toBeGreaterThanOrEqual(6);
  });
});

describe('conversation', () => {
  it('starts with sane parameters and known topics', () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i++) {
      const c = startConversation(i, randomAgent(1, rng), randomAgent(2, rng), 100, rng);
      expect(TOPICS).toContain(c.topic);
      expect(c.maxLines).toBeGreaterThanOrEqual(4);
      expect(c.maxLines).toBeLessThanOrEqual(8);
      expect(c.nextLineIn).toBeGreaterThan(0);
      expect(c.participants).toEqual([1, 2]);
      expect(c.lines).toEqual([]);
    }
  });

  it('topic choice is biased by traits', () => {
    const rng = createRng(3);
    const count = (traits: Partial<Traits>) => {
      let n = 0;
      for (let i = 0; i < 2000; i++) {
        if (startConversation(i, makeAgent(1, 'A', traits), makeAgent(2, 'B', traits), 0, rng).topic === 'sport') n++;
      }
      return n;
    };
    expect(count({ activity: 1 })).toBeGreaterThan(count({ activity: -1 }) * 2);
  });

  it('acceptance grows with relationship', () => {
    const target = makeAgent(1, 'Ola');
    const initiator = makeAgent(2, 'Bartek');
    const rate = (rel: number) => {
      const rng = createRng(11);
      let n = 0;
      for (let i = 0; i < 3000; i++) if (willAcceptChat(target, initiator, rel, rng)) n++;
      return n / 3000;
    };
    const rates = [-100, -50, 0, 50, 100].map(rate);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1]);
  });

  it('acceptance drops when exhausted or hungry, rises with sociability', () => {
    const init = makeAgent(2, 'B');
    const base = chatAcceptanceChance(makeAgent(1, 'A'), init, 0);
    const tired = makeAgent(1, 'A');
    tired.needs.energy = 5;
    const hungry = makeAgent(1, 'A');
    hungry.needs.hunger = 5;
    expect(chatAcceptanceChance(tired, init, 0)).toBeLessThan(base);
    expect(chatAcceptanceChance(hungry, init, 0)).toBeLessThan(base);
    expect(chatAcceptanceChance(makeAgent(1, 'A', { sociability: 1 }), init, 0)).toBeGreaterThan(base);
  });

  it('delta sign follows tones and stays in range', () => {
    const rng = createRng(5);
    for (let i = 0; i < 300; i++) {
      const a = randomAgent(1, rng);
      const b = randomAgent(2, rng);
      const n = rng.int(4, 8);
      expect(conversationDelta(a, b, lines('positive', n))).toBeGreaterThan(0);
      expect(conversationDelta(a, b, lines('negative', n))).toBeLessThan(0);
      const mixed: DialogueLine[] = Array.from({ length: n }, () => ({ speakerId: 1, text: '', tone: rng.pick(['positive', 'neutral', 'negative'] as const) }));
      const d = conversationDelta(a, b, mixed);
      expect(d).toBeGreaterThanOrEqual(-8);
      expect(d).toBeLessThanOrEqual(8);
    }
  });

  it('compatible personalities get a better delta', () => {
    const a = makeAgent(1, 'A', { cheerfulness: 0.8, sociability: 0.8 });
    const same = makeAgent(2, 'B', { cheerfulness: 0.8, sociability: 0.8 });
    const opposite = makeAgent(3, 'C', { cheerfulness: -0.8, sociability: -0.8 });
    const l = lines('neutral', 6);
    expect(conversationDelta(a, same, l)).toBeGreaterThan(conversationDelta(a, opposite, l));
  });

  it('describes conversations in Polish without declining names', () => {
    const rng = createRng(1);
    const a = makeAgent(1, 'Ola');
    const b = makeAgent(2, 'Bartek');
    const conv = startConversation(4, a, b, 0, rng);
    conv.topic = 'muzyka';
    for (const d of [8, 3, 0, -3, -8]) {
      const s = describeConversation(a, b, conv, d);
      expect(s.startsWith('Ola ↔ Bartek: ')).toBe(true);
      expect(s.length).toBeGreaterThan(20);
    }
    expect(describeConversation(a, b, conv, 3)).toContain('o muzyce');
  });
});

describe('procedural dialogue provider', () => {
  it('has a big pool of templates', () => {
    const pools = [
      ...Object.values(GREETINGS),
      ...Object.values(FAREWELLS),
      ...Object.values(SMALL_TALK),
      ...Object.values(REACTIONS).flatMap((r) => Object.values(r)),
      ...Object.values(TOPIC_LINES).flatMap((r) => Object.values(r)),
    ];
    const all = new Set(pools.flat());
    expect(all.size).toBeGreaterThanOrEqual(150);
    for (const t of TOPICS) expect(TOPIC_LINES[t], t).toBeDefined();
  });

  it('returns non-empty short lines for many random contexts', () => {
    const p = createProceduralProvider();
    const rng = createRng(99);
    const longestThing = Math.max(...THINGS.map((t) => t.length));
    expect(longestThing).toBeLessThan(25);
    const tones = new Set<Tone>();
    for (let i = 0; i < 3000; i++) {
      const speaker = randomAgent(1, rng);
      const listener = randomAgent(2, rng);
      const history: DialogueLine[] = [];
      const maxLines = rng.int(4, 8);
      for (let turn = 0; turn < maxLines; turn++) {
        const out = p.nextLine(
          {
            speaker: turn % 2 ? listener : speaker,
            listener: turn % 2 ? speaker : listener,
            relationship: rng.range(-100, 100),
            topic: rng.chance(0.05) ? 'coś nieznanego' : rng.pick(TOPICS),
            history,
            turn,
            isLast: turn === maxLines - 1,
            time: timeFromTick(rng.int(0, 5000)),
          },
          rng,
        );
        if (out instanceof Promise) throw new Error('procedural provider must be synchronous');
        expect(out.text.trim().length).toBeGreaterThan(0);
        expect(out.text.length, out.text).toBeLessThanOrEqual(70);
        expect(out.text).not.toMatch(/[{}]/);
        tones.add(out.tone);
        history.push(out);
      }
    }
    expect(tones.size).toBe(3);
  });

  it('tone follows relationship and mood', () => {
    const p = createProceduralProvider();
    const rng = createRng(4);
    const negShare = (rel: number, mood: number) => {
      let neg = 0;
      for (let i = 0; i < 2000; i++) {
        const s = makeAgent(1, 'A', {}, { mood });
        const out = p.nextLine({ speaker: s, listener: makeAgent(2, 'B'), relationship: rel, topic: 'sport', history: [], turn: 2, isLast: false, time: timeFromTick(0) }, rng) as DialogueLine;
        if (out.tone === 'negative') neg++;
      }
      return neg;
    };
    expect(negShare(-90, 15)).toBeGreaterThan(negShare(90, 85) * 2);
  });

  it('is deterministic with a seed', () => {
    const run = () => {
      const p = createProceduralProvider();
      const rng = createRng(1234);
      const out: string[] = [];
      for (let i = 0; i < 200; i++) {
        const l = p.nextLine(
          { speaker: makeAgent(1, 'Ola'), listener: makeAgent(2, 'Bartek'), relationship: 10, topic: rng.pick(TOPICS), history: [], turn: i % 6, isLast: i % 6 === 5, time: timeFromTick(i * 37) },
          rng,
        ) as DialogueLine;
        out.push(`${l.tone}:${l.text}`);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
