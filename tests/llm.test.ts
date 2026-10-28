import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';
import {
  LLM_MAX_LINE,
  buildLineRequest,
  fetchLlmStatus,
  gossipCandidates,
  modelShortName,
  createLlmProvider,
  describeNeeds,
  describeTraits,
  parseLineResponse,
  sanitizeLine,
  type LlmLineRequest,
} from '../src/social/llmProvider';
import {
  DEFAULT_MODELS,
  OPENROUTER_CHAT_URL,
  SYSTEM_PROMPT,
  buildChatRequest,
  buildHeaders,
  buildUserPrompt,
  createDailyBudget,
  createLlmHandler,
  createRateLimiter,
  extractJson,
  parseCompletion,
  parseDailyLimit,
  parseModelList,
  parseModelText,
  validateLineRequest,
} from '../server/llmProxy';
import type { Agent, ConversationContext, Gossip, Traits } from '../src/types';

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
    expect(parseLineResponse({ text: 'Hej!', tone: 'positive' })).toEqual({ text: 'Hej!', tone: 'positive', gossip: null });
    expect(parseLineResponse({ text: 'Hej!', tone: 'positive', gossip: 1 }, undefined, 2)).toMatchObject({ gossip: 1 });
    expect(parseLineResponse({ text: 'Hej!', tone: 'positive', gossip: 2 }, undefined, 2)).toMatchObject({ gossip: null });
    expect(parseLineResponse({ text: 'Hej!', tone: 'positive', gossip: 0.5 }, undefined, 2)).toMatchObject({ gossip: null });
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
    expect(sent.gossip).toEqual([]);
  });

  it('sets DialogueLine.gossip to the exact Gossip object the model retold', async () => {
    const stories: Gossip[] = [
      { text: 'Bartek przypala obiad', aboutIds: [2], valence: -0.6 },
      { text: 'Kasia wygrywa w szachy', aboutIds: [3], valence: 0.7 },
      { text: 'Ola i Bartek tańczą w ogrodzie', aboutIds: [1, 2], valence: 0.5, shared: true },
      { text: 'Czwarta historia', aboutIds: [3], valence: 0 },
    ];
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => jsonResponse({ text: 'Słyszysz? Kasia wygrywa w szachy!', tone: 'positive', gossip: 1 }));
    const provider = createLlmProvider({ fetch: fetchMock as unknown as typeof fetch });
    const line = await provider.nextLine(makeCtx({ gossip: stories }), rng);
    expect(line.gossip).toBe(stories[1]);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as LlmLineRequest;
    expect(sent.gossip).toEqual([
      { text: 'Bartek przypala obiad', valence: -0.6, shared: false },
      { text: 'Kasia wygrywa w szachy', valence: 0.7, shared: false },
      { text: 'Ola i Bartek tańczą w ogrodzie', valence: 0.5, shared: true },
    ]);
    // out-of-range index → plain line
    fetchMock.mockImplementation(async () => jsonResponse({ text: 'No hej.', tone: 'neutral', gossip: 7 }));
    expect((await provider.nextLine(makeCtx({ gossip: stories }), rng)).gossip).toBeUndefined();
  });

  it('offers no stories already told, and none once the speaker told one', () => {
    const g1: Gossip = { text: 'A robi B', aboutIds: [3], valence: 0 };
    const g2: Gossip = { text: 'C robi D', aboutIds: [3], valence: 0 };
    const heard = makeCtx({ gossip: [g1, g2], history: [{ speakerId: 2, text: 'x', tone: 'neutral', gossip: g1 }] });
    expect(gossipCandidates(heard)).toEqual([g2]);
    const told = makeCtx({ gossip: [g1, g2], history: [{ speakerId: 1, text: 'x', tone: 'neutral', gossip: g1 }] });
    expect(gossipCandidates(told)).toEqual([]);
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
    expect(p).toContain('"gossip" ustaw na null');
    expect(buildUserPrompt({ ...validRequest(), turn: 0, history: [] })).toContain('przywitaj się');
    expect(buildUserPrompt({ ...validRequest(), isLast: true })).toContain('pożegnaj się');
    expect(SYSTEM_PROMPT).toContain('JSON');
    expect(SYSTEM_PROMPT).toContain(`maksymalnie ${LLM_MAX_LINE} znaków`);
  });

  it('lists numbered stories (with shared flag) mid-conversation only', () => {
    const r = { ...validRequest(), gossip: [{ text: 'Kasia przypala obiad', valence: -0.6, shared: false }, { text: 'Ola i Bartek tańczą', valence: 0.5, shared: true }] };
    const p = buildUserPrompt(r);
    expect(p).toContain('0. Kasia przypala obiad (wstydliwa)');
    expect(p).toContain('1. Ola i Bartek tańczą (miła; wspólne wspomnienie z: Bartek)');
    expect(buildUserPrompt({ ...r, isLast: true })).not.toContain('Kasia przypala obiad');
  });

  it('builds an OpenRouter chat-completions body with the free fallback chain', () => {
    const body = buildChatRequest(validRequest());
    expect(body.models).toEqual([...DEFAULT_MODELS]);
    expect(DEFAULT_MODELS.every((m) => m.endsWith(':free'))).toBe(true);
    expect(body).not.toHaveProperty('model');
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[0].content).toBe(SYSTEM_PROMPT);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBeLessThanOrEqual(400);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.stream).toBe(false);
    expect(buildChatRequest(validRequest(), ['a/b:free']).models).toEqual(['a/b:free']);
  });

  it('builds headers with bearer auth and app attribution', () => {
    const h = buildHeaders('test-key');
    expect(h.Authorization).toBe('Bearer test-key');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-OpenRouter-Title']).toBeTruthy();
    expect(h['HTTP-Referer']).toBeTruthy();
  });
});

