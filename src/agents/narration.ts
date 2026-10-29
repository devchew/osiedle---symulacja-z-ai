import type { Agent, Gossip, NeedKey, ObjectDef, SimEventKind, World } from '../types';
import { pushEvent } from '../world/events';
import { loadByAgent, registerWorldState, saveByAgent, type Json } from '../core/state';

// Small story beats for the event log: mishaps and successes during activities,
// mood swings and neglected needs. Polish texts avoid gendered past tense and
// never decline names ("Ola: …", "Ola ↔ Bartek: …"). Story-worthy events carry
// a Gossip (third person, present tense, name first and not declined, e.g.
// "Ola przypala obiad") that residents remember and retell (social/memory.ts).

/** at most this many narration events per game hour across the whole world */
export const NARRATION_PER_HOUR = 4;
/** per agent, the same kind of state event (mood / need) repeats at most this often */
const STATE_COOLDOWN = 8 * 60;
const MOOD_HIGH = 85;
const MOOD_HIGH_RESET = 72;
const MOOD_LOW = 28;
const MOOD_LOW_RESET = 42;
const NEED_LOW: Partial<Record<NeedKey, { at: number; reset: number; texts: string[] }>> = {
  hunger: { at: 12, reset: 40, texts: ['pusty żołądek!', 'burczy w brzuchu na cały dom'] },
  energy: { at: 8, reset: 40, texts: ['oczy same się zamykają', 'ledwo trzyma się na nogach'] },
  social: { at: 10, reset: 40, texts: ['tęsknota za towarzystwem', 'nikt nie ma czasu na pogawędkę…'] },
  hygiene: { at: 8, reset: 40, texts: ['najwyższa pora na prysznic'] },
};

/** a log text and, optionally, the retellable story (without the subject's name) */
type Beat = [log: string, gossip?: string];

interface Mishap {
  chance: number;
  /** variants: [log text, gossip predicate] */
  text: Beat[];
  /** story valence (-1..1); used when the beat has a gossip predicate */
  valence?: number;
  icon: string;
  /** scale of the object's effects for this use (mishaps < 1) */
  scale?: number;
  /** one-off need change */
  bump?: Partial<Record<NeedKey, number>>;
  kind?: SimEventKind;
}

/** rolled when an agent starts using an object */
const ON_START: Record<string, Mishap[]> = {
  stove: [
    { chance: 0.08, text: [['przypala obiad 🔥', 'przypala obiad'], ['przypala sos 🔥', 'przypala sos']], valence: -0.5, icon: '🔥', scale: 0.6, bump: { fun: -5 } },
    { chance: 0.05, text: [['wymyśla nowy przepis 🍽️', 'wymyśla nowy przepis']], valence: 0.5, icon: '✨', bump: { fun: 8 } },
  ],
  grill: [{ chance: 0.05, text: [['przypala kiełbaski 🔥', 'przypala kiełbaski na grillu']], valence: -0.5, icon: '🔥', scale: 0.7 }],
  shower: [{ chance: 0.06, text: [['zimna woda pod prysznicem! 🥶', 'bierze lodowaty prysznic']], valence: -0.2, icon: '🥶', bump: { comfort: -10 } }],
  computer: [{ chance: 0.05, text: [['komputer się zawiesza 💻', 'klnie na zawieszony komputer']], valence: -0.3, icon: '😤', scale: 0.5, bump: { fun: -5 } }],
  piano: [{ chance: 0.06, text: [['ćwiczy nowy utwór 🎶', 'ćwiczy nowy utwór na pianinie']], valence: 0.4, icon: '🎶', bump: { fun: 5 } }],
  fridge: [{ chance: 0.03, text: [['w lodówce pustki…', 'wyjada ostatnie zapasy z lodówki']], valence: -0.3, icon: '😕', scale: 0.5 }],
  tv: [{ chance: 0.05, text: [['leci ulubiony serial! 📺']], icon: '😍', bump: { fun: 6 } }],
  bathtub: [{ chance: 0.05, text: [['piana po sam sufit 🛁', 'robi w wannie pianę po sam sufit']], valence: 0.2, icon: '🛁', bump: { fun: 5 } }],
};

