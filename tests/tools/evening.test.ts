import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createWorld, tickWorld } from '../../src/world/world';
import { traceOf } from '../../src/world/trace';
import { jointLog } from '../../src/agents/joint';
import { gatheringLog } from '../../src/agents/groups';

// bedtimes and what happens in the evening (17–23)
it('evening', () => {
  const out: string[] = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = createWorld(seed);
    for (let i = 0; i < 7 * 1440; i++) tickWorld(w);
    const mod = (t: number) => (t + 420) % 1440;
    const beds = traceOf(w).filter((e) => e.kind === 'arrive' && /Łóżko/.test(e.text) && (mod(e.tick) >= 18 * 60 || mod(e.tick) < 3 * 60));
    const bt = beds.map((e) => { const m = mod(e.tick); return m < 180 ? m + 1440 : m; }).sort((a, b) => a - b);
    const med = bt[Math.floor(bt.length / 2)];
    const fmt = (m: number) => `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
    const eveConsole = jointLog(w).filter((j) => j.happened && j.kind === 'console' && mod(j.start) >= 17 * 60).length;
    const movies = gatheringLog(w).filter((g) => g.kind === 'movie').length;
    out.push(`seed ${seed}: bedtime p10 ${fmt(bt[Math.floor(bt.length * 0.1)])} median ${fmt(med)} p90 ${fmt(bt[Math.floor(bt.length * 0.9)])} | evening console ${eveConsole} | movies ${movies}`);
  }
  writeFileSync('test-results/evening.txt', out.join('\n'));
});
