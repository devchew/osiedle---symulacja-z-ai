import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { createWorld } from '../src/world/world';
import { slotUsePos } from '../src/world/objects';
import type { Agent, ObjectInstance, World } from '../src/types';
import {
  REL_TUNING,
  STATUS_LABELS,
  chemistry,
  couplesOf,
  deriveStatus,
  feltSympathy,
  partnerOf,
  recordConversation,
  recordQuarrel,
  relationOf,
  relationStats,
  relationsOf,
  updateRelations,
} from '../src/social/relationships';
import { startConversation } from '../src/social/conversation';
import {
  GROUP_TUNING,
  gatheringLog,
  gatheringTotals,
  invitationsOf,
  joinNames,
  onHeadingTo,
  socialObjectBias,
  talkStatusFactor,
  tickGatherings,
} from '../src/agents/groups';

const T = REL_TUNING;
/** game tick for a given hour of day 1 (the simulation starts at 07:00) */
const at = (hour: number): number => (hour - 7) * 60;

function pairs(world: World): [Agent, Agent][] {
  const out: [Agent, Agent][] = [];
  for (let i = 0; i < world.agents.length; i++) for (let j = i + 1; j < world.agents.length; j++) out.push([world.agents[i], world.agents[j]]);
  return out;
}

/** a world and a pair with the given compatibility (searching seeds) */
function worldWithPair(compatible: boolean): { world: World; a: Agent; b: Agent } {
  for (let seed = 1; seed < 50; seed++) {
    const world = createWorld(seed, { agentCount: 6 });
    const p = pairs(world).find(([x, y]) => (chemistry(world, x.id, y.id) >= T.CHEMISTRY_MIN) === compatible);
    if (p) return { world, a: p[0], b: p[1] };
  }
  throw new Error('no pair found');
}

function seat(world: World, agent: Agent, obj: ObjectInstance, slot: number): void {
  const def = world.objectDefs[obj.type];
  obj.reservedBy[slot] = agent.id;
  agent.pos = slotUsePos(obj, def, slot);
  agent.path = [];
  agent.action = { kind: 'use', phase: 'using', objectUid: obj.uid, slot, ticksLeft: 30, label: def.verb, icon: def.icon };
}

describe('relationship status', () => {
  it('derives Polish labels from sympathy, romance and rivalry', () => {
    expect(deriveStatus(0, 0, 0, undefined)).toBe('acquaintances');
    expect(deriveStatus(50, 0, 0, undefined)).toBe('friends');
    expect(deriveStatus(90, 0, 0, undefined)).toBe('best_friends');
    expect(deriveStatus(-70, 0, 0, undefined)).toBe('enemies');
    expect(deriveStatus(50, T.CRUSH_AT, 0, undefined)).toBe('crush');
    expect(deriveStatus(50, T.COUPLE_AT, 0, undefined)).toBe('couple');
    // romance alone is not enough: they must like each other
    expect(deriveStatus(T.COUPLE_SYMPATHY - 1, T.COUPLE_AT, 0, undefined)).toBe('crush');
    expect(deriveStatus(10, 0, T.RIVAL_AT, undefined)).toBe('rivals');
    expect(deriveStatus(-50, 0, T.RIVAL_AT, undefined)).toBe('enemies');
    expect(STATUS_LABELS.couple).toBe('para');
    expect(STATUS_LABELS.rivals).toBe('rywale');
  });

  it('has hysteresis, so labels do not flap around thresholds', () => {
    expect(deriveStatus(50, T.COUPLE_AT - 5, 0, 'couple')).toBe('couple');
    expect(deriveStatus(50, T.COUPLE_AT - 5, 0, 'crush')).toBe('crush');
    expect(deriveStatus(5, 0, T.RIVAL_AT - 5, 'rivals')).toBe('rivals');
    expect(deriveStatus(5, 0, T.RIVAL_AT - 5, undefined)).toBe('acquaintances');
    // sympathy bands keep their label within the margin
    expect(deriveStatus(38, 0, 0, 'friends')).toBe('friends');
    expect(deriveStatus(38, 0, 0, 'acquaintances')).toBe('pals');
  });

  it('read-only helpers do not change the simulation', () => {
    const world = createWorld(3, { agentCount: 6 });
    const [a, b] = world.agents;
    const v = relationOf(world, a.id, b.id);
    expect(v.sympathy).toBe(world.relationships.get(a.id, b.id));
    expect(v.romance).toBe(0);
    expect(v.history).toEqual([]);
    expect(relationsOf(world, a.id)).toHaveLength(5);
    const stats = relationStats(world);
    expect(Object.values(stats).reduce((s, x) => s + x, 0)).toBe(15);
    expect(world.events.filter((e) => e.kind === 'relationship')).toHaveLength(0);
  });
});

