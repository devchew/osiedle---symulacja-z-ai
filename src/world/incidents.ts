import type { ObjectDef, ObjectInstance, World } from '../types';

// World events: weather, broken objects, visitors. Wave 5 stub — see plan/TASKS.md.

/** advances weather and incidents; called once per tick before agents act */
export function tickIncidents(_world: World): void {}

/**
 * multiplier (0 = unusable) applied to an object's utility score:
 * broken objects, rain for outdoor activities, etc.
 */
export function availability(_world: World, _obj: ObjectInstance, _def: ObjectDef): number {
  return 1;
}
