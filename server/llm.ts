import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';
import type { LlmGossip, LlmLineRequest, LlmLineResponse } from '../src/social/llmProvider.ts';
import type { LlmDiaryRequest } from '../src/social/diaryAi.ts';
import { DIARY_AI_MAX_WORDS, LLM_DIARY_URL, checkDiaryText, validateDiaryRequest } from '../src/social/diaryAi.ts';
import type { LlmChronicleRequest } from '../src/social/chronicleAi.ts';
import { CHRONICLE_AI_MAX_WORDS, LLM_CHRONICLE_URL, checkChronicleText, validateChronicleRequest } from '../src/social/chronicleAi.ts';
import {
  LLM_HISTORY_LINES,
  LLM_LINE_URL,
  LLM_MAX_GOSSIP,
  LLM_MAX_LINE,
  LLM_MAX_NEWS,
  LLM_NEWS_CHARS,
  LLM_STATUS_URL,
  isGossipIndex,
  isTone,
  sanitizeLine,
} from '../src/social/llmProvider.ts';

// Server-side proxy for LLM dialogue lines via OpenRouter (chat completions).
// Runs inside the Vite dev / preview server (via the plugin) or the production server (server/prod.ts), so OPENROUTER_API_KEY stays in
// Node and never reaches the bundle. The key is never logged.

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

/**
 * Default model fallback chain: free models only (":free", price 0), chosen from the live
 * model list (2026-10-28) for multilingual quality + `response_format` support. OpenRouter
 * tries them in order via the `models` array. A paid model is used only when the user lists
 * it explicitly in OPENROUTER_MODELS.
 */
export const DEFAULT_MODELS: readonly string[] = [
  // answered every smoke-test call in ~1 s; Gemma's free pool (Google AI Studio) was often 429 upstream
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];
/** OpenRouter's `models` routing list; longer env lists are cut */
export const MAX_MODELS = 3;
export const LLM_MAX_TOKENS = 300;
export const LLM_TEMPERATURE = 0.9;
export const LLM_TIMEOUT_MS = 12_000;
/** free models: 20 req/min per account (docs) — keep headroom */
export const LLM_RATE_LIMIT = 15;
export const LLM_RATE_WINDOW_MS = 60_000;
/** free models: 50 or 1000 req per UTC day depending on credits purchased (docs); synced from /api/v1/key at start */
export const LLM_DAILY_LIMIT = 180;
export const LLM_MAX_IN_FLIGHT = 3;
const MAX_BODY_BYTES = 12 * 1024;
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

/** parses OPENROUTER_MODELS ("a/b:free, c/d:free"); falls back to the free defaults */
export function parseModelList(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => MODEL_ID.test(s));
  const unique = [...new Set(ids)].slice(0, MAX_MODELS);
  return unique.length ? unique : [...DEFAULT_MODELS];
}

export function parseDailyLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : LLM_DAILY_LIMIT;
}

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
  const gossip: LlmGossip[] = [];
  if (b.gossip !== undefined) {
    if (!Array.isArray(b.gossip) || b.gossip.length > LLM_MAX_GOSSIP) return null;
    for (const g of b.gossip) {
      if (!g || typeof g !== 'object') return null;
      const r = g as Record<string, unknown>;
      const text = str(r.text, 100);
      const valence = typeof r.valence === 'number' && Number.isFinite(r.valence) ? Math.max(-1, Math.min(1, r.valence)) : null;
      if (!text || valence === null) return null;
      gossip.push({ text, valence, shared: r.shared === true });
    }
  }
  const news: string[] = [];
  if (b.news !== undefined) {
    if (!Array.isArray(b.news) || b.news.length > LLM_MAX_NEWS) return null;
    for (const n of b.news) {
      const t = str(n, LLM_NEWS_CHARS);
      if (!t) return null;
      news.push(t);
    }
  }
  return {
    speaker, listener, traits, mood, needs, relationship, relationshipLabel, topic, timeOfDay, history, turn, isLast: b.isLast, gossip,
    ...(news.length ? { news } : {}),
  };
}

// ------------------------------------------------------------ prompt

