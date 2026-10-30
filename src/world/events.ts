import type { Gossip, SimEventKind, World } from '../types.ts';
import { MAX_EVENTS } from '../types.ts';

export function pushEvent(world: World, kind: SimEventKind, text: string, agentIds: number[], gossip?: Gossip): void {
  world.events.push(gossip ? { tick: world.tick, kind, text, agentIds, gossip } : { tick: world.tick, kind, text, agentIds });
  if (world.events.length > MAX_EVENTS) world.events.splice(0, world.events.length - MAX_EVENTS);
}
