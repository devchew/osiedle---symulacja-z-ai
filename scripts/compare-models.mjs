// Compares free OpenRouter models on the same dialogue + diary requests (#28). Manual only, never part of npm test.
//
// usage:
//   LLM_FIXTURE=1 npx vitest run tests/tools/llmFixture.test.ts   # (re)record tests/fixtures/llm-requests.json
//   node scripts/compare-models.mjs [--models a/b:free,c/d:free] [--out model-results] [--pause 4000] [--limit N]
//
// Reads OPENROUTER_API_KEY from .env (never printed or written). Uses the real prompts (buildChatRequest /
// buildDiaryChatRequest with one model each) and the real validators (parseCompletion, parseDiaryCompletion,
// findGenderedForms). Requests run interleaved across models with a pause (free models: ~20 req/min per account),
// one retry after a 429. Already answered requests in <out>/raw.jsonl are skipped, so a run can be resumed later.
// Output in <out>: raw.jsonl (raw responses), report.md (metrics), blind.md + blind-key.json (blind naturalness rating).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerImport } from 'vite';

const DEFAULT_CANDIDATES = [
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'dots-studio/dots-3-note-preview:free',
  'recursive/flint-v1.0:free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  // no response_format in the model list: relies on extractJson finding the object in plain text
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  // not tested: thinkingmachines/inkling(-small):free → 403 "only available on agentic harnesses" (2026-10-30)
];

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const models = args.models ? args.models.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CANDIDATES;
const outDir = args.out ?? 'model-results';
const pauseMs = Number(args.pause ?? 4000);
const limit = Number(args.limit ?? Infinity);

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!existsSync('.env')) return '';
  const m = readFileSync('.env', 'utf8').match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
  return m ? m[1] : '';
}

const load = async (path) => (await runnerImport(path, { configFile: false, logLevel: 'error' })).module;
const llm = await load('/server/llm.ts');
const diaryAi = await load('/src/social/diaryAi.ts');
const fixture = JSON.parse(readFileSync('tests/fixtures/llm-requests.json', 'utf8'));
const items = [
  ...fixture.lines.map((x) => ({ ...x, kind: 'line' })),
  ...fixture.diaries.map((x) => ({ ...x, kind: 'diary', why: 'diary' })),
];

