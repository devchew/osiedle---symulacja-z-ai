import { NEED_KEYS } from '../types';
import type { Agent, NeedKey, Needs, Traits } from '../types';

const PER_HOUR = (hours: number): number => 100 / (hours * 60);

/** base decay per tick (game minute) for an awake, trait-neutral agent; 100 -> 0 in the given hours */
export const NEED_DECAY: Record<NeedKey, number> = {
  hunger: PER_HOUR(20),
  energy: PER_HOUR(18),
  fun: PER_HOUR(14),
  social: PER_HOUR(16),
  hygiene: PER_HOUR(26),
  comfort: PER_HOUR(16),
};

/** multiplier applied to NEED_DECAY while sleeping (energy is refilled by the bed's effect) */
export const SLEEP_DECAY_FACTOR: Record<NeedKey, number> = {
  hunger: 0.4,
  energy: 0,
  fun: 0.1,
  social: 0.1,
  hygiene: 0.4,
  comfort: 0.1,
};

/** how strongly traits scale decay: rate *= 1 + trait * factor */
export const TRAIT_DECAY = {
  socialPerSociability: 0.4,
  funPerActivity: 0.3,
  energyPerActivity: 0.15,
  hygienePerNeatness: 0.3,
  /** extra energy drain when awake late at night (23:00–05:00) */
  lateNightEnergy: 1.3,
} as const;

const clamp = (v: number, lo = 0, hi = 100): number => (v < lo ? lo : v > hi ? hi : v);

export function decayRate(key: NeedKey, traits: Traits, ctx: { sleeping: boolean; hour: number }): number {
  let r = NEED_DECAY[key];
  switch (key) {
    case 'social': r *= 1 + traits.sociability * TRAIT_DECAY.socialPerSociability; break;
    case 'fun': r *= 1 + traits.activity * TRAIT_DECAY.funPerActivity; break;
    case 'energy':
      r *= 1 + traits.activity * TRAIT_DECAY.energyPerActivity;
      if (!ctx.sleeping && (ctx.hour >= 23 || ctx.hour < 5)) r *= TRAIT_DECAY.lateNightEnergy;
      break;
    case 'hygiene': r *= 1 + traits.neatness * TRAIT_DECAY.hygienePerNeatness; break;
  }
  return ctx.sleeping ? r * SLEEP_DECAY_FACTOR[key] : r;
}

/** one tick of need decay; also refreshes mood */
export function decayNeeds(agent: Agent, ctx: { sleeping: boolean; hour: number }): void {
  for (const k of NEED_KEYS) agent.needs[k] = clamp(agent.needs[k] - decayRate(k, agent.traits, ctx));
  agent.mood = computeMood(agent.needs, agent.traits);
}

export function applyEffects(agent: Agent, effects: Partial<Record<NeedKey, number>>, scale = 1): void {
  for (const k of NEED_KEYS) {
    const e = effects[k];
    if (e) agent.needs[k] = clamp(agent.needs[k] + e * scale);
  }
}

/** 0..1, convex: gentle while satisfied, steep below ~20 */
export function urgency(value: number): number {
  const d = (100 - clamp(value)) / 100;
  return 0.8 * d * d + 0.2 * Math.max(0, (d - 0.8) / 0.2);
}

/** weighted mean of needs where low needs weigh more; cheerfulness shifts by up to ±10 */
export function computeMood(needs: Needs, traits: Traits): number {
  let sum = 0;
  let wsum = 0;
  for (const k of NEED_KEYS) {
    const w = 1 + 4 * urgency(needs[k]);
    sum += needs[k] * w;
    wsum += w;
  }
  return clamp(sum / wsum + traits.cheerfulness * 10);
}

export function lowestNeed(needs: Needs): NeedKey {
  let best: NeedKey = NEED_KEYS[0];
  for (const k of NEED_KEYS) if (needs[k] < needs[best]) best = k;
  return best;
}