describe('romance', () => {
  it('grows over nice chats between compatible residents and logs a couple', () => {
    const { world, a, b } = worldWithPair(true);
    world.relationships.adjust(a.id, b.id, 60);
    for (let i = 0; i < 12 && relationOf(world, a.id, b.id).status !== 'couple'; i++) recordConversation(world, a.id, b.id, 4, 'muzyka');
    const v = relationOf(world, a.id, b.id);
    expect(v.status).toBe('couple');
    expect(v.label).toBe('para');
    expect(partnerOf(world, a.id)).toBe(b.id);
    expect(couplesOf(world)).toEqual([[Math.min(a.id, b.id), Math.max(a.id, b.id)]]);
    const ev = world.events.find((e) => e.text.includes('są parą'));
    expect(ev?.kind).toBe('relationship');
    expect(ev?.gossip).toEqual({ text: `${a.name} i ${b.name} są parą`, aboutIds: [a.id, b.id], valence: 0.7 });
    expect(v.history.map((h) => h.text)).toContain('Zostają parą 💕');
    // couples feel warmer, seek each other out and talk romantic topics
    expect(feltSympathy(world, a.id, b.id)).toBeGreaterThan(world.relationships.get(a.id, b.id) - 1);
    expect(talkStatusFactor(world, a.id, b.id)).toBeGreaterThan(1.5);
  });

  it('never grows without chemistry or without sympathy', () => {
    const { world, a, b } = worldWithPair(false);
    world.relationships.adjust(a.id, b.id, 80);
    for (let i = 0; i < 20; i++) recordConversation(world, a.id, b.id, 6, 'muzyka');
    expect(relationOf(world, a.id, b.id).romance).toBe(0);
    const w2 = worldWithPair(true);
    w2.world.relationships.adjust(w2.a.id, w2.b.id, -100);
    w2.world.relationships.adjust(w2.a.id, w2.b.id, T.ROMANCE_SYMPATHY - 5);
    for (let i = 0; i < 20; i++) recordConversation(w2.world, w2.a.id, w2.b.id, 3, 'muzyka');
    expect(relationOf(w2.world, w2.a.id, w2.b.id).romance).toBe(0);
  });

  it('is exclusive: someone in a couple does not fall for a third person', () => {
    for (let seed = 1; seed < 80; seed++) {
      const world = createWorld(seed, { agentCount: 8 });
      const ok = pairs(world).filter(([x, y]) => chemistry(world, x.id, y.id) >= T.CHEMISTRY_MIN);
      const tri = ok.flatMap(([x, y]) => ok.filter(([p, q]) => (p === x || q === x) && !(p === x && q === y)).map((o) => [x, y, o[0] === x ? o[1] : o[0]] as const));
      if (tri.length === 0) continue;
      const [x, y, z] = tri[0];
      world.relationships.adjust(x.id, y.id, 80);
      world.relationships.adjust(x.id, z.id, 80);
      for (let i = 0; i < 15; i++) recordConversation(world, x.id, y.id, 5, 'muzyka');
      expect(relationOf(world, x.id, y.id).status).toBe('couple');
      for (let i = 0; i < 15; i++) recordConversation(world, x.id, z.id, 5, 'muzyka');
      expect(relationOf(world, x.id, z.id).romance).toBe(0);
      return;
    }
    throw new Error('no triangle found');
  });

  it('breaks up after quarrels', () => {
    const { world, a, b } = worldWithPair(true);
    world.relationships.adjust(a.id, b.id, 60);
    for (let i = 0; i < 12; i++) recordConversation(world, a.id, b.id, 5, 'muzyka');
    expect(relationOf(world, a.id, b.id).status).toBe('couple');
    for (let i = 0; i < 6; i++) recordQuarrel(world, a.id, b.id, 'Kłótnia — temat: polityka');
    expect(relationOf(world, a.id, b.id).status).not.toBe('couple');
    expect(world.events.some((e) => e.text === `${a.name} i ${b.name} się rozstają 💔`)).toBe(true);
  });
});

describe('rivalry', () => {
  it('repeated quarrels make rivals, time and nice chats heal it', () => {
    const world = createWorld(5, { agentCount: 6 });
    const [a, b] = world.agents;
    updateRelations(world);
    for (let i = 0; i < 3; i++) recordConversation(world, a.id, b.id, -6, 'polityka');
    const v = relationOf(world, a.id, b.id);
    expect(['rivals', 'enemies']).toContain(v.status);
    expect(v.history.filter((h) => h.text.startsWith('Kłótnia')).length).toBe(3);
    const ev = world.events.find((e) => e.text.includes('zostają rywalami') || e.text.includes('nie mogą się znieść'));
    expect(ev?.gossip?.valence).toBeLessThan(0);
    // rivals avoid each other and feel colder in conversation
    expect(talkStatusFactor(world, a.id, b.id)).toBeLessThan(0.5);
    expect(feltSympathy(world, a.id, b.id)).toBeLessThan(world.relationships.get(a.id, b.id));
    // a couple of quiet weeks later the rivalry is over
    world.tick += 20 * 24 * 60;
    world.relationships.adjust(a.id, b.id, 40);
    updateRelations(world);
    expect(['rivals', 'enemies']).not.toContain(relationOf(world, a.id, b.id).status);
  });
});

