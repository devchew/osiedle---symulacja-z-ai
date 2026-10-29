import type { ObjectDef, ObjectInstance, Vec2 } from '../types';
import { PROJECT_DEFS } from './projects';

// Effects are per tick (1 tick = 1 game minute), needs are 0..100.
// Slot coordinates are relative to the object's top-left tile. Unless noted,
// objects stand against a wall above them and are used from the tile below.

type Def = Omit<ObjectDef, 'id'>;

const deco = (name: string, icon: string, color: string, w: number, h: number, blocking: boolean, tags: string[] = []): Def => ({
  name,
  verb: '',
  icon,
  color,
  size: { w, h },
  blocking,
  slots: [],
  effects: {},
  duration: [0, 0],
  tags: ['decor', ...tags],
});

const defs: Record<string, Def> = {
  // ------------------------------------------------------------ food
  fridge: {
    name: 'Lodówka', verb: 'Je przekąskę', icon: '🥪', color: '#dfe6ec',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 } }],
    effects: { hunger: 1.0 }, duration: [15, 25], tags: ['food', 'snack'],
  },
  stove: {
    name: 'Kuchenka', verb: 'Gotuje obiad', icon: '🍳', color: '#5b6068',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0.5, y: 0.75 } }],
    effects: { hunger: 1.0, fun: 0.1 }, duration: [40, 60], tags: ['food', 'meal'],
  },
  // 3x2 table, three chairs on each long side
  dining_table: {
    name: 'Stół jadalny', verb: 'Je posiłek przy stole', icon: '🍲', color: '#a0703c',
    size: { w: 3, h: 2 }, blocking: true,
    slots: [
      { stand: { x: 0, y: -1 }, use: { x: 0, y: -0.6 } },
      { stand: { x: 1, y: -1 }, use: { x: 1, y: -0.6 } },
      { stand: { x: 2, y: -1 }, use: { x: 2, y: -0.6 } },
      { stand: { x: 0, y: 2 }, use: { x: 0, y: 1.6 } },
      { stand: { x: 1, y: 2 }, use: { x: 1, y: 1.6 } },
      { stand: { x: 2, y: 2 }, use: { x: 2, y: 1.6 } },
    ],
    effects: { hunger: 1.2, social: 0.4, comfort: 0.4 }, duration: [30, 45], social: true, tags: ['food', 'meal'],
  },
  grill: {
    name: 'Grill', verb: 'Grilluje kiełbaski', icon: '🌭', color: '#3a3a3a',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 } }, { stand: { x: 1, y: 1 } }],
    effects: { hunger: 0.9, fun: 0.4, social: 0.3 }, duration: [40, 60], social: true, tags: ['food', 'outdoor'],
  },

  // ------------------------------------------------------------ rest
  // single bed 1x2 (head at top); agent steps from the right side and lies on it
  bed: {
    name: 'Łóżko', verb: 'Śpi', icon: '💤', color: '#6f8fc9',
    size: { w: 1, h: 2 }, blocking: true,
    slots: [{ stand: { x: 1, y: 1 }, use: { x: 0, y: 0.5 } }],
    effects: { energy: 0.3, comfort: 0.15 }, duration: [360, 480], tags: ['sleep'],
  },

  // ------------------------------------------------------------ hygiene
  shower: {
    name: 'Prysznic', verb: 'Bierze prysznic', icon: '🚿', color: '#9fd3e6',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0, y: 0 } }],
    effects: { hygiene: 4.0, comfort: 0.2 }, duration: [12, 18], tags: ['hygiene'],
  },
  bathtub: {
    name: 'Wanna', verb: 'Relaksuje się w wannie', icon: '🛁', color: '#f2f5f7',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0.5, y: 0 } }],
    effects: { hygiene: 2.5, comfort: 0.8, energy: 0.1 }, duration: [30, 45], tags: ['hygiene'],
  },
  toilet: {
    name: 'Toaleta', verb: 'Korzysta z toalety', icon: '🚽', color: '#ffffff',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0, y: 0.2 } }],
    effects: { comfort: 3.0, hygiene: -0.3 }, duration: [5, 10], tags: ['hygiene'],
  },
  // mounted on an east wall: used from the tile on its left
  sink: {
    name: 'Umywalka', verb: 'Myje ręce i twarz', icon: '🧼', color: '#e8eef2',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [{ stand: { x: -1, y: 0 }, use: { x: -0.6, y: 0 } }],
    effects: { hygiene: 2.0 }, duration: [5, 10], tags: ['hygiene'],
  },

  // ------------------------------------------------------------ fun
  // TV cabinet 3x1; viewers stand 2 tiles below and are drawn on the sofa placed 3 tiles below
  tv: {
    name: 'Telewizor', verb: 'Ogląda telewizję', icon: '📺', color: '#222831',
    size: { w: 3, h: 1 }, blocking: true,
    slots: [
      { stand: { x: 0, y: 2 }, use: { x: 0, y: 3 } },
      { stand: { x: 1, y: 2 }, use: { x: 1, y: 3 } },
      { stand: { x: 2, y: 2 }, use: { x: 2, y: 3 } },
    ],
    effects: { fun: 0.8, comfort: 0.4, energy: -0.02 }, duration: [60, 120], social: true, tags: ['fun', 'sofa'],
  },
  bookshelf: {
    name: 'Regał z książkami', verb: 'Czyta książkę', icon: '📖', color: '#7a4e2d',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 } }, { stand: { x: 1, y: 1 } }],
    effects: { fun: 0.4, comfort: 0.3 }, duration: [45, 90], tags: ['fun', 'quiet'],
  },
  computer: {
    name: 'Komputer', verb: 'Gra na komputerze', icon: '🎮', color: '#3d5a80',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0.5, y: 0.7 } }],
    effects: { fun: 0.9, energy: -0.05, comfort: 0.15 }, duration: [45, 90], tags: ['fun', 'quiet'],
  },
  piano: {
    name: 'Pianino', verb: 'Gra na pianinie', icon: '🎹', color: '#2b2118',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0.5, y: 0.7 } }],
    effects: { fun: 0.7, comfort: 0.2 }, duration: [30, 60], tags: ['fun', 'music', 'quiet'],
  },
  exercise_bike: {
    name: 'Rowerek treningowy', verb: 'Ćwiczy na rowerku', icon: '🚴', color: '#d1495b',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0, y: 0 } }],
    effects: { fun: 0.8, comfort: 0.2, energy: -0.25, hygiene: -0.35 }, duration: [30, 45], tags: ['fun', 'exercise'],
  },
  treadmill: {
    name: 'Bieżnia', verb: 'Biega na bieżni', icon: '🏃', color: '#4a4e69',
    size: { w: 1, h: 2 }, blocking: true,
    slots: [{ stand: { x: 0, y: 2 }, use: { x: 0, y: 0.5 } }],
    effects: { fun: 0.75, energy: -0.3, hygiene: -0.4, comfort: 0.25 }, duration: [30, 45], tags: ['fun', 'exercise'],
  },

  // games console with its own screen, standing against a south wall; up to four players sit on
  // poufs in the row above it (joint activity, see agents/joint.ts; alone it is a short session)
  console: {
    name: 'Konsola do gier', verb: 'Gra na konsoli', icon: '🕹️', color: '#2d3142',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [
      { stand: { x: 0, y: -1 }, use: { x: 0, y: -0.82 } },
      { stand: { x: 1, y: -1 }, use: { x: 1, y: -0.82 } },
      { stand: { x: -1, y: -1 }, use: { x: -1, y: -0.82 } },
      { stand: { x: 2, y: -1 }, use: { x: 2, y: -0.82 } },
    ],
    effects: { fun: 0.75, comfort: 0.2, social: 0.1, energy: -0.03 }, duration: [30, 50], social: true, tags: ['fun', 'games'],
  },
  // small square card / board game table with a seat on every side (N, S, W, E)
  board_game_table: {
    name: 'Stolik do gier', verb: 'Gra w planszówkę', icon: '🎲', color: '#7c5b3a',
    size: { w: 1, h: 1 }, blocking: true,
    slots: [
      { stand: { x: 0, y: -1 }, use: { x: 0, y: -0.62 } },
      { stand: { x: 0, y: 1 }, use: { x: 0, y: 0.6 } },
      { stand: { x: -1, y: 0 }, use: { x: -0.66, y: 0 } },
      { stand: { x: 1, y: 0 }, use: { x: 0.66, y: 0 } },
    ],
    effects: { fun: 0.6, comfort: 0.25, social: 0.15 }, duration: [25, 40], social: true, tags: ['fun', 'games'],
  },

  // ------------------------------------------------------------ garden
  bench: {
    name: 'Ławka', verb: 'Odpoczywa na ławce', icon: '🪑', color: '#8d6e4a',
    size: { w: 2, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 }, use: { x: 0, y: 0.2 } }, { stand: { x: 1, y: 1 }, use: { x: 1, y: 0.2 } }],
    effects: { comfort: 0.6, social: 0.3, fun: 0.1 }, duration: [30, 60], social: true, tags: ['outdoor', 'rest'],
  },
  // non-blocking spot on the pond shore; the agent stands on it
  fishing_spot: {
    name: 'Pomost wędkarski', verb: 'Łowi ryby', icon: '🎣', color: '#a68a64',
    size: { w: 1, h: 1 }, blocking: false,
    slots: [{ stand: { x: 0, y: 0 } }],
    effects: { fun: 0.6, comfort: 0.3 }, duration: [60, 120], tags: ['outdoor', 'fun', 'quiet'],
  },
  flowerbed: {
    name: 'Grządka z kwiatami', verb: 'Pielęgnuje kwiaty', icon: '🌷', color: '#6a994e',
    size: { w: 3, h: 1 }, blocking: true,
    slots: [{ stand: { x: 0, y: 1 } }, { stand: { x: 2, y: 1 } }],
    effects: { fun: 0.6, comfort: 0.3, hygiene: -0.2 }, duration: [30, 50], tags: ['outdoor', 'fun', 'quiet'],
  },

  // ------------------------------------------------------------ decoration
  sofa: deco('Kanapa', '🛋️', '#b5654a', 3, 1, true),
  wardrobe: deco('Szafa', '🚪', '#8b5e3c', 2, 1, true),
  counter: deco('Blat kuchenny', '🔪', '#c9b79c', 1, 1, true),
  plant: deco('Roślina doniczkowa', '🪴', '#4f9d4f', 1, 1, false),
  lamp: deco('Lampa', '💡', '#f4d35e', 1, 1, false),
  rug: deco('Dywan', '🟥', '#c08497', 3, 2, false),
  tree: deco('Drzewo', '🌳', '#2d6a4f', 1, 1, true, ['outdoor']),
  bush: deco('Krzew', '🌿', '#52b788', 1, 1, true, ['outdoor']),
};

