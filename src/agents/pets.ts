import type { Agent, ObjectInstance, Rng, Vec2, World } from '../types';
import { createRng } from '../core/rng';
import { registerWorldState, type Json } from '../core/state';
import { timeFromTick } from '../core/time';
import { narrateStory } from './narration';
import { isWalkable } from '../world/grid';
import { isOutdoorTile } from '../world/incidents';
import { getMap, mapIdOf, type MapData } from '../world/maps';
import type { PetSpec } from '../world/maps/build';
import { OBJECT_DEFS } from '../world/objects';
import { findPath } from './pathfinding';
import { loadWalkerMove, saveWalkerMove, stepAgent, WALK_SPEED, type TrailPoint } from './movement';

// House pets (issue #9): one cat or dog per place, described by the map (MapData.pet).
//
// A pet is not an Agent: it never talks, has no goals, bed, diary or relationships, so none of the
// resident code sees it. Residents look after it through ordinary objects (pet_bowl, pet_toy,
// dog_walk in world/objects.ts) that appeal only while the pet needs that kind of care
// (petObjectBias, used by brain.ts); tickPets runs after the residents and makes the pet react to
// whoever is using them: it eats from a filled bowl, plays next to the resident at the toy corner
// and follows the walker outside. The rest of the time it naps on its cushion or strolls around
// the rooms; a cat never goes outdoors and a dog only on a walk.
//
// The pet has its own RNG stream (never world.rng), so residents behave exactly as without it
// until someone picks one of the pet objects. Texts: present tense, names in the nominative.

export type PetSpecies = PetSpec['species'];
export type PetActivity = 'idle' | 'stroll' | 'sleep' | 'eat' | 'play' | 'walk' | 'cuddle';

export interface PetNeeds {
  hunger: number;
  fun: number;
  energy: number;
  /** dogs only (always 100 for a cat) */
  walk: number;
}

export interface Pet {
  id: number;
  species: PetSpecies;
  name: string;
  needs: PetNeeds;
  /** 0..100 */
  mood: number;
  pos: Vec2;
  facing: -1 | 1;
  path: Vec2[];
  activity: PetActivity;
  /** the resident it plays with, walks with or keeps company */
  withId: number | null;
  /** tick the current activity started */
  since: number;
}

export const PET_OBJECT_TYPES = ['pet_bowl', 'pet_cushion', 'pet_toy', 'dog_walk'] as const;

export const PET_NEED_LABELS: Record<keyof PetNeeds, string> = {
  hunger: 'Głód',
  fun: 'Zabawa',
  energy: 'Energia',
  walk: 'Spacer',
};

const SPECIES_NAME: Record<PetSpecies, string> = { cat: 'kot', dog: 'pies' };

// per tick (game minute); needs are 0..100
const DECAY = {
  hunger: { awake: 0.1, asleep: 0.04 },
  fun: { awake: 0.12, asleep: 0.02 },
  energy: { cat: 0.11, dog: 0.08 },
  walk: { awake: 0.1, asleep: 0.02 },
} as const;
const EAT_RATE = 5;
const PLAY_RATE = 2.5;
const WALK_RATE = 3;
const SLEEP_RATE = 0.35;
/** strolling near a resident keeps a pet a little entertained */
const COMPANY_FUN = 0.3;

/** below these the residents notice the pet needs them (petObjectBias) */
export const CARE_BELOW = { hunger: 60, fun: 65, walk: 55 } as const;
/** a full bowl is eaten once hunger is below this */
const EAT_BELOW = 85;
const NAP_ENERGY = 25;
/** pet moments (petting, mischief) per awake tick */
const MOMENT_CHANCE = 0.004;

interface PetStore {
  pets: Pet[];
  rng: Rng;
  /** uid of a filled bowl → true */
  bowls: Record<number, boolean>;
  /** who used each pet object last tick (agent id), to tell new visits apart */
  users: Record<number, number>;
  /** a hungry pet already complained (reset after eating) */
  complained: Record<number, boolean>;
}