export const SYSTEM_PROMPT = [
  'Piszesz kwestie dialogowe do symulacji życia w stylu The Sims. Mieszkańcy osiedla rozmawiają ze sobą w dymkach nad głowami.',
  'Za każdym razem dostajesz opis postaci, która teraz mówi, i dotychczasowy przebieg rozmowy. Napisz JEDNĄ następną kwestię tej postaci.',
  'Zasady:',
  `- naturalna, potoczna polszczyzna, jedno krótkie zdanie lub dwa bardzo krótkie, maksymalnie ${LLM_MAX_LINE} znaków;`,
  '- mów w charakterze postaci: uwzględnij nastrój, cechy, potrzeby, relację z rozmówcą, temat i porę dnia;',
  '- reaguj na ostatnią kwestię rozmówcy, nie powtarzaj wcześniejszych kwestii; jeśli rozmówca właśnie opowiedział jakąś historię, odnieś się do niej;',
  '- unikaj czasowników w czasie przeszłym z rodzajem (np. "zrobiłem/zrobiłam", "byliśmy/byłyśmy") i form zdradzających płeć mówiącego; wybieraj czas teraźniejszy, przyszły lub formy bezosobowe;',
  '- bez cudzysłowów, bez imienia mówiącego na początku, bez emoji, bez opisów didaskaliów;',
  '- pierwsza kwestia rozmowy to powitanie, ostatnia to pożegnanie;',
  '- treści przyjazne rodzinie.',
  'Czasem dostajesz listę historii, które mówiący pamięta (plotki o innych albo wspólne wspomnienia). Jeśli rozmowa na to pozwala, chętnie opowiedz JEDNĄ z nich (nie musisz). Zachowaj czas teraźniejszy i imiona w mianowniku jak w opisie, np. "Słyszysz? Kasia przypala obiad!"; wspólne wspomnienie przywołaj bez czasu przeszłego, np. "Pamiętasz, jak Ola i Tomek tańczą w ogrodzie?" albo "Pamiętasz ten taniec w ogrodzie?" (nigdy "tańczyliśmy"). Nie wymyślaj innych plotek.',
  'Czasem dostajesz też nagłówki wiadomości, które mówiący widzi w telewizji (prawdziwe wiadomości ze świata albo wiadomości z osiedla). Możesz (nie musisz) nawiązać do JEDNEGO: przytocz go dosłownie w cudzysłowie „…”, np. "W telewizji podają: „…”", albo skomentuj krótko i ogólnie. Nie dodawaj faktów, liczb, nazwisk ani szczegółów, których nie ma w nagłówku, niczego nie zgaduj; przy poważnych lub smutnych wiadomościach zachowaj powagę i nie żartuj.',
  'Odpowiedz WYŁĄCZNIE obiektem JSON, bez komentarzy i bez bloku kodu:',
  '{"text": "<kwestia>", "tone": "positive" | "neutral" | "negative", "gossip": <numer wykorzystanej historii albo null>}',
].join('\n');

/** schema we ask for (also documented in the prompt; JSON mode only guarantees an object) */
export const LINE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: `kwestia po polsku, maks. ${LLM_MAX_LINE} znaków` },
    tone: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    gossip: { type: ['integer', 'null'], description: 'numer opowiedzianej historii albo null' },
  },
  required: ['text', 'tone', 'gossip'],
  additionalProperties: false,
} as const;

function moodWord(mood: number): string {
  if (mood >= 75) return 'świetny';
  if (mood >= 55) return 'dobry';
  if (mood >= 40) return 'taki sobie';
  if (mood >= 20) return 'kiepski';
  return 'fatalny';
}

