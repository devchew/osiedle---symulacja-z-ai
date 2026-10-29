import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWorld, tickWorld } from '../../src/world/world';
import { jointLog } from '../../src/agents/joint';
import { timeFromTick, formatClock } from '../../src/core/time';

// Joint activities report: SEEDS=1,2 DAYS=7 MAP=dom npx vitest run tests/tools/joint.test.ts → test-results/joint.txt

it.runIf(!!process.env.SEEDS || !!process.env.JOINT_REPORT)('joint activities report', () => {
  const seeds = (process.env.SEEDS ?? '1,2,3').split(',').map(Number);
  const days = Number(process.env.DAYS ?? 3);
  const mapId = process.env.MAP ?? 'dom';
  const out: string[] = [];
  for (const seed of seeds) {
    const w = createWorld(seed, { mapId });
    for (let i = 0; i < days * 24 * 60; i++) tickWorld(w);
    const log = jointLog(w);
    const done = log.filter((r) => r.happened);
    const per = new Map<number, number>();
    for (const r of done) for (const id of r.ids) per.set(id, (per.get(id) ?? 0) + 1);
    const avg = done.reduce((s, r) => s + r.minutes, 0) / Math.max(1, done.length);
    out.push(`## seed ${seed} map ${mapId}: ${done.length} sessions (${log.length - done.length} called off), avg ${avg.toFixed(0)} min`);
    out.push(`   per agent: ${w.agents.map((a) => `${a.name}(soc ${a.traits.sociability.toFixed(1)})=${per.get(a.id) ?? 0}`).join(' ')}`);
    for (const r of log) {
      const t = timeFromTick(r.start);
      out.push(`   D${t.day} ${formatClock(t)} t${r.start}-${r.end} ${r.kind.padEnd(9)} ${String(r.minutes).padStart(3)}m ${r.happened ? '' : '✗ '}${r.text}`);
    }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/joint.txt', out.join('\n') + '\n');
});
