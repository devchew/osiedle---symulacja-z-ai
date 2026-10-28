import type { Agent, Needs, Rng, Traits, Vec2 } from '../types';
import { NEED_KEYS } from '../types';
import { computeMood } from './needs';

export const AGENT_NAMES: readonly string[] = [
  'Ania', 'Bartek', 'Kasia', 'Tomek', 'Zosia', 'Kuba', 'Ola', 'Marek',
  'Magda', 'Piotr', 'Ewa', 'Janek', 'Basia', 'Wojtek', 'Ula', 'Staś',
];

const PALETTE: readonly string[] = [
  '#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f', '#9b5de5', '#f15bb5',
  '#00bbf9', '#e9c46a', '#2a9d8f', '#ff8c61', '#6a994e', '#c77dff',
];

/** random trait in [-1, 1], pushed away from 0 so characters feel distinct */
function trait(rng: Rng): number {
  const v = rng.range(-1, 1);
  return Math.sign(v) * Math.sqrt(Math.abs(v));
}

export function createAgent(id: number, name: string, pos: Vec2, rng: Rng): Agent {
  const traits: Traits = {
    sociability: trait(rng),
    activity: trait(rng),
    neatness: trait(rng),
    cheerfulness: trait(rng),
  };
  const needs = {} as Needs;
  for (const k of NEED_KEYS) needs[k] = rng.range(55, 90);
  return {
    id,
    name,
    color: PALETTE[((id % PALETTE.length) + PALETTE.length) % PALETTE.length],
    traits,
    needs,
    mood: computeMood(needs, traits),
    pos: { x: pos.x, y: pos.y },
    prevPos: { x: pos.x, y: pos.y },
    facing: 1,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
  };
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** ids 0..count-1; unique names (suffixed if count exceeds AGENT_NAMES); distinct spawns while enough exist */
export function createAgents(count: number, spawnPoints: readonly Vec2[], rng: Rng): Agent[] {
  if (count > 0 && spawnPoints.length === 0) throw new Error('createAgents: no spawn points');
  const names = shuffled(AGENT_NAMES, rng);
  const spawns = shuffled(spawnPoints, rng);
  const agents: Agent[] = [];
  for (let i = 0; i < count; i++) {
    const round = Math.floor(i / names.length);
    const name = names[i % names.length] + (round > 0 ? ` ${round + 1}` : '');
    agents.push(createAgent(i, name, spawns[i % spawns.length], rng));
  }
  return agents;
}
