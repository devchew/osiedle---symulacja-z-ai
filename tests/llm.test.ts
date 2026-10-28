import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';
import {
  LLM_MAX_LINE,
  buildLineRequest,
  createLlmProvider,
  describeNeeds,
  describeTraits,
  parseLineResponse,
  sanitizeLine,
  type LlmLineRequest,
} from '../src/social/llmProvider';
import {
  LINE_SCHEMA,
  LLM_MODEL,
  SYSTEM_PROMPT,
  buildMessageParams,
  buildUserPrompt,
  createLlmHandler,
  createRateLimiter,
  parseModelMessage,
  validateLineRequest,
  type MessagesClient,
} from '../server/llmProxy';
import type { Agent, ConversationContext, Traits } from '../src/types';

function makeAgent(id: number, name: string, traits: Partial<Traits> = {}, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    color: '#f00',
    traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0, ...traits },
    needs: { hunger: 70, energy: 70, fun: 60, social: 50, hygiene: 70, comfort: 70 },
    mood: 60,
    pos: { x: 0, y: 0 },
    prevPos: { x: 0, y: 0 },
    facing: 1,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
    ...extra,
  };
}

function makeCtx(over: Partial<ConversationContext> = {}): ConversationContext {
  const speaker = makeAgent(1, 'Ola', { sociability: 0.8, cheerfulness: -0.6 }, { needs: { hunger: 10, energy: 25, fun: 60, social: 50, hygiene: 70, comfort: 70 } });
  const listener = makeAgent(2, 'Bartek');
  return {
    speaker,
    listener,
    relationship: 32,
    topic: 'muzyka',
    history: [
      { speakerId: 2, text: 'Hej Ola!', tone: 'positive' },
      { speakerId: 1, text: 'Cześć.', tone: 'neutral' },
    ],
    turn: 2,
    isLast: false,
    time: timeFromTick(0),
    ...over,
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ------------------------------------------------------------------ client

describe('sanitizeLine', () => {
  it('strips quotes, newlines and speaker prefix', () => {
    expect(sanitizeLine('  "Cześć,\n  jak leci?"  ')).toBe('Cześć, jak leci?');
    expect(sanitizeLine('„Super dzień!”')).toBe('Super dzień!');
    expect(sanitizeLine('Ola: "No hej!"', LLM_MAX_LINE, 'Ola')).toBe('No hej!');
    expect(sanitizeLine('Słuchaj: to ważne', LLM_MAX_LINE, 'Ola')).toBe('Słuchaj: to ważne');
  });

  it('clamps long lines with an ellipsis at a word boundary', () => {
    const long = 'To jest bardzo długa kwestia, która zdecydowanie nie zmieści się w żadnym dymku nad głową postaci.';
    const out = sanitizeLine(long);
    expect(out.length).toBeLessThanOrEqual(LLM_MAX_LINE);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it('rejects non-strings', () => {
    expect(sanitizeLine(42)).toBe('');
    expect(sanitizeLine(null)).toBe('');
  });
});

describe('buildLineRequest', () => {
  it('builds a compact context with ≤ 6 history lines and names instead of ids', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ speakerId: i % 2 ? 1 : 2, text: `linia ${i}`, tone: 'neutral' as const }));
    const req = buildLineRequest(makeCtx({ history: many, turn: 9 }));
    expect(req.speaker).toBe('Ola');
    expect(req.listener).toBe('Bartek');
    expect(req.history).toHaveLength(6);
    expect(req.history[5]).toEqual({ speaker: 'Bartek', text: 'linia 8' });
    expect(req.relationshipLabel).toBe('koledzy');
    expect(req.timeOfDay).toBe('rano');
    expect(req.traits).toContain('uwielbia towarzystwo');
    expect(req.needs).toMatch(/^niskie: głód 10\/100, energia 25\/100/);
    expect(JSON.stringify(req)).not.toContain('"pos"');
  });

  it('describes neutral characters and satisfied needs', () => {
    expect(describeTraits({ sociability: 0, activity: 0.1, neatness: -0.2, cheerfulness: 0 })).toBe('przeciętny charakter');
    expect(describeNeeds({ hunger: 90, energy: 90, fun: 90, social: 90, hygiene: 90, comfort: 90 })).toBe('nic pilnego');
  });
});

