// AI rewrite of diary entries (optional, only with the AI dialogue mode on).
// Shared by the browser (client below) and the proxy (server/llm.ts): request
// contract, validation, output sanitizing and the gendered-form detector.
// No runtime imports from the simulation, so the production server bundle stays small.

export const LLM_DIARY_URL = '/api/llm/diary';
/** the model is asked for at most this many words; longer answers are cut at a sentence end */
export const DIARY_AI_MAX_WORDS = 120;
/** hard cap after sanitizing (characters) */
export const DIARY_AI_MAX_CHARS = 1100;
/** shorter answers are rejected (keeps the procedural entry) */
export const DIARY_AI_MIN_WORDS = 15;
export const DIARY_MAX_FACTS = 24;
export const DIARY_FACT_CHARS = 160;
export const DIARY_MAX_NEWS = 2;
export const DIARY_NEWS_CHARS = 160;

/** compact, JSON-serialisable request (names only, no ids) */
export interface LlmDiaryRequest {
  /** writer's name */
  name: string;
  /** short Polish trait description (describeTraits) */
  traits: string;
  /** writer's mood at bedtime, 0..100 */
  mood: number;
  /** Polish one-liner, e.g. "rano 62, wieczorem 80, najniżej 41 po południu" */
  moodArc: string;
  /** game day (1-based) */
  day: number;
  /** what really happened, short Polish fact lines */
  facts: string[];
  /** TV headlines the writer saw (verbatim, may be quoted only as given) */
  news: string[];
}

export interface LlmDiaryResponse {
  text: string;
}

// ------------------------------------------------------------ gendered forms

/** first/second person past tense: always reveals the writer's (or addressee's) gender */
const PAST_PERSONAL = /(łem|łam|łeś|łaś|liśmy|łyśmy|liście|łyście)$/;
/** third person past tense singular/plural (non-masculine-personal) */
const PAST_THIRD = /(ł|ła|ły)$/;
/** masculine-personal plural past tense that is common in a diary */
const PAST_LI = new Set([
  'byli', 'mieli', 'poszli', 'przyszli', 'wyszli', 'weszli', 'szli', 'zjedli', 'jedli', 'robili', 'zrobili', 'gadali', 'rozmawiali',
  'kłócili', 'pokłócili', 'oglądali', 'grali', 'spali', 'mogli', 'chcieli', 'wiedzieli', 'musieli', 'powiedzieli', 'widzieli',
  'słyszeli', 'siedzieli', 'pili', 'gotowali', 'śmiali', 'tańczyli', 'czytali', 'łowili', 'biegali', 'spędzili', 'zostali',
]);
/** words ending like a past-tense form that are nouns / adjectives (not about anyone's gender) */
const NOT_PAST = new Set([
  'stół', 'dół', 'kościół', 'orzeł', 'anioł', 'węzeł', 'popiół', 'kocioł', 'pół', 'wół', 'muł', 'kół',
  'mała', 'mały', 'cała', 'cały', 'biała', 'biały', 'wesoła', 'wesoły', 'ciepła', 'ciepły', 'miła', 'miły', 'zła', 'zły',
  'siła', 'siły', 'skała', 'skały', 'szkoła', 'szkoły', 'pszczoła', 'pszczoły', 'mgła', 'mgły', 'igła', 'strzała', 'chała',
  'dojrzała', 'dojrzały', 'okrągła', 'okrągły', 'śmiała', 'śmiały', 'trwała', 'trwały', 'doskonała', 'doskonały', 'stała', 'stały',
  'gała', 'pała', 'zgniły', 'zgniła', 'spleśniały', 'zapał', 'upał', 'kanał', 'materiał',
  'ideał', 'szał', 'pedał', 'pedały', 'sandał', 'sandały', 'kryształ', 'generał', 'kapitał', 'rytuał', 'potencjał', 'sygnał',
  'sygnały', 'kanały', 'materiały', 'ideały', 'upały', 'zapały', 'działa', 'mydła', 'koła', 'koły', 'stoły', 'doły', 'kościoły',
]);
/** after "jestem / czuję się / będę" these are fine (prepositions, adverbs handled by the ending check) */
const AFTER_BE_OK = new Set(['na', 'za', 'do', 'po', 'przy', 'bez', 'od', 'pod', 'nad', 'przed', 'tu', 'tam', 'w', 'we', 'z', 'ze', 'u', 'jak', 'taka']);

