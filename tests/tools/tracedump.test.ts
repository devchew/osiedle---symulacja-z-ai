import { it } from 'vitest';
import { createWorld, tickWorld } from '../../src/world/world';
import { traceOf, formatTraceEntry } from '../../src/world/trace';

// Trace excerpt: SEED=2 MAP=dom FROM=400 UNTIL=1500 GREP=wspólne npx vitest run tests/tools/tracedump.test.ts → test-results/tracedump.txt
it.runIf(!!process.env.UNTIL)('trace dump', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const w = createWorld(Number(process.env.SEED ?? 1), { mapId: process.env.MAP ?? 'dom' });
  const until = Number(process.env.UNTIL);
  for (let i = 0; i < until; i++) tickWorld(w);
  const from = Number(process.env.FROM ?? 0);
  const re = process.env.GREP ? new RegExp(process.env.GREP) : null;
  const lines = traceOf(w).filter((e) => e.tick >= from).map((e) => formatTraceEntry(w, e)).filter((l) => !re || re.test(l));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/tracedump.txt', lines.join('\n') + '\n');
});
