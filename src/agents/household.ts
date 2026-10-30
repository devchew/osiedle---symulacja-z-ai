import type { World } from '../types';
import { registerWorldState, type Json } from '../core/state';

// The household's purse and pantry (issue #8). A leaf module: wages, shopping trips and repairs
// live in agents/work.ts and world/incidents.ts and only call in here. Lazy per-world state, so
// worlds from before this module simply start with the defaults on first use.

export const HOUSEHOLD_TUNING = {
  /** starting purse and pantry, per resident */
  START_MONEY: 40,
  START_STOCK: 3,
  /** the pantry holds this many portions per resident; a shopping trip fills it */
  CAPACITY: 5,
  /** somebody goes shopping when the pantry is down to this many portions per resident (at least 2) */
  LOW_PER_RESIDENT: 1,
  PRICE: 2,
  /** even with an empty purse a trip brings this many portions per resident (on credit) */
  MIN_BUY_PER_RESIDENT: 3,
  /** rent, power and the like, per resident per day */
  BILLS_PER_DAY: 4,
  REPAIR_PARTS: 12,
  HANDYMAN: 40,
  /** utility multiplier of cooking / snacking when the pantry cannot cover it */
  EMPTY_FACTOR: 0.1,
} as const;

/** portions taken from the pantry by one use of a food object */
export const PORTIONS: Record<string, number> = { fridge: 1, stove: 1, grill: 1 };

export interface Household {
  /** zł; may go below zero (credit), the next wages pay it off */
  money: number;
  /** portions in the fridge */
  stock: number;
  /** resident on a shopping trip right now (one at a time) */
  shopper: number | null;
  /** totals since the world began, for metrics and the UI */
  trips: number;
  earned: number;
  spent: { food: number; repairs: number; bills: number };
}

const states = new WeakMap<World, Household>();

registerWorldState('household', {
  save: (world) => {
    const h = states.get(world);
    return h ? (JSON.parse(JSON.stringify(h)) as Json) : null;
  },
  load: (world, data) => void states.set(world, JSON.parse(JSON.stringify(data)) as Household),
  clear: (world) => void states.delete(world),
  optional: true,
});

export function householdOf(world: World): Household {
  let h = states.get(world);
  if (!h) {
    const n = world.agents.length;
    h = {
      money: HOUSEHOLD_TUNING.START_MONEY * n,
      stock: HOUSEHOLD_TUNING.START_STOCK * n,
      shopper: null,
      trips: 0,
      earned: 0,
      spent: { food: 0, repairs: 0, bills: 0 },
    };
    states.set(world, h);
  }
  return h;
}

export const pantryCapacity = (world: World): number => HOUSEHOLD_TUNING.CAPACITY * world.agents.length;

export function pantryIsLow(world: World): boolean {
  const low = Math.max(2, HOUSEHOLD_TUNING.LOW_PER_RESIDENT * world.agents.length);
  return householdOf(world).stock <= low;
}

export function earn(world: World, amount: number): void {
  const h = householdOf(world);
  h.money += amount;
  h.earned += amount;
}

export function payRepair(world: World, byHandyman: boolean): number {
  const h = householdOf(world);
  const cost = byHandyman ? HOUSEHOLD_TUNING.HANDYMAN : HOUSEHOLD_TUNING.REPAIR_PARTS;
  h.money -= cost;
  h.spent.repairs += cost;
  return cost;
}

export function payBills(world: World): void {
  const h = householdOf(world);
  const cost = HOUSEHOLD_TUNING.BILLS_PER_DAY * world.agents.length;
  h.money -= cost;
  h.spent.bills += cost;
}

/** utility multiplier for food objects that need the pantry: 1 while it is stocked */
export function pantryFactor(world: World, objectType: string): number {
  const need = PORTIONS[objectType];
  if (!need) return 1;
  return householdOf(world).stock >= need ? 1 : HOUSEHOLD_TUNING.EMPTY_FACTOR;
}

/** a resident starts eating / cooking at a food object */
export function eatPortions(world: World, objectType: string): void {
  const need = PORTIONS[objectType];
  if (!need) return;
  const h = householdOf(world);
  h.stock = Math.max(0, h.stock - need);
}

/** shopping done: fills the pantry as far as the purse allows; returns portions bought */
export function restock(world: World): number {
  const h = householdOf(world);
  const n = world.agents.length;
  let buy = Math.max(0, pantryCapacity(world) - h.stock);
  if (h.money < buy * HOUSEHOLD_TUNING.PRICE) buy = Math.max(HOUSEHOLD_TUNING.MIN_BUY_PER_RESIDENT * n, Math.floor(Math.max(0, h.money) / HOUSEHOLD_TUNING.PRICE));
  buy = Math.min(buy, Math.max(0, pantryCapacity(world) - h.stock));
  h.stock += buy;
  h.money -= buy * HOUSEHOLD_TUNING.PRICE;
  h.spent.food += buy * HOUSEHOLD_TUNING.PRICE;
  return buy;
}
