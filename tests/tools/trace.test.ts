import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWorld, tickWorld } from '../../src/world/world';
import { isGuestId } from '../../src/agents/role';
import { formatTrace, formatTraceEntry, traceOf, type TraceEntry } from '../../src/world/trace';

// Behaviour analysis: runs a world headlessly and looks for "chaotic" patterns in the trace.
// SEED=42 TICKS=4500 npx vitest run tests/tools/trace.test.ts → test-results/trace-*.txt

it('trace analysis', () => {
  const seed = Number(process.env.SEED ?? 42);
  const ticks = Number(process.env.TICKS ?? 4500);
  const w = createWorld(seed);
  for (let i = 0; i < ticks; i++) tickWorld(w);
  const all = traceOf(w);
  const fmt = (e: TraceEntry) => formatTraceEntry(w, e);
  const byAgent = new Map<number, TraceEntry[]>();
  for (const e of all) byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e]);
  const nextOf = (e: TraceEntry, pred: (x: TraceEntry) => boolean, within = 30) =>
    byAgent.get(e.agentId)!.find((x) => x.tick >= e.tick && x !== e && x.tick - e.tick <= within && pred(x));

  const out: string[] = [];
  const section = (title: string, rows: string[]) => {
    out.push(`\n## ${title} (${rows.length})`);
    out.push(...rows.slice(0, 25));
    if (rows.length > 25) out.push(`… +${rows.length - 25}`);
  };

  // 1. conversations ended before the topic ran out, by reason
  const convEnds = all.filter((e) => e.kind === 'conv-end');
  const early = convEnds.filter((e) => !e.text.includes('koniec tematu'));
  const reasons = new Map<string, number>();
  for (const e of early) {
    const r = e.text.split(' — ')[1].replace(/^\S+ odchodzi: (idzie do|używa): ([^#]+).*/, 'odchodzi → $2').replace(/^\S+: krytyczna/, 'krytyczna');
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  section(
    `rozmowy: ${convEnds.length / 2} zakończonych, przerwanych przed końcem: ${early.length / 2}; powody`,
    [...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n / 2).padStart(5)}×  ${r}`),
  );
  section('przerwane rozmowy — przykłady', early.filter((_, i) => i % 2 === 0).map(fmt));

  // 2. accepted an invitation, but the chat barely happened (≤1 line)
  const fizzled = convEnds.filter((e) => /: [01]\/\d+ kwestii/.test(e.text));
  section('rozmowy, które się nie odbyły (0–1 kwestii)', fizzled.filter((_, i) => i % 2 === 0).map(fmt));

  // 3. what invitations interrupted
  const interrupted = all.filter((e) => e.kind === 'end' && e.text.includes('przerwane: zaproszenie'));
  const interruptedWhat = new Map<string, number>();
  for (const e of interrupted) {
    const what = e.text.replace(/ \(zostało.*$/, '').replace(/#\d+/, '').replace(/ — .*$/, '');
    interruptedWhat.set(what, (interruptedWhat.get(what) ?? 0) + 1);
  }
  section('co przerywało zaproszenie do rozmowy', [...interruptedWhat].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n).padStart(5)}×  ${r}`));

  // 4. refused / talked, then went to bed right after
  const toBed = (x: TraceEntry) => x.kind === 'start' && /Łóżko/.test(x.text);
  const refuseThenBed = all.filter((e) => e.kind === 'refuse' && nextOf(e, toBed, 20));
  section('odmowa rozmowy, a zaraz potem łóżko', refuseThenBed.map((e) => `${fmt(e)}\n      → ${fmt(nextOf(e, toBed, 20)!)}`));
  const chatThenBed = convEnds.filter((e) => nextOf(e, toBed, 5));
  section('koniec rozmowy i od razu do łóżka (≤5 min)', chatThenBed.map((e) => `${fmt(e)}\n      → ${fmt(nextOf(e, toBed, 5)!)}`));
  const inviteTired = all.filter((e) => e.kind === 'invite' && /idzie do: Łóżko/.test(e.text));
  section('zaproszenie kogoś, kto idzie spać', inviteTired.map(fmt));

  // 5. walking abandoned: started walking to X, ended before arriving
  const abandoned = all.filter((e) => e.kind === 'end' && /idzie do:/.test(e.text));
  const abandonReasons = new Map<string, number>();
  for (const e of abandoned) {
    const r = e.text.split(' — ')[1].replace(/zaproszenie od \S+/, 'zaproszenie od X');
    abandonReasons.set(r, (abandonReasons.get(r) ?? 0) + 1);
  }
  section('porzucone drogi do obiektu — powody', [...abandonReasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n).padStart(5)}×  ${r}`));

  // 6. approaching a partner that never worked out
  const approachFail = all.filter((e) => e.kind === 'end' && /podchodzi do:/.test(e.text));
  const approachReasons = new Map<string, number>();
  for (const e of approachFail) {
    const r = e.text.split(' — ')[1].replace(/^\S+ zajęty\/a: (idzie do|używa): ([^#]+).*/, 'partner zajęty: $1 $2');
    approachReasons.set(r, (approachReasons.get(r) ?? 0) + 1);
  }
  const invites = all.filter((e) => e.kind === 'invite').length;
  const talkDecisions = all.filter((e) => e.kind === 'start' && e.text.startsWith('podchodzi do')).length;
  section(
    `podejścia do rozmowy: ${talkDecisions}, doszło do zaproszenia: ${invites}, przyjęte: ${all.filter((e) => e.kind === 'accept').length}; nieudane podejścia`,
    [...approachReasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n).padStart(5)}×  ${r}`),
  );

  // 7. flip-flopping: ≥4 decisions within 15 minutes by the same agent
  const flips: string[] = [];
  for (const [, list] of byAgent) {
    const dec = list.filter((e) => e.kind === 'decide');
    for (let i = 0; i + 3 < dec.length; i++) {
      if (dec[i + 3].tick - dec[i].tick <= 15) {
        flips.push(dec.slice(i, i + 4).map(fmt).join('\n      '));
        i += 3;
      }
    }
  }
  section('zmiany zdania (4 decyzje w ≤15 min)', flips);

  // 8. activity mix
  const used = new Map<string, number>();
  for (const e of all.filter((x) => x.kind === 'arrive')) {
    const k = e.text.replace(/#.*/, '');
    used.set(k, (used.get(k) ?? 0) + 1);
  }
  section('użycia obiektów', [...used].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n).padStart(5)}×  ${r}`));

  // 9. guests: visits and what the visitors did while here
  const visits = w.events.filter((e) => e.text.startsWith('Wizyta: '));
  const guestRows = all.filter((e) => isGuestId(e.agentId));
  const guestKinds = new Map<string, number>();
  for (const e of guestRows) guestKinds.set(`${e.kind}: ${e.text.replace(/#.*/, '').slice(0, 40)}`, (guestKinds.get(`${e.kind}: ${e.text.replace(/#.*/, '').slice(0, 40)}`) ?? 0) + 1);
  section('wizyty gości (z ostatnich zdarzeń)', visits.map((e) => `${e.tick}  ${e.text}`));
  section('co robią goście', [...guestKinds].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${String(n).padStart(5)}×  ${r}`));

  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/trace-analysis-${seed}.txt`, `# seed ${seed}, ${ticks} ticks, ${all.length} trace entries\n${out.join('\n')}\n`);
  writeFileSync(`test-results/trace-${seed}.txt`, formatTrace(w));
});