describe('parseLineResponse', () => {
  it('accepts valid bodies and rejects malformed ones', () => {
    expect(parseLineResponse({ text: 'Hej!', tone: 'positive' })).toEqual({ text: 'Hej!', tone: 'positive' });
    expect(parseLineResponse({ text: 'Hej!', tone: 'happy' })).toBeNull();
    expect(parseLineResponse({ text: '   ', tone: 'neutral' })).toBeNull();
    expect(parseLineResponse({ tone: 'neutral' })).toBeNull();
    expect(parseLineResponse('Hej')).toBeNull();
    expect(parseLineResponse(null)).toBeNull();
  });
});

describe('createLlmProvider', () => {
  const rng = createRng(1);

  it('returns a sanitized line on success and posts the compact context', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ text: '"Ta piosenka jest super!"\n', tone: 'positive' }));
    const provider = createLlmProvider({ fetch: fetchMock as unknown as typeof fetch });
    const result = provider.nextLine(makeCtx(), rng);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ speakerId: 1, text: 'Ta piosenka jest super!', tone: 'positive' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/llm/line');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(String(init?.body)) as LlmLineRequest;
    expect(sent.topic).toBe('muzyka');
    expect(sent.turn).toBe(2);
  });

  it('rejects on HTTP errors and malformed responses', async () => {
    const p1 = createLlmProvider({ fetch: (async () => jsonResponse({ error: 'x' }, 503)) as typeof fetch, cooldownMs: 0 });
    await expect(p1.nextLine(makeCtx(), rng)).rejects.toThrow(/503/);
    const p2 = createLlmProvider({ fetch: (async () => jsonResponse({ text: 'Hej', tone: 'angry' })) as typeof fetch, cooldownMs: 0 });
    await expect(p2.nextLine(makeCtx(), rng)).rejects.toThrow(/malformed/);
    const p3 = createLlmProvider({ fetch: (async () => new Response('not json')) as typeof fetch, cooldownMs: 0 });
    await expect(p3.nextLine(makeCtx(), rng)).rejects.toThrow();
  });

  it('rejects (and aborts the request) after the client timeout', async () => {
    let aborted = false;
    const hanging = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => (aborted = true));
      })) as typeof fetch;
    const provider = createLlmProvider({ fetch: hanging, timeoutMs: 30 });
    await expect(provider.nextLine(makeCtx(), rng)).rejects.toThrow(/timeout/);
    expect(aborted).toBe(true);
  });

  it('fails fast during the cooldown after a failure', async () => {
    let t = 1000;
    const fetchMock = vi.fn(async () => jsonResponse({}, 429));
    const provider = createLlmProvider({ fetch: fetchMock as unknown as typeof fetch, cooldownMs: 5000, now: () => t });
    await expect(provider.nextLine(makeCtx(), rng)).rejects.toThrow(/429/);
    await expect(provider.nextLine(makeCtx(), rng)).rejects.toThrow(/cooling/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += 5001;
    fetchMock.mockImplementation(async () => jsonResponse({ text: 'Już działa.', tone: 'neutral' }));
    await expect(provider.nextLine(makeCtx(), rng)).resolves.toMatchObject({ text: 'Już działa.' });
  });
});

// ------------------------------------------------------------------ server

const validRequest = (): LlmLineRequest => buildLineRequest(makeCtx());

describe('validateLineRequest', () => {
  it('accepts a client request and clamps values', () => {
    const req = validateLineRequest({ ...validRequest(), mood: 250, relationship: -999, speaker: 'X'.repeat(100) });
    expect(req).not.toBeNull();
    expect(req!.mood).toBe(100);
    expect(req!.relationship).toBe(-100);
    expect(req!.speaker.length).toBe(24);
  });

  it('rejects junk', () => {
    expect(validateLineRequest(null)).toBeNull();
    expect(validateLineRequest({})).toBeNull();
    expect(validateLineRequest({ ...validRequest(), isLast: 'no' })).toBeNull();
    expect(validateLineRequest({ ...validRequest(), mood: 'happy' })).toBeNull();
    expect(validateLineRequest({ ...validRequest(), history: [{ speaker: 1 }] })).toBeNull();
  });

  it('keeps at most 6 history lines', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ speaker: 'Ola', text: `l${i}` }));
    expect(validateLineRequest({ ...validRequest(), history })!.history.map((h) => h.text)).toEqual(['l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
  });
});