function valenceWord(v: number): string {
  if (v > 0.25) return 'miła';
  if (v < -0.25) return 'wstydliwa';
  return 'zwykła';
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
  const gossip = r.gossip ?? [];
  if (gossip.length && !r.isLast && r.turn > 0) {
    lines.push(`Historie, które ${r.speaker} pamięta (możesz opowiedzieć jedną):`);
    gossip.forEach((g, i) =>
      lines.push(`${i}. ${g.text} (${valenceWord(g.valence)}${g.shared ? `; wspólne wspomnienie z: ${r.listener}` : ''})`),
    );
  } else {
    lines.push('Tym razem bez opowiadania historii: "gossip" ustaw na null.');
  }
  const news = r.news ?? [];
  if (news.length && !r.isLast && r.turn > 0) {
    lines.push(`Nagłówki, które ${r.speaker} widzi w telewizji (możesz nawiązać do jednego, bez dodawania faktów):`);
    for (const n of news) lines.push(`- „${n}”`);
  }
  const stage = r.isLast ? 'To ostatnia kwestia — pożegnaj się.' : r.turn === 0 ? 'To pierwsza kwestia — przywitaj się.' : `To kwestia nr ${r.turn + 1}.`;
  lines.push(stage, `Napisz następną kwestię postaci ${r.speaker}.`);
  return lines.join('\n');
}

export interface ChatRequestBody {
  models: string[];
  messages: { role: 'system' | 'user'; content: string }[];
  response_format: { type: 'json_object' };
  max_tokens: number;
  temperature: number;
  reasoning: { enabled: false };
  stream: false;
}

/** OpenRouter chat-completions body; `models` = ordered fallback list */
export function buildChatRequest(r: LlmLineRequest, models: readonly string[] = DEFAULT_MODELS): ChatRequestBody {
  return {
    models: [...models],
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(r) },
    ],
    // JSON mode works on all default models (json_schema is not supported by the Gemma endpoints)
    response_format: { type: 'json_object' },
    max_tokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
    // a one-liner needs no thinking; reasoning tokens would also eat max_tokens
    reasoning: { enabled: false },
    stream: false,
  };
}

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // optional app attribution (docs: HTTP-Referer + X-OpenRouter-Title, X-Title also accepted)
    'HTTP-Referer': 'http://localhost',
    'X-OpenRouter-Title': 'Osiedle (sim)',
  };
}

/** finds the JSON object in model text: plain, ```json fenced, or surrounded by chatter */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

/** parses the model's JSON line; null when unusable. An out-of-range gossip index becomes null. */
export function parseModelText(content: string, speakerName?: string, gossipCount = 0): LlmLineResponse | null {
  const data = extractJson(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { text, tone, gossip } = data as Record<string, unknown>;
  const clean = sanitizeLine(text, LLM_MAX_LINE, speakerName);
  if (!clean || !isTone(tone)) return null;
  return { text: clean, tone, gossip: isGossipIndex(gossip, gossipCount) ? gossip : null };
}

/** extracts the line from a chat-completions response body; also returns the model that answered */
export function parseCompletion(
  body: unknown,
  speakerName?: string,
  gossipCount = 0,
): { line: LlmLineResponse; model: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error) return null; // generation error delivered with HTTP 200
  const choice = Array.isArray(b.choices) ? (b.choices[0] as Record<string, unknown> | undefined) : undefined;
  if (!choice || choice.error) return null;
  const finish = choice.finish_reason;
  if (finish !== 'stop' && finish !== null && finish !== undefined) return null; // length, content_filter, error, tool_calls
  const content = (choice.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== 'string') return null;
  const line = parseModelText(content, speakerName, gossipCount);
  return line ? { line, model: typeof b.model === 'string' ? b.model : '?' } : null;
}

// ------------------------------------------------------------ diary prompt

export const DIARY_MAX_TOKENS = 700;
export const DIARY_TEMPERATURE = 0.8;
/**
 * diary entries are a nice-to-have: they are refused once fewer than this many requests are
 * left in today's budget (dialogue lines keep priority), see diaryReserve
 */
export const DIARY_RESERVE_MIN = 20;
export const DIARY_RESERVE_SHARE = 0.15;

export function diaryReserve(limit: number): number {
  return Math.max(DIARY_RESERVE_MIN, Math.ceil(limit * DIARY_RESERVE_SHARE));
}

