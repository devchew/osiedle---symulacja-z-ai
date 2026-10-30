// Headless behaviour metrics shared by the soak test and the diag tool.
import { createWorld, tickWorld } from '../../src/world/world';
import { NEED_KEYS } from '../../src/types';
import type { Agent, NeedKey, Traits, World } from '../../src/types';
import { setCalendar, timeOf } from '../../src/core/calendar';
import { isAgentSleeping } from '../../src/agents/actions';
import { goalHistory, type GoalRecord } from '../../src/agents/goals';
import { gatheringTotals, type GatheringKind } from '../../src/agents/groups';
import { jointLog, type JointRecord } from '../../src/agents/joint';
import { REL_TUNING, chemistry, relationStats, statusOf as relationStatus, type RelationStatus } from '../../src/social/relationships';

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
  /** ticks still walking to an object or a partner at the end of the tick (trips longer than a game minute) */
  tripTicks: number;
  /** tiles walked (any reason) */
  tilesWalked: number;
  /** idle ticks ("Rozgląda się", waiting for rain to stop…) */
  idleTicks: number;
  /** minute of day (0..1439, may exceed 1440 past midnight) of each night-time going to bed (19:00–04:00) */
  bedtimes: number[];
  /** minute of day of each morning getting up (04:00–11:00) */
  wakeTimes: number[];
  /** ticks spent walking to a bed */
  bedWalkTicks: number;
  /** distinct beds slept in */
  bedsUsed: number;
  /** ticks using garden (outdoor) objects between 22:00 and 06:00 */
  gardenNightTicks: number;
  /** ticks spent eating (food objects) per hour of day */
  eatingByHour: number[];
  /** daily goals, one per goal day (06:00–06:00) */
  goals: GoalRecord[];
}

export interface RunMetrics {
  seed: number;
  days: number;
  agents: AgentMetrics[];
  doubleBookings: number;
  /** max number of narration events (excluding conversations, sleep and daily goals) in any single game hour */
  maxEventsPerHour: number;
  /** max number of "cel dnia wykonany" events in any single game hour */
  maxGoalEventsPerHour: number;
  /** max number of all story events (narration + goals) in any single game hour */
  maxStoriesPerHour: number;
  /** max number of gathering events ("Wspólny grill: …") in any single game hour */
  maxGatheringsPerHour: number;
  /** gatherings logged during the run, per kind */
  gatherings: Record<GatheringKind, number>;
  /** joint activities (agents/joint.ts) that took place: console, card table, fishing together */
  joint: JointRecord[];
  /** joint sessions called off (nobody came, rain…) */
  jointCalledOff: number;
  /** max number of joint activity log lines in any single game hour */
  maxJointPerHour: number;
  /** pair statuses at the end of the run */
  statuses: Record<RelationStatus, number>;
  /** distinct pairs that were a couple / rivals-or-enemies at some point (sampled hourly) */
  everCouples: number;
  everRivals: number;
  /** distinct pairs that had a crush or were a couple at some point */
  everRomance: number;
  /** pairs with chemistry ≥ CHEMISTRY_MIN */
  compatiblePairs: number;
  /** relationship status events ("… są parą", "… zostają rywalami") */
  statusEvents: string[];
  eventCounts: Record<string, number>;
  /** fingerprint for determinism checks */
  fingerprint: string;
  world: World;
}

/** log lines of group activities (agents/groups.ts) */
export const GATHERING_RE = /^(Wspólny|Wspólne|Wspólna|Wieczór filmowy)/;
/** evening TV gatherings */
export const MOVIE_NIGHT_RE = /^Wieczór filmowy/;
/** log lines of joint activities (agents/joint.ts): "Wspólne granie (…)", "Wspólna gra (…)", "Wspólne wędkowanie …" */
export const JOINT_RE = /^(Wspólne granie|Wspólna gra|Wspólne wędkowanie)/;

