import type { Json } from '../core/state';
import { registerWorldState } from '../core/state';
import { loadMovementState, saveMovementState, type MovementSnapshot } from './movement';

// Registers the walking trails / per-tick walking clock of src/agents/movement.ts with the world
// snapshot registry (core/state.ts). Kept apart so movement.ts stays free of registry code.

registerWorldState('movement', {
  save: (world) => {
    const s = saveMovementState(world);
    return Object.keys(s.agents).length ? (JSON.parse(JSON.stringify(s)) as Json) : null;
  },
  load: (world, data) => loadMovementState(world, data as unknown as MovementSnapshot),
});
