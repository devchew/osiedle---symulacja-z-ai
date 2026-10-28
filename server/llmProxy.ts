import type { IncomingMessage, ServerResponse } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv, type Connect, type Plugin } from 'vite';
import type { LlmLineRequest, LlmLineResponse } from '../src/social/llmProvider';
import { LLM_HISTORY_LINES, LLM_LINE_URL, LLM_MAX_LINE, LLM_STATUS_URL, isTone, sanitizeLine } from '../src/social/llmProvider';

// Server-side proxy for LLM dialogue lines. Runs inside the Vite dev / preview
// server only, so ANTHROPIC_API_KEY stays in Node and never reaches the bundle.

export const LLM_MODEL = 'claude-haiku-5-5';
export const LLM_MAX_TOKENS = 400;
export const LLM_TIMEOUT_MS = 6000;
export const LLM_RATE_LIMIT = 20; // requests per window, all clients together
export const LLM_RATE_WINDOW_MS = 60_000;
export const LLM_MAX_IN_FLIGHT = 4;
const MAX_BODY_BYTES = 8 * 1024;

// ------------------------------------------------------------ request validation

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null;
const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;

/** validates + clamps an untrusted request body; null when invalid */
export function validateLineRequest(body: unknown): LlmLineRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const speaker = str(b.speaker, 24);
  const listener = str(b.listener, 24);
  const traits = str(b.traits, 160) ?? '';
  const needs = str(b.needs, 120) ?? '';
  const relationshipLabel = str(b.relationshipLabel, 40) ?? '';
  const topic = str(b.topic, 40);
  const timeOfDay = str(b.timeOfDay, 20) ?? '';
  const mood = num(b.mood, 0, 100);
  const relationship = num(b.relationship, -100, 100);
  const turn = num(b.turn, 0, 50);
  if (!speaker || !listener || !topic || mood === null || relationship === null || turn === null) return null;
  if (typeof b.isLast !== 'boolean') return null;
  const rawHistory = Array.isArray(b.history) ? b.history.slice(-LLM_HISTORY_LINES) : [];
  const history: LlmLineRequest['history'] = [];
  for (const h of rawHistory) {
    if (!h || typeof h !== 'object') return null;
    const hs = str((h as Record<string, unknown>).speaker, 24);
    const ht = str((h as Record<string, unknown>).text, 120);
    if (!hs || ht === null) return null;
    history.push({ speaker: hs, text: ht });
  }
  return { speaker, listener, traits, mood, needs, relationship, relationshipLabel, topic, timeOfDay, history, turn, isLast: b.isLast };
}

// ------------------------------------------------------------ prompt

export const SYSTEM_PROMPT = [
  'Piszesz kwestie dialogowe do symulacji życia w stylu The Sims. Mieszkańcy osiedla rozmawiają ze sobą w dymkach nad głowami.',
  'Za każdym razem dostajesz opis postaci, która teraz mówi, i dotychczasowy przebieg rozmowy. Napisz JEDNĄ następną kwestię tej postaci.',
  'Zasady:',
  `- naturalna, potoczna polszczyzna, jedno krótkie zdanie lub dwa bardzo krótkie, maksymalnie ${LLM_MAX_LINE} znaków;`,
  '- mów w charakterze postaci: uwzględnij nastrój, cechy, potrzeby, relację z rozmówcą, temat i porę dnia;',
  '- reaguj na ostatnią kwestię rozmówcy, nie powtarzaj wcześniejszych kwestii;',
  '- unikaj czasowników w czasie przeszłym z rodzajem (np. "zrobiłem/zrobiłam") i form zdradzających płeć mówiącego; wybieraj czas teraźniejszy, przyszły lub formy bezosobowe;',
  '- bez cudzysłowów, bez imienia mówiącego na początku, bez emoji, bez opisów didaskaliów;',
  '- pierwsza kwestia rozmowy to powitanie, ostatnia to pożegnanie;',
  '- treści przyjazne rodzinie.',
  'Podaj też ton kwestii: "positive", "neutral" albo "negative".',
].join('\n');

export const LINE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: `kwestia po polsku, maks. ${LLM_MAX_LINE} znaków` },
    tone: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
  },
  required: ['text', 'tone'],
  additionalProperties: false,
} as const;

function moodWord(mood: number): string {
  if (mood >= 75) return 'świetny';
  if (mood >= 55) return 'dobry';
  if (mood >= 40) return 'taki sobie';
  if (mood >= 20) return 'kiepski';
  return 'fatalny';
}

export function buildUserPrompt(r: LlmLineRequest): string {
  const lines = [
    `Mówi: ${r.speaker}. Rozmówca: ${r.listener}.`,
    `Charakter mówiącego: ${r.traits || 'przeciętny'}.`,
    `Nastrój: ${moodWord(r.mood)} (${r.mood}/100). Potrzeby: ${r.needs || 'nic pilnego'}.`,
    `Relacja z rozmówcą: ${r.relationshipLabel || 'znajomi'} (sympatia ${r.relationship} w skali -100..100).`,
    `Temat rozmowy: ${r.topic}. Pora: ${r.timeOfDay || 'w ciągu dnia'}.`,
  ];
  if (r.history.length) {
    lines.push('Dotychczasowa rozmowa:');
    for (const h of r.history) lines.push(`${h.speaker}: ${h.text}`);
  } else {
    lines.push('Rozmowa dopiero się zaczyna.');
  }
  const stage = r.isLast ? 'To ostatnia kwestia — pożegnaj się.' : r.turn === 0 ? 'To pierwsza kwestia — przywitaj się.' : `To kwestia nr ${r.turn + 1}.`;
  lines.push(stage, `Napisz następną kwestię postaci ${r.speaker}.`);
  return lines.join('\n');
}