export const DIARY_SYSTEM_PROMPT = [
  'Piszesz krótkie wpisy do pamiętników mieszkańców symulacji życia w stylu The Sims.',
  'Dostajesz imię i charakter autora, jego nastrój oraz listę FAKTÓW z jego dnia. Napisz wpis do pamiętnika w pierwszej osobie, tak jak autor pisałby wieczorem przed snem.',
  'Zasady:',
  `- naturalna, potoczna polszczyzna, 2–4 krótkie akapity, łącznie najwyżej ${DIARY_AI_MAX_WORDS} słów;`,
  '- opisuj WYŁĄCZNIE podane fakty, nie wymyślaj zdarzeń, osób, miejsc, rozmów, cytatów ani szczegółów; możesz dodać uczucia i komentarze autora zgodne z jego charakterem i nastrojem; nie musisz użyć wszystkich faktów;',
  '- pisz w czasie teraźniejszym (np. "Rano łowię ryby", "Ola mówi, że…", "Bartek i ja kłócimy się o politykę");',
  '- NIGDY nie używaj czasu przeszłego ani trybu przypuszczającego z rodzajem (np. "zrobiłem/zrobiłam", "poszedł/poszła", "rozmawialiśmy", "chciałbym/chciałabym") ani przymiotników zdradzających płeć autora (np. "jestem zmęczony/zmęczona", "byłem szczęśliwy") — zamiast tego czas teraźniejszy, formy bezosobowe lub rzeczowniki ("zmęczenie", "padam z nóg", "co za radość");',
  '- imiona innych osób zawsze w mianowniku, bez odmiany i bez przyimków przed imieniem (np. "Ola i ja…", "Bartek: miła rozmowa", "Kasia mówi, że…", "wspólny obiad: Staś, Marek i ja"), nigdy "z Olą", "ze Staś", "Bartka";',
  '- nagłówki z telewizji możesz przytoczyć tylko dosłownie w cudzysłowie „…” albo pominąć; nie dodawaj do nich żadnych faktów ani interpretacji; innych cytatów w „…” nie używaj;',
  '- bez daty, bez nagłówka, bez podpisu; najwyżej 3 emoji; treści przyjazne rodzinie.',
  'Przykład stylu (inne fakty): "Pobudka o 7:10. Rano długie wędkowanie — i jest szczupak! 🎣\\n\\nKasia i ja: świetna rozmowa o muzyce. Tomek nie ma czasu na pogawędkę. Trudno.\\n\\nCel dnia zaliczony. Co za dzień!"',
  'Odpowiedz WYŁĄCZNIE obiektem JSON, bez komentarzy i bez bloku kodu:',
  '{"text": "<wpis; akapity oddzielone znakami \\n\\n>"}',
].join('\n');

export function buildDiaryPrompt(r: LlmDiaryRequest): string {
  const lines = [
    `Autor: ${r.name}. Charakter: ${r.traits || 'przeciętny'}.`,
    `Nastrój wieczorem: ${moodWord(r.mood)} (${r.mood}/100)${r.moodArc ? `; w ciągu dnia: ${r.moodArc}` : ''}.`,
    `Dzień ${r.day}. Fakty z dnia:`,
    ...r.facts.map((f) => `- ${f}`),
  ];
  if (r.news.length) {
    lines.push('Nagłówki z telewizji (wolno tylko dosłownie):');
    for (const n of r.news) lines.push(`- „${n}”`);
  }
  lines.push(`Napisz wpis do pamiętnika: ${r.name}, pierwsza osoba, czas teraźniejszy, bez form z rodzajem.`);
  return lines.join('\n');
}

export function buildDiaryChatRequest(r: LlmDiaryRequest, models: readonly string[] = DEFAULT_MODELS): ChatRequestBody {
  return {
    models: [...models],
    messages: [
      { role: 'system', content: DIARY_SYSTEM_PROMPT },
      { role: 'user', content: buildDiaryPrompt(r) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: DIARY_MAX_TOKENS,
    temperature: DIARY_TEMPERATURE,
    reasoning: { enabled: false },
    stream: false,
  };
}

/** extracts + sanitizes the diary text from a chat-completions body; null when unusable (`why` gets the reason) */
export function parseDiaryCompletion(body: unknown, r: LlmDiaryRequest, why?: (reason: string) => void): { text: string; model: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error) return null;
  const choice = Array.isArray(b.choices) ? (b.choices[0] as Record<string, unknown> | undefined) : undefined;
  if (!choice || choice.error) return null;
  const finish = choice.finish_reason;
  if (finish !== 'stop' && finish !== null && finish !== undefined) return null;
  const content = (choice.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== 'string') return null;
  const data = extractJson(content);
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).text : null;
  const checked = checkDiaryText(raw, { name: r.name, news: r.news, allow: [r.name] });
  if ('reason' in checked) {
    why?.(checked.reason);
    return null;
  }
  return { text: checked.text, model: typeof b.model === 'string' ? b.model : '?' };
}

