import type { SimEventKind, World } from '../types';
import { MAX_EVENTS } from '../types';

export function pushEvent(world: World, kind: SimEventKind, text: string, agentIds: number[]): void {
  world.events.push({ tick: world.tick, kind, text, agentIds });
  if (world.events.length > MAX_EVENTS) world.events.splice(0, world.events.length - MAX_EVENTS);
}
