// Pure mapping from the world state to sound parameters (no DOM, no Web Audio): the engine in
// engine.ts only plays what this module asks for. Everything is procedural, there are no audio files.

export interface SoundInput {
  /** 0 = darkest night, 1 = full daylight (GameTime.daylight) */
  daylight: number;
  weather: 'sunny' | 'cloudy' | 'rain' | 'storm';
  /** 0..1 weather intensity */
  intensity: number;
}

/** relative loudness of each ambient layer, 0..1 */
export interface SoundMix {
  birds: number;
  crickets: number;
  wind: number;
  rain: number;
}

export type EffectId = 'water' | 'sizzle' | 'flush' | 'piano';

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const smooth = (from: number, to: number, x: number): number => {
  const t = clamp01((x - from) / (to - from));
  return t * t * (3 - 2 * t);
};

export function soundMix({ daylight, weather, intensity }: SoundInput): SoundMix {
  const power = clamp01(intensity);
  const raining = weather === 'rain' || weather === 'storm';
  const rain = raining ? 0.35 + 0.65 * power : 0;
  const wind = weather === 'storm' ? 0.6 + 0.4 * power : weather === 'rain' ? 0.2 + 0.2 * power : weather === 'cloudy' ? 0.25 : 0.12;
  // animals fall silent in the rain and the storm
  const calm = raining ? 0 : weather === 'cloudy' ? 0.7 : 1;
  return {
    birds: smooth(0.35, 0.8, daylight) * calm,
    crickets: smooth(0.5, 0.1, daylight) * calm,
    wind,
    rain,
  };
}

/** sound of a resident using an object of this type, if it has one */
const OBJECT_EFFECT: Record<string, EffectId> = {
  shower: 'water',
  bathtub: 'water',
  sink: 'water',
  toilet: 'flush',
  stove: 'sizzle',
  grill: 'sizzle',
  piano: 'piano',
};

export function effectForObject(type: string | undefined): EffectId | null {
  return (type && OBJECT_EFFECT[type]) || null;
}

export interface UsingAgent {
  id: number;
  action: { kind: string; phase?: string; objectUid?: number } | null;
}

/**
 * Effects for residents who started using an object since `prev` (agent id → object uid).
 * `prev = null` (first look at a world) only records the state, so nothing plays for the past.
 */
export function newEffects(
  prev: ReadonlyMap<number, number> | null,
  agents: readonly UsingAgent[],
  typeOf: (uid: number) => string | undefined,
): { effects: EffectId[]; next: Map<number, number> } {
  const next = new Map<number, number>();
  const effects: EffectId[] = [];
  for (const a of agents) {
    const { action } = a;
    if (!action || action.kind !== 'use' || action.phase !== 'using' || action.objectUid === undefined) continue;
    next.set(a.id, action.objectUid);
    if (!prev || prev.get(a.id) === action.objectUid) continue;
    const fx = effectForObject(typeOf(action.objectUid));
    if (fx) effects.push(fx);
  }
  return { effects, next };
}