describe('config parsing', () => {
  it('parses OPENROUTER_MODELS, dedupes, caps at 3 and defaults to free models', () => {
    expect(parseModelList(undefined)).toEqual([...DEFAULT_MODELS]);
    expect(parseModelList('  ')).toEqual([...DEFAULT_MODELS]);
    expect(parseModelList('a/b:free, c/d ,a/b:free,bad id,x/y,z/w')).toEqual(['a/b:free', 'c/d', 'x/y']);
    expect(parseDailyLimit('50')).toBe(50);
    expect(parseDailyLimit('')).toBe(180);
    expect(parseDailyLimit('-3')).toBe(180);
  });

  it('shortens model ids for the UI', () => {
    expect(modelShortName('google/gemma-4-31b-it:free')).toBe('gemma-4-31b-it');
    expect(modelShortName('openai/gpt-x')).toBe('gpt-x');
  });
});

const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'google/gemma-4-31b-it:free',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  ...extra,
});

describe('model output parsing', () => {
  it('parses plain JSON and sanitizes it', () => {
    expect(parseModelText('{"text":"„Gramy coś?”","tone":"positive","gossip":null}')).toEqual({ text: 'Gramy coś?', tone: 'positive', gossip: null });
  });

  it('accepts JSON wrapped in code fences or chatter', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelText('Oto odpowiedź: {"text":"Hej","tone":"neutral"} :)')).toEqual({ text: 'Hej', tone: 'neutral', gossip: null });
  });

  it('rejects invalid JSON, bad tones and empty text', () => {
    expect(parseModelText('Hej!')).toBeNull();
    expect(parseModelText('{"text":"Hej","tone":"angry"}')).toBeNull();
    expect(parseModelText('{"text":"  ","tone":"neutral"}')).toBeNull();
    expect(parseModelText('[1,2]')).toBeNull();
  });

  it('validates the gossip index against the offered stories', () => {
    expect(parseModelText('{"text":"Wiesz co?","tone":"neutral","gossip":1}', undefined, 2)?.gossip).toBe(1);
    expect(parseModelText('{"text":"Wiesz co?","tone":"neutral","gossip":2}', undefined, 2)?.gossip).toBeNull();
    expect(parseModelText('{"text":"Wiesz co?","tone":"neutral","gossip":"0"}', undefined, 2)?.gossip).toBeNull();
    expect(parseModelText('{"text":"Wiesz co?","tone":"neutral","gossip":-1}', undefined, 2)?.gossip).toBeNull();
    expect(parseModelText('{"text":"Wiesz co?","tone":"neutral","gossip":0}')?.gossip).toBeNull();
  });

  it('reads chat completions and rejects errors / truncation', () => {
    expect(parseCompletion(completion('{"text":"Hej","tone":"neutral","gossip":null}'))).toEqual({
      line: { text: 'Hej', tone: 'neutral', gossip: null },
      model: 'google/gemma-4-31b-it:free',
    });
    expect(parseCompletion({ ...completion('{"text":"Hej","tone":"neutral"}'), choices: [{ finish_reason: 'length', message: { content: '{"text":"He' } }] })).toBeNull();
    expect(parseCompletion(completion('{"text":"Hej","tone":"neutral"}', { error: { code: 502, message: 'x' } }))).toBeNull();
    expect(parseCompletion({ error: { code: 429, message: 'x' } })).toBeNull();
    expect(parseCompletion({ choices: [] })).toBeNull();
    expect(parseCompletion(null)).toBeNull();
  });
});

