import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';
import { createRelationships } from '../src/social/relationships';
import {
  HALF_LIFE_LIVED,
  MEMORY_CAP,
  WITNESS_RADIUS,
  agentMemories,
  conversationGossip,
  memoryStats,
  onConversationEnd,
  recallFor,
  updateMemories,
} from '../src/social/memory';
import { GOSSIP_TELL, MAX_GOSSIP_LINE, createProceduralProvider, fitGossip } from '../src/social/dialogueProvider';
import { pushEvent } from '../src/world/events';
import { createWorld, tickWorld } from '../src/world/world';
import type { Agent, Conversation, ConversationContext, DialogueLine, Gossip, Traits, World } from '../src/types';

function makeAgent(id: number, name: string, x: number, y: number, traits: Partial<Traits> = {}): Agent {
  return {
    id,
    name,
    color: '#f00',
    traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0, ...traits },
    needs: { hunger: 70, energy: 70, fun: 60, social: 50, hygiene: 70, comfort: 70 },
    mood: 60,
    pos: { x, y },
    prevPos: { x, y },
    facing: 1,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
  };
}

/** minimal world: Ola (0) at 0,0; Bartek (1) at 3,0; Kasia (2) at 20,0; Tomek (3) at 40,0 */
function miniWorld(): World {
  return {
    seed: 1,
    rng: createRng(1),
    tick: 0,
    grid: { width: 50, height: 10, tiles: [], solid: [], rooms: [] },
    objectDefs: {},
    objects: [],
    agents: [makeAgent(0, 'Ola', 0, 0), makeAgent(1, 'Bartek', 3, 0), makeAgent(2, 'Kasia', 20, 0), makeAgent(3, 'Tomek', 40, 0)],
    relationships: createRelationships(),
    conversations: [],
    events: [],
    dialogue: createProceduralProvider(),
  };
}

const ids = (w: World, agentId: number): string[] => agentMemories(w, agentId).map((m) => m.gossip.text);

function happen(w: World, g: Gossip): void {
  pushEvent(w, 'use', g.text, g.aboutIds, g);
  updateMemories(w);
}

function conv(id: number, a: Agent, b: Agent, lines: DialogueLine[]): Conversation {
  return { id, participants: [a.id, b.id], topic: 'plotki', lines, nextLineIn: 0, pending: false, maxLines: 6, startedAt: 0 };
}

/** a two-line conversation in which `teller` retells `g` to `other` */
function tell(w: World, teller: Agent, other: Agent, g: Gossip, id = 1): void {
  onConversationEnd(w, conv(id, teller, other, [
    { speakerId: teller.id, text: `Podobno ${g.text}.`, tone: 'neutral', gossip: g },
    { speakerId: other.id, text: 'Serio?!', tone: 'neutral' },
  ]));
}

const burnt: Gossip = { text: 'Ola przypala obiad', aboutIds: [0], valence: -0.5 };

describe('memory formation', () => {
  it('only the subject and witnesses within range remember an event', () => {
    const w = miniWorld();
    happen(w, burnt);
    expect(ids(w, 0)).toEqual(['Ola przypala obiad']);
    expect(ids(w, 1)).toEqual(['Ola przypala obiad']); // 3 tiles away
    expect(ids(w, 2)).toEqual([]); // 20 tiles away
    expect(ids(w, 3)).toEqual([]);
    expect(WITNESS_RADIUS).toBeLessThan(20);
  });

  it('ignores events without gossip and processes each event once', () => {
    const w = miniWorld();
    pushEvent(w, 'info', 'Ola: coś tam', [0]);
    updateMemories(w);
    expect(ids(w, 0)).toEqual([]);
    happen(w, burnt);
    updateMemories(w);
    updateMemories(w);
    expect(memoryStats(w).stories).toBe(1);
    expect(agentMemories(w, 0)).toHaveLength(1);
  });

  it('keeps working after old events are dropped from the capped log', () => {
    const w = miniWorld();
    for (let i = 0; i < 260; i++) pushEvent(w, 'info', `x${i}`, []);
    updateMemories(w);
    for (let i = 0; i < 260; i++) pushEvent(w, 'info', `y${i}`, []);
    happen(w, burnt);
    expect(ids(w, 0)).toEqual(['Ola przypala obiad']);
  });

  it('big quarrels become stories for the pair and bystanders', () => {
    const w = miniWorld();
    const [ola, bartek] = w.agents;
    const lines: DialogueLine[] = Array.from({ length: 6 }, (_, i) => ({ speakerId: i % 2, text: 'Grr', tone: 'negative' }));
    const g = conversationGossip(ola, bartek, conv(7, ola, bartek, lines));
    expect(g?.aboutIds).toEqual([0, 1]);
    expect(g!.valence).toBeLessThan(0);
    w.agents[2].pos = { x: 5, y: 2 }; // Kasia nearby
    onConversationEnd(w, conv(7, ola, bartek, lines));
    expect(ids(w, 0)).toContain(g!.text);
    expect(ids(w, 2)).toContain(g!.text);
    expect(ids(w, 3)).toEqual([]);
  });
});