export const OBJECT_DEFS: Record<string, ObjectDef> = Object.fromEntries(
  Object.entries(defs).map(([id, d]) => [id, { id, ...d }]),
);

// ------------------------------------------------------------ repairs
// A broken object keeps its instance but its `type` becomes `repair_<type>`:
// same footprint and stand tiles, but "using" it means fixing it (see world/incidents.ts).

export const REPAIR_PREFIX = 'repair_';

/** object types that can break down */
export const BREAKABLE: readonly string[] = [
  'fridge', 'stove', 'shower', 'bathtub', 'toilet', 'sink', 'tv', 'computer', 'exercise_bike', 'treadmill',
];

const REPAIR_VERB: Record<string, string> = {
  fridge: 'Naprawia lodówkę',
  stove: 'Naprawia kuchenkę',
  shower: 'Naprawia prysznic',
  bathtub: 'Przetyka wannę',
  toilet: 'Przetyka toaletę',
  sink: 'Uszczelnia umywalkę',
  tv: 'Naprawia telewizor',
  computer: 'Naprawia komputer',
  exercise_bike: 'Naprawia rowerek',
  treadmill: 'Naprawia bieżnię',
};

function repairDef(base: ObjectDef): ObjectDef {
  return {
    ...base,
    id: REPAIR_PREFIX + base.id,
    name: `${base.name} (awaria)`,
    verb: REPAIR_VERB[base.id] ?? 'Naprawia sprzęt',
    icon: '🔧',
    // one repairer, standing at the first usual spot (instances swap reservedBy to match)
    slots: [{ stand: base.slots[0].stand }],
    effects: { fun: 0.8, comfort: -0.1, hygiene: -0.1 },
    duration: [25, 45],
    social: false,
    // 'exercise': active residents like this kind of job (brain personality)
    tags: ['repair', 'exercise'],
  };
}

