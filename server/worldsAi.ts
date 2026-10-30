import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ConversationContext, DialogueLine, DialogueProvider, Rng } from '../src/types';
import { createLlmProvider } from '../src/social/llmProvider';
import { createDiaryAiClient, DiaryAiError, type DiaryAiClient } from '../src/social/diaryAi';
import { createChronicleAiClient, type ChronicleAiClient } from '../src/social/chronicleAi';

// AI for the live worlds, server-side.
//
// The worlds reuse the browser clients (src/social/llmProvider.ts for dialogue lines,
// src/social/diaryAi.ts for diary rewrites) with a `fetch` that calls the /api/llm handler of
// this same process directly (no network hop, no port to know). So the OpenRouter key, the model
// chain, the rate limiter, the in-flight cap, upstream 429 pauses and the UTC-day budget are the
// very same objects that serve /api/llm — one budget for everything.
//
// On top of that the four worlds share the daily budget (see aiAllowed): each world has an even
// share; a world nobody is watching may spend only half of its share, a watched world may go
// beyond its share into what the others left unused (keeping a small reserve). A refused request
// never fails anything: dialogue falls back to the procedural line synchronously, diary entries
// keep their procedural text.

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * a fetch() that runs `handler` in-process with a fake request / response — enough of
 * http.IncomingMessage / ServerResponse for server/llm.ts (method, url, headers, body stream;
 * statusCode, setHeader, end)
 */
export function inProcessFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://live.internal');
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const body = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.alloc(0);
    const req = Readable.from(body.length ? [body] : []) as unknown as IncomingMessage;
    Object.assign(req, {
      method: (init.method ?? 'GET').toUpperCase(),
      url: url.pathname + url.search,
      // no Origin / Sec-Fetch-Site: a server-side caller, accepted by the same-origin check
      headers: { 'content-type': 'application/json', host: 'live.internal' },
    });
    return new Promise<Response>((resolve, reject) => {
      const headers = new Headers();
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(k: string, v: string | number) {
          headers.set(k, String(v));
          return res;
        },
        getHeader: (k: string) => headers.get(k) ?? undefined,
        writeHead(status: number, h?: Record<string, string>) {
          res.statusCode = status;
          for (const [k, v] of Object.entries(h ?? {})) headers.set(k, v);
          return res;
        },
        end(chunk?: string | Buffer) {
          if (done) return res;
          done = true;
          res.headersSent = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(new Response(chunk === undefined ? null : chunk.toString(), { status: res.statusCode, headers }));
          return res;
        },
      };
      try {
        handler(req, res as unknown as ServerResponse, () => res.writeHead(404).end('{"error":"not found"}'));
      } catch (err) {
        done = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }) as typeof fetch;
}

// ---------------------------------------------------------------- budget split

/** a world nobody watches may spend this part of its even share */
export const AI_IDLE_SHARE = 0.5;
/** a watched world may borrow from the shared pool while more than this part of the limit is left */
export const AI_POOL_RESERVE = 0.1;

export interface AiBudgetView {
  /** today's cap (requests per UTC day) */
  limit: number;
  /** used today, all callers */
  used: number;
}

/** may a world send one more AI request today? (pure) */
export function aiAllowed(p: { limit: number; usedTotal: number; usedByWorld: number; worlds: number; watched: boolean }): boolean {
  if (p.limit <= 0 || p.usedTotal >= p.limit) return false;
  const share = p.limit / Math.max(1, p.worlds);
  if (!p.watched) return p.usedByWorld < share * AI_IDLE_SHARE;
  if (p.usedByWorld < share) return true;
  return p.limit - p.usedTotal > p.limit * AI_POOL_RESERVE;
}

export interface AiGate {
  /** counts the attempt when allowed */
  tryAcquire(place: string): boolean;
  /** gives an attempt back (it never reached OpenRouter: local cooldown / rate limit) */
  refund(place: string): void;
  usedBy(place: string): number;
}

export function createAiGate(opts: { budget: AiBudgetView; worlds: number; watched: (place: string) => boolean; now?: () => number }): AiGate {
  const now = opts.now ?? Date.now;
  let day = '';
  const used = new Map<string, number>();
  const roll = (): void => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      used.clear();
    }
  };
  return {
    tryAcquire(place) {
      roll();
      const usedByWorld = used.get(place) ?? 0;
      const ok = aiAllowed({ limit: opts.budget.limit, usedTotal: opts.budget.used, usedByWorld, worlds: opts.worlds, watched: opts.watched(place) });
      if (ok) used.set(place, usedByWorld + 1);
      return ok;
    },
    refund(place) {
      roll();
      const n = used.get(place) ?? 0;
      if (n > 0) used.set(place, n - 1);
    },
    usedBy(place) {
      roll();
      return used.get(place) ?? 0;
    },
  };
}

// ---------------------------------------------------------------- providers

/** LLM dialogue gated by the world's budget share; falls back to `fallback` synchronously */
export function createGatedDialogue(place: string, gate: AiGate, fetchImpl: typeof fetch, fallback: DialogueProvider): DialogueProvider {
  const llm = createLlmProvider({ fetch: fetchImpl, baseUrl: 'http://live.internal' });
  return {
    name: 'llm',
    nextLine(ctx: ConversationContext, rng: Rng): DialogueLine | Promise<DialogueLine> {
      if (!gate.tryAcquire(place)) return fallback.nextLine(ctx, rng);
      const line = llm.nextLine(ctx, rng);
      if (line instanceof Promise)
        line.catch((err: unknown) => {
          if (/cooling down|http 429/.test((err as Error)?.message ?? '')) gate.refund(place);
        });
      return line;
    },
  };
}

/** diary AI client gated by the world's budget share (a refusal = "daily budget", the entry stays procedural) */
export function createGatedDiaryClient(place: string, gate: AiGate, fetchImpl: typeof fetch): DiaryAiClient {
  const inner = createDiaryAiClient({ fetch: fetchImpl, baseUrl: 'http://live.internal' });
  return {
    write(req, allow) {
      if (!gate.tryAcquire(place)) return Promise.reject(new DiaryAiError('live world budget share used', 429, 'daily budget share'));
      return inner.write(req, allow);
    },
  };
}

/** chronicle summary client gated by the world's budget share (a refusal keeps the procedural summary) */
export function createGatedChronicleClient(place: string, gate: AiGate, fetchImpl: typeof fetch): ChronicleAiClient {
  const inner = createChronicleAiClient({ fetch: fetchImpl, baseUrl: 'http://live.internal' });
  return {
    write(req) {
      if (!gate.tryAcquire(place)) return Promise.reject(new DiaryAiError('live world budget share used', 429, 'daily budget share'));
      return inner.write(req);
    },
  };
}