const stores = new WeakMap<World, PetStore>();

const RNG_SALT = 0x9e7f00d5;

export function petsOf(world: World): readonly Pet[] {
  return stores.get(world)?.pets ?? [];
}

export function petById(world: World, id: number): Pet | undefined {
  return petsOf(world).find((p) => p.id === id);
}

export function speciesName(pet: Pet): string {
  return SPECIES_NAME[pet.species];
}

const isNight = (hour: number): boolean => hour >= 22 || hour < 6;

// ---------------------------------------------------------------- creation / old worlds

/**
 * gives the world its map's pet (once): adds the pet objects missing from world.objects (worlds
 * saved before #9) and the pet itself on its cushion. `map` saves building the layout again.
 */
export function ensurePets(world: World, map?: MapData): void {
  if (stores.get(world)?.pets.length) return;
  const data = map ?? getMap(mapIdOf(world)).create();
  if (!data.pet) return;
  let uid = world.objects.reduce((m, o) => Math.max(m, o.uid), 0);
  for (const o of data.objects) {
    if (!(PET_OBJECT_TYPES as readonly string[]).includes(o.type)) continue;
    if (world.objects.some((w) => w.type === o.type)) continue;
    if (!isWalkable(world.grid, o.pos.x, o.pos.y)) continue;
    world.objects.push({ uid: ++uid, type: o.type, pos: { ...o.pos }, reservedBy: OBJECT_DEFS[o.type].slots.map(() => null) });
  }
  const cushion = world.objects.find((o) => o.type === 'pet_cushion');
  const home = cushion ? { ...cushion.pos } : { ...data.spawnPoints[0] };
  const pet: Pet = {
    id: 1,
    species: data.pet.species,
    name: data.pet.name,
    needs: { hunger: 80, fun: 75, energy: 85, walk: data.pet.species === 'dog' ? 70 : 100 },
    mood: 80,
    pos: home,
    facing: 1,
    path: [],
    activity: 'sleep',
    withId: null,
    since: world.tick,
  };
  stores.set(world, {
    pets: [pet],
    rng: createRng((world.seed ^ RNG_SALT) >>> 0),
    bowls: {},
    users: {},
    complained: {},
  });
}

// ---------------------------------------------------------------- residents' side

export interface PetBias {
  mult: number;
  add: number;
}

const NO_PET_BIAS: PetBias = { mult: 1, add: 0 };
const NOT_NEEDED: PetBias = { mult: 0, add: 0 };

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * how much a pet object is worth right now (applied like a daily-goal bias in brain.ts): nothing
 * while the pet is fine, a strong pull when it is hungry, bored or needs to go out
 */
export function petObjectBias(world: World, obj: ObjectInstance): PetBias {
  if (obj.type !== 'pet_bowl' && obj.type !== 'pet_toy' && obj.type !== 'dog_walk') return NO_PET_BIAS;
  const store = stores.get(world);
  const pet = store?.pets[0];
  if (!store || !pet) return NOT_NEEDED;
  const hour = timeFromTick(world.tick).hour;
  if (obj.type === 'pet_bowl') {
    if (store.bowls[obj.uid] || pet.needs.hunger >= CARE_BELOW.hunger) return NOT_NEEDED;
    const u = clamp01((CARE_BELOW.hunger - pet.needs.hunger) / CARE_BELOW.hunger);
    return { mult: 1.5 + 1.5 * u, add: 6 + 10 * u };
  }
  if (obj.type === 'pet_toy') {
    if (pet.needs.fun >= CARE_BELOW.fun || (pet.activity === 'sleep' && isNight(hour)) || pet.activity === 'walk') return NOT_NEEDED;
    const u = clamp01((CARE_BELOW.fun - pet.needs.fun) / CARE_BELOW.fun);
    return { mult: 1.2 + u, add: 3 + 6 * u };
  }
  if (pet.species !== 'dog' || pet.needs.walk >= CARE_BELOW.walk || hour >= 21 || hour < 7) return NOT_NEEDED;
  const u = clamp01((CARE_BELOW.walk - pet.needs.walk) / CARE_BELOW.walk);
  return { mult: 1.5 + 1.5 * u, add: 6 + 10 * u };
}