describe('conversation mood', () => {
  it('couples talk plans and memories, rivals politics', () => {
    const world = createWorld(1, { agentCount: 2 });
    const [a, b] = world.agents;
    const count = (mood: 'romantic' | 'tense' | undefined, topic: string): number => {
      const rng = createRng(9);
      let n = 0;
      for (let i = 0; i < 2000; i++) if (startConversation(i, a, b, 0, rng, mood).topic === topic) n++;
      return n;
    };
    expect(count('romantic', 'plany na weekend')).toBeGreaterThan(count(undefined, 'plany na weekend') * 1.5);
    expect(count('tense', 'polityka')).toBeGreaterThan(count(undefined, 'polityka') * 1.5);
  });
});

describe('gatherings', () => {
  it('joins names without declension', () => {
    expect(joinNames(['Ola'])).toBe('Ola');
    expect(joinNames(['Ola', 'Bartek'])).toBe('Ola i Bartek');
    expect(joinNames(['Ola', 'Bartek', 'Kasia'])).toBe('Ola, Bartek i Kasia');
  });

  it('logs one shared meal when three people sit at the table', () => {
    const world = createWorld(2, { agentCount: 6 });
    world.tick = at(13);
    const table = world.objects.find((o) => o.type === 'dining_table')!;
    const [a, b, c] = world.agents;
    seat(world, a, table, 0);
    seat(world, b, table, 1);
    tickGatherings(world);
    expect(gatheringLog(world)).toHaveLength(0);
    seat(world, c, table, 3);
    for (let i = 0; i < 5; i++) {
      world.tick++;
      tickGatherings(world);
    }
    const log = gatheringLog(world);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'meal', label: 'Wspólny obiad', active: true });
    expect(gatheringTotals(world).meal).toBe(1);
    const ev = world.events.filter((e) => e.text.startsWith('Wspólny obiad: '));
    expect(ev).toHaveLength(1);
    expect(ev[0].text).toContain(`${a.name}, ${b.name}, ${c.name}`);
    // everyone leaves: the gathering closes
    for (const p of [a, b, c]) p.action = null;
    for (let i = 0; i <= GROUP_TUNING.END_AFTER + 1; i++) {
      world.tick++;
      tickGatherings(world);
    }
    expect(gatheringLog(world)[0].active).toBe(false);
  });

  it('counts garden benches around the grill and tells the story', () => {
    const world = createWorld(2, { agentCount: 6 });
    world.tick = at(18);
    const grill = world.objects.find((o) => o.type === 'grill' && world.objects.some((b) => b.type === 'bench' && Math.hypot(b.pos.x - o.pos.x, b.pos.y - o.pos.y) <= GROUP_TUNING.GRILL_RADIUS))!;
    const bench = world.objects.find((b) => b.type === 'bench' && Math.hypot(b.pos.x - grill.pos.x, b.pos.y - grill.pos.y) <= GROUP_TUNING.GRILL_RADIUS)!;
    const [a, b, c] = world.agents;
    seat(world, a, grill, 0);
    seat(world, b, grill, 1);
    seat(world, c, bench, 0);
    tickGatherings(world);
    const ev = world.events.find((e) => e.text.startsWith('Wspólny grill: '));
    expect(ev?.gossip?.text).toBe(`${a.name}, ${b.name} i ${c.name} grillują razem w ogrodzie`);
  });

  it('an invitation pulls friends (not rivals) to the same object', () => {
    for (let seed = 1; seed < 40; seed++) {
      const world = createWorld(seed, { agentCount: 6 });
      world.tick = at(13);
      const host = world.agents.reduce((x, y) => (y.traits.sociability > x.traits.sociability ? y : x));
      const table = world.objects.find((o) => o.type === 'dining_table')!;
      onHeadingTo(world, host, table, { tick: world.tick, day: 1, hour: 13, minute: 0, phase: 'day', daylight: 1 });
      if (invitationsOf(world).length === 0) continue;
      const def = world.objectDefs.dining_table;
      const friend = world.agents.find((o) => o !== host && world.relationships.get(o.id, host.id) >= 10)!;
      const near = (ag: Agent) => (ag.pos = { ...host.pos });
      near(friend);
      expect(socialObjectBias(world, friend, table, def, 1).add).toBeGreaterThan(0);
      expect(socialObjectBias(world, host, table, def, 1).add).toBe(0);
      // a rival of the host ignores it
      const rival = world.agents.find((o) => o !== host && o !== friend)!;
      near(rival);
      for (let i = 0; i < 4; i++) recordQuarrel(world, rival.id, host.id, 'Kłótnia');
      expect(socialObjectBias(world, rival, table, def, 1).add).toBe(0);
      return;
    }
    throw new Error('no invitation in 40 seeds');
  });
});
