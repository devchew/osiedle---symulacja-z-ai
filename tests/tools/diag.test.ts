import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { formatMetrics, runMetrics } from './metrics';

// DAYS=7 SEED=1 npx vitest run tests/tools/diag.test.ts  ->  test-results/diag.txt
// SEED may be a comma-separated list.
it('diag', () => {
  const seeds = String(process.env.SEED ?? 3).split(',').map(Number);
  const days = Number(process.env.DAYS ?? 2);
  const out: string[] = [];
  for (const seed of seeds) {
    const m = runMetrics(seed, days, Number(process.env.AGENTS ?? 6));
    out.push(formatMetrics(m));
    if (process.env.EVENTS) {
      out.push(
        m.world.events
          .slice(-Number(process.env.EVENTS))
          .map((e) => {
            const t = (e.tick + 420) % 1440;
            return `D${Math.floor((e.tick + 420) / 1440) + 1} ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} [${e.kind}] ${e.text}`;
          })
          .join('\n'),
      );
    }
    out.push('');
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync(process.env.OUT ?? 'test-results/diag.txt', out.join('\n'));
});
