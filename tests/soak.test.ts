import { beforeAll, describe, expect, it } from 'vitest';
import { runMetrics, type AgentMetrics, type RunMetrics } from './tools/metrics';
import { NARRATION_PER_HOUR } from '../src/agents/narration';

// A week of headless life for several seeds. Inspect failures with
// `DAYS=7 SEED=1,2,3,4 npx vitest run tests/tools/diag.test.ts` -> test-results/diag.txt

const DAYS = 7;
/** SOAK_SEEDS=1,2,…,20 to explore more seeds */
const SEEDS = process.env.SOAK_SEEDS ? process.env.SOAK_SEEDS.split(',').map(Number) : [1, 2, 3, 4, 5, 6];
const MIN_CONVERSATIONS = 3;
const MIN_DISTINCT_ACTIVITIES = 6;
/** consecutive ticks with some need at <= 1 */
const MAX_LOW_STREAK = 60;
/** consecutive ticks standing still while not using anything or talking */
const MAX_STUCK = 120;
const MIN_NIGHT_SLEEP_SHARE = 0.8;

const QUIET = ['bookshelf', 'fishing_spot', 'computer', 'piano', 'flowerbed'];
const EXERCISE = ['exercise_bike', 'treadmill'];

let runs: RunMetrics[] = [];

const allAgents = (): AgentMetrics[] => runs.flatMap((r) => r.agents);
const awakeTicks = (a: AgentMetrics): number =>
  Object.entries(a.activityTicks).reduce((s, [k, v]) => (k === 'bed' ? s : s + v), 0);
const share = (a: AgentMetrics, keys: string[]): number => keys.reduce((s, k) => s + (a.activityTicks[k] ?? 0), 0) / awakeTicks(a);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const label = (r: RunMetrics, a: AgentMetrics): string => `seed ${r.seed} ${a.name}`;

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
    expect(mean(active.map((a) => share(a, EXERCISE)))).toBeGreaterThan(mean(lazy.map((a) => share(a, EXERCISE))) + 0.01);
  });

  it('tells a few stories without flooding the log', () => {
    for (const r of runs) {
      expect(r.maxEventsPerHour, `seed ${r.seed}`).toBeLessThanOrEqual(NARRATION_PER_HOUR);
      const stories = Object.entries(r.eventCounts)
        .filter(([k]) => !['conversation', 'relationship', 'idzie spać', 'wstaje z łóżka'].includes(k))
        .reduce((s, [, v]) => s + v, 0);
      expect(stories, `seed ${r.seed}`).toBeGreaterThanOrEqual(5);
    }
  });
});