mkdirSync(outDir, { recursive: true });
const rawPath = join(outDir, 'raw.jsonl');
const readRaw = () => (existsSync(rawPath) ? readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const done = new Set(readRaw().filter((r) => r.status !== 429).map((r) => `${r.model}|${r.item}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINE_MAX = 70;

/** names that must not count as gendered forms (residents of the fixture) */
const NAMES = [...new Set(fixture.lines.flatMap((l) => [l.request.speaker, l.request.listener]).concat(fixture.diaries.map((d) => d.request.name)))];

/** models that reject `reasoning: { enabled: false }` (400 "Reasoning is mandatory"); retried with low effort */
const mustReason = new Set();

async function call(key, model, item) {
  const body = item.kind === 'line' ? llm.buildChatRequest(item.request, [model]) : llm.buildDiaryChatRequest(item.request, [model]);
  if (mustReason.has(model)) body.reasoning = { effort: 'low' };
  const t0 = Date.now();
  try {
    const res = await fetch(llm.OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: llm.buildHeaders(key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ms: Date.now() - t0, body: json ?? text.slice(0, 2000) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: String(e?.message ?? e) };
  }
}

/** automatic checks on one raw record (same validators as the server) */
function evaluate(rec) {
  const item = items.find((i) => i.id === rec.item);
  const b = rec.body && typeof rec.body === 'object' ? rec.body : null;
  const content = b?.choices?.[0]?.message?.content;
  const finish = b?.choices?.[0]?.finish_reason ?? null;
  const out = { ok: false, reason: '', text: '', rawLen: 0, gendered: [], answeredBy: b?.model ?? null };
  if (rec.status !== 200) return { ...out, reason: rec.status === 429 ? '429' : `http ${rec.status}` };
  if (!b || b.error) return { ...out, reason: `error: ${String(b?.error?.message ?? 'no body').slice(0, 60)}` };
  if (typeof content !== 'string' || !content.trim()) return { ...out, reason: `empty (finish ${finish})` };
  const data = llm.extractJson(content);
  const rawText = data && typeof data === 'object' && typeof data.text === 'string' ? data.text : '';
  out.rawLen = rawText.length;
  if (item.kind === 'line') {
    let why = '';
    const { speaker, listener } = item.request;
    const parsed = llm.parseCompletion(b, speaker, item.request.gossip?.length ?? 0, (r) => (why = r), [speaker, listener]);
    if (!parsed) {
      out.text = rawText;
      out.gendered = rawText ? diaryAi.findGenderedForms(rawText, NAMES) : [];
      return { ...out, reason: why || (rawText ? `invalid (finish ${finish})` : 'no JSON') };
    }
    out.text = parsed.line.text;
    out.tone = parsed.line.tone;
    out.gossip = parsed.line.gossip;
    out.gendered = diaryAi.findGenderedForms(parsed.line.text, NAMES);
    out.ok = true;
    return out;
  }
  let why = '';
  const parsed = llm.parseDiaryCompletion(b, { ...item.request, names: NAMES }, (r) => (why = r));
  if (!parsed) {
    out.text = rawText;
    out.gendered = rawText ? diaryAi.findGenderedForms(rawText, NAMES) : [];
    return { ...out, reason: why || (rawText ? `invalid (finish ${finish})` : 'no JSON') };
  }
  out.text = parsed.text;
  out.ok = true;
  return out;
}

// ------------------------------------------------------------ run

const key = readKey();
if (!key) {
  console.error('OPENROUTER_API_KEY missing (.env or env)');
  process.exit(1);
}
const queue = items.flatMap((item) => models.map((model) => ({ model, item }))).filter((q) => !done.has(`${q.model}|${q.item.id}`));
console.log(`${models.length} models × ${items.length} requests; ${queue.length} to go, pause ${pauseMs} ms`);
let sent = 0;
for (const { model, item } of queue) {
  if (sent >= limit) break;
  let r = await call(key, model, item);
  sent++;
  if (r.status === 400 && !mustReason.has(model) && /reasoning is mandatory/i.test(JSON.stringify(r.body))) {
    mustReason.add(model);
    await sleep(pauseMs);
    r = await call(key, model, item);
    sent++;
  }
  if (mustReason.has(model)) r = { ...r, reasoning: 'low' };
  if (r.status === 429) {
    await sleep(20_000);
    r = { ...(await call(key, model, item)), retried: true };
    sent++;
  }
  const rec = { model, item: item.id, kind: item.kind, at: new Date().toISOString(), ...r };
  appendFileSync(rawPath, JSON.stringify(rec) + '\n');
  const ev = evaluate(rec);
  console.log(`${String(sent).padStart(3)} ${item.id.padEnd(8)} ${model.padEnd(40)} ${String(r.ms).padStart(6)} ms ${ev.ok ? 'ok ' : ev.reason} ${ev.text.slice(0, 60)}`);
  await sleep(pauseMs);
}

// ------------------------------------------------------------ report

const records = readRaw();
// last record per model × item wins (a resumed run may have retried a 429)
const latest = new Map(records.map((r) => [`${r.model}|${r.item}`, r]));
const rows = [];
const examples = {};
for (const model of models) {
  const recs = [...latest.values()].filter((r) => r.model === model);
  if (!recs.length) continue;
  const ev = recs.map((r) => ({ r, e: evaluate(r) }));
  const lines = ev.filter((x) => x.r.kind === 'line');
  const diaries = ev.filter((x) => x.r.kind === 'diary');
  const okLines = lines.filter((x) => x.e.ok);
  const okMs = ev.filter((x) => x.r.status === 200).map((x) => x.r.ms).sort((a, b) => a - b);
  const reasons = {};
  for (const x of ev.filter((x) => !x.e.ok)) {
    const k = x.e.reason.replace(/: .*/, '');
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const openers = okLines.map((x) => x.e.text.toLowerCase().split(/\s+/).slice(0, 2).join(' '));
  rows.push({
    model,
    lineOk: `${okLines.length}/${lines.length}`,
    diaryOk: `${diaries.filter((x) => x.e.ok).length}/${diaries.length}`,
    gendered: lines.filter((x) => x.e.gendered.length).length,
    tooLong: okLines.filter((x) => x.e.rawLen > LINE_MAX).length,
    avgLen: okLines.length ? Math.round(okLines.reduce((s, x) => s + x.e.text.length, 0) / okLines.length) : 0,
    gossip: okLines.filter((x) => x.e.gossip !== null && x.e.gossip !== undefined).length,
    openers: okLines.length ? `${new Set(openers).size}/${okLines.length}` : '-',
    p50: okMs.length ? okMs[Math.floor(okMs.length / 2)] : '-',
    p90: okMs.length ? okMs[Math.floor(okMs.length * 0.9)] : '-',
    e429: ev.filter((x) => x.r.status === 429 || x.r.retried).length,
    failures: Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(', ') || '-',
  });
  examples[model] = { lines: okLines.slice(0, 4).map((x) => `${x.r.item}: ${x.e.text}`), diary: diaries.find((x) => x.e.ok)?.e.text ?? '' };
}

const md = [
  `# Porównanie modeli (#28) — ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Fixture: ${fixture.lines.length} kwestii + ${fixture.diaries.length} pamiętniki (tests/fixtures/llm-requests.json).`,
  '',
  '| model | kwestie OK | pamiętnik OK | formy z rodzajem | >70 zn. | śr. dł. | plotka | różne początki | p50 ms | p90 ms | 429 | błędy |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.model} | ${r.lineOk} | ${r.diaryOk} | ${r.gendered} | ${r.tooLong} | ${r.avgLen} | ${r.gossip} | ${r.openers} | ${r.p50} | ${r.p90} | ${r.e429} | ${r.failures} |`),
  '',
  '## Przykłady',
  ...Object.entries(examples).flatMap(([m, x]) => ['', `### ${m}`, ...x.lines.map((l) => `- ${l}`), ...(x.diary ? ['', '> ' + x.diary.replace(/\n+/g, '\n> ')] : [])]),
  '',
].join('\n');
writeFileSync(join(outDir, 'report.md'), md);
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows, null, 2) + '\n');

