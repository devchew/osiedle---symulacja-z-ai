import type { Agent, World } from '../types';
import { loadByAgent, registerWorldState, saveByAgent } from '../core/state';
import { residentsOf } from './role';

// Bed ownership. Agent has no field for it (contract unchanged), so it lives here,
// keyed by the agent object.

const ownBed = new WeakMap<Agent, number>();

registerWorldState('home', {
  save: (world) => saveByAgent(world, ownBed),
  load: (world, data) => loadByAgent(world, ownBed, data),
  clear: (world) => world.agents.forEach((a) => ownBed.delete(a)),
});

function isBed(world: World, type: string): boolean {
  return !!world.objectDefs[type]?.tags?.includes('sleep');
}

/** gives every agent its own bed, in map order (housemates share bedrooms pairwise); extra agents get none */
export function assignBeds(world: World): void {
  const beds = world.objects.filter((o) => isBed(world, o.type));
  residentsOf(world).forEach((agent, i) => {
    if (i < beds.length) ownBed.set(agent, beds[i].uid);
    else ownBed.delete(agent);
  });
}

/** uid of the agent's own bed, if it has one */
export function bedOf(agent: Agent): number | undefined {
  return ownBed.get(agent);
}
