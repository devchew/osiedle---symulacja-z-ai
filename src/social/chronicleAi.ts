import { DiaryAiError, checkDiaryText, countWords } from './diaryAi.ts';

// AI summary of one finished day of a place's chronicle (optional, server-side only, budgeted).
// Shared by the server (client below, request validation in server/llm.ts) and tests. Same rules
// as the diaries: present tense, names in the nominative, no gendered forms; any failure keeps
// the procedural summary.

export const LLM_CHRONICLE_URL = '/api/llm/chronicle';
export const CHRONICLE_AI_MAX_FACTS = 14;
export const CHRONICLE_FACT_CHARS = 160;
export const CHRONICLE_AI_MAX_NAMES = 12;
/** longer answers are rejected (the summary is one short paragraph) */
export const CHRONICLE_AI_MAX_WORDS = 90;

export interface LlmChronicleRequest {
  /** Polish place name, e.g. "Kamienica" */
  place: string;
  /** local calendar date YYYY-MM-DD */
  date: string;
  /** what really happened, short Polish fact lines */
  facts: string[];
  /** residents' names (for the grammar check) */
  names: string[];
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null;

/** validates + clamps an untrusted chronicle request; null when invalid */
export function validateChronicleRequest(body: unknown): LlmChronicleRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const place = str(b.place, 60);
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  if (!place || !date) return null;
  if (!Array.isArray(b.facts) || b.facts.length === 0 || b.facts.length > CHRONICLE_AI_MAX_FACTS) return null;
  const facts: string[] = [];
  for (const f of b.facts) {
    const t = str(f, CHRONICLE_FACT_CHARS);
    if (!t) return null;
    facts.push(t);
  }
  const names: string[] = [];
  if (b.names !== undefined) {
    if (!Array.isArray(b.names) || b.names.length > CHRONICLE_AI_MAX_NAMES) return null;
    for (const n of b.names) {
      const t = str(n, 24);
      if (!t) return null;
      names.push(t);
    }
  }
  return { place, date, facts, names };
}

/** cleans an AI summary into one paragraph; says why it was rejected otherwise */
export function checkChronicleText(raw: unknown, req: Pick<LlmChronicleRequest, 'names'>): { text: string } | { reason: string } {
  const checked = checkDiaryText(raw, { allow: req.names, names: req.names, news: [] });
  if ('reason' in checked) return checked;
  const text = checked.text.replace(/\s*\n+\s*/g, ' ').trim();
  if (countWords(text) > CHRONICLE_AI_MAX_WORDS) return { reason: 'too long' };
  return { text };
}

export interface ChronicleAiClient {
  /** resolves with the sanitized summary; rejects with DiaryAiError */
  write(req: LlmChronicleRequest): Promise<string>;
}

export interface ChronicleAiClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createChronicleAiClient(opts: ChronicleAiClientOptions = {}): ChronicleAiClient {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = `${opts.baseUrl ?? ''}${LLM_CHRONICLE_URL}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    async write(req) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiaryAiError('chronicle ai timeout', 0, 'timeout'));
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
          throw new DiaryAiError(`chronicle ai http ${res.status}`, res.status, reason);
        }
        const body = (await Promise.race([res.json(), timeout])) as Record<string, unknown> | null;
        const checked = checkChronicleText(body?.text, req);
        if ('reason' in checked) throw new DiaryAiError('chronicle ai malformed response', 0, 'malformed');
        return checked.text;
      } catch (err) {
        if (err instanceof DiaryAiError) throw err;
        throw new DiaryAiError(`chronicle ai ${(err as Error).message}`, 0, 'network');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
