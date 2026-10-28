import type { Grid, ObjectInstance, Vec2, World } from '../../types';
import { createDefaultMap } from '../map';

// House layouts to choose from. Wave 7: more houses are added here (see plan/TASKS.md).

export interface MapData {
  grid: Grid;
  objects: ObjectInstance[];
  spawnPoints: Vec2[];
}

export interface MapDef {
  id: string;
  /** Polish display name */
  name: string;
  /** one-line Polish description for the new-world dialog */
  description: string;
  create(): MapData;
}

export const MAPS: readonly MapDef[] = [
  { id: 'dom', name: 'Dom z ogrodem', description: 'Parterowy dom z czterema sypialniami, stawem i sadem', create: createDefaultMap },
];

export const DEFAULT_MAP_ID = 'dom';

export function getMap(id: string | null | undefined): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS.find((m) => m.id === DEFAULT_MAP_ID)!;
}

export function bedCount(map: MapDef): number {
  return map.create().objects.filter((o) => o.type === 'bed').length;
}

const mapOfWorld = new WeakMap<World, string>();

export function setMapId(world: World, id: string): void {
  mapOfWorld.set(world, id);
}

export function mapIdOf(world: World): string {
  return mapOfWorld.get(world) ?? DEFAULT_MAP_ID;
}