function pairsOf(world: World): [number, number][] {
  const ids = world.agents.map((a) => a.id);
  const out: [number, number][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return out;
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
  // SOAK_DATE=2026-12-21 runs the week in another season (the date of day 1)
  if (process.env.SOAK_DATE) setCalendar(world, Math.round(Date.parse(process.env.SOAK_DATE) / 86_400_000));
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
    tripTicks: 0,
    tilesWalked: 0,
    idleTicks: 0,
    bedtimes: [],
    wakeTimes: [],
    bedWalkTicks: 0,
    bedsUsed: 0,
    gardenNightTicks: 0,
    eatingByHour: new Array(24).fill(0),
    goals: [],
  }));
  const lowStreak = new Array(world.agents.length).fill(0);
  const stuck = new Array(world.agents.length).fill(0);
  const prevPhase: string[] = world.agents.map(() => 'none');
  const wasSleeping: boolean[] = world.agents.map(() => false);
  const beds = world.agents.map(() => new Set<number>());
  let doubleBookings = 0;
  const eventsPerHour = new Map<number, number>();
  const goalsPerHour = new Map<number, number>();
  const storiesPerHour = new Map<number, number>();
  const gatheringsPerHour = new Map<number, number>();
  const jointPerHour = new Map<number, number>();
  const everCouples = new Set<string>();
  const everRivals = new Set<string>();
  const everRomance = new Set<string>();
  const statusEvents: string[] = [];
  const eventCounts: Record<string, number> = {};
  let lastEventTick = -1;

  for (let i = 0; i < ticks; i++) {
    tickWorld(world);
    const time = timeOf(world);
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
      m.tilesWalked += Math.hypot(agent.pos.x - agent.prevPos.x, agent.pos.y - agent.prevPos.y);
      if (phase === 'walking' || phase === 'approaching') {
        m.walkTicks++;
        if (!moved) m.waitTicks++;
        if (key === 'wander') m.wanderTicks++;
        else m.tripTicks++;
      }
      if (agent.action?.kind === 'idle') m.idleTicks++;
      const asleep = isAgentSleeping(world, agent);
      const mod = time.hour * 60 + time.minute;
      if (asleep && !wasSleeping[idx] && (time.hour >= 19 || time.hour < 4)) m.bedtimes.push(time.hour < 12 ? mod + 1440 : mod);
      if (!asleep && wasSleeping[idx] && time.hour >= 4 && time.hour < 11) m.wakeTimes.push(mod);
      wasSleeping[idx] = asleep;
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
        if (e.kind === 'relationship' && /parą|rywal|znieść|rozstają|ku sobie|topór/.test(e.text)) statusEvents.push(e.text);
        if (e.kind === 'conversation' || e.kind === 'relationship' || /spać|wstaje/.test(e.text)) continue;
        const h = Math.floor(world.tick / 60);
        // world incidents (weather, breakdowns, repairs; src/world/incidents.ts) have their own budget
        if (e.agentIds.length === 0 || /🔧|🧰/.test(e.text)) continue;
        // estate news bulletins (world/news.ts, "📰 …") are TV, not narration
        if (e.text.startsWith('📰')) continue;
        if (JOINT_RE.test(e.text)) {
          jointPerHour.set(h, (jointPerHour.get(h) ?? 0) + 1);
          continue;
        }
        if (GATHERING_RE.test(e.text)) {
          gatheringsPerHour.set(h, (gatheringsPerHour.get(h) ?? 0) + 1);
          continue;
        }
        storiesPerHour.set(h, (storiesPerHour.get(h) ?? 0) + 1);
        const bucket = e.text.includes('cel dnia') ? goalsPerHour : eventsPerHour;
        bucket.set(h, (bucket.get(h) ?? 0) + 1);
      }
      lastEventTick = world.events[world.events.length - 1].tick;
    }
    if (world.tick % 60 === 0) {
      for (const [x, y] of pairsOf(world)) {
        const st = relationStatus(world, x, y);
        if (st === 'couple') everCouples.add(`${x}:${y}`);
        if (st === 'couple' || st === 'crush') everRomance.add(`${x}:${y}`);
        if (st === 'rivals' || st === 'enemies') everRivals.add(`${x}:${y}`);
      }
    }
  }
  let compatiblePairs = 0;
  for (const [x, y] of pairsOf(world)) if (chemistry(world, x, y) >= REL_TUNING.CHEMISTRY_MIN) compatiblePairs++;

  world.agents.forEach((agent, idx) => {
    ms[idx].conversations = agent.stats.conversations;
    ms[idx].distinctActivities = Object.keys(ms[idx].activityTicks).length;
    ms[idx].bedsUsed = beds[idx].size;
    ms[idx].goals = [...goalHistory(agent)];
  });

  return {
    seed,
    days,
    agents: ms,
    doubleBookings,
    maxEventsPerHour: Math.max(0, ...eventsPerHour.values()),
    maxGoalEventsPerHour: Math.max(0, ...goalsPerHour.values()),
    maxStoriesPerHour: Math.max(0, ...storiesPerHour.values()),
    maxGatheringsPerHour: Math.max(0, ...gatheringsPerHour.values()),
    maxJointPerHour: Math.max(0, ...jointPerHour.values()),
    gatherings: gatheringTotals(world),
    joint: jointLog(world).filter((r) => r.happened),
    jointCalledOff: jointLog(world).filter((r) => !r.happened).length,
    statuses: relationStats(world),
    everCouples: everCouples.size,
    everRivals: everRivals.size,
    everRomance: everRomance.size,
    compatiblePairs,
    statusEvents,
    eventCounts,
    fingerprint: JSON.stringify([world.rng.state(), world.agents.map((a) => [a.pos, a.needs, a.stats])]),
    world,
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const hhmm = (m: number) => `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;

/** run-wide averages: share of awake time per kind of doing, mean bedtime / wake-up */
export function summary(m: RunMetrics): string {
  let act = 0, walk = 0, wander = 0, idle = 0, sleep = 0, tiles = 0;
  const beds: number[] = [];
  const ups: number[] = [];
  for (const a of m.agents) {
    sleep += a.sleepTicks;
    act += Object.entries(a.activityTicks).filter(([k]) => k !== 'bed').reduce((s, [, v]) => s + v, 0);
    walk += a.tripTicks;
    wander += a.wanderTicks;
    idle += a.idleTicks;
    tiles += a.tilesWalked;
    beds.push(...a.bedtimes);
    ups.push(...a.wakeTimes);
  }
  const total = m.agents.length * m.days * 1440;
  const awake = total - sleep;
  const pct = (v: number) => `${Math.round((100 * v) / awake)}%`;
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : 0);
  const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);
  const b = sorted(beds);
  return (
    `awake: activities ${pct(act)}, trips ${pct(walk)}, strolls ${pct(wander)}, idle ${pct(idle)}; sleep ${Math.round(sleep / (m.agents.length * m.days) / 6) / 10} h/day; ` +
    `tiles/day ${Math.round(tiles / m.agents.length / m.days)}; bed mean ${hhmm(mean(beds))} (${b.length ? `${hhmm(b[0])}–${hhmm(b[b.length - 1])}` : '-'}), up mean ${hhmm(mean(ups))}; ` +
    `joint ${m.joint.length} (avg ${Math.round(m.joint.reduce((s, r) => s + r.minutes, 0) / Math.max(1, m.joint.length))} min)`
  );
}

/** compact human-readable summary */
export function formatMetrics(m: RunMetrics): string {
  const out: string[] = [
    `seed ${m.seed}, ${m.days} days, doubleBookings=${m.doubleBookings}, maxEventsPerHour=${m.maxEventsPerHour} goals/h=${m.maxGoalEventsPerHour} stories/h=${m.maxStoriesPerHour}`,
    summary(m),
  ];
  for (const a of m.agents) {
    const t = a.traits;
    const top = Object.entries(a.activityTicks)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}:${v}/${a.activityStarts[k] ?? 0}`)
      .join(' ');
    out.push(
      `${a.name.padEnd(7)} soc=${r1(t.sociability)} act=${r1(t.activity)} neat=${r1(t.neatness)} conv=${a.conversations} distinct=${a.distinctActivities} ` +
        `lowStreak=${a.maxLowStreak}${a.lowStreakNeed ? `(${a.lowStreakNeed})` : ''} stuck=${a.maxStuck} sleepNight=${a.sleepTicks ? Math.round((100 * a.sleepNightTicks) / a.sleepTicks) : 0}% ` +
        `walk=${a.walkTicks} wait=${a.waitTicks} wander=${a.wanderTicks} trip=${a.tripTicks} tiles=${Math.round(a.tilesWalked)} idle=${a.idleTicks} bedWalk=${a.bedWalkTicks} beds=${a.bedsUsed} gardenNight=${a.gardenNightTicks}`,
        `        bed ${a.bedtimes.map(hhmm).join(' ')} | up ${a.wakeTimes.map(hhmm).join(' ')}`,
    );
    out.push(`        ${top}`);
    out.push(`        goals: ${a.goals.map((g) => `${g.kind}${g.done ? '✓' : g.open ? '…' : '✗'}`).join(' ')}`);
  }
  const eat = new Array(24).fill(0);
  for (const a of m.agents) a.eatingByHour.forEach((v, h) => (eat[h] += v));
  out.push(`eating by hour: ${eat.map((v, h) => `${h}:${v}`).join(' ')}`);
  out.push(`gatherings: ${JSON.stringify(m.gatherings)} max/h=${m.maxGatheringsPerHour}`);
  const jm = m.joint.reduce((s, r) => s + r.minutes, 0) / Math.max(1, m.joint.length);
  out.push(`joint: ${m.joint.length} sessions (${m.jointCalledOff} called off), avg ${Math.round(jm)} min; ${m.joint.map((r) => `${r.kind}/${r.game}×${r.ids.length} ${r.minutes}m`).join(', ')}`);
  out.push(`statuses: ${JSON.stringify(Object.fromEntries(Object.entries(m.statuses).filter(([, v]) => v > 0)))} everCouples=${m.everCouples} everRivals=${m.everRivals} everRomance=${m.everRomance} compatible=${m.compatiblePairs}`);
  out.push(`status events: ${m.statusEvents.join(' | ')}`);
  out.push(`events: ${JSON.stringify(m.eventCounts)}`);
  return out.join('\n');
}
