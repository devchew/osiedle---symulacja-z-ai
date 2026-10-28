import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createWorld, tickWorld } from '../../src/world/world';
import { isAgentSleeping } from '../../src/agents/actions';
import { timeFromTick } from '../../src/core/time';

it('naps', () => {
  const out: string[] = [];
  for (const seed of [1, 2, 3]) {
    const w = createWorld(seed);
    const was = new Map<number, boolean>();
    const wakeEnergy = new Map<number, number>();
    for (let i = 0; i < 4 * 1440; i++) {
      tickWorld(w);
      const t = timeFromTick(w.tick);
      for (const a of w.agents) {
        const s = isAgentSleeping(w, a);
        if (s && !was.get(a.id) && t.hour >= 9 && t.hour < 19) {
          out.push(`s${seed} D${t.day} ${t.hour}:${String(t.minute).padStart(2, '0')} ${a.name} nap energy=${a.needs.energy.toFixed(0)} wokeWith=${wakeEnergy.get(a.id)?.toFixed(0)} act=${a.traits.activity.toFixed(1)}`);
        }
        if (!s && was.get(a.id)) wakeEnergy.set(a.id, a.needs.energy);
        was.set(a.id, s);
      }
    }
  }
  writeFileSync('test-results/naps.txt', out.join('\n'));
});