// ------------------------------------------------------------ chronicle prompt

export const CHRONICLE_MAX_TOKENS = 400;
export const CHRONICLE_TEMPERATURE = 0.7;

export const CHRONICLE_SYSTEM_PROMPT = [
  'Piszesz krótkie podsumowania dnia w kronice miejsca w symulacji życia w stylu The Sims.',
  'Dostajesz nazwę miejsca, datę i listę FAKTÓW z tego dnia. Napisz jeden krótki akapit w trzeciej osobie, w stylu lokalnej kroniki.',
  'Zasady:',
  `- naturalna polszczyzna, 2–4 zdania, łącznie najwyżej ${Math.min(70, CHRONICLE_AI_MAX_WORDS)} słów;`,
  '- opisuj WYŁĄCZNIE podane fakty, nie wymyślaj zdarzeń, osób, miejsc, rozmów ani cytatów; nie musisz użyć wszystkich faktów, wybierz najciekawsze;',
  '- pisz w czasie teraźniejszym (np. "Ola i Bartek zostają parą", "Wieczorem pada deszcz");',
  '- NIGDY nie używaj czasu przeszłego z rodzajem (np. "poszedł/poszła", "zrobili") ani przymiotników zdradzających płeć;',
  '- imiona zawsze w mianowniku, bez odmiany i bez przyimków przed imieniem (nigdy "z Olą", "ze Staś", "Bartka");',
  '- bez cytatów w cudzysłowie, bez daty, bez nagłówka; najwyżej 2 emoji; treści przyjazne rodzinie.',
  'Odpowiedz WYŁĄCZNIE obiektem JSON, bez komentarzy i bez bloku kodu:',
  '{"text": "<podsumowanie dnia>"}',
].join('\n');

export function buildChroniclePrompt(r: LlmChronicleRequest): string {
  return [`Miejsce: ${r.place}. Data: ${r.date}. Fakty z dnia:`, ...r.facts.map((f) => `- ${f}`), 'Napisz podsumowanie dnia: jeden akapit, czas teraźniejszy, bez form z rodzajem.'].join('\n');
}

export function buildChronicleChatRequest(r: LlmChronicleRequest, models: readonly string[] = DEFAULT_MODELS): ChatRequestBody {
  return {
    models: [...models],
    messages: [
      { role: 'system', content: CHRONICLE_SYSTEM_PROMPT },
      { role: 'user', content: buildChroniclePrompt(r) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: CHRONICLE_MAX_TOKENS,
    temperature: CHRONICLE_TEMPERATURE,
    reasoning: { enabled: false },
    stream: false,
  };
}

/** extracts + sanitizes the summary from a chat-completions body; null when unusable (`why` gets the reason) */
export function parseChronicleCompletion(body: unknown, r: LlmChronicleRequest, why?: (reason: string) => void): { text: string; model: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error) return null;
  const choice = Array.isArray(b.choices) ? (b.choices[0] as Record<string, unknown> | undefined) : undefined;
  if (!choice || choice.error) return null;
  const finish = choice.finish_reason;
  if (finish !== 'stop' && finish !== null && finish !== undefined) return null;
  const content = (choice.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== 'string') return null;
  const data = extractJson(content);
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).text : null;
  const checked = checkChronicleText(raw, r);
  if ('reason' in checked) {
    why?.(checked.reason);
    return null;
  }
  return { text: checked.text, model: typeof b.model === 'string' ? b.model : '?' };
}

// ------------------------------------------------------------ limits

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

export interface DailyBudget extends RateLimiter {
  readonly used: number;
  readonly limit: number;
  /** adopts the account's real free-model counter (OpenRouter /api/v1/key) for today */
  sync(used: number, accountLimit: number): void;
}