describe('recall', () => {
  it('offers third-person stories the listener does not know', () => {
    const w = miniWorld();
    const [ola, bartek, kasia] = w.agents;
    happen(w, burnt);
    // Ola is the subject: she does not gossip about herself
    expect(recallFor(w, ola, kasia)).toEqual([]);
    // Bartek tells Kasia, but not Ola (it is about her)
    expect(recallFor(w, bartek, kasia).map((g) => g.text)).toEqual(['Ola przypala obiad']);
    expect(recallFor(w, bartek, ola)).toEqual([]);
    // once Kasia knows, Bartek has nothing new for her
    tell(w, bartek, kasia, recallFor(w, bartek, kasia)[0]);
    expect(recallFor(w, bartek, kasia)).toEqual([]);
  });

  it('returns at most 3 stories, strongest first', () => {
    const w = miniWorld();
    const [, bartek, kasia] = w.agents;
    w.agents[3].pos = { x: 4, y: 0 }; // Tomek near Bartek too
    const stories: Gossip[] = [
      { text: 'Ola ma świetny humor', aboutIds: [0], valence: 0.3 },
      { text: 'Ola łowi wielkiego szczupaka', aboutIds: [0], valence: 0.6 },
      { text: 'Tomek bije rekord na bieżni', aboutIds: [3], valence: 0.6 },
      { text: 'Ola i Tomek kłócą się o pilota', aboutIds: [0, 3], valence: -0.5 },
    ];
    for (const g of stories) happen(w, g);
    const r = recallFor(w, bartek, kasia);
    expect(r).toHaveLength(3);
    expect(r.map((g) => g.text)).not.toContain('Ola ma świetny humor');
  });

  it('shared moments come back as "remember when" after a while', () => {
    const w = miniWorld();
    const [, bartek, kasia] = w.agents;
    kasia.pos = { x: 2, y: 1 };
    happen(w, burnt);
    expect(recallFor(w, bartek, kasia)).toEqual([]); // too fresh
    w.tick += 120;
    const r = recallFor(w, bartek, kasia);
    expect(r).toHaveLength(1);
    expect(r[0].shared).toBe(true);
    tell(w, bartek, kasia, r[0]);
    expect(recallFor(w, bartek, kasia)).toEqual([]);
    expect(memoryStats(w).reminisced).toBe(1);
  });
});

