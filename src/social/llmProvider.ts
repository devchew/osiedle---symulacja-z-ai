import type { ConversationContext, DialogueLine, DialogueProvider, Gossip, NeedKey, Tone, Traits } from '../types';
import { NEED_KEYS, NEED_LABELS } from '../types';
import { relationshipLabel } from './relationships';

// LLM-backed dialogue. The browser never talks to OpenRouter directly: it posts
// a compact context to the local proxy (server/llmProxy.ts, a Vite plugin),
// which holds the API key. Any failure rejects the promise, and
// agents/actions.ts then falls back to the procedural provider.

export const LLM_STATUS_URL = '/api/llm/status';
export const LLM_LINE_URL = '/api/llm/line';
/** hard cap on a spoken line (bubble-friendly) */
export const LLM_MAX_LINE = 70;
export const LLM_HISTORY_LINES = 6;
/** at most this many remembered stories are offered to the model per line */
export const LLM_MAX_GOSSIP = 3;
const TONES: readonly Tone[] = ['positive', 'neutral', 'negative'];

/** compact, JSON-serialisable context sent to the proxy (no agent objects, no ids) */
export interface LlmLineRequest {
  speaker: string;
  listener: string;
  /** short Polish trait description, e.g. "towarzyska, pogodna" */
  traits: string;
  /** 0..100 */
  mood: number;
  /** short Polish summary of pressing needs, e.g. "głodna, zmęczona" or "nic pilnego" */
  needs: string;
  /** speaker's sympathy towards listener, -100..100 */
  relationship: number;
  relationshipLabel: string;
  topic: string;
  /** "rano" | "w ciągu dnia" | "wieczorem" | "w nocy" */
  timeOfDay: string;
  /** last ≤ 6 lines, oldest first */
  history: { speaker: string; text: string }[];
  turn: number;
  isLast: boolean;
  /** stories the speaker could retell (≤ 3); the model answers with the index of the one it used */
  gossip?: LlmGossip[];
}

export interface LlmGossip {
  /** Polish third-person phrase, e.g. "Ola przypala obiad" */
  text: string;
  /** -1 embarrassing .. 1 admirable */
  valence: number;
  /** both speaker and listener lived through it */
  shared: boolean;
}

export interface LlmLineResponse {
  text: string;
  tone: Tone;
  /** index into the request's `gossip` when the line retells that story, else null */
  gossip: number | null;
}

/** true when `v` is a valid index into a gossip list of length `count` */
export function isGossipIndex(v: unknown, count: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count;
}

export function isTone(v: unknown): v is Tone {
  return typeof v === 'string' && (TONES as readonly string[]).includes(v);
}

