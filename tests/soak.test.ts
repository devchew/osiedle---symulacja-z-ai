import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runMetrics, type AgentMetrics, type RunMetrics } from './tools/metrics';
import { GATHERING_RE } from './tools/metrics';
import { NARRATION_PER_HOUR } from '../src/agents/narration';
import { GOAL_KINDS, QUIET_GOALS, type GoalRecord } from '../src/agents/goals';

// A week of headless life for several seeds. Inspect failures with
// `DAYS=7 SEED=1,2,3,4 npx vitest run tests/tools/diag.test.ts` -> test-results/diag.txt

const DAYS = 7;
/** SOAK_SEEDS=1,2,…,20 to explore more seeds */
const SEEDS = process.env.SOAK_SEEDS ? process.env.SOAK_SEEDS.split(',').map(Number) : [1, 2, 3, 4, 5, 6, 11];
const MIN_CONVERSATIONS = 3;
const MIN_DISTINCT_ACTIVITIES = 6;
/** consecutive ticks with some need at <= 1 */
const MAX_LOW_STREAK = 60;
/** consecutive ticks standing still while not using anything or talking */
const MAX_STUCK = 120;
const MIN_NIGHT_SLEEP_SHARE = 0.8;

/** share of agent-days whose goal of the day gets done (mean over seeds / worst seed) */
const MIN_GOAL_RATE = 0.6;
const MIN_GOAL_RATE_SEED = 0.45;
/** goal completions are a separate log channel (≤ 1 per agent per day) on top of narration */
const MAX_GOAL_EVENTS_PER_HOUR = 4;
const MAX_STORIES_PER_HOUR = NARRATION_PER_HOUR + 2;

/** group activities (agents/groups.ts) per seed-week, and how many may land in one game hour */
const MIN_GATHERINGS_PER_WEEK = 8;
const MAX_GATHERINGS_PER_HOUR = 3;
/** pair statuses at the end of a week, per world of 6 */
const MAX_COUPLES = 2;
const MAX_RIVAL_PAIRS = 4;

/** joint activities (agents/joint.ts): on average one per resident every two days or more (a quiet house a bit less), long ones */
const MIN_JOINT_PER_RESIDENT_DAY = 0.6;
const MIN_JOINT_PER_RESIDENT_DAY_SEED = 0.4;
/** a loner may skip them for a week, but not most of the house */
const MAX_RESIDENTS_WITHOUT_JOINT = 1;
const MIN_JOINT_AVG_MINUTES = 60;
/** joint activity log lines (their own channel next to gatherings) in any single game hour */
const MAX_JOINT_PER_HOUR = 3;

const QUIET = ['bookshelf', 'fishing_spot', 'computer', 'piano', 'flowerbed'];
const EXERCISE = ['exercise_bike', 'treadmill'];

let runs: RunMetrics[] = [];

const allAgents = (): AgentMetrics[] => runs.flatMap((r) => r.agents);
const awakeTicks = (a: AgentMetrics): number =>
  Object.entries(a.activityTicks).reduce((s, [k, v]) => (k === 'bed' ? s : s + v), 0);
const share = (a: AgentMetrics, keys: string[]): number => keys.reduce((s, k) => s + (a.activityTicks[k] ?? 0), 0) / awakeTicks(a);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const label = (r: RunMetrics, a: AgentMetrics): string => `seed ${r.seed} ${a.name}`;
/** goals whose day is over (the last one may still be running when the run ends) */
const closedGoals = (a: AgentMetrics): GoalRecord[] => a.goals.filter((g) => !g.open);
const goalRate = (r: RunMetrics): number => {
  const gs = r.agents.flatMap(closedGoals);
  return gs.filter((g) => g.done).length / gs.length;
};