describe('gossip spreading', () => {
  it('the listener learns the story (weaker) and changes opinion about the subject', () => {
    const w = miniWorld();
    const [, bartek, kasia, tomek] = w.agents;
    happen(w, burnt);
    const g = recallFor(w, bartek, kasia)[0];
    tell(w, bartek, kasia, g);
    const heard = agentMemories(w, kasia.id)[0];
    expect(heard.source).toBe('heard');
    expect(heard.fromId).toBe(bartek.id);
    expect(heard.strength).toBeLessThan(agentMemories(w, bartek.id)[0].strength);
    expect(w.relationships.get(kasia.id, 0)).toBeLessThan(0);
    // and Kasia can pass it on to Tomek, who was never there
    expect(recallFor(w, kasia, tomek).map((x) => x.text)).toEqual(['Ola przypala obiad']);
    tell(w, kasia, tomek, recallFor(w, kasia, tomek)[0], 2);
    expect(ids(w, tomek.id)).toEqual(['Ola przypala obiad']);
    expect(memoryStats(w).spreads).toBe(2);
  });

  it('trust in the teller scales the opinion shift; nice stories improve it', () => {
    const shift = (rel: number, g: Gossip): number => {
      const w = miniWorld();
      const [, bartek, kasia] = w.agents;
      w.relationships.adjust(kasia.id, bartek.id, rel);
      happen(w, g);
      tell(w, bartek, kasia, recallFor(w, bartek, kasia)[0]);
      return w.relationships.get(kasia.id, 0);
    };
    const fish: Gossip = { text: 'Ola łowi wielkiego szczupaka', aboutIds: [0], valence: 0.9 };
    expect(shift(0, fish)).toBeGreaterThan(0);
    expect(shift(80, fish)).toBeGreaterThan(shift(-80, fish));
    expect(Math.abs(shift(80, fish))).toBeLessThanOrEqual(3);
    expect(shift(80, burnt)).toBeLessThan(shift(-80, burnt));
  });

  it('a story the listener already knows changes nothing', () => {
    const w = miniWorld();
    const [, bartek, kasia] = w.agents;
    happen(w, burnt);
    const g = recallFor(w, bartek, kasia)[0];
    tell(w, bartek, kasia, g);
    const rel = w.relationships.get(kasia.id, 0);
    tell(w, bartek, kasia, g, 2);
    expect(w.relationships.get(kasia.id, 0)).toBe(rel);
    expect(memoryStats(w).spreads).toBe(1);
  });
});

describe('decay and caps', () => {
  it('memories fade over game days and are forgotten', () => {
    const w = miniWorld();
    happen(w, burnt);
    const s0 = agentMemories(w, 1)[0].strength;
    w.tick += HALF_LIFE_LIVED;
    expect(agentMemories(w, 1)[0].strength).toBeCloseTo(s0 / 2, 5);
    w.tick += HALF_LIFE_LIVED * 5;
    updateMemories(w);
    expect(agentMemories(w, 1)).toEqual([]);
    expect(recallFor(w, w.agents[1], w.agents[2])).toEqual([]);
  });

  it('keeps at most MEMORY_CAP memories per agent, dropping the weakest', () => {
    const w = miniWorld();
    for (let i = 0; i < MEMORY_CAP + 6; i++) happen(w, { text: `Ola robi rzecz nr ${i}`, aboutIds: [0], valence: i === 0 ? 1 : 0.1 });
    const mem = agentMemories(w, 1);
    expect(mem).toHaveLength(MEMORY_CAP);
    expect(mem[0].gossip.text).toBe('Ola robi rzecz nr 0');
  });
});

