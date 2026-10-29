import type { World } from '../../types';
import { registerWorldState } from '../../core/state';
import type { MapData } from './build';
import { createDefaultMap } from './dom';
import { createKamienicaMap } from './kamienica';
import { createJezioroMap } from './jezioro';
import { createAkademikMap } from './akademik';

// House layouts to choose from. Each layout is its own module built with ./build helpers.

export type { MapData } from './build';

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
  {
    id: 'kamienica',
    name: 'Kamienica',
    description: 'Cztery małe mieszkania, klub i siłownia wokół zielonego podwórka z grillem',
    create: createKamienicaMap,
  },
  {
    id: 'jezioro',
    name: 'Domek nad jeziorem',
    description: 'Drewniana chatka w lesie: pomost, ognisko i wędkowanie nad dużym jeziorem',
    create: createJezioroMap,
  },
  {
    id: 'akademik',
    name: 'Akademik',
    description: 'Korytarz z pokojami dwuosobowymi, wspólna kuchnia, świetlica i siłownia',
    create: createAkademikMap,
  },
];

export const DEFAULT_MAP_ID = 'dom';

export function getMap(id: string | null | undefined): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS.find((m) => m.id === DEFAULT_MAP_ID)!;
}

export function bedCount(map: MapDef): number {
  return map.create().objects.filter((o) => o.type === 'bed').length;
}

const mapOfWorld = new WeakMap<World, string>();

registerWorldState('map', {
  save: (world) => mapOfWorld.get(world) ?? null,
  load: (world, data) => void mapOfWorld.set(world, data as string),
});

export function setMapId(world: World, id: string): void {
  mapOfWorld.set(world, id);
}

export function mapIdOf(world: World): string {
  return mapOfWorld.get(world) ?? DEFAULT_MAP_ID;
}
