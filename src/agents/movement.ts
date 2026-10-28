import type { Agent } from '../types';

/** tiles per tick (game minute) */
export const WALK_SPEED = 0.45;

/**
 * Moves the agent along its path by up to `speed` tiles, carrying leftover distance over
 * waypoints. Assigns a new `pos` object; never touches `prevPos` (the world tick does).
 */
export function stepAgent(agent: Agent, speed = WALK_SPEED): 'moving' | 'arrived' | 'idle' {
  if (agent.path.length === 0) return 'idle';
  let { x, y } = agent.pos;
  let budget = speed;
  while (budget > 1e-9 && agent.path.length > 0) {
    const t = agent.path[0];
    const dx = t.x - x, dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx) > 1e-9) agent.facing = dx < 0 ? -1 : 1;
    if (d <= budget + 1e-6) {
      x = t.x; y = t.y;
      budget = Math.max(0, budget - d);
      agent.path.shift();
    } else {
      x += (dx / d) * budget;
      y += (dy / d) * budget;
      budget = 0;
    }
  }
  agent.pos = { x, y };
  return agent.path.length === 0 ? 'arrived' : 'moving';
}