/** removes quoted fragments („…”, "…") — quotes (e.g. news headlines) are not the writer's words */
export function stripQuotes(text: string): string {
  return text.replace(/„[^”]*”/g, ' ').replace(/"[^"]*"/g, ' ');
}

/**
 * gendered forms in Polish text: past tense with gender ("zrobiłam", "poszedł", "byli")
 * and gendered adjectives about the writer ("jestem zmęczona"). Quotes are ignored.
 * `allow` = extra words that are fine (e.g. names).
 */
export function findGenderedForms(text: string, allow: Iterable<string> = []): string[] {
  const ok = new Set([...allow].map((w) => w.toLowerCase()));
  const out: string[] = [];
  const plain = stripQuotes(text);
  const words = plain.toLowerCase().match(/\p{L}+/gu) ?? [];
  for (const w of words) {
    if (ok.has(w) || NOT_PAST.has(w)) continue;
    if (PAST_PERSONAL.test(w) || PAST_LI.has(w) || (w.length > 2 && PAST_THIRD.test(w))) out.push(w);
  }
  const be = /(?:^|[^\p{L}])(jestem|czuję się|będę|zostaję)\s+(\p{L}+)/giu;
  for (let m = be.exec(plain); m; m = be.exec(plain)) {
    const next = m[2].toLowerCase();
    if (AFTER_BE_OK.has(next) || ok.has(next)) continue;
    if (/(y|a|i|ny|na|ty|ta)$/.test(next) && !/(o|e)$/.test(next)) out.push(`${m[1].toLowerCase()} ${next}`);
  }
  return out;
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []).length;
}

// ------------------------------------------------------------ validation (server) and sanitizing (both)

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null;

/** validates + clamps an untrusted diary request; null when invalid */
export function validateDiaryRequest(body: unknown): LlmDiaryRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = str(b.name, 24);
  const traits = str(b.traits, 160) ?? '';
  const moodArc = str(b.moodArc, 120) ?? '';
  const mood = typeof b.mood === 'number' && Number.isFinite(b.mood) ? Math.max(0, Math.min(100, Math.round(b.mood))) : null;
  const day = typeof b.day === 'number' && Number.isInteger(b.day) && b.day >= 1 && b.day <= 100_000 ? b.day : null;
  if (!name || mood === null || day === null) return null;
  if (!Array.isArray(b.facts) || b.facts.length === 0 || b.facts.length > DIARY_MAX_FACTS) return null;
  const facts: string[] = [];
  for (const f of b.facts) {
    const t = str(f, DIARY_FACT_CHARS);
    if (!t) return null;
    facts.push(t);
  }
  const news: string[] = [];
  if (b.news !== undefined) {
    if (!Array.isArray(b.news) || b.news.length > DIARY_MAX_NEWS) return null;
    for (const n of b.news) {
      const t = str(n, DIARY_NEWS_CHARS);
      if (!t) return null;
      news.push(t);
    }
  }
  return { name, traits, mood, moodArc, day, facts, news };
}

/** cuts text to ≤ maxWords at the last sentence end (or word) */
function limitWords(text: string, maxWords: number): string {
  if (countWords(text) <= maxWords) return text;
  const tokens = text.split(/(\s+)/);
  let n = 0;
  let out = '';
  for (const tok of tokens) {
    if (/\S/.test(tok)) {
      n += countWords(tok);
      if (n > maxWords) break;
    }
    out += tok;
  }
  const end = Math.max(out.lastIndexOf('. '), out.lastIndexOf('! '), out.lastIndexOf('? '), out.lastIndexOf('.\n'), out.lastIndexOf('!\n'));
  return (end > out.length * 0.5 ? out.slice(0, end + 1) : `${out.trim().replace(/[,;:–-]+$/, '')}…`).trim();
}

export interface DiarySanitizeOptions {
  /** writer's name (a "Name:" prefix or a signature is dropped) */
  name?: string;
  /** headlines given to the model: any „quote” must be one of them */
  news?: readonly string[];
  /** extra allowed words for the gender check (names) */
  allow?: Iterable<string>;
  /** residents' names: a preposition right before one ("ze Staś", "z Ola") is rejected as broken grammar */
  names?: readonly string[];
}

/**
 * cleans an AI diary text: paragraphs kept (max 4), control chars and markdown removed,
 * ≤ DIARY_AI_MAX_WORDS words. null when unusable: too short, gendered past tense / adjectives,
 * or a quoted „headline” that was not provided.
 */
export function sanitizeDiaryText(raw: unknown, opts: DiarySanitizeOptions = {}): string | null {
  const r = checkDiaryText(raw, opts);
  return 'text' in r ? r.text : null;
}

