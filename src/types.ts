// Shared contracts between simulation modules. Changing anything here is a
// cross-module change: log it in plan/DECISIONS.md.
//
// Coordinates: everything in the simulation uses tile units. Integer values are
// tile centres, so an agent standing on tile (3, 4) has pos { x: 3, y: 4 }.
// Time: one simulation tick = one game minute.

export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- core

export interface Rng {
  /** float in [0, 1) */
  next(): number;
  /** float in [min, max) */
  range(min: number, max: number): number;
  /** integer in [min, max] (inclusive) */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** picks an index with probability proportional to weight (weights >= 0) */
  weightedIndex(weights: readonly number[]): number;
  /** current internal state, for snapshots / determinism checks */
  state(): number;
}

export type DayPhase = 'night' | 'morning' | 'day' | 'evening';

export interface GameTime {
  tick: number;
  /** 1-based day counter */
  day: number;
  hour: number;
  minute: number;
  phase: DayPhase;
  /** 0 = darkest night, 1 = full daylight; smooth across dawn/dusk */
  daylight: number;
}

// ---------------------------------------------------------------- world

export type TileKind = 'grass' | 'path' | 'floor' | 'tile' | 'wall' | 'door' | 'water';

export interface RectArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: string;
  /** display name, Polish (e.g. "Kuchnia") */
  name: string;
  rect: RectArea;
}

export interface Grid {
  width: number;
  height: number;
  /** row-major, index = y * width + x */
  tiles: TileKind[];
  /** row-major; true for walls, water and blocking object footprints */
  solid: boolean[];
  rooms: Room[];
}

export type NeedKey = 'hunger' | 'energy' | 'fun' | 'social' | 'hygiene' | 'comfort';
export const NEED_KEYS: readonly NeedKey[] = ['hunger', 'energy', 'fun', 'social', 'hygiene', 'comfort'];
export const NEED_LABELS: Record<NeedKey, string> = {
  hunger: 'Głód',
  energy: 'Energia',
  fun: 'Zabawa',
  social: 'Towarzystwo',
  hygiene: 'Higiena',
  comfort: 'Komfort',
};
export const NEED_ICONS: Record<NeedKey, string> = {
  hunger: '🍽️',
  energy: '⚡',
  fun: '🎲',
  social: '💬',
  hygiene: '🧼',
  comfort: '🛋️',
};

/** 0..100 where 100 = fully satisfied, 0 = desperate */
export type Needs = Record<NeedKey, number>;

export interface ObjectSlot {
  /** tile (relative to object origin) where the agent stands to use the object; must be walkable */
  stand: Vec2;
  /** where the agent is drawn while using it (relative to origin, may be inside the footprint); defaults to stand */
  use?: Vec2;
}

export interface ObjectDef {
  id: string;
  /** Polish display name, e.g. "Lodówka" */
  name: string;
  /** Polish progressive label for the action, e.g. "Je przekąskę" */
  verb: string;
  icon: string;
  color: string;
  size: { w: number; h: number };
  blocking: boolean;
  slots: ObjectSlot[];
  /** need change per tick while using (positive = satisfying, negative = cost) */
  effects: Partial<Record<NeedKey, number>>;
  /** usage length in ticks, [min, max] */
  duration: [number, number];
  /** if true, agents using it at the same time may chat */
  social?: boolean;
  tags?: string[];
}

export interface ObjectInstance {
  uid: number;
  type: string;
  /** top-left tile of the footprint */
  pos: Vec2;
  /** agent id per slot, or null when free (reservation also covers walking there) */
  reservedBy: (number | null)[];
}

// ---------------------------------------------------------------- agents

/** each trait in [-1, 1] */
export interface Traits {
  /** -1 introvert .. 1 extrovert */
  sociability: number;
  /** -1 lazy .. 1 active */
  activity: number;
  /** -1 messy .. 1 neat */
  neatness: number;
  /** -1 grumpy .. 1 cheerful */
  cheerfulness: number;
}

