// Usage: node scripts/review-prs.mjs [--pr 55,58] [--diff ok|fail] [--notes "text"] [--apply] [--no-browser]
//
// Checks open PRs against the mechanical merge gates and (with --apply) marks them with a label:
//   safe-to-merge — every gate OK and the diff review passed (--diff ok); the human merges
//   needs-work    — a gate failed or the diff review failed (--diff fail)
// GitHub does not allow approving your own PR, so a label + report comment replaces "approve".
//
// Gates: not a draft, mergeable, CI checks green, Coolify preview ready and fresh, preview smoke test
// (HTTP, /api/live/*, no console errors in Chromium), `Closes #<nr>`, diff review (done by a human/agent
// with `gh pr diff <nr>`, see .claude/skills/review-prs/SKILL.md, passed in via --diff / --notes).
// Without --apply nothing is written to GitHub. PRs that are still pending are left untouched.
// --diff and --notes need exactly one --pr.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const MARKER = '<!-- pr-review-bot -->';
const LABEL_OK = 'safe-to-merge';
const LABEL_BAD = 'needs-work';
const REQUIRED_CHECKS = ['test', 'docker'];
const PREVIEW_BOT = /smartdeploy|coolify/i;
const PLACES = 4;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = flag('apply');
const noBrowser = flag('no-browser');
const only = opt('pr')?.split(',').map(Number);
const diffVerdict = opt('diff');
const notes = opt('notes');
if ((diffVerdict || notes) && only?.length !== 1) fail('--diff / --notes need exactly one --pr');
if (diffVerdict && !['ok', 'fail'].includes(diffVerdict)) fail('--diff must be ok or fail');

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function gh(...a) {
  return execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const ghJson = (...a) => JSON.parse(gh(...a));

const repo = ghJson('repo', 'view', '--json', 'nameWithOwner').nameWithOwner;

const gate = (name, status, detail) => ({ name, status, detail });

function ciGate(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  const parts = [];
  let status = 'ok';
  for (const name of REQUIRED_CHECKS) {
    const c = rollup.find((x) => x.name === name);
    if (!c) {
      parts.push(`${name}: brak`);
      status = status === 'fail' ? 'fail' : 'pending';
    } else if (c.status !== 'COMPLETED') {
      parts.push(`${name}: w toku`);
      if (status !== 'fail') status = 'pending';
    } else if (c.conclusion !== 'SUCCESS') {
      parts.push(`${name}: ${c.conclusion}`);
      status = 'fail';
    } else parts.push(`${name}: OK`);
  }
  return gate('CI', status, parts.join(', '));
}

function findPreview(pr) {
  const comments = ghJson('api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate').filter((c) =>
    PREVIEW_BOT.test(c.user?.login ?? ''),
  );
  const last = comments.at(-1);
  if (!last) return { gate: gate('Preview Coolify', 'pending', 'brak komentarza z preview') };
  const url = last.body.match(/\]\((https:\/\/[^)\s]+)\)/)?.[1];
  const ready = /ready|🟢/i.test(last.body);
  const failed = /fail|error|🔴/i.test(last.body) && !ready;
  const lastCommit = pr.commits.at(-1)?.committedDate;
  const fresh = !lastCommit || new Date(last.updated_at) >= new Date(lastCommit);
  if (failed) return { gate: gate('Preview Coolify', 'fail', 'wdrożenie preview nieudane') };
  if (!ready || !url) return { gate: gate('Preview Coolify', 'pending', 'preview jeszcze się buduje') };
  if (!fresh) return { gate: gate('Preview Coolify', 'pending', 'preview starszy niż ostatni commit') };
  return { url, gate: gate('Preview Coolify', 'ok', url) };
}