// blind sheet: models as letters, shuffled per item (seeded, so re-generating keeps the order)
let seed = 28;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffledModels = [...models].sort(() => rnd() - 0.5);
const anon = Object.fromEntries(shuffledModels.map((m, i) => [m, `M${i + 1}`]));
const blind = ['# Ślepa ocena naturalności (#28)', '', 'Oceń każdą odpowiedź 1–5: żywa rozmowa po polsku, pasuje do relacji i nastroju, gramatyka i imiona.', ''];
for (const item of items) {
  const req = item.request;
  blind.push(`## ${item.id} (${item.why})`);
  if (item.kind === 'line') {
    blind.push(`${req.speaker} → ${req.listener}; relacja ${req.relationshipLabel} (${req.relationship}); nastrój ${req.mood}; temat ${req.topic}`);
    for (const h of req.history) blind.push(`> ${h.speaker}: ${h.text}`);
  } else {
    blind.push(`${req.name}, nastrój ${req.mood}; ${req.facts.length} faktów`);
  }
  blind.push('');
  const answers = models
    .map((m) => ({ m, e: latest.get(`${m}|${item.id}`) && evaluate(latest.get(`${m}|${item.id}`)) }))
    .filter((x) => x.e?.text)
    .sort(() => rnd() - 0.5);
  for (const { m, e } of answers) blind.push(`- **${anon[m]}** [ ]: ${e.text.replace(/\n+/g, ' / ')}${e.ok ? '' : ' _(odrzucone)_'}`);
  blind.push('');
}
writeFileSync(join(outDir, 'blind.md'), blind.join('\n'));
writeFileSync(join(outDir, 'blind-key.json'), JSON.stringify(anon, null, 2) + '\n');
console.log(`\n${md.split('## Przykłady')[0]}\n→ ${outDir}/report.md, blind.md`);