/** requests per UTC day (OpenRouter's free-model quota resets per UTC day) */
export function createDailyBudget(limit: number, now: () => number = Date.now): DailyBudget {
  const dayOf = (): string => new Date(now()).toISOString().slice(0, 10);
  let day = dayOf();
  let used = 0;
  let cap = limit;
  const roll = (): void => {
    const d = dayOf();
    if (d !== day) {
      day = d;
      used = 0;
      cap = limit;
    }
  };
  return {
    get used() {
      roll();
      return used;
    },
    get limit() {
      roll();
      return cap;
    },
    tryAcquire() {
      roll();
      if (used >= cap) return false;
      used++;
      return true;
    },
    sync(accountUsed, accountLimit) {
      roll();
      if (Number.isFinite(accountLimit) && accountLimit >= 0) cap = Math.min(limit, accountLimit);
      if (Number.isFinite(accountUsed) && accountUsed > used) used = accountUsed;
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
    const host = new URL(origin).host;
    // behind a reverse proxy the Host header may be rewritten; a browser can't send
    // X-Forwarded-Host cross-origin without a CORS preflight, which this server never grants
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    return host === req.headers.host || (forwarded !== '' && host === forwarded);
  } catch {
    return false;
  }
}

/** reads the account's free-model daily counter; never throws, never logs the key */
export async function fetchKeyInfo(
  apiKey: string,
  doFetch: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<{ used: number; limit: number; usageUsd: number | null } | null> {
  try {
    const res = await doFetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: Record<string, unknown> }).data;
    const free = data?.free_model_daily_requests as { used?: unknown; limit?: unknown } | undefined;
    if (typeof free?.used !== 'number' || typeof free.limit !== 'number') return null;
    return { used: free.used, limit: free.limit, usageUsd: typeof data?.usage === 'number' ? data.usage : null };
  } catch {
    return null;
  }
}

export interface LlmHandlerOptions {
  apiKey: string | undefined;
  models?: readonly string[];
  timeoutMs?: number;
  limiter?: RateLimiter;
  daily?: DailyBudget;
  /** injectable for tests (server-side fetch to OpenRouter) */
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
}