describe('gossip dialogue', () => {
  const ctxFor = (speaker: Agent, listener: Agent, gossip: Gossip[], turn = 2, history: DialogueLine[] = []): ConversationContext => ({
    speaker,
    listener,
    relationship: 0,
    topic: 'plotki',
    history,
    turn,
    isLast: false,
    time: timeFromTick(300),
    gossip,
  });

  it('retells stories with tagged, short lines and reacts to them', () => {
    const provider = createProceduralProvider();
    const rng = createRng(3);
    const kasia = makeAgent(2, 'Kasia', 0, 0, { sociability: 1, cheerfulness: 1 });
    const bartek = makeAgent(1, 'Bartek', 1, 0);
    const long: Gossip = { text: 'Maksymilian i Zuzanna godzinami rozmawiają o planach na weekend', aboutIds: [4, 5], valence: 0.4 };
    let told = 0;
    let reactions = 0;
    for (let i = 0; i < 300; i++) {
      const g = i % 2 ? burnt : long;
      const line = provider.nextLine(ctxFor(kasia, bartek, [g]), rng) as DialogueLine;
      expect(line.text.length).toBeLessThanOrEqual(MAX_GOSSIP_LINE);
      if (line.gossip) {
        told++;
        expect(line.gossip).toBe(g);
        const reply = provider.nextLine(ctxFor(bartek, kasia, [], 3, [line]), rng) as DialogueLine;
        if (/Serio|Nie wierzę|No proszę|coś ty|Ojej|dopiero|super|Brawo|pomyślał|Ciekawe/.test(reply.text)) reactions++;
      }
    }
    expect(told).toBeGreaterThan(80);
    expect(reactions).toBeGreaterThan(told * 0.5);
  });

  it('greetings, farewells and conversations without gossip never retell', () => {
    const provider = createProceduralProvider();
    const rng = createRng(5);
    const a = makeAgent(0, 'Ola', 0, 0, { sociability: 1 });
    const b = makeAgent(1, 'Bartek', 1, 0);
    for (let i = 0; i < 100; i++) {
      expect((provider.nextLine(ctxFor(a, b, [burnt], 0), rng) as DialogueLine).gossip).toBeUndefined();
      expect((provider.nextLine({ ...ctxFor(a, b, [burnt], 5), isLast: true }, rng) as DialogueLine).gossip).toBeUndefined();
      expect((provider.nextLine(ctxFor(a, b, []), rng) as DialogueLine).gossip).toBeUndefined();
    }
  });

  it('shared memories use "Pamiętasz, jak…"', () => {
    const provider = createProceduralProvider();
    const rng = createRng(9);
    const a = makeAgent(0, 'Ola', 0, 0, { sociability: 1 });
    const b = makeAgent(1, 'Bartek', 1, 0);
    const shared = { ...burnt, text: 'Kasia przypala obiad', shared: true };
    const lines = Array.from({ length: 60 }, () => provider.nextLine(ctxFor(a, b, [shared]), rng) as DialogueLine).filter((l) => l.gossip);
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(l.text).toMatch(/^A? ?[Pp]amiętasz, jak Kasia przypala obiad\?/);
  });

  it('fitGossip cuts at a word boundary', () => {
    expect(fitGossip('Ola przypala obiad', 40)).toBe('Ola przypala obiad');
    const cut = fitGossip('Maksymilian i Zuzanna godzinami rozmawiają o planach', 30);
    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut.endsWith('…')).toBe(true);
    for (const tpl of GOSSIP_TELL.bad) expect(tpl).toContain('{g}');
  });
});

describe('gossip in the running simulation', () => {
  function run(seed: number, days: number): { world: World; stats: ReturnType<typeof memoryStats>; heardBy: number; snapshot: string } {
    const world = createWorld(seed, { agentCount: 6 });
    for (let t = 0; t < days * 24 * 60; t++) tickWorld(world);
    const stats = memoryStats(world);
    let heardBy = 0;
    const snap: string[] = [];
    for (const a of world.agents) {
      const mem = agentMemories(world, a.id);
      heardBy += mem.filter((m) => m.source === 'heard').length;
      snap.push(`${a.id}:${mem.map((m) => `${m.gossip.text}/${m.source}/${m.strength.toFixed(3)}`).join('|')}`);
    }
    return { world, stats, heardBy, snapshot: snap.join('\n') };
  }

  it('is deterministic for a seed', () => {
    const a = run(11, 1);
    const b = run(11, 1);
    expect(a.snapshot).toBe(b.snapshot);
    expect(a.stats).toEqual(b.stats);
  });

  it('gossip flows during a week (3 seeds)', () => {
    for (const seed of [1, 2, 3]) {
      const { world, stats, heardBy } = run(seed, 7);
      // eslint-disable-next-line no-console
      console.log(`seed ${seed}: ${JSON.stringify(stats)}, heard memories held at the end: ${heardBy}, gossip log lines: ${world.events.filter((e) => e.text.includes(': plotka (')).length}`);
      expect(stats.stories).toBeGreaterThan(10);
      expect(stats.gossipLines).toBeGreaterThanOrEqual(15);
      expect(stats.spreads).toBeGreaterThanOrEqual(10);
      expect(stats.opinionShifts).toBeGreaterThan(0);
    }
  }, 120_000);
});
