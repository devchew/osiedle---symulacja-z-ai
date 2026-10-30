import { it } from 'vitest';
import { createWorld, tickWorld } from '../../src/world/world';
import { setCalendar, timeOf } from '../../src/core/calendar';
import { formatClock } from '../../src/core/time';
import { traceOf, formatTraceEntry } from '../../src/world/trace';
import { worldCheck } from './worldCheck';

// Headless replacement of the removed /lab (#36): reproduces a world from seed / map / agents / tick and dumps
// what happened. Output goes to test-results/tracedump.txt (header: world fingerprint, then the trace lines).
//
//   SEED=2 MAP=dom UNTIL=1500 npx vitest run tests/tools/tracedump.test.ts
//
//   SEED      world seed (default 1)          MAP     map id (default dom)     AGENTS  resident count (default: map's)
//   UNTIL     tick to stop at (required; 1440 = one game day, the day starts at 07:00)
//   FROM      first tick of the trace excerpt  GREP    regexp filtering trace lines
//   AGENT     agent id: trace of that resident only (the world keeps the last 30000 trace entries)
//   DATE      calendar date of day 1 (YYYY-MM-DD: season, weekday)
//   SAMPLE    every N ticks add a line (clock, moods, conversations) to test-results/tracedump-samples.txt
it.runIf(!!process.env.UNTIL)('trace dump', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const env = process.env;
  const w = createWorld(Number(env.SEED ?? 1), { mapId: env.MAP ?? 'dom', agentCount: env.AGENTS ? Number(env.AGENTS) : undefined });
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(env.DATE ?? '');
  if (date) setCalendar(w, Math.round(Date.UTC(+date[1], +date[2] - 1, +date[3]) / 86_400_000));
  const until = Number(env.UNTIL);
  const every = Number(env.SAMPLE ?? 0);
  const samples: string[] = [];
  for (let i = 0; i < until; i++) {
    tickWorld(w);
    if (every > 0 && w.tick % every === 0) {
      const moods = w.agents.map((a) => Math.round(a.mood)).join(',');
      samples.push(`tick ${w.tick}  D${timeOf(w).day} ${formatClock(timeOf(w))}  conversations ${w.conversations.length}  moods ${moods}`);
    }
  }
  const from = Number(env.FROM ?? 0);
  const re = env.GREP ? new RegExp(env.GREP) : null;
  const agent = env.AGENT === undefined ? undefined : Number(env.AGENT);
  const lines = traceOf(w).filter((e) => e.tick >= from && (agent === undefined || e.agentId === agent)).map((e) => formatTraceEntry(w, e)).filter((l) => !re || re.test(l));
  mkdirSync('test-results', { recursive: true });
  const header = `# seed ${w.seed}, map ${env.MAP ?? 'dom'}, ${w.agents.length} agents, tick ${w.tick}, check ${worldCheck(w)}`;
  writeFileSync('test-results/tracedump.txt', `${header}\n${lines.join('\n')}\n`);
  if (every > 0) writeFileSync('test-results/tracedump-samples.txt', `${header}\n${samples.join('\n')}\n`);
  console.log(`${header} → test-results/tracedump.txt (${lines.length} lines)`);
});