export function createLlmHandler(opts: LlmHandlerOptions): Connect.NextHandleFunction {
  const models = opts.models?.length ? [...opts.models] : [...DEFAULT_MODELS];
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  const limiter = opts.limiter ?? createRateLimiter(LLM_RATE_LIMIT, LLM_RATE_WINDOW_MS);
  const daily = opts.daily ?? createDailyBudget(LLM_DAILY_LIMIT);
  const log = opts.log ?? ((m: string) => console.warn(`[llm] ${m}`));
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  let inFlight = 0;
  /** upstream said 429 + Retry-After: don't hammer it */
  let upstreamBlockedUntil = 0;

  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === LLM_STATUS_URL && req.method === 'GET') {
      sendJson(res, 200, { available: !!opts.apiKey, provider: 'openrouter', models });
      return;
    }
    const diary = path === LLM_DIARY_URL;
    const chronicle = path === LLM_CHRONICLE_URL;
    if (path !== LLM_LINE_URL && !diary && !chronicle) {
      next();
      return;
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!opts.apiKey) return sendJson(res, 503, { error: 'OPENROUTER_API_KEY not set' });
    if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    if (now() < upstreamBlockedUntil || inFlight >= LLM_MAX_IN_FLIGHT || !limiter.tryAcquire()) {
      return sendJson(res, 429, { error: 'rate limited' });
    }

    inFlight++;
    void (async () => {
      try {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: 'bad json' });
        }
        const diaryRequest = diary ? validateDiaryRequest(body) : null;
        const chronicleRequest = chronicle ? validateChronicleRequest(body) : null;
        const request = diary || chronicle ? null : validateLineRequest(body);
        if (!request && !diaryRequest && !chronicleRequest) return sendJson(res, 400, { error: 'invalid request' });
        // diary entries and chronicle summaries are optional: keep a reserve of today's budget for dialogue lines
        if ((diaryRequest || chronicleRequest) && daily.limit - daily.used <= diaryReserve(daily.limit)) return sendJson(res, 429, { error: 'daily budget low' });
        // counted only for requests that actually go upstream
        if (!daily.tryAcquire()) return sendJson(res, 429, { error: 'daily limit reached' });

        let upstream: Response;
        try {
          upstream = await doFetch(OPENROUTER_CHAT_URL, {
            method: 'POST',
            headers: buildHeaders(opts.apiKey!),
            body: JSON.stringify(
              chronicleRequest ? buildChronicleChatRequest(chronicleRequest, models) : diaryRequest ? buildDiaryChatRequest(diaryRequest, models) : buildChatRequest(request!, models),
            ),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const name = (err as Error).name;
          if (name === 'TimeoutError' || name === 'AbortError') return sendJson(res, 504, { error: 'timeout' });
          log(`network error: ${(err as Error).message}`);
          return sendJson(res, 503, { error: 'upstream unreachable' });
        }

        if (!upstream.ok) {
          const status = upstream.status;
          let detail = '';
          try {
            const e = (await upstream.json()) as { error?: { message?: unknown } };
            if (typeof e.error?.message === 'string') detail = e.error.message.slice(0, 160);
          } catch {
            /* non-JSON error body */
          }
          log(`OpenRouter HTTP ${status}${detail ? `: ${detail}` : ''}`);
          if (status === 429) {
            const retry = Number.parseInt(upstream.headers.get('retry-after') ?? '', 10);
            upstreamBlockedUntil = now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 600) : 20) * 1000;
            return sendJson(res, 429, { error: 'upstream rate limited' });
          }
          if (status === 408) return sendJson(res, 504, { error: 'timeout' });
          return sendJson(res, 503, { error: 'upstream error' }); // 400/401/402/403/502/503…
        }

        let completion: unknown;
        try {
          completion = await upstream.json();
        } catch (err) {
          const name = (err as Error).name;
          if (name === 'TimeoutError' || name === 'AbortError') return sendJson(res, 504, { error: 'timeout' });
          return sendJson(res, 503, { error: 'unusable model output' });
        }
        if (chronicleRequest) {
          let reason = 'bad completion';
          const summary = parseChronicleCompletion(completion, chronicleRequest, (r) => (reason = r));
          if (!summary) {
            const c = completion as { choices?: { finish_reason?: unknown }[]; model?: unknown };
            log(`unusable chronicle output (model=${String(c?.model ?? '?')}, finish=${String(c?.choices?.[0]?.finish_reason ?? '-')}, ${reason})`);
            return sendJson(res, 503, { error: 'unusable model output' });
          }
          return sendJson(res, 200, summary);
        }
        if (diaryRequest) {
          let reason = 'bad completion';
          const entry = parseDiaryCompletion(completion, diaryRequest, (r) => (reason = r));
          if (!entry) {
            const c = completion as { choices?: { finish_reason?: unknown }[]; model?: unknown };
            log(`unusable diary output (model=${String(c?.model ?? '?')}, finish=${String(c?.choices?.[0]?.finish_reason ?? '-')}, ${reason})`);
            return sendJson(res, 503, { error: 'unusable model output' });
          }
          return sendJson(res, 200, entry);
        }
        const parsed = parseCompletion(completion, request!.speaker, request!.gossip?.length ?? 0);
        if (!parsed) {
          const c = completion as { error?: { message?: unknown }; choices?: { finish_reason?: unknown }[]; model?: unknown };
          log(
            `unusable model output (model=${String(c?.model ?? '?')}, finish=${String(c?.choices?.[0]?.finish_reason ?? '-')}` +
              `${typeof c?.error?.message === 'string' ? `, error=${c.error.message.slice(0, 120)}` : ''})`,
          );
          return sendJson(res, 503, { error: 'unusable model output' });
        }
        sendJson(res, 200, { ...parsed.line, model: parsed.model });
      } catch (err) {
        log(`error: ${(err as Error).message}`);
        sendJson(res, 503, { error: 'proxy error' });
      } finally {
        inFlight--;
      }
    })();
  };
}

/** Vite plugin: registers /api/llm/* on both the dev and the preview server */
