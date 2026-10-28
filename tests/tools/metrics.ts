// Headless behaviour metrics shared by the soak test and the diag tool.
import { createWorld, tickWorld } from '../../src/world/world';
import { NEED_KEYS } from '../../src/types';
import type { Agent, NeedKey, Traits, World } from '../../src/types';
import { timeFromTick } from '../../src/core/time';

export interface AgentMetrics {
  id: number;
  name: string;
  traits: Traits;
  conversations: number;
  /** ticks spent per activity ("use" phase of an object type, or "talk") */
  activityTicks: Record<string, number>;
  /** number of times each activity was started (counted on entering the using/talking phase) */
  activityStarts: Record<string, number>;
  distinctActivities: number;
  /** longest run of consecutive ticks with some need <= 1 */
  maxLowStreak: number;
  lowStreakNeed: NeedKey | null;
  /** longest run of ticks without moving while not using an object or talking */
  maxStuck: number;
  sleepTicks: number;
  /** sleeping ticks between 20:00 and 09:00 */
  sleepNightTicks: number;
  walkTicks: number;
  /** walking ticks without moving (waiting for someone in the way) */
  waitTicks: number;
  /** walking ticks spent strolling (wander) */
  wanderTicks: number;
  /** ticks spent walking to a bed */
  bedWalkTicks: number;
  /** distinct beds slept in */
  bedsUsed: number;
  /** ticks using garden (outdoor) objects between 22:00 and 06:00 */
  gardenNightTicks: number;
  /** ticks spent eating (food objects) per hour of day */
  eatingByHour: number[];
}

export interface RunMetrics {
  seed: number;
  days: number;
  agents: AgentMetrics[];
  doubleBookings: number;
  /** max number of events (excluding conversations and sleep) in any single game hour */
  maxEventsPerHour: number;
  eventCounts: Record<string, number>;
  /** fingerprint for determinism checks */
  fingerprint: string;
  world: World;
}

function activityOf(world: World, agent: Agent): { key: string | null; phase: string } {
  const a = agent.action;
  if (!a) return { key: null, phase: 'none' };
  if (a.kind === 'use') {
    const obj = world.objects.find((o) => o.uid === a.objectUid);
    return { key: obj ? obj.type : null, phase: a.phase };
  }
  if (a.kind === 'talk') return { key: 'talk', phase: a.phase };
  return { key: a.kind, phase: 'phase' in a ? a.phase : 'idle' };
}

