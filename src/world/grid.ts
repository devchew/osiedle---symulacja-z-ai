import type { Grid, RectArea, Rng, Room, TileKind, Vec2 } from '../types';

const SOLID_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(['wall', 'water']);

export const isSolidKind = (kind: TileKind): boolean => SOLID_KINDS.has(kind);

export function createGrid(w: number, h: number, fill: TileKind): Grid {
  return {
    width: w,
    height: h,
    tiles: new Array<TileKind>(w * h).fill(fill),
    solid: new Array<boolean>(w * h).fill(isSolidKind(fill)),
    rooms: [],
  };
}

export function inBounds(g: Grid, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < g.width && y < g.height;
}

export function isWalkable(g: Grid, x: number, y: number): boolean {
  return inBounds(g, x, y) && !g.solid[y * g.width + x];
}

export function tileAt(g: Grid, x: number, y: number): TileKind | null {
  return inBounds(g, x, y) ? g.tiles[y * g.width + x] : null;
}

/** sets the tile kind and resets `solid` from the kind (object footprints must be re-marked) */
export function setTile(g: Grid, x: number, y: number, kind: TileKind): void {
  if (!inBounds(g, x, y)) return;
  const i = y * g.width + x;
  g.tiles[i] = kind;
  g.solid[i] = isSolidKind(kind);
}

export function markSolid(g: Grid, x: number, y: number, solid: boolean): void {
  if (inBounds(g, x, y)) g.solid[y * g.width + x] = solid;
}

/** accepts fractional positions (rounded to the nearest tile) */
export function roomAt(g: Grid, x: number, y: number): Room | null {
  const tx = Math.round(x);
  const ty = Math.round(y);
  for (const r of g.rooms) {
    const { rect } = r;
    if (tx >= rect.x && ty >= rect.y && tx < rect.x + rect.w && ty < rect.y + rect.h) return r;
  }
  return null;
}

export function randomWalkableTile(g: Grid, rng: Rng, area?: RectArea): Vec2 {
  const x0 = Math.max(0, area?.x ?? 0);
  const y0 = Math.max(0, area?.y ?? 0);
  const x1 = Math.min(g.width, area ? area.x + area.w : g.width) - 1;
  const y1 = Math.min(g.height, area ? area.y + area.h : g.height) - 1;
  for (let attempt = 0; attempt < 64; attempt++) {
    const x = rng.int(x0, x1);
    const y = rng.int(y0, y1);
    if (isWalkable(g, x, y)) return { x, y };
  }
  // dense area: pick uniformly from all walkable tiles in it
  const free: Vec2[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isWalkable(g, x, y)) free.push({ x, y });
  if (free.length) return rng.pick(free);
  if (area) return randomWalkableTile(g, rng);
  throw new Error('grid has no walkable tiles');
}