async function getJson(url, retries = 6) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status !== 503 || i >= retries) return { status: res.status, body: await res.json().catch(() => null) };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function smokeGate(pr, url) {
  const problems = [];
  try {
    const home = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (home.status !== 200) problems.push(`/ → ${home.status}`);
    const places = await getJson(`${url}/api/live/places`);
    const list = Array.isArray(places.body) ? places.body : [];
    if (places.status !== 200 || list.length !== PLACES) problems.push(`/api/live/places → ${places.status}, ${list.length} miejsc`);
    for (const p of list) {
      const id = p.id ?? p.place;
      const snap = await getJson(`${url}/api/live/${id}/snapshot`);
      if (snap.status !== 200) problems.push(`snapshot ${id} → ${snap.status}`);
    }
  } catch (e) {
    return gate('Smoke-test', 'pending', `preview niedostępny: ${e.message}`);
  }
  if (noBrowser) return gate('Smoke-test', problems.length ? 'fail' : 'pending', problems.join('; ') || 'HTTP OK, przeglądarka pominięta');

  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  } catch (e) {
    return gate('Smoke-test', 'pending', `brak Chromium: ${e.message.split('\n')[0]}`);
  }
  const dir = `test-results/pr-review/${pr.number}`;
  mkdirSync(dir, { recursive: true });
  try {
    for (const path of ['/', '/dom']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url + path, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `${dir}/${path === '/' ? 'home' : path.slice(1)}.png` });
      await page.close();
      if (errors.length) problems.push(`${path}: ${errors.length} błędów konsoli (${errors[0].slice(0, 120)})`);
    }
  } catch (e) {
    problems.push(`przeglądarka: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
  return gate('Smoke-test', problems.length ? 'fail' : 'ok', problems.join('; ') || `HTTP + konsola OK, zrzuty: ${dir}`);
}

async function review(number) {
  const pr = ghJson(
    'pr', 'view', String(number), '--json',
    'number,title,isDraft,mergeable,baseRefName,body,headRefOid,statusCheckRollup,commits,labels,url',
  );
  const gates = [];
  gates.push(gate('Stan', pr.isDraft || pr.baseRefName !== 'master' ? 'fail' : 'ok', pr.isDraft ? 'draft' : `base ${pr.baseRefName}`));
  gates.push(
    gate(
      'Merge',
      pr.mergeable === 'MERGEABLE' ? 'ok' : pr.mergeable === 'CONFLICTING' ? 'fail' : 'pending',
      pr.mergeable === 'CONFLICTING' ? 'konflikt z master — wymagany rebase' : pr.mergeable,
    ),
  );
  const closes = /(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i.test(pr.body ?? '');
  gates.push(gate('Closes #', closes ? 'ok' : 'fail', closes ? 'jest' : 'opis PR musi zawierać Closes #<nr>'));
  gates.push(ciGate(pr));
  const preview = findPreview(pr);
  gates.push(preview.gate);
  const ciOk = gates.find((g) => g.name === 'CI').status !== 'fail';
  if (preview.url && ciOk) gates.push(await smokeGate(pr, preview.url));
  else gates.push(gate('Smoke-test', 'pending', 'wymaga gotowego preview'));
  gates.push(
    diffVerdict
      ? gate('Przegląd diffu', diffVerdict === 'ok' ? 'ok' : 'fail', notes ?? '')
      : gate('Przegląd diffu', 'pending', 'jeszcze nie wykonany (--diff ok|fail)'),
  );

  const verdict = gates.some((g) => g.status === 'fail') ? 'needs-work' : gates.every((g) => g.status === 'ok') ? 'safe-to-merge' : 'pending';
  return { pr, gates, verdict };
}

const ICON = { ok: '✅', fail: '❌', pending: '⏳' };

function report({ pr, gates, verdict }) {
  const head =
    verdict === 'safe-to-merge'
      ? '🟢 **Można mergować** — wszystkie bramki OK.'
      : '🔴 **Wymaga poprawek** — popraw poniższe i uruchom przegląd ponownie.';
  const rows = gates.map((g) => `| ${g.name} | ${ICON[g.status]} | ${g.detail} |`).join('\n');
  return `${MARKER}\n${head}\n\nPrzejrzany commit: \`${pr.headRefOid.slice(0, 7)}\` (nowszy commit = przegląd nieaktualny)\n\n| Bramka | | Szczegóły |\n|---|---|---|\n${rows}\n`;
}

function applyVerdict(r) {
  const { pr, verdict } = r;
  const [add, remove] = verdict === 'safe-to-merge' ? [LABEL_OK, LABEL_BAD] : [LABEL_BAD, LABEL_OK];
  const labels = pr.labels.map((l) => l.name);
  const edit = [];
  if (!labels.includes(add)) edit.push('--add-label', add);
  if (labels.includes(remove)) edit.push('--remove-label', remove);
  if (edit.length) gh('pr', 'edit', String(pr.number), ...edit);

  const body = report(r);
  const existing = ghJson('api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate').find((c) => c.body.startsWith(MARKER));
  if (existing) gh('api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`);
  else gh('pr', 'comment', String(pr.number), '--body', body);
}

const numbers = only ?? ghJson('pr', 'list', '--state', 'open', '--json', 'number').map((p) => p.number).sort((a, b) => a - b);
let exit = 0;
for (const n of numbers) {
  try {
    const r = await review(n);
    console.log(`\n#${n} ${r.pr.title}\n  → ${r.verdict}`);
    for (const g of r.gates) console.log(`  ${ICON[g.status]} ${g.name}: ${g.detail}`);
    if (apply && r.verdict !== 'pending') {
      applyVerdict(r);
      console.log(`  (oznaczono: ${r.verdict})`);
    }
  } catch (e) {
    exit = 1;
    console.error(`\n#${n}: błąd — ${e.message}`);
  }
}
if (!apply) console.log('\nDry-run: nic nie zapisano w GitHub (dodaj --apply).');
process.exit(exit);