describe('soak: a week in the house', () => {
  beforeAll(() => {
    runs = SEEDS.map((seed) => runMetrics(seed, DAYS));
  });

  it('is deterministic for a seed', () => {
    expect(runMetrics(SEEDS[0], 2).fingerprint).toBe(runMetrics(SEEDS[0], 2).fingerprint);
  });

  it('never double-books an object slot', () => {
    for (const r of runs) expect(r.doubleBookings, `seed ${r.seed}`).toBe(0);
  });

  it('keeps every need away from zero', () => {
    for (const r of runs)
      for (const a of r.agents) expect(a.maxLowStreak, `${label(r, a)} (${a.lowStreakNeed})`).toBeLessThanOrEqual(MAX_LOW_STREAK);
  });

  it('nobody gets stuck', () => {
    for (const r of runs) for (const a of r.agents) expect(a.maxStuck, label(r, a)).toBeLessThanOrEqual(MAX_STUCK);
  });

  it('everyone talks and does varied things', () => {
    for (const r of runs)
      for (const a of r.agents) {
        expect(a.conversations, label(r, a)).toBeGreaterThanOrEqual(MIN_CONVERSATIONS);
        expect(a.distinctActivities, label(r, a)).toBeGreaterThanOrEqual(MIN_DISTINCT_ACTIVITIES);
      }
  });

  it('sleeps mostly at night, in their own bed', () => {
    for (const r of runs)
      for (const a of r.agents) {
        expect(a.sleepTicks, label(r, a)).toBeGreaterThan(DAYS * 6 * 60);
        expect(a.sleepNightTicks / a.sleepTicks, label(r, a)).toBeGreaterThanOrEqual(MIN_NIGHT_SLEEP_SHARE);
        expect(a.bedsUsed, label(r, a)).toBe(1);
      }
  });

  it('eats around meal times and keeps the garden for daytime', () => {
    const eat = new Array<number>(24).fill(0);
    for (const a of allAgents()) a.eatingByHour.forEach((v, h) => (eat[h] += v));
    const total = eat.reduce((s, v) => s + v, 0);
    const meals = [7, 8, 9, 12, 13, 14, 18, 19, 20].reduce((s, h) => s + eat[h], 0);
    expect(meals / total).toBeGreaterThan(0.75);
    for (const a of allAgents()) expect(a.gardenNightTicks, a.name).toBeLessThanOrEqual(60);
  });

  it('personality shows in what people do', () => {
    const agents = allAgents();
    const extro = agents.filter((a) => a.traits.sociability > 0.3);
    const intro = agents.filter((a) => a.traits.sociability < -0.3);
    const active = agents.filter((a) => a.traits.activity > 0.3);
    const lazy = agents.filter((a) => a.traits.activity < -0.3);
    for (const g of [extro, intro, active, lazy]) expect(g.length).toBeGreaterThan(2);
    expect(mean(extro.map((a) => a.conversations))).toBeGreaterThan(mean(intro.map((a) => a.conversations)) * 1.2);
    expect(mean(intro.map((a) => share(a, QUIET)))).toBeGreaterThan(mean(extro.map((a) => share(a, QUIET))) * 2);
    // exercise is a small slice of the day; since walking became (almost) free (wave 10) the awake
    // activity time is ~40% larger, so absolute shares shrink: compare relatively, with a small margin
    const exActive = mean(active.map((a) => share(a, EXERCISE)));
    const exLazy = mean(lazy.map((a) => share(a, EXERCISE)));
    expect(exActive).toBeGreaterThan(exLazy * 2);
    expect(exActive).toBeGreaterThan(exLazy + 0.005);
  });

  it('residents pick a goal every day and mostly reach it', () => {
    for (const r of runs)
      for (const a of r.agents) {
        expect(a.goals.length, label(r, a)).toBeGreaterThanOrEqual(DAYS);
        expect(new Set(a.goals.map((g) => g.day)).size, label(r, a)).toBe(a.goals.length);
      }
    const rates = runs.map(goalRate);
    for (const [i, rate] of rates.entries()) expect(rate, `seed ${runs[i].seed}`).toBeGreaterThanOrEqual(MIN_GOAL_RATE_SEED);
    expect(mean(rates)).toBeGreaterThanOrEqual(MIN_GOAL_RATE);
    // goals are varied across the house
    const kinds = new Set(allAgents().flatMap((a) => a.goals.map((g) => g.kind)));
    expect(kinds.size).toBeGreaterThanOrEqual(GOAL_KINDS.length - 2);
  });

  it('goal choice follows personality', () => {
    const agents = allAgents();
    const quietShare = (as: AgentMetrics[]): number => {
      const gs = as.flatMap((a) => a.goals);
      return gs.filter((g) => QUIET_GOALS.includes(g.kind)).length / gs.length;
    };
    const exerciseShare = (as: AgentMetrics[]): number => {
      const gs = as.flatMap((a) => a.goals);
      return gs.filter((g) => g.kind === 'exercise').length / gs.length;
    };
    const intro = agents.filter((a) => a.traits.sociability < -0.3);
    const extro = agents.filter((a) => a.traits.sociability > 0.3);
    expect(quietShare(intro)).toBeGreaterThan(quietShare(extro) * 1.5);
    const active = agents.filter((a) => a.traits.activity > 0.3);
    const lazy = agents.filter((a) => a.traits.activity < -0.3);
    expect(exerciseShare(active)).toBeGreaterThan(exerciseShare(lazy));
  });

  it('tells a few stories without flooding the log', () => {
    for (const r of runs) {
      expect(r.maxEventsPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(NARRATION_PER_HOUR);
      expect(r.maxGoalEventsPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_GOAL_EVENTS_PER_HOUR);
      expect(r.maxStoriesPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_STORIES_PER_HOUR);
      const stories = Object.entries(r.eventCounts)
        .filter(([k]) => !['conversation', 'relationship', 'idzie spać', 'wstaje z łóżka'].includes(k))
        .reduce((s, [, v]) => s + v, 0);
      expect(stories, `seed ${r.seed}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('residents get together: shared meals, grills, now and then a movie night', () => {
    for (const r of runs) {
      const g = r.gatherings;
      expect(g.meal + g.grill + g.movie, `seed ${r.seed}`).toBeGreaterThanOrEqual(MIN_GATHERINGS_PER_WEEK);
      expect(g.meal, `seed ${r.seed}`).toBeGreaterThan(0);
      expect(g.grill, `seed ${r.seed}`).toBeGreaterThan(0);
      expect(r.maxGatheringsPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_GATHERINGS_PER_HOUR);
    }
    // an evening together at the TV: a movie night or a group console session (the console shares the TV)
    const eveningAtTv = (r: (typeof runs)[number]) =>
      r.gatherings.movie > 0 || r.joint.some((j) => j.kind === 'console' && j.ids.length >= 2 && (j.start + 420) % 1440 >= 17 * 60);
    expect(runs.some(eveningAtTv)).toBe(true);
  });

  it('relationships take shape: a few couples and rivals, mostly friendly', () => {
    const withRomance = runs.filter((r) => r.everRomance > 0).length;
    // romance is rare: some worlds, not all
    expect(withRomance).toBeGreaterThan(0);
    expect(runs.filter((r) => r.everCouples > 0).length).toBeLessThan(runs.length);
    expect(runs.some((r) => r.everRivals > 0)).toBe(true);
    for (const r of runs) {
      const s = r.statuses;
      expect(s.couple, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_COUPLES);
      expect(s.couple + s.crush, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_COUPLES + 1);
      expect(s.rivals + s.enemies, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_RIVAL_PAIRS);
      // the house stays friendly overall (introverted houses have many mere acquaintances)
      const warm = s.pals + s.friends + s.best_friends + s.couple + s.crush;
      const cold = s.cool + s.dislike + s.rivals + s.enemies;
      expect(warm, `seed ${r.seed}`).toBeGreaterThanOrEqual(3);
      expect(warm, `seed ${r.seed}`).toBeGreaterThan(cold);
      // status changes are rare news, not noise
      expect(r.statusEvents.length, `seed ${r.seed}`).toBeLessThanOrEqual(8);
    }
  });

  it('relationship and gathering texts are Polish without gendered past tense', () => {
    const texts = runs.flatMap((r) => [...r.statusEvents, ...r.world.events.filter((e) => GATHERING_RE.test(e.text)).map((e) => e.text)]);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t, t).not.toMatch(/\p{L}+(ł|ła|ło|li|ły)\b/u);
  });

  it('residents do long things together: console, cards, fishing side by side', () => {
    const rows: string[] = ['seed | sessions | called off | per resident/day | min per resident | avg min | console/board/fishing | players/session'];
    const checks: (() => void)[] = [];
    const perDays: number[] = [];
    for (const r of runs) {
      const per = new Map<number, number>(r.agents.map((a) => [a.id, 0]));
      for (const j of r.joint) for (const id of j.ids) per.set(id, (per.get(id) ?? 0) + 1);
      const counts = [...per.values()];
      const perDay = counts.reduce((s, n) => s + n, 0) / counts.length / DAYS;
      const avgMin = mean(r.joint.map((j) => j.minutes));
      const by = (k: string) => r.joint.filter((j) => j.kind === k).length;
      rows.push(
        `${r.seed} | ${r.joint.length} | ${r.jointCalledOff} | ${perDay.toFixed(2)} | ${Math.min(...counts)} | ${avgMin.toFixed(0)} | ${by('console')}/${by('boardgame')}/${by('fishing')} | ${mean(r.joint.map((j) => j.ids.length)).toFixed(1)}`,
      );
      perDays.push(perDay);
      checks.push(() => {
        expect(perDay, `seed ${r.seed}`).toBeGreaterThanOrEqual(MIN_JOINT_PER_RESIDENT_DAY_SEED);
        expect(counts.filter((n) => n === 0).length, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_RESIDENTS_WITHOUT_JOINT);
        expect(avgMin, `seed ${r.seed}`).toBeGreaterThanOrEqual(MIN_JOINT_AVG_MINUTES);
        for (const j of r.joint) expect(j.ids.length, `seed ${r.seed} ${j.text}`).toBeGreaterThanOrEqual(2);
        expect(r.maxJointPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(MAX_JOINT_PER_HOUR);
      });
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/soak-joint.txt', rows.join('\n') + '\n');
    for (const c of checks) c();
    expect(mean(perDays)).toBeGreaterThanOrEqual(MIN_JOINT_PER_RESIDENT_DAY);
  });

  it('joint activities follow personality: quiet ones for introverts, a crowded console for extroverts', () => {
    const agents = allAgents();
    const intro = agents.filter((a) => a.traits.sociability < -0.3);
    const extro = agents.filter((a) => a.traits.sociability > 0.3);
    const sessionsOf = (a: AgentMetrics) => runs.find((r) => r.agents.includes(a))!.joint.filter((j) => j.ids.includes(a.id));
    const quietShare = (as: AgentMetrics[]) => {
      const js = as.flatMap(sessionsOf);
      return js.filter((j) => j.kind !== 'console').length / Math.max(1, js.length);
    };
    // the size of the group someone gathers: extroverts call more people
    const hostedSize = (as: AgentMetrics[]) => mean(runs.flatMap((r) => r.joint.filter((j) => as.some((a) => a.id === j.hostId && r.agents.includes(a)))).map((j) => j.ids.length));
    expect(quietShare(intro)).toBeGreaterThan(quietShare(extro));
    expect(hostedSize(extro)).toBeGreaterThan(hostedSize(intro));
    const consoleSize = mean(runs.flatMap((r) => r.joint.filter((j) => j.kind === 'console').map((j) => j.ids.length)));
    const quietSize = mean(runs.flatMap((r) => r.joint.filter((j) => j.kind !== 'console').map((j) => j.ids.length)));
    expect(consoleSize).toBeGreaterThan(quietSize);
  });

  it('joint activity log lines are Polish without gendered past tense', () => {
    const texts = runs.flatMap((r) => r.joint.map((j) => j.text));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t, t).toMatch(/^Wspóln[aey] /);
      expect(t, t).not.toMatch(/\p{L}+(ł|ła|ło|li|ły)\b/u);
    }
  });
});