/** single line, no wrapping quotes / speaker prefix, collapsed whitespace, ≤ max chars */
export function sanitizeLine(raw: unknown, max = LLM_MAX_LINE, speakerName?: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // strip wrapping quotes, repeatedly ("„Cześć”" → Cześć)
  const quotes = /^["'„”“«»‚‘’`]+|["'„”“«»‚‘’`]+$/g;
  for (let i = 0; i < 3; i++) s = s.replace(quotes, '').trim();
  // drop an accidental "Name: " prefix
  if (speakerName && s.toLowerCase().startsWith(`${speakerName.toLowerCase()}:`)) {
    s = s.slice(speakerName.length + 1).trim();
    for (let i = 0; i < 3; i++) s = s.replace(quotes, '').trim();
  }
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    s = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '')}…`;
  }
  return s;
}

const TRAIT_WORDS: Record<keyof Traits, [string, string]> = {
  sociability: ['ceni ciszę i samotność', 'uwielbia towarzystwo'],
  activity: ['lubi leniuchować', 'lubi ruch i działanie'],
  neatness: ['nie przejmuje się bałaganem', 'lubi porządek'],
  cheerfulness: ['często marudzi', 'tryska humorem'],
};

export function describeTraits(t: Traits): string {
  const out: string[] = [];
  for (const key of Object.keys(TRAIT_WORDS) as (keyof Traits)[]) {
    const v = t[key];
    if (Math.abs(v) >= 0.35) out.push(TRAIT_WORDS[key][v < 0 ? 0 : 1]);
  }
  return out.length ? out.join(', ') : 'przeciętny charakter';
}

export function describeNeeds(needs: Record<NeedKey, number>): string {
  const low = NEED_KEYS.filter((k) => needs[k] < 30)
    .sort((a, b) => needs[a] - needs[b])
    .slice(0, 3)
    .map((k) => `${NEED_LABELS[k].toLowerCase()} ${Math.round(needs[k])}/100`);
  return low.length ? `niskie: ${low.join(', ')}` : 'nic pilnego';
}

const TIME_OF_DAY = { morning: 'rano', day: 'w ciągu dnia', evening: 'wieczorem', night: 'w nocy' } as const;

/**
 * stories offered to the model for this line: none once the speaker has told one in this
 * conversation (same rule as the procedural provider), never one already told, at most 3
 */
export function gossipCandidates(ctx: ConversationContext): Gossip[] {
  if (!ctx.gossip?.length) return [];
  if (ctx.history.some((l) => l.gossip && l.speakerId === ctx.speaker.id)) return [];
  const told = new Set(ctx.history.filter((l) => l.gossip).map((l) => l.gossip!.text));
  return ctx.gossip.filter((g) => !told.has(g.text)).slice(0, LLM_MAX_GOSSIP);
}

export function buildLineRequest(ctx: ConversationContext, candidates: Gossip[] = gossipCandidates(ctx)): LlmLineRequest {
  const names = new Map([
    [ctx.speaker.id, ctx.speaker.name],
    [ctx.listener.id, ctx.listener.name],
  ]);
  return {
    speaker: ctx.speaker.name,
    listener: ctx.listener.name,
    traits: describeTraits(ctx.speaker.traits),
    mood: Math.round(ctx.speaker.mood),
    needs: describeNeeds(ctx.speaker.needs),
    relationship: Math.round(ctx.relationship),
    relationshipLabel: relationshipLabel(ctx.relationship),
    topic: ctx.topic,
    timeOfDay: TIME_OF_DAY[ctx.time.phase],
    history: ctx.history.slice(-LLM_HISTORY_LINES).map((l) => ({ speaker: names.get(l.speakerId) ?? '?', text: l.text })),
    turn: ctx.turn,
    isLast: ctx.isLast,
    gossip: candidates.map((g) => ({ text: g.text, valence: Math.round(g.valence * 100) / 100, shared: !!g.shared })),
  };
}

/** validates a proxy response; null when unusable. An invalid gossip index becomes null. */
export function parseLineResponse(body: unknown, speakerName?: string, gossipCount = 0): LlmLineResponse | null {
  if (!body || typeof body !== 'object') return null;
  const { text, tone, gossip } = body as Record<string, unknown>;
  const clean = sanitizeLine(text, LLM_MAX_LINE, speakerName);
  if (clean.length < 1 || !isTone(tone)) return null;
  return { text: clean, tone, gossip: isGossipIndex(gossip, gossipCount) ? gossip : null };
}

export interface LlmProviderOptions {
  /** client-side timeout in ms (default 14000; the proxy itself gives up after ~12 s) */
  timeoutMs?: number;
  /** injectable for tests */
  fetch?: typeof fetch;
  /** base URL, default '' (same origin) */
  baseUrl?: string;
  /** after a failure (rate limit, timeout, upstream error) skip the network for this long; default 5000 ms */
  cooldownMs?: number;
  /** injectable clock for tests */
  now?: () => number;
}

export function createLlmProvider(opts: LlmProviderOptions = {}): DialogueProvider {
  const timeoutMs = opts.timeoutMs ?? 14_000;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = `${opts.baseUrl ?? ''}${LLM_LINE_URL}`;
  const cooldownMs = opts.cooldownMs ?? 5000;
  const now = opts.now ?? Date.now;
  let blockedUntil = 0;

  return {
    name: 'llm',
    async nextLine(ctx: ConversationContext): Promise<DialogueLine> {
      // during a cooldown fail fast: actions.ts uses the procedural line instead
      if (now() < blockedUntil) throw new Error('llm cooling down');
      const candidates = gossipCandidates(ctx);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('llm timeout'));
        }, timeoutMs);
      });
      try {
        const res = await Promise.race([
          doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildLineRequest(ctx, candidates)),
            signal: controller.signal,
          }),
          timeout,
        ]);
        if (!res.ok) throw new Error(`llm http ${res.status}`);
        const body: unknown = await Promise.race([res.json(), timeout]);
        const parsed = parseLineResponse(body, ctx.speaker.name, candidates.length);
        if (!parsed) throw new Error('llm malformed response');
        const line: DialogueLine = { speakerId: ctx.speaker.id, text: parsed.text, tone: parsed.tone };
        // the exact Gossip object from ctx: social/memory spreads it when the conversation ends
        if (parsed.gossip !== null) line.gossip = candidates[parsed.gossip];
        return line;
      } catch (err) {
        blockedUntil = now() + cooldownMs;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface LlmStatus {
  available: boolean;
  provider?: string;
  /** configured OpenRouter model ids, in fallback order */
  models: string[];
}

/** "google/gemma-4-31b-it:free" → "gemma-4-31b-it" */
export function modelShortName(id: string): string {
  return id.replace(/^.*\//, '').replace(/:free$/, '');
}

export const isFreeModel = (id: string): boolean => id.endsWith(':free');

/** asks the proxy whether a key is configured; never throws */
export async function fetchLlmStatus(doFetch: typeof fetch = fetch, timeoutMs = 3000): Promise<LlmStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(LLM_STATUS_URL, { signal: controller.signal });
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as Record<string, unknown>;
    const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string').slice(0, 8) : [];
    return {
      available: body.available === true,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      models,
    };
  } catch {
    return { available: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
