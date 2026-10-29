import type { Grid, ObjectInstance, RectArea, Room, TileKind, Vec2 } from '../../types';
import { createGrid, markSolid, setTile } from '../grid';
import { OBJECT_DEFS, footprint } from '../objects';

// Shared helpers for building house layouts (src/world/maps/*.ts).

export interface MapData {
  grid: Grid;
  objects: ObjectInstance[];
  spawnPoints: Vec2[];
}

export const rect = (x: number, y: number, w: number, h: number): RectArea => ({ x, y, w, h });

export interface MapBuilder {
  grid: Grid;
  objects: ObjectInstance[];
  fill(r: RectArea, kind: TileKind): void;
  /** horizontal line x0..x1 (inclusive) */
  hLine(y: number, x0: number, x1: number, kind?: TileKind): void;
  /** vertical line y0..y1 (inclusive) */
  vLine(x: number, y0: number, y1: number, kind?: TileKind): void;
  door(x: number, y: number): void;
  /** places an object (top-left tile) and marks blocking footprints solid; uids follow call order */
  put(type: string, x: number, y: number): ObjectInstance;
  /** fills a room's floor and registers it in grid.rooms */
  room(id: string, name: string, r: RectArea, floor?: TileKind): Room;
}

export function createBuilder(width: number, height: number, ground: TileKind = 'grass'): MapBuilder {
  const g = createGrid(width, height, ground);
  const objects: ObjectInstance[] = [];
  const fill = (r: RectArea, kind: TileKind): void => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setTile(g, x, y, kind);
  };
  return {
    grid: g,
    objects,
    fill,
    hLine: (y, x0, x1, kind = 'wall') => fill(rect(x0, y, x1 - x0 + 1, 1), kind),
    vLine: (x, y0, y1, kind = 'wall') => fill(rect(x, y0, 1, y1 - y0 + 1), kind),
    door: (x, y) => setTile(g, x, y, 'door'),
    put(type, x, y) {
      const def = OBJECT_DEFS[type];
      if (!def) throw new Error(`unknown object type ${type}`);
      const obj: ObjectInstance = { uid: objects.length + 1, type, pos: { x, y }, reservedBy: def.slots.map(() => null) };
      objects.push(obj);
      if (def.blocking) for (const p of footprint(obj, def)) markSolid(g, p.x, p.y, true);
      return obj;
    },
    room(id, name, r, floor = 'floor') {
      fill(r, floor);
      const room: Room = { id, name, rect: r };
      g.rooms.push(room);
      return room;
    },
  };
}

/** legend of the ASCII dumps at the top of every map file */
const OBJECT_CHARS: Record<string, string> = {
  bed: 'B', fridge: 'F', stove: 'S', dining_table: 'T', counter: '=', shower: 'H', bathtub: 'U', toilet: 'W', sink: 'K',
  tv: 'V', sofa: 'O', bookshelf: 'R', piano: 'P', computer: 'C', exercise_bike: 'E', treadmill: 'M', bench: 'L',
  grill: 'G', flowerbed: '*', fishing_spot: 'f', console: 'X', board_game_table: 'g', wardrobe: 'Z', plant: 'p', lamp: 'l', rug: 'r', tree: 'Y', bush: 'b',
};
const TILE_CHARS: Record<TileKind, string> = { wall: '#', door: 'D', floor: ' ', tile: '.', grass: ',', path: ':', water: '~' };

/** ASCII picture of a map (same legend as the dumps in the map files); handy when editing layouts */
export function mapToAscii(map: MapData): string {
  const { grid: g, objects, spawnPoints } = map;
  const rows = Array.from({ length: g.height }, (_, y) =>
    Array.from({ length: g.width }, (_, x) => TILE_CHARS[g.tiles[y * g.width + x]]),
  );
  // rugs first so furniture on top of them wins
  const sorted = [...objects].sort((a, b) => Number(b.type === 'rug') - Number(a.type === 'rug'));
  for (const o of sorted) {
    const def = OBJECT_DEFS[o.type];
    for (const p of footprint(o, def)) if (rows[p.y]?.[p.x] !== undefined) rows[p.y][p.x] = OBJECT_CHARS[o.type] ?? '?';
  }
  for (const s of spawnPoints) if (rows[s.y]?.[s.x] !== undefined) rows[s.y][s.x] = '@';
  return rows.map((r) => r.join('')).join('\n');
}