describe('limits', () => {
  it('allows N requests per sliding window', () => {
    let t = 0;
    const rl = createRateLimiter(3, 1000, () => t);
    expect([rl.tryAcquire(), rl.tryAcquire(), rl.tryAcquire(), rl.tryAcquire()]).toEqual([true, true, true, false]);
    t = 999;
    expect(rl.tryAcquire()).toBe(false);
    t = 1000;
    expect(rl.tryAcquire()).toBe(true);
  });

  it('caps requests per UTC day, resets at midnight and syncs with the account quota', () => {
    let t = Date.UTC(2026, 9, 28, 23, 59);
    const d = createDailyBudget(3, () => t);
    expect([d.tryAcquire(), d.tryAcquire(), d.tryAcquire(), d.tryAcquire()]).toEqual([true, true, true, false]);
    t = Date.UTC(2026, 9, 29, 0, 1);
    expect(d.used).toBe(0);
    expect(d.tryAcquire()).toBe(true);
    d.sync(48, 50); // account already used 48 of 50 free requests today
    expect(d.limit).toBe(3);
    expect(d.used).toBe(48);
    expect(d.tryAcquire()).toBe(false);
    const big = createDailyBudget(180, () => t);
    big.sync(48, 50);
    expect([big.limit, big.tryAcquire(), big.tryAcquire(), big.tryAcquire()]).toEqual([50, true, true, false]);
  });
});