// ---------------------------------------------------------------- pet's side

function objectOfType(world: World, type: string): ObjectInstance | undefined {
  return world.objects.find((o) => o.type === type);
}

function tileOf(p: Vec2): Vec2 {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * walks to `target` within this tick; false when it cannot get there. indoorOnly keeps a pet that is
 * inside from crossing the garden (a pet already outside, back from a walk, may come home).
 */
function goTo(world: World, pet: Pet, target: Vec2, indoorOnly: boolean): boolean {
  const from = tileOf(pet.pos);
  const to = tileOf(target);
  if (from.x === to.x && from.y === to.y) {
    pet.path = [];
    return true;
  }
  const g = world.grid;
  const inside = indoorOnly && !isOutdoorTile(g, from.x, from.y);
  if (inside && isOutdoorTile(g, to.x, to.y)) return false;
  const path = findPath(g, from, to, { maxNodes: 6000, extraBlocked: inside ? (x, y) => isOutdoorTile(g, x, y) : undefined });
  if (!path) return false;
  pet.path = path;
  stepAgent(pet, WALK_SPEED, world.tick);
  return true;
}

/** a free tile next to a resident (deterministic order), the resident's own tile as a last resort */
function besideOf(world: World, agent: Agent): Vec2 {
  const c = tileOf(agent.pos);
  const order: [number, number][] = [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [0, -1], [1, -1], [-1, -1]];
  for (const [dx, dy] of order) if (isWalkable(world.grid, c.x + dx, c.y + dy)) return { x: c.x + dx, y: c.y + dy };
  return c;
}

const near = (a: Vec2, b: Vec2, d: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= d;

function setActivity(world: World, pet: Pet, activity: PetActivity, withId: number | null = null): void {
  if (pet.activity !== activity || pet.withId !== withId) pet.since = world.tick;
  pet.activity = activity;
  pet.withId = withId;
}

/** residents using the pet objects this tick: object type → agent */
function carers(world: World): Map<string, { agent: Agent; obj: ObjectInstance; using: boolean }> {
  const out = new Map<string, { agent: Agent; obj: ObjectInstance; using: boolean }>();
  for (const a of world.agents) {
    const act = a.action;
    if (act?.kind !== 'use') continue;
    const obj = world.objects.find((o) => o.uid === act.objectUid);
    if (obj && (obj.type === 'pet_bowl' || obj.type === 'pet_toy' || obj.type === 'dog_walk'))
      out.set(obj.type, { agent: a, obj, using: act.phase === 'using' });
  }
  return out;
}

/** shares the narration budget (agents/narration.ts): false = the hour already had enough stories */
function story(world: World, agent: Agent, text: string, valence: number): boolean {
  return narrateStory(world, 'use', text, [agent.id], { text, aboutIds: [agent.id], valence });
}

const FEED_TEXT: Record<PetSpecies, ((a: string, p: string) => string)[]> = {
  cat: [(a, p) => `${a} nasypuje karmę, ${p} już czeka przy misce`, (a, p) => `${a} karmi kota — ${p} mruczy przy misce`],
  dog: [(a, p) => `${a} nasypuje karmę, ${p} merda ogonem przy misce`, (a, p) => `${a} karmi psa — ${p} pałaszuje w sekundę`],
};
const PLAY_TEXT: Record<PetSpecies, ((a: string, p: string) => string)[]> = {
  cat: [(a, p) => `${a} bawi się z kotem — ${p} goni kłębek wełny`, (a, p) => `${a} macha wędką z piórkiem, ${p} poluje`],
  dog: [(a, p) => `${a} rzuca piłkę, ${p} aportuje`, (a, p) => `${a} i ${p} przeciągają sznurek`],
};
const WALK_TEXT: ((a: string, p: string) => string)[] = [
  (a, p) => `${a} i ${p} wychodzą na spacer`,
  (a, p) => `${a} zabiera psa na spacer, ${p} ciągnie smycz`,
];
const MOMENT_TEXT: Record<PetSpecies, { text: (a: string, p: string) => string; valence: number }[]> = {
  cat: [
    { text: (a, p) => `${a} głaszcze kota, ${p} mruczy z zadowolenia`, valence: 0.5 },
    { text: (a, p) => `${p} wskakuje na kolana: ${a} nie może wstać`, valence: 0.4 },
    { text: (a, p) => `${p} strąca kubek ze stołu, ${a} sprząta skorupy`, valence: -0.2 },
  ],
  dog: [
    { text: (a, p) => `${a} drapie psa za uchem, ${p} merda ogonem`, valence: 0.5 },
    { text: (a, p) => `${p} kradnie skarpetkę, ${a} goni psa po całym domu`, valence: 0.1 },
    { text: (a, p) => `${p} kładzie łeb na kolanach: ${a} od razu się uśmiecha`, valence: 0.5 },
  ],
};
const HUNGRY_TEXT: Record<PetSpecies, (p: string) => string> = {
  cat: (p) => `${p} miauczy przy pustej misce`,
  dog: (p) => `${p} szczeka przy pustej misce`,
};

function decay(pet: Pet, sleeping: boolean): void {
  const n = pet.needs;
  const s = sleeping ? 'asleep' : 'awake';
  n.hunger = Math.max(0, n.hunger - DECAY.hunger[s]);
  n.fun = Math.max(0, n.fun - DECAY.fun[s]);
  n.energy = sleeping ? Math.min(100, n.energy + SLEEP_RATE) : Math.max(0, n.energy - DECAY.energy[pet.species]);
  if (pet.species === 'dog') n.walk = Math.max(0, n.walk - DECAY.walk[s]);
}

function moodOf(pet: Pet): number {
  const n = pet.needs;
  const low = (v: number): number => v * (0.6 + 0.4 * (v / 100));
  const m = pet.species === 'dog'
    ? 0.3 * low(n.hunger) + 0.25 * low(n.fun) + 0.2 * low(n.energy) + 0.25 * low(n.walk)
    : 0.4 * low(n.hunger) + 0.35 * low(n.fun) + 0.25 * low(n.energy);
  return Math.round(Math.max(0, Math.min(100, m / 0.8)) * 10) / 10;
}

/** somewhere to go when nothing is going on: another room, or the company of a resident */
function stroll(world: World, store: PetStore, pet: Pet): void {
  const rng = store.rng;
  const awake = world.agents.filter((a) => a.action?.kind !== 'use' || a.action.phase !== 'using' || !isBedLike(world, a));
  if (awake.length && rng.chance(0.45)) {
    const a = rng.pick(awake);
    if (goTo(world, pet, besideOf(world, a), true)) {
      setActivity(world, pet, 'cuddle', a.id);
      return;
    }
  }
  const rooms = world.grid.rooms;
  if (!rooms.length) return;
  const room = rng.pick(rooms);
  for (let i = 0; i < 6; i++) {
    const x = rng.int(room.rect.x, room.rect.x + room.rect.w - 1);
    const y = rng.int(room.rect.y, room.rect.y + room.rect.h - 1);
    if (isWalkable(world.grid, x, y) && goTo(world, pet, { x, y }, true)) {
      setActivity(world, pet, 'stroll');
      return;
    }
  }
}

function isBedLike(world: World, a: Agent): boolean {
  const act = a.action;
  if (act?.kind !== 'use') return false;
  const obj = world.objects.find((o) => o.uid === act.objectUid);
  return !!obj && /bed/.test(obj.type) && !obj.type.startsWith('pet_');
}

function tickPet(world: World, store: PetStore, pet: Pet, care: ReturnType<typeof carers>): void {
  const hour = timeFromTick(world.tick).hour;
  const night = isNight(hour);
  const rng = store.rng;
  const bowl = objectOfType(world, 'pet_bowl');
  const cushion = objectOfType(world, 'pet_cushion');
  decay(pet, pet.activity === 'sleep');

  // residents' visits: a filled bowl, a new walk or game (one story per visit)
  for (const [type, c] of care) {
    const fresh = store.users[c.obj.uid] !== c.agent.id;
    store.users[c.obj.uid] = c.agent.id;
    if (!fresh && type !== 'pet_bowl') continue;
    if (type === 'pet_bowl' && c.using && !store.bowls[c.obj.uid]) {
      store.bowls[c.obj.uid] = true;
      story(world, c.agent, rng.pick(FEED_TEXT[pet.species])(c.agent.name, pet.name), 0.3);
    } else if (fresh && type === 'pet_toy') story(world, c.agent, rng.pick(PLAY_TEXT[pet.species])(c.agent.name, pet.name), 0.4);
    else if (fresh && type === 'dog_walk' && pet.species === 'dog') story(world, c.agent, rng.pick(WALK_TEXT)(c.agent.name, pet.name), 0.3);
  }
  for (const uid of Object.keys(store.users).map(Number))
    if (![...care.values()].some((c) => c.obj.uid === uid)) delete store.users[uid];

  const walker = pet.species === 'dog' ? care.get('dog_walk') : undefined;
  const player = care.get('pet_toy');
  const bowlFull = !!bowl && !!store.bowls[bowl.uid];

  if (walker) {
    // follows the walker there and back (the walk itself happens at the walk spot)
    if (!near(pet.pos, walker.agent.pos, 1.5)) goTo(world, pet, besideOf(world, walker.agent), false);
    setActivity(world, pet, 'walk', walker.agent.id);
    if (near(pet.pos, walker.agent.pos, 3)) {
      pet.needs.walk = Math.min(100, pet.needs.walk + WALK_RATE);
      pet.needs.fun = Math.min(100, pet.needs.fun + 0.4);
    }
  } else if (cushion && isOutdoorTile(world.grid, Math.round(pet.pos.x), Math.round(pet.pos.y))) {
    // back from a walk: straight home
    goTo(world, pet, cushion.pos, false);
    setActivity(world, pet, 'idle');
  } else if (player?.using && !(pet.activity === 'sleep' && night) && goTo(world, pet, besideOf(world, player.agent), true)) {
    setActivity(world, pet, 'play', player.agent.id);
    pet.needs.fun = Math.min(100, pet.needs.fun + PLAY_RATE);
  } else if (bowl && bowlFull && (pet.activity === 'eat' || (pet.needs.hunger < EAT_BELOW && goTo(world, pet, bowl.pos, true)))) {
    // once at the bowl it eats it all up
    setActivity(world, pet, 'eat');
    pet.needs.hunger = Math.min(100, pet.needs.hunger + EAT_RATE);
    if (pet.needs.hunger >= 98) {
      store.bowls[bowl.uid] = false;
      store.complained[pet.id] = false;
      setActivity(world, pet, 'idle');
    }
  } else if (pet.activity === 'sleep' && (night || pet.needs.energy < 95)) {
    // keeps sleeping
  } else if ((night || pet.needs.energy < NAP_ENERGY) && cushion) {
    if (goTo(world, pet, cushion.pos, true)) setActivity(world, pet, 'sleep');
  } else {
    if (pet.activity === 'sleep' || pet.activity === 'eat' || pet.activity === 'play' || pet.activity === 'walk') setActivity(world, pet, 'idle');
    const company = pet.withId === null ? undefined : world.agents.find((a) => a.id === pet.withId);
    if (company && pet.activity === 'cuddle') {
      if (!near(pet.pos, company.pos, 2.5)) setActivity(world, pet, 'idle');
      else pet.needs.fun = Math.min(100, pet.needs.fun + COMPANY_FUN);
    }
    // a short stay, then somewhere else (cats lounge longer)
    const stay = world.tick - pet.since;
    const restless = pet.species === 'dog' ? 0.06 : 0.035;
    if (stay >= 8 && rng.chance(restless)) stroll(world, store, pet);
    // petting, mischief: a resident right next to it
    if (company && pet.activity === 'cuddle' && rng.chance(MOMENT_CHANCE * 6)) {
      const m = rng.pick(MOMENT_TEXT[pet.species]);
      if (story(world, company, m.text(company.name, pet.name), m.valence)) {
        company.needs.fun = Math.min(100, company.needs.fun + 3);
        company.needs.social = Math.min(100, company.needs.social + 2);
      }
    }
  }

  if (pet.needs.hunger < 20 && !bowlFull && !store.complained[pet.id] && pet.activity !== 'sleep') {
    store.complained[pet.id] = true;
    narrateStory(world, 'info', HUNGRY_TEXT[pet.species](pet.name), []);
  }
  pet.mood = moodOf(pet);
}

/** once per tick, after the residents moved */
export function tickPets(world: World): void {
  const store = stores.get(world);
  if (!store) return;
  const care = carers(world);
  for (const pet of store.pets) tickPet(world, store, pet, care);
}

// ---------------------------------------------------------------- labels (UI)

export function describePet(world: World, pet: Pet): string {
  const who = pet.withId === null ? undefined : world.agents.find((a) => a.id === pet.withId)?.name;
  switch (pet.activity) {
    case 'sleep':
      return 'Śpi na legowisku';
    case 'eat':
      return 'Je z miski';
    case 'play':
      return who ? `Bawi się (${who})` : 'Bawi się';
    case 'walk':
      return who ? `Na spacerze (${who})` : 'Na spacerze';
    case 'cuddle':
      return who ? `Kręci się przy: ${who}` : 'Kręci się przy domownikach';
    case 'stroll':
      return 'Spaceruje po domu';
    default:
      return pet.needs.hunger < CARE_BELOW.hunger ? 'Czeka na jedzenie' : 'Odpoczywa';
  }
}

export function petIcon(pet: Pet): string {
  return pet.species === 'cat' ? '🐈' : '🐕';
}

// ---------------------------------------------------------------- snapshot

interface PetsSnapshot {
  pets: Pet[];
  rng: number;
  bowls: Record<number, boolean>;
  users: Record<number, number>;
  complained: Record<number, boolean>;
  moves: Record<number, { trail: TrailPoint[]; clockTick: number; clockT: number } | null>;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

registerWorldState('pets', {
  // worlds saved before pets existed get theirs on load (ensurePets)
  optional: true,
  save: (world) => {
    const s = stores.get(world);
    if (!s) return null;
    const snap: PetsSnapshot = {
      pets: copy(s.pets),
      rng: s.rng.state(),
      bowls: { ...s.bowls },
      users: { ...s.users },
      complained: { ...s.complained },
      moves: Object.fromEntries(s.pets.map((p) => [p.id, saveWalkerMove(p)])),
    };
    return copy(snap) as unknown as Json;
  },
  load: (world, data) => {
    const d = copy(data as unknown as PetsSnapshot);
    stores.set(world, {
      pets: d.pets,
      rng: createRng((world.seed ^ RNG_SALT) >>> 0, d.rng),
      bowls: d.bowls,
      users: d.users,
      complained: d.complained,
    });
    for (const p of d.pets) loadWalkerMove(p, d.moves[p.id]);
  },
  clear: (world) => void stores.delete(world),
  missing: (world) => ensurePets(world),
});
