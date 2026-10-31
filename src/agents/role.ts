import type { Agent, World } from '../types.ts';

// Residents live in the house; guests (agents/guests.ts) visit and leave. A leaf module, so any
// simulation or UI module can tell them apart without import cycles.

/** guest ids start here (residents are 0..n-1), so a guest is recognisable by id alone */
export const GUEST_ID_BASE = 1000;

export const isGuestId = (id: number): boolean => id >= GUEST_ID_BASE;
export const isGuest = (agent: Agent): boolean => agent.role === 'guest';
export const isResident = (agent: Agent): boolean => agent.role !== 'guest';
export const residentsOf = (world: World): Agent[] => world.agents.filter(isResident);