describe('prompt builder', () => {
  it('puts the context into a Polish user prompt', () => {
    const p = buildUserPrompt(validRequest());
    expect(p).toContain('Mówi: Ola. Rozmówca: Bartek.');
    expect(p).toContain('Temat rozmowy: muzyka');
    expect(p).toContain('Bartek: Hej Ola!');
    expect(p).toContain('Napisz następną kwestię postaci Ola.');
    expect(buildUserPrompt({ ...validRequest(), turn: 0, history: [] })).toContain('przywitaj się');
    expect(buildUserPrompt({ ...validRequest(), isLast: true })).toContain('pożegnaj się');
  });

  it('builds Messages API params with Haiku, a small budget and a JSON schema', () => {
    const params = buildMessageParams(validRequest());
    expect(params.model).toBe(LLM_MODEL);
    expect(LLM_MODEL).toBe('claude-haiku-5-5');
    expect(params.max_tokens).toBeLessThanOrEqual(1024);
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params.output_config?.format).toEqual({ type: 'json_schema', schema: LINE_SCHEMA });
    expect(params.output_config?.effort).toBe('low');
    expect(params).not.toHaveProperty('temperature');
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe('user');
  });
});

const msg = (text: string, stop: Anthropic.StopReason = 'end_turn'): Pick<Anthropic.Message, 'content' | 'stop_reason'> => ({
  stop_reason: stop,
  content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
});

describe('parseModelMessage', () => {
  it('parses structured output and sanitizes it', () => {
    expect(parseModelMessage(msg('{"text":"„Gramy coś?”","tone":"positive"}'))).toEqual({ text: 'Gramy coś?', tone: 'positive' });
  });

  it('skips thinking blocks and reads the text block', () => {
    const m = { stop_reason: 'end_turn' as const, content: [{ type: 'thinking', thinking: '', signature: 's' }, ...msg('{"text":"Hej","tone":"neutral"}').content] };
    expect(parseModelMessage(m as Pick<Anthropic.Message, 'content' | 'stop_reason'>)).toEqual({ text: 'Hej', tone: 'neutral' });
  });

  it('rejects refusals, truncation, bad JSON and bad tones', () => {
    expect(parseModelMessage(msg('{"text":"Hej","tone":"neutral"}', 'refusal'))).toBeNull();
    expect(parseModelMessage(msg('{"text":"Hej","tone":"neu', 'max_tokens'))).toBeNull();
    expect(parseModelMessage(msg('Hej!'))).toBeNull();
    expect(parseModelMessage(msg('{"text":"Hej","tone":"angry"}'))).toBeNull();
    expect(parseModelMessage({ stop_reason: 'end_turn', content: [] })).toBeNull();
  });
});

describe('createRateLimiter', () => {
  it('allows N requests per sliding window', () => {
    let t = 0;
    const rl = createRateLimiter(3, 1000, () => t);
    expect([rl.tryAcquire(), rl.tryAcquire(), rl.tryAcquire(), rl.tryAcquire()]).toEqual([true, true, true, false]);
    t = 999;
    expect(rl.tryAcquire()).toBe(false);
    t = 1000;
    expect(rl.tryAcquire()).toBe(true);
  });
});

// ------------------------------------------------------------------ HTTP handler (fake SDK client, no network)

describe('createLlmHandler', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function serve(handler: ReturnType<typeof createLlmHandler>): Promise<string> {
    server = createServer((req, res) =>
      handler(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  const fakeClient = (impl: (p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>): MessagesClient => ({
    messages: { create: (p) => impl(p) },
  });
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/llm/line`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reports unavailable without a key and refuses lines with 503', async () => {
    const base = await serve(createLlmHandler({ apiKey: undefined }));
    expect(await (await fetch(`${base}/api/llm/status`)).json()).toEqual({ available: false, model: LLM_MODEL });
    expect((await post(base, validRequest())).status).toBe(503);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('proxies a line through the (fake) SDK client', async () => {
    const create = vi.fn(async () => msg('{"text":"Słucham teraz jazzu!","tone":"positive"}') as Anthropic.Message);
    const base = await serve(createLlmHandler({ apiKey: 'test', createClient: () => fakeClient(create) }));
    expect(await (await fetch(`${base}/api/llm/status`)).json()).toEqual({ available: true, model: LLM_MODEL });
    const res = await post(base, validRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Słucham teraz jazzu!', tone: 'positive' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps invalid input, unusable output, rate limits and cross-site calls to error codes', async () => {
    const create = vi.fn(async () => msg('nope') as Anthropic.Message);
    const base = await serve(
      createLlmHandler({ apiKey: 'test', createClient: () => fakeClient(create), limiter: createRateLimiter(2, 60_000), log: () => {} }),
    );
    expect((await post(base, { junk: true })).status).toBe(400);
    expect((await post(base, validRequest())).status).toBe(503);
    expect((await post(base, validRequest())).status).toBe(429);
    const cross = await fetch(`${base}/api/llm/line`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    expect(cross.status).toBe(403);
  });
});