export const REPAIR_DEFS: Record<string, ObjectDef> = Object.fromEntries(
  BREAKABLE.map((t) => [REPAIR_PREFIX + t, repairDef(OBJECT_DEFS[t])]),
);

/** catalogue used by a running world: placeable objects plus their "being repaired" variants */
export const WORLD_OBJECT_DEFS: Record<string, ObjectDef> = { ...OBJECT_DEFS, ...REPAIR_DEFS, ...PROJECT_DEFS };

export function slotStandTile(obj: ObjectInstance, def: ObjectDef, i: number): Vec2 {
  const s = def.slots[i].stand;
  return { x: obj.pos.x + s.x, y: obj.pos.y + s.y };
}

export function slotUsePos(obj: ObjectInstance, def: ObjectDef, i: number): Vec2 {
  const s = def.slots[i];
  const p = s.use ?? s.stand;
  return { x: obj.pos.x + p.x, y: obj.pos.y + p.y };
}

export function objectCenter(obj: ObjectInstance, def: ObjectDef): Vec2 {
  return { x: obj.pos.x + (def.size.w - 1) / 2, y: obj.pos.y + (def.size.h - 1) / 2 };
}

/** footprint tiles of an instance */
export function footprint(obj: ObjectInstance, def: ObjectDef): Vec2[] {
  const out: Vec2[] = [];
  for (let dy = 0; dy < def.size.h; dy++) for (let dx = 0; dx < def.size.w; dx++) out.push({ x: obj.pos.x + dx, y: obj.pos.y + dy });
  return out;
}
