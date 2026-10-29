import type { ObjectDef, ObjectInstance, World } from '../../types';

// Multi-day building projects (e.g. a garden gazebo built by several residents over ~2 weeks).
// Wave 9 stub — implemented by the projects task (see plan/TASKS.md).

/** object defs for construction sites and finished buildings; merged into WORLD_OBJECT_DEFS */
export const PROJECT_DEFS: Record<string, ObjectDef> = {};

/** sets up project state for a new world (called once from createWorld) */
export function initProjects(_world: World): void {}

/** advances projects; called once per tick right after incidents */
export function tickProjects(_world: World): void {}

/** extra utility multiplier for project-related objects (work sites); 1 = neutral */
export function projectAppeal(_world: World, _obj: ObjectInstance, _def: ObjectDef): number {
  return 1;
}
