import type { SimControls, World } from '../types';
import type { Loop } from '../core/loop';

// Real-time mode: the game clock follows the local clock and the weather follows real weather.
// Wave 7 stub — implemented by the real-time task (see plan/TASKS.md).

export interface RealtimeOptions {
  world: World;
  loop: Loop;
  controls: SimControls;
  /** advances the simulation by one tick (also records UI history) */
  step(): void;
  /** where to mount UI hints (e.g. location prompt) */
  parent: HTMLElement;
}

/** switches the running simulation into real-time mode; resolves once synced */
export async function startRealtime(_opts: RealtimeOptions): Promise<void> {}
