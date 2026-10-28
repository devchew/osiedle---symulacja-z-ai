import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { NEED_KEYS, type Grid, type Vec2 } from '../src/types';
import { createGrid, inBounds, isWalkable, markSolid, randomWalkableTile, roomAt, setTile } from '../src/world/grid';
import { createDefaultMap } from '../src/world/map';
import { OBJECT_DEFS, footprint, objectCenter, slotStandTile, slotUsePos } from '../src/world/objects';

const key = (p: Vec2) => `${p.x},${p.y}`;

/** 4-neighbour flood fill over walkable tiles (stricter than 8-dir A*) */
function reachable(g: Grid, starts: Vec2[]): Set<string> {
  const seen = new Set<string>(starts.map(key));
  const queue = [...starts];
  while (queue.length) {
    const p = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (isWalkable(g, n.x, n.y) && !seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
    }
  }
  return seen;
}

describe('grid', () => {
  it('setTile keeps solid in sync, markSolid overrides', () => {
    const g = createGrid(4, 3, 'grass');
    expect(g.tiles.length).toBe(12);
    setTile(g, 1, 1, 'wall');
    setTile(g, 2, 1, 'water');
    setTile(g, 3, 1, 'door');
    expect(isWalkable(g, 1, 1)).toBe(false);
    expect(isWalkable(g, 2, 1)).toBe(false);
    expect(isWalkable(g, 3, 1)).toBe(true);
    markSolid(g, 0, 0, true);
    expect(isWalkable(g, 0, 0)).toBe(false);
    expect(inBounds(g, 4, 0)).toBe(false);
    expect(isWalkable(g, -1, 0)).toBe(false);
  });
  it('roomAt and randomWalkableTile', () => {
    const g = createGrid(10, 10, 'floor');
    g.rooms.push({ id: 'r', name: 'Pokój', rect: { x: 2, y: 2, w: 3, h: 3 } });
    expect(roomAt(g, 3, 3)?.id).toBe('r');
    expect(roomAt(g, 4.4, 2)?.id).toBe('r');
    expect(roomAt(g, 5, 5)).toBeNull();
    const rng = createRng(1);
    for (let i = 0; i < 50; i++) {
      const p = randomWalkableTile(g, rng, { x: 2, y: 2, w: 3, h: 3 });
      expect(roomAt(g, p.x, p.y)?.id).toBe('r');
    }
  });
});

describe('objects', () => {
  const activities = Object.values(OBJECT_DEFS).filter((d) => d.slots.length > 0);
  it('has enough activities with Polish labels', () => {
    expect(activities.length).toBeGreaterThanOrEqual(14);
    for (const d of activities) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.verb.length).toBeGreaterThan(0);
      expect(d.duration[0]).toBeGreaterThan(0);
      expect(d.duration[1]).toBeGreaterThanOrEqual(d.duration[0]);
    }
  });
  it('each need is satisfied by some activity', () => {
    for (const need of NEED_KEYS) expect(activities.some((d) => (d.effects[need] ?? 0) > 0), need).toBe(true);
  });
  it('sleep refills energy', () => {
    const bed = OBJECT_DEFS.bed;
    expect(bed.tags).toContain('sleep');
    expect(bed.effects.energy! * bed.duration[0]).toBeGreaterThanOrEqual(90);
  });
  it('slot helpers are relative to origin', () => {
    const def = OBJECT_DEFS.tv;
    const obj = { uid: 1, type: 'tv', pos: { x: 10, y: 5 }, reservedBy: [null, null, null] };
    expect(slotStandTile(obj, def, 1)).toEqual({ x: 11, y: 7 });
    expect(slotUsePos(obj, def, 1)).toEqual({ x: 11, y: 8 });
    expect(objectCenter(obj, def)).toEqual({ x: 11, y: 5 });
  });
});