export function buildMessageParams(r: LlmLineRequest, model = LLM_MODEL): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: LLM_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // thinking stays at the model default (adaptive); low effort keeps it short/absent
    output_config: { effort: 'low', format: { type: 'json_schema', schema: LINE_SCHEMA } },
    messages: [{ role: 'user', content: buildUserPrompt(r) }],
  };
}

/** extracts { text, tone } from a Messages API response; null when unusable */
export function parseModelMessage(msg: Pick<Anthropic.Message, 'content' | 'stop_reason'>, speakerName?: string): LlmLineResponse | null {
  if (msg.stop_reason !== 'end_turn') return null; // refusal, max_tokens, …
  const textBlock = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) return null;
  let data: unknown;
  try {
    data = JSON.parse(textBlock.text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { text, tone } = data as Record<string, unknown>;
  const clean = sanitizeLine(text, LLM_MAX_LINE, speakerName);
  if (!clean || !isTone(tone)) return null;
  return { text: clean, tone };
}

// ------------------------------------------------------------ rate limit

export interface RateLimiter {
  /** true (and counts the hit) when a request may proceed */
  tryAcquire(): boolean;
}

export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const hits: number[] = [];
  return {
    tryAcquire() {
      const t = now();
      while (hits.length && hits[0] <= t - windowMs) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(t);
      return true;
    },
  };
}

// ------------------------------------------------------------ HTTP

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** blocks cross-site browser requests (another page can't spend the key) */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** minimal surface of the SDK client we use; injectable for tests */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message>;
  };
}

export interface LlmHandlerOptions {
  apiKey: string | undefined;
  model?: string;
  timeoutMs?: number;
  limiter?: RateLimiter;
  /** factory for the SDK client (tests inject a fake) */
  createClient?: (apiKey: string) => MessagesClient;
  log?: (msg: string) => void;
}

export function createLlmHandler(opts: LlmHandlerOptions): Connect.NextHandleFunction {
  const model = opts.model ?? LLM_MODEL;
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const limiter = opts.limiter ?? createRateLimiter(LLM_RATE_LIMIT, LLM_RATE_WINDOW_MS);
  const log = opts.log ?? ((m: string) => console.warn(`[llm] ${m}`));
  let client: MessagesClient | null = null;
  let inFlight = 0;

  const getClient = (): MessagesClient => {
    if (!client) {
      const key = opts.apiKey!;
      client = opts.createClient ? opts.createClient(key) : (new Anthropic({ apiKey: key }) as MessagesClient);
    }
    return client;
  };

  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === LLM_STATUS_URL && req.method === 'GET') {
      sendJson(res, 200, { available: !!opts.apiKey, model });
      return;
    }
    if (path !== LLM_LINE_URL) {
      next();
      return;
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!opts.apiKey) return sendJson(res, 503, { error: 'ANTHROPIC_API_KEY not set' });
    if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (inFlight >= LLM_MAX_IN_FLIGHT || !limiter.tryAcquire()) return sendJson(res, 429, { error: 'rate limited' });

    inFlight++;
    void (async () => {
      try {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: 'bad json' });
        }
        const request = validateLineRequest(body);
        if (!request) return sendJson(res, 400, { error: 'invalid request' });
        const msg = await getClient().messages.create(buildMessageParams(request, model), { timeout: timeoutMs, maxRetries: 0 });
        const line = parseModelMessage(msg, request.speaker);
        if (!line) {
          log(`unusable model output (stop_reason=${msg.stop_reason})`);
          return sendJson(res, 503, { error: 'unusable model output' });
        }
        sendJson(res, 200, line);
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) {
          sendJson(res, 504, { error: 'timeout' });
        } else if (err instanceof Anthropic.APIError) {
          log(`API error ${err.status ?? ''}: ${err.message}`);
          sendJson(res, 503, { error: 'upstream error' });
        } else {
          log(`error: ${(err as Error).message}`);
          sendJson(res, 503, { error: 'proxy error' });
        }
      } finally {
        inFlight--;
      }
    })();
  };
}

/** Vite plugin: registers /api/llm/* on both the dev and the preview server */
export function llmProxy(): Plugin {
  let handler: Connect.NextHandleFunction | null = null;
  return {
    name: 'sim-llm-proxy',
    configResolved(config) {
      // '' prefix: read all vars from .env files (server-side only, nothing is exposed to import.meta.env)
      const env = loadEnv(config.mode, config.envDir, '');
      const apiKey = (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim() || undefined;
      handler = createLlmHandler({ apiKey });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => (handler ? handler(req, res, next) : next()));
    },
  };
}
