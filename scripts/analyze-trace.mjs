// Summarises a trace.txt (from tests/tools/tracedump.test.ts, test-results/trace-<seed>.txt or scripts/observe.mjs).
// usage: node scripts/analyze-trace.mjs <trace.txt>
import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => /^D\d/.test(l));
const rows = lines.map((l) => {
  const m = l.match(/^D(\d+) (\d\d):(\d\d)\s+(\S+)\s+(\S+)\s+\[[^\]]*\]\s+(.*)$/);
  return m && { t: (+m[1] - 1) * 1440 + +m[2] * 60 + +m[3], who: m[4], kind: m[5], text: m[6], line: l };
}).filter(Boolean);
const count = (k) => rows.filter((r) => r.kind === k).length;
const convEnds = rows.filter((r) => r.kind === 'conv-end');
const cut = convEnds.filter((r) => !/koniec tematu|krytyczna/.test(r.text));
const quick = rows.filter((r) => r.kind === 'end' && /potrzeby zaspokojone/.test(r.text)).filter((e) => {
  const a = [...rows].reverse().find((x) => x.who === e.who && x.kind === 'arrive' && x.t <= e.t);
  return a && e.t - a.t < 10;
});
let flips = 0;
const byWho = {};
for (const r of rows.filter((r) => r.kind === 'decide')) (byWho[r.who] ??= []).push(r.t);
for (const ts of Object.values(byWho)) for (let i = 0; i + 3 < ts.length; i++) if (ts[i + 3] - ts[i] <= 15) flips++;
const chatThenBed = convEnds.filter((c) => rows.some((r) => r.who === c.who && r.kind === 'start' && /Łóżko/.test(r.text) && r.t - c.t >= 0 && r.t - c.t <= 5));
console.log(JSON.stringify({
  entries: rows.length,
  conversations: convEnds.length / 2,
  cutOff: cut.length / 2,
  zeroOrOneLine: convEnds.filter((r) => /: [01]\/\d+ kwestii/.test(r.text)).length / 2,
  invites: count('invite'), accepted: count('accept'), refused: count('refuse'),
  interruptedByInvite: rows.filter((r) => r.kind === 'end' && /zaproszenie od/.test(r.text)).length,
  sitDownStandUp: quick.length,
  flipFlops: flips,
  chatThenBedWithin5min: chatThenBed.length,
}, null, 1));