// ------------------------------------------------------------------ HTTP handler (fake fetch, no network)

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

  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/llm/line`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const fakeUpstream = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => impl(String(url), init ?? {}));

  it('reports unavailable without a key and refuses lines with 503', async () => {
    const base = await serve(createLlmHandler({ apiKey: undefined }));
    expect(await (await fetch(`${base}/api/llm/status`)).json()).toEqual({ available: false, provider: 'openrouter', models: [...DEFAULT_MODELS] });
    expect((await post(base, validRequest())).status).toBe(503);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('proxies a line to OpenRouter (fake fetch) and returns the answering model', async () => {
    const upstream = fakeUpstream(() => jsonResponse(completion('{"text":"Słucham teraz jazzu!","tone":"positive","gossip":0}')));
    const models = ['a/one:free', 'b/two:free'];
    const base = await serve(createLlmHandler({ apiKey: 'test-key', models, fetch: upstream as unknown as typeof fetch }));
    const status = (await (await fetch(`${base}/api/llm/status`)).json()) as Awaited<ReturnType<typeof fetchLlmStatus>>;
    expect(status).toEqual({ available: true, provider: 'openrouter', models });
    const res = await post(base, { ...validRequest(), gossip: [{ text: 'Kasia gra na gitarze', valence: 0.5, shared: false }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Słucham teraz jazzu!', tone: 'positive', gossip: 0, model: 'google/gemma-4-31b-it:free' });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe(OPENROUTER_CHAT_URL);
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const sent = JSON.parse(String(init!.body)) as ReturnType<typeof buildChatRequest>;
    expect(sent.models).toEqual(models);
    expect(sent.messages[1].content).toContain('0. Kasia gra na gitarze');
  });

  it('maps invalid input, unusable output, rate limits and cross-site calls to error codes', async () => {
    const upstream = fakeUpstream(() => jsonResponse(completion('nope')));
    const base = await serve(
      createLlmHandler({ apiKey: 'test', fetch: upstream as unknown as typeof fetch, limiter: createRateLimiter(3, 60_000), log: () => {} }),
    );
    expect((await post(base, { junk: true })).status).toBe(400);
    expect((await post(base, { ...validRequest(), gossip: [1, 2, 3, 4] })).status).toBe(400);
    expect((await post(base, validRequest())).status).toBe(503);
    expect((await post(base, validRequest())).status).toBe(429);
    const cross = await fetch(`${base}/api/llm/line`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    expect(cross.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('maps upstream 429 (and backs off), 402/5xx and timeouts', async () => {
    let t = 0;
    let mode: 'r429' | 'r402' | 'hang' | 'ok' = 'r429';
    const upstream = fakeUpstream((_u, init) => {
      if (mode === 'r429') return new Response(JSON.stringify({ error: { code: 429, message: 'rate' } }), { status: 429, headers: { 'Retry-After': '30' } });
      if (mode === 'r402') return jsonResponse({ error: { code: 402, message: 'credits' } }, 402);
      if (mode === 'hang')
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return jsonResponse(completion('{"text":"Hej","tone":"neutral","gossip":null}'));
    });
    const base = await serve(createLlmHandler({ apiKey: 'k', fetch: upstream as unknown as typeof fetch, timeoutMs: 50, now: () => t, log: () => {} }));
    expect((await post(base, validRequest())).status).toBe(429);
    mode = 'ok';
    expect((await post(base, validRequest())).status).toBe(429); // Retry-After still running, no upstream call
    expect(upstream).toHaveBeenCalledTimes(1);
    t = 31_000;
    expect((await post(base, validRequest())).status).toBe(200);
    mode = 'r402';
    expect((await post(base, validRequest())).status).toBe(503);
    mode = 'hang';
    expect((await post(base, validRequest())).status).toBe(504);
  });

  it('stops at the daily budget with 429', async () => {
    const upstream = fakeUpstream(() => jsonResponse(completion('{"text":"Hej","tone":"neutral"}')));
    const base = await serve(createLlmHandler({ apiKey: 'k', fetch: upstream as unknown as typeof fetch, daily: createDailyBudget(2) }));
    expect((await post(base, validRequest())).status).toBe(200);
    expect((await post(base, { junk: 1 })).status).toBe(400); // invalid input does not spend the budget
    expect((await post(base, validRequest())).status).toBe(200);
    const res = await post(base, validRequest());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'daily limit reached' });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe('fetchLlmStatus', () => {
  it('reads provider + models and degrades gracefully', async () => {
    const ok = (async () => jsonResponse({ available: true, provider: 'openrouter', models: ['a/b:free', 3] })) as typeof fetch;
    expect(await fetchLlmStatus(ok)).toEqual({ available: true, provider: 'openrouter', models: ['a/b:free'] });
    expect(await fetchLlmStatus((async () => jsonResponse({}, 500)) as typeof fetch)).toEqual({ available: false, models: [] });
    expect(await fetchLlmStatus((async () => { throw new Error('x'); }) as typeof fetch)).toEqual({ available: false, models: [] });
  });
});