export type Action =
  | { kind: 'use'; phase: 'walking' | 'using'; objectUid: number; slot: number; ticksLeft: number; label: string; icon: string }
  | { kind: 'talk'; phase: 'approaching' | 'talking'; partnerId: number; conversationId: number | null; ticksLeft: number; label: string; icon: string }
  | { kind: 'wander'; phase: 'walking'; ticksLeft: number; label: string; icon: string }
  | { kind: 'idle'; ticksLeft: number; label: string; icon: string };

export interface Bubble {
  kind: 'speech' | 'thought';
  text: string;
  /** remaining ticks */
  ttl: number;
  tone?: Tone;
}

export interface AgentStats {
  conversations: number;
  objectsUsed: number;
  ticksIdle: number;
}

export interface Agent {
  id: number;
  name: string;
  /** body colour, CSS colour string */
  color: string;
  traits: Traits;
  needs: Needs;
  /** 0..100 */
  mood: number;
  pos: Vec2;
  /** position at the previous tick, used by the renderer for interpolation */
  prevPos: Vec2;
  /** -1 facing left, 1 facing right */
  facing: -1 | 1;
  /** remaining tiles to walk, excluding the current position */
  path: Vec2[];
  action: Action | null;
  bubble: Bubble | null;
  stats: AgentStats;
}

// ---------------------------------------------------------------- social

export type Tone = 'positive' | 'neutral' | 'negative';

export interface DialogueLine {
  speakerId: number;
  text: string;
  tone: Tone;
  /** the story this line retells, if any (set by the provider; read by social/memory to spread gossip) */
  gossip?: Gossip;
}

export interface Conversation {
  id: number;
  participants: [number, number];
  topic: string;
  lines: DialogueLine[];
  /** ticks until the next line is requested */
  nextLineIn: number;
  /** true while waiting for an async provider */
  pending: boolean;
  maxLines: number;
  startedAt: number;
}

export interface ConversationContext {
  speaker: Agent;
  listener: Agent;
  /** speaker's sympathy towards listener, -100..100 */
  relationship: number;
  topic: string;
  history: DialogueLine[];
  /** index of the line being generated (0-based) */
  turn: number;
  isLast: boolean;
  time: GameTime;
  /** stories the speaker remembers and could bring up (about third persons or shared moments) */
  gossip?: Gossip[];
  /** TV news headlines the speaker saw recently (newest first) */
  news?: string[];
}

export interface DialogueProvider {
  readonly name: string;
  /** procedural providers return synchronously; LLM providers return a Promise */
  nextLine(ctx: ConversationContext, rng: Rng): DialogueLine | Promise<DialogueLine>;
}

export interface Relationships {
  /** symmetric sympathy -100..100, 0 if unknown */
  get(a: number, b: number): number;
  /** adds delta (clamped) and returns the new value */
  adjust(a: number, b: number, delta: number): number;
  /** all known pairs with a < b */
  all(): { a: number; b: number; value: number }[];
}

// ---------------------------------------------------------------- simulation

export type SimEventKind = 'conversation' | 'use' | 'relationship' | 'mood' | 'info';

/** something worth retelling: residents remember it and may gossip about it */
export interface Gossip {
  /** retellable Polish phrase in the third person, present tense, names not declined, e.g. "Ola przypala obiad" */
  text: string;
  /** who the story is about */
  aboutIds: number[];
  /** -1 embarrassing / bad .. 1 nice / admirable */
  valence: number;
  /** recall only: both speaker and listener lived through it ("Pamiętasz, jak …?") */
  shared?: boolean;
}

export interface SimEvent {
  tick: number;
  kind: SimEventKind;
  /** Polish, human readable */
  text: string;
  agentIds: number[];
  gossip?: Gossip;
}

export interface World {
  seed: number;
  rng: Rng;
  tick: number;
  grid: Grid;
  objectDefs: Record<string, ObjectDef>;
  objects: ObjectInstance[];
  agents: Agent[];
  relationships: Relationships;
  conversations: Conversation[];
  /** newest last, capped (see MAX_EVENTS) */
  events: SimEvent[];
  dialogue: DialogueProvider;
}

export const MAX_EVENTS = 200;

/** what the UI may read / control about the running simulation */
export interface SimControls {
  readonly paused: boolean;
  readonly speed: number;
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  time(): GameTime;
}