describe('default map', () => {
  const { grid, objects, spawnPoints } = createDefaultMap();
  const blocked = new Set<string>();
  for (const o of objects) {
    const def = OBJECT_DEFS[o.type];
    if (def.blocking) footprint(o, def).forEach((p) => blocked.add(key(p)));
  }

  it('is deterministic', () => {
    expect(createDefaultMap()).toEqual(createDefaultMap());
  });

  it('objects are known, unique uid, in bounds, on floor and non-overlapping', () => {
    const used = new Map<string, number>();
    expect(new Set(objects.map((o) => o.uid)).size).toBe(objects.length);
    for (const o of objects) {
      const def = OBJECT_DEFS[o.type];
      expect(def, o.type).toBeDefined();
      expect(o.reservedBy.length).toBe(def.slots.length);
      for (const p of footprint(o, def)) {
        expect(inBounds(grid, p.x, p.y), `${o.type} ${key(p)}`).toBe(true);
        const t = grid.tiles[p.y * grid.width + p.x];
        expect(['wall', 'water', 'door'], `${o.type} on ${t} at ${key(p)}`).not.toContain(t);
        expect(used.get(key(p)), `${o.type} overlaps uid ${used.get(key(p))} at ${key(p)}`).toBeUndefined();
        used.set(key(p), o.uid);
      }
    }
  });

  it('solid matches walls, water and blocking objects', () => {
    for (let y = 0; y < grid.height; y++)
      for (let x = 0; x < grid.width; x++) {
        const t = grid.tiles[y * grid.width + x];
        const expected = t === 'wall' || t === 'water' || blocked.has(key({ x, y }));
        expect(grid.solid[y * grid.width + x], `${x},${y}`).toBe(expected);
      }
  });

  it('has >= 8 distinct walkable spawn points', () => {
    expect(new Set(spawnPoints.map(key)).size).toBeGreaterThanOrEqual(8);
    for (const s of spawnPoints) expect(isWalkable(grid, s.x, s.y), key(s)).toBe(true);
  });

  it('every slot stand tile is walkable and reachable from every spawn', () => {
    const reach = reachable(grid, [spawnPoints[0]]);
    for (const s of spawnPoints) expect(reach.has(key(s)), `spawn ${key(s)}`).toBe(true);
    for (const o of objects) {
      const def = OBJECT_DEFS[o.type];
      def.slots.forEach((_, i) => {
        const p = slotStandTile(o, def, i);
        expect(isWalkable(grid, p.x, p.y), `${o.type}#${o.uid} slot ${i} at ${key(p)}`).toBe(true);
        expect(reach.has(key(p)), `${o.type}#${o.uid} slot ${i} unreachable`).toBe(true);
      });
    }
  });

  it('slot stand tiles are not shared between slots', () => {
    const seen = new Set<string>();
    for (const o of objects) {
      const def = OBJECT_DEFS[o.type];
      def.slots.forEach((_, i) => {
        const k = key(slotStandTile(o, def, i));
        expect(seen.has(k), `${o.type} slot ${i} at ${k}`).toBe(false);
        seen.add(k);
      });
    }
  });

  it('every room is reachable', () => {
    const reach = reachable(grid, spawnPoints);
    for (const r of grid.rooms) {
      let ok = false;
      for (let y = r.rect.y; y < r.rect.y + r.rect.h && !ok; y++)
        for (let x = r.rect.x; x < r.rect.x + r.rect.w && !ok; x++) ok = reach.has(key({ x, y }));
      expect(ok, r.name).toBe(true);
    }
  });

  it('has a full household: >= 6 beds, kitchen, bathrooms, garden', () => {
    const count = (t: string) => objects.filter((o) => o.type === t).length;
    expect(count('bed')).toBeGreaterThanOrEqual(6);
    expect(count('toilet')).toBeGreaterThanOrEqual(2);
    expect(count('shower')).toBeGreaterThanOrEqual(2);
    expect(grid.rooms.filter((r) => r.id.startsWith('bedroom')).length).toBeGreaterThanOrEqual(3);
    expect(grid.tiles).toContain('water');
    expect(grid.tiles).toContain('path');
    // every activity type appears on the map
    for (const def of Object.values(OBJECT_DEFS)) if (def.slots.length) expect(count(def.id), def.id).toBeGreaterThan(0);
  });
});
