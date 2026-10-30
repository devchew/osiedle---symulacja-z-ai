// Boardwalk detection: `path` tiles that stand over water are drawn as planks, not stepping stones.

import type { Grid } from '../types';

const DIRS: [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

export const PLANK_TONES = ['#b98a57', '#a97b4a', '#c39563', '#b08052'];

/** indices (y * width + x) of path tiles that form a pier over water */
export function pierTiles(g: Grid): Set<number> {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= g.width || y >= g.height ? null : g.tiles[y * g.width + x]);
  const wet = (x: number, y: number) => at(x, y) === 'water';
  const pier = new Set<number>();
  const hasWater = new Map<number, number>();
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (at(x, y) !== 'path') continue;
      const n = DIRS.filter(([dx, dy]) => wet(x + dx, y + dy)).length;
      if (n === 0) continue;
      const i = y * g.width + x;
      hasWater.set(i, n);
      // water on both sides of the walkway, or boxed in by water at the pier head
      if ((wet(x, y - 1) && wet(x, y + 1)) || (wet(x - 1, y) && wet(x + 1, y)) || n >= 2) pier.add(i);
    }
  }
  // plug holes at the head: a shore-side tile wedged between pier tiles
  for (const i of hasWater.keys()) {
    if (pier.has(i)) continue;
    const x = i % g.width;
    const y = Math.floor(i / g.width);
    const around = DIRS.filter(([dx, dy]) => pier.has((y + dy) * g.width + x + dx) && at(x + dx, y + dy) === 'path').length;
    if (around >= 2) pier.add(i);
  }
  return pier;
}