/** like sanitizeDiaryText, but says why a text was rejected (for the proxy's log; never the text itself) */
export function checkDiaryText(raw: unknown, opts: DiarySanitizeOptions = {}): { text: string } | { reason: string } {
  if (typeof raw !== 'string') return { reason: 'no text' };
  let s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ');
  // markdown leftovers: headings, bold, bullets
  s = s.replace(/^#+\s*/gm, '').replace(/\*\*|__/g, '').replace(/^\s*[-*•]\s+/gm, '');
  let paras = s
    .split(/\n\s*\n|\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (opts.name) {
    const n = opts.name.toLowerCase();
    paras = paras.map((p) => (p.toLowerCase().startsWith(`${n}:`) ? p.slice(n.length + 1).trim() : p));
    // drop a trailing signature ("— Ola", "Ola")
    const last = paras[paras.length - 1]?.replace(/^[—–-]\s*/, '').replace(/[.!]$/, '').toLowerCase();
    if (last === n) paras.pop();
  }
  // a date header is the UI's job
  if (paras.length && /^(dzień|dzien)\s+\d+\.?$/i.test(paras[0])) paras.shift();
  if (paras.length > 4) paras = [...paras.slice(0, 3), paras.slice(3).join(' ')];
  let text = paras.join('\n\n');
  text = limitWords(text, DIARY_AI_MAX_WORDS);
  if (text.length > DIARY_AI_MAX_CHARS) text = limitWords(text.slice(0, DIARY_AI_MAX_CHARS), DIARY_AI_MAX_WORDS);
  if (countWords(text) < DIARY_AI_MIN_WORDS) return { reason: 'too short' };
  const gendered = findGenderedForms(text, opts.allow ?? []);
  if (gendered.length > 0) return { reason: `gendered forms: ${gendered.slice(0, 3).join(', ')}` };
  const esc = (n: string): string => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = (opts.names ?? []).filter((n) => n.length > 1).map(esc);
  if (names.length && new RegExp(`(^|[^\\p{L}])(ze?|dla|od|do|przy|u)\\s+(${names.join('|')})(?![\\p{L}])`, 'iu').test(stripQuotes(text)))
    return { reason: 'preposition before a name' };
  const news = (opts.news ?? []).map((n) => n.replace(/\s+/g, ' ').trim());
  for (const m of text.matchAll(/„([^”]*)”/g)) {
    const q = m[1].replace(/…$/, '').trim();
    if (q.length < 3) continue;
    if (!news.some((n) => n.startsWith(q) || q.startsWith(n))) return { reason: 'quote not among the given headlines' };
  }
  return { text };
}

// ------------------------------------------------------------ client

export interface DiaryAiClientOptions {
  /** injectable for tests */
  fetch?: typeof fetch;
  /** base URL, default '' (same origin) */
  baseUrl?: string;
  /** client-side timeout in ms (default 20000) */
  timeoutMs?: number;
}

/** error from the proxy; `status` = HTTP status (0 = network / timeout / bad body) */
export class DiaryAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string = '',
  ) {
    super(message);
  }
}

export interface DiaryAiClient {
  /** resolves with the sanitized text; rejects with DiaryAiError */
  write(req: LlmDiaryRequest, allow?: Iterable<string>): Promise<string>;
}

export function createDiaryAiClient(opts: DiaryAiClientOptions = {}): DiaryAiClient {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = `${opts.baseUrl ?? ''}${LLM_DIARY_URL}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    async write(req, allow = []) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiaryAiError('diary ai timeout', 0, 'timeout'));
        }, timeoutMs);
      });
      try {
        const res = await Promise.race([
          doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: controller.signal }),
          timeout,
        ]);
        if (!res.ok) {
          let reason = '';
          try {
            const e = (await res.json()) as { error?: unknown };
            if (typeof e.error === 'string') reason = e.error;
          } catch {
            /* non-JSON */
          }
          throw new DiaryAiError(`diary ai http ${res.status}`, res.status, reason);
        }
        const body = (await Promise.race([res.json(), timeout])) as Record<string, unknown> | null;
        const names = [req.name, ...allow];
        const text = sanitizeDiaryText(body?.text, { name: req.name, news: req.news, allow: names, names });
        if (!text) throw new DiaryAiError('diary ai malformed response', 0, 'malformed');
        return text;
      } catch (err) {
        if (err instanceof DiaryAiError) throw err;
        throw new DiaryAiError(`diary ai ${(err as Error).message}`, 0, 'network');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