export function runMetrics(seed: number, days: number, agentCount = 6): RunMetrics {
  const world = createWorld(seed, { agentCount });
  const ticks = days * 24 * 60;
  const ms: AgentMetrics[] = world.agents.map((a) => ({
    id: a.id,
    name: a.name,
    traits: { ...a.traits },
    conversations: 0,
    activityTicks: {},
    activityStarts: {},
    distinctActivities: 0,
    maxLowStreak: 0,
    lowStreakNeed: null,
    maxStuck: 0,
    sleepTicks: 0,
    sleepNightTicks: 0,
    walkTicks: 0,
    waitTicks: 0,
    wanderTicks: 0,
    bedWalkTicks: 0,
    bedsUsed: 0,
    gardenNightTicks: 0,
    eatingByHour: new Array(24).fill(0),
  }));
  const lowStreak = new Array(world.agents.length).fill(0);
  const stuck = new Array(world.agents.length).fill(0);
  const prevPhase: string[] = world.agents.map(() => 'none');
  const beds = world.agents.map(() => new Set<number>());
  let doubleBookings = 0;
  const eventsPerHour = new Map<number, number>();
  const eventCounts: Record<string, number> = {};
  let lastEventTick = -1;

  for (let i = 0; i < ticks; i++) {
    tickWorld(world);
    const time = timeFromTick(world.tick);
    const holders = world.objects.flatMap((o) => o.reservedBy.filter((r) => r !== null));
    if (new Set(holders).size !== holders.length) doubleBookings++;

    world.agents.forEach((agent, idx) => {
      const m = ms[idx];
      const { key, phase } = activityOf(world, agent);
      const active = phase === 'using' || phase === 'talking';
      if (active && key) {
        m.activityTicks[key] = (m.activityTicks[key] ?? 0) + 1;
        if (prevPhase[idx] !== `${key}:${phase}`) m.activityStarts[key] = (m.activityStarts[key] ?? 0) + 1;
      }
      prevPhase[idx] = `${key}:${phase}`;
      const moved = agent.pos.x !== agent.prevPos.x || agent.pos.y !== agent.prevPos.y;
      if (phase === 'walking' || phase === 'approaching') {
        m.walkTicks++;
        if (!moved) m.waitTicks++;
        if (key === 'wander') m.wanderTicks++;
      }
      const a = agent.action;
      if (a?.kind === 'use') {
        const obj = world.objects.find((o) => o.uid === a.objectUid)!;
        const def = world.objectDefs[obj.type];
        const tags = def.tags ?? [];
        if (tags.includes('sleep')) {
          if (a.phase === 'walking') m.bedWalkTicks++;
          else {
            m.sleepTicks++;
            beds[idx].add(obj.uid);
            if (time.hour >= 20 || time.hour < 9) m.sleepNightTicks++;
          }
        } else if (a.phase === 'using') {
          if (tags.includes('outdoor') && (time.hour >= 22 || time.hour < 6)) m.gardenNightTicks++;
          if (tags.includes('food')) m.eatingByHour[time.hour]++;
        }
      }

      const low = NEED_KEYS.find((k) => agent.needs[k] <= 1);
      lowStreak[idx] = low ? lowStreak[idx] + 1 : 0;
      if (lowStreak[idx] > m.maxLowStreak) {
        m.maxLowStreak = lowStreak[idx];
        m.lowStreakNeed = low ?? null;
      }
      stuck[idx] = moved || active ? 0 : stuck[idx] + 1;
      m.maxStuck = Math.max(m.maxStuck, stuck[idx]);
    });

    // events are capped in world.events; count the new ones each tick
    if (world.events.length > 0 && world.events[world.events.length - 1].tick !== lastEventTick) {
      const fresh = world.events.filter((e) => e.tick === world.tick);
      for (const e of fresh) {
        const k = e.kind === 'info' || e.kind === 'use' ? e.text.replace(/^[^ :↔]+( ↔ [^ :]+)?:? ?/, '').slice(0, 24) : e.kind;
        eventCounts[k] = (eventCounts[k] ?? 0) + 1;
        if (e.kind === 'conversation' || e.kind === 'relationship' || /spać|wstaje/.test(e.text)) continue;
        const h = Math.floor(world.tick / 60);
        eventsPerHour.set(h, (eventsPerHour.get(h) ?? 0) + 1);
      }
      lastEventTick = world.events[world.events.length - 1].tick;
    }
  }

  world.agents.forEach((agent, idx) => {
    ms[idx].conversations = agent.stats.conversations;
    ms[idx].distinctActivities = Object.keys(ms[idx].activityTicks).length;
    ms[idx].bedsUsed = beds[idx].size;
  });

  return {
    seed,
    days,
    agents: ms,
    doubleBookings,
    maxEventsPerHour: Math.max(0, ...eventsPerHour.values()),
    eventCounts,
    fingerprint: JSON.stringify([world.rng.state(), world.agents.map((a) => [a.pos, a.needs, a.stats])]),
    world,
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** compact human-readable summary */
export function formatMetrics(m: RunMetrics): string {
  const out: string[] = [`seed ${m.seed}, ${m.days} days, doubleBookings=${m.doubleBookings}, maxEventsPerHour=${m.maxEventsPerHour}`];
  for (const a of m.agents) {
    const t = a.traits;
    const top = Object.entries(a.activityTicks)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}:${v}/${a.activityStarts[k] ?? 0}`)
      .join(' ');
    out.push(
      `${a.name.padEnd(7)} soc=${r1(t.sociability)} act=${r1(t.activity)} neat=${r1(t.neatness)} conv=${a.conversations} distinct=${a.distinctActivities} ` +
        `lowStreak=${a.maxLowStreak}${a.lowStreakNeed ? `(${a.lowStreakNeed})` : ''} stuck=${a.maxStuck} sleepNight=${a.sleepTicks ? Math.round((100 * a.sleepNightTicks) / a.sleepTicks) : 0}% ` +
        `walk=${a.walkTicks} wait=${a.waitTicks} wander=${a.wanderTicks} bedWalk=${a.bedWalkTicks} beds=${a.bedsUsed} gardenNight=${a.gardenNightTicks}`,
    );
    out.push(`        ${top}`);
  }
  const eat = new Array(24).fill(0);
  for (const a of m.agents) a.eatingByHour.forEach((v, h) => (eat[h] += v));
  out.push(`eating by hour: ${eat.map((v, h) => `${h}:${v}`).join(' ')}`);
  out.push(`events: ${JSON.stringify(m.eventCounts)}`);
  return out.join('\n');
}