/** rolled when an agent finishes a full session */
const ON_FINISH: Record<string, Mishap[]> = {
  fishing_spot: [
    { chance: 0.18, text: [['złowiony szczupak! 🐟', 'łowi wielkiego szczupaka'], ['piękny karp na haczyku! 🐟', 'łowi pięknego karpia']], valence: 0.6, icon: '🐟', bump: { fun: 10 } },
    { chance: 0.08, text: [['ryba się zerwała…', 'gubi rybę tuż przy brzegu']], valence: -0.3, icon: '😩', bump: { fun: -3 } },
  ],
  computer: [{ chance: 0.1, text: [['wygrana partia! 🏆', 'wygrywa partię na komputerze']], valence: 0.4, icon: '🏆', bump: { fun: 8 } }],
  treadmill: [{ chance: 0.1, text: [['nowy rekord na bieżni! 🏅', 'bije rekord na bieżni']], valence: 0.6, icon: '🏅', bump: { fun: 8 } }],
  exercise_bike: [{ chance: 0.1, text: [['20 km na rowerku! 🏅', 'robi 20 km na rowerku']], valence: 0.5, icon: '🏅', bump: { fun: 8 } }],
  flowerbed: [{ chance: 0.1, text: [['tulipany zakwitły 🌷', 'ma najpiękniejsze tulipany w ogrodzie']], valence: 0.5, icon: '🌷', bump: { fun: 6 } }],
  bench: [{ chance: 0.08, text: [['chwila spokoju na ławce 🌿']], icon: '🌿', bump: { comfort: 5 } }],
  bookshelf: [{ chance: 0.08, text: [['książka skończona — świetne zakończenie 📖', 'kończy świetną książkę']], valence: 0.3, icon: '📖', bump: { fun: 6 } }],
};

const recentEvents = new WeakMap<World, number[]>();

/** rate limiter shared by all narration */
function budget(world: World): boolean {
  let list = recentEvents.get(world);
  if (!list) recentEvents.set(world, (list = []));
  while (list.length > 0 && world.tick - list[0] >= 60) list.shift();
  return list.length < NARRATION_PER_HOUR;
}

function narrate(world: World, kind: SimEventKind, text: string, ids: number[], gossip?: Gossip): void {
  recentEvents.get(world)?.push(world.tick);
  pushEvent(world, kind, text, ids, gossip);
}

/** story about a single agent: "<name> <predicate>" */
function story(agent: Agent, predicate: string | undefined, valence: number | undefined): Gossip | undefined {
  if (!predicate || valence === undefined) return undefined;
  return { text: `${agent.name} ${predicate}`, aboutIds: [agent.id], valence };
}

const effectScale = new WeakMap<Agent, number>();

/** multiplier for the current activity's effects (mishaps make it less effective) */
export function useEffectScale(agent: Agent): number {
  return effectScale.get(agent) ?? 1;
}

function roll(world: World, agent: Agent, list: Mishap[] | undefined): boolean {
  if (!list || !budget(world)) return false;
  for (const m of list) {
    if (!world.rng.chance(m.chance)) continue;
    if (m.scale !== undefined) effectScale.set(agent, m.scale);
    if (m.bump) for (const [k, v] of Object.entries(m.bump) as [NeedKey, number][]) agent.needs[k] = Math.max(0, Math.min(100, agent.needs[k] + v));
    agent.bubble = { kind: 'thought', text: m.icon, ttl: 25 };
    const [log, predicate] = world.rng.pick(m.text);
    narrate(world, m.kind ?? 'use', `${agent.name}: ${log}`, [agent.id], story(agent, predicate, m.valence));
    return true;
  }
  return false;
}

