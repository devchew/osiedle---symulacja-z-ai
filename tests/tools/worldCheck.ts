import type { World } from '../../src/types';

/** short FNV-1a fingerprint of the deterministic state: tick, rng state, agent positions */
export function worldCheck(world: World): string {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(world.tick);
  mix(world.rng.state());
  for (const a of world.agents) {
    mix(a.id);
    mix(Math.round(a.pos.x * 1000));
    mix(Math.round(a.pos.y * 1000));
  }
  return (h >>> 0).toString(36);
}
