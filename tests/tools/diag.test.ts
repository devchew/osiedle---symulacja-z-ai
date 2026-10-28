import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.join(' '));
import { createWorld, tickWorld } from '../../src/world/world';
import { NEED_KEYS } from '../../src/types';

it('diag', () => {
  const seed = Number(process.env.SEED ?? 3);
  const days = Number(process.env.DAYS ?? 2);
  const w = createWorld(seed);
  const zero: Record<string, Record<string, number>> = {};
  const uses: Record<string, Record<string, number>> = {};
  const kinds: Record<string, Record<string, number>> = {};
  for (let i = 0; i < days * 1440; i++) {
    tickWorld(w);
    for (const a of w.agents) {
      zero[a.name] ??= {}; uses[a.name] ??= {}; kinds[a.name] ??= {};
      for (const k of NEED_KEYS) if (a.needs[k] <= 0.5) zero[a.name][k] = (zero[a.name][k] ?? 0) + 1;
      const act = a.action;
      const key = act ? (act.kind === 'use' ? `use:${w.objects.find(o => o.uid === act.objectUid)!.type}:${act.phase}` : act.kind + ('phase' in act ? ':' + act.phase : '')) : 'none';
      kinds[a.name][key] = (kinds[a.name][key] ?? 0) + 1;
    }
  }
  for (const a of w.agents) {
    log(a.name, JSON.stringify(a.traits, (_, v) => typeof v === 'number' ? +v.toFixed(2) : v), 'mood', a.mood.toFixed(0), JSON.stringify(a.stats));
    log('  needs', NEED_KEYS.map(k => `${k}=${a.needs[k].toFixed(0)}`).join(' '));
    log('  zero-ticks', JSON.stringify(zero[a.name]));
    log('  time', JSON.stringify(Object.fromEntries(Object.entries(kinds[a.name]).sort((x, y) => y[1] - x[1]).slice(0, 12))));
  }
  log(w.events.filter(e => /spać|wstaje/.test(e.text)).slice(-24).map(e => { const m = (e.tick + 420) % 1440; return `D${Math.floor((e.tick + 420) / 1440) + 1} ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} ${e.text}`; }).join('\n'));
  writeFileSync(process.env.OUT ?? 'test-results/diag.txt', out.join('\n'));
});
