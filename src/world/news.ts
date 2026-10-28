import type { Agent, World } from '../types';

// TV news: real headlines (via the dev-server proxy) or news from the residents' own life.
// Wave 7 stub — implemented by the news task (see plan/TASKS.md).

export interface NewsItem {
  /** short Polish headline */
  title: string;
  /** e.g. "PAP", "Osiedle" */
  source: string;
  /** true for headlines from the real world, false for in-simulation news */
  real: boolean;
}

/** called once per tick */
export function tickNews(_world: World): void {}

/** what the TV shows right now (null when nothing to show) */
export function currentHeadline(_world: World): NewsItem | null {
  return null;
}

/** headlines this agent saw recently and might bring up in a chat (newest first, max 3) */
export function newsFor(_world: World, _agent: Agent): string[] {
  return [];
}