/** called when an agent arrives and starts using an object; `others` = agents already using it */
export function onStartUse(world: World, agent: Agent, def: ObjectDef, others: Agent[]): void {
  effectScale.delete(agent);
  if (def.id === 'tv' && others.length > 0 && budget(world) && world.rng.chance(0.08)) {
    const other = others[0];
    world.relationships.adjust(agent.id, other.id, -2);
    agent.bubble = { kind: 'speech', text: 'Oddaj pilota!', ttl: 25, tone: 'negative' };
    narrate(world, 'relationship', `${agent.name} ↔ ${other.name}: kłótnia o pilota 📺`, [agent.id, other.id], {
      text: `${agent.name} i ${other.name} kłócą się o pilota`,
      aboutIds: [agent.id, other.id],
      valence: -0.5,
    });
    return;
  }
  roll(world, agent, ON_START[def.id]);
}

/** called when an activity ends; `completed` = it ran its full planned length */
export function onFinishUse(world: World, agent: Agent, def: ObjectDef, completed: boolean): void {
  effectScale.delete(agent);
  if (completed) roll(world, agent, ON_FINISH[def.id]);
}

interface StateFlags {
  moodHigh: boolean;
  moodLow: boolean;
  low: Partial<Record<NeedKey, boolean>>;
  lastMood: number;
  lastNeed: number;
}

const flags = new WeakMap<Agent, StateFlags>();

registerWorldState('narration', {
  save: (world) => {
    const recent = recentEvents.get(world);
    const scale = saveByAgent(world, effectScale);
    const f = saveByAgent(world, flags);
    return recent || scale || f ? { recent: recent ? [...recent] : null, scale, flags: f } : null;
  },
  load: (world, data) => {
    const d = data as { recent: number[] | null; scale: Json; flags: Json };
    if (d.recent) recentEvents.set(world, [...d.recent]);
    if (d.scale) loadByAgent(world, effectScale, d.scale);
    if (d.flags) loadByAgent(world, flags, d.flags);
  },
});

/** mood swings and neglected needs; called once per tick per agent after mood is updated */
export function narrateState(world: World, agent: Agent, sleeping: boolean): void {
  let f = flags.get(agent);
  if (!f) flags.set(agent, (f = { moodHigh: agent.mood >= MOOD_HIGH, moodLow: agent.mood <= MOOD_LOW, low: {}, lastMood: -1e9, lastNeed: -1e9 }));
  // nothing to tell about someone asleep; crossings are noticed after waking up
  if (sleeping) return;

  if (f.moodHigh && agent.mood < MOOD_HIGH_RESET) f.moodHigh = false;
  if (f.moodLow && agent.mood > MOOD_LOW_RESET) f.moodLow = false;
  if (!f.moodHigh && agent.mood >= MOOD_HIGH) {
    f.moodHigh = true;
    if (world.tick - f.lastMood >= STATE_COOLDOWN && budget(world)) {
      f.lastMood = world.tick;
      narrate(world, 'mood', `${agent.name} ma świetny humor ☀️`, [agent.id], story(agent, 'ma świetny humor', 0.3));
    }
  } else if (!f.moodLow && agent.mood <= MOOD_LOW) {
    f.moodLow = true;
    if (world.tick - f.lastMood >= STATE_COOLDOWN && budget(world)) {
      f.lastMood = world.tick;
      narrate(world, 'mood', `${agent.name}: kiepski dzień 🌧️`, [agent.id], story(agent, 'ma kiepski dzień', -0.3));
    }
  }

  for (const [k, cfg] of Object.entries(NEED_LOW) as [NeedKey, NonNullable<(typeof NEED_LOW)[NeedKey]>][]) {
    const v = agent.needs[k];
    if (f.low[k] && v > cfg.reset) f.low[k] = false;
    if (!f.low[k] && v <= cfg.at) {
      f.low[k] = true;
      if (world.tick - f.lastNeed >= STATE_COOLDOWN && budget(world)) {
        f.lastNeed = world.tick;
        narrate(world, 'info', `${agent.name}: ${world.rng.pick(cfg.texts)}`, [agent.id]);
      }
    }
  }
}
