import type { Agent, Conversation, Gossip, World } from '../types';

// Residents' memories and gossip. Wave 4 stub — implemented by the memory task (see plan/TASKS.md).

/** called once per tick: turn new world events into memories of the agents involved / present */
export function updateMemories(_world: World): void {}

/** stories `speaker` could bring up when talking to `listener` (most interesting first) */
export function recallFor(_world: World, _speaker: Agent, _listener: Agent): Gossip[] {
  return [];
}

/** called when a conversation with ≥2 lines ends: gossip spreads, opinions about third persons shift */
export function onConversationEnd(_world: World, _conv: Conversation): void {}
