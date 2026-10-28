import type { Agent, Conversation, SimEvent, World } from '../types';
import { MINUTES_PER_DAY, START_MINUTE } from '../core/time';
import { pushEvent } from './events';
import { forecastOf, isBroken, weatherOf, type WeatherKind } from './incidents';

// TV news: real headlines (via the dev-server proxy, see server/newsProxy.ts) or
// "Wiadomości z osiedla" — bulletins generated from the residents' own life (world.events,
// weather, breakdowns, gatherings).
//
// Determinism: with in-sim news only, everything here is a pure function of the world
// (no RNG, no clock, no network), so a seed replays exactly. Real headlines are pushed in
// from outside the tick (setNewsFeed / startNewsFeed) and make a run non-reproducible.
// State lives in a WeakMap keyed by the world (no contract changes).

export interface NewsItem {
  /** short Polish headline */
  title: string;
  /** e.g. "PAP", "Osiedle" */
  source: string;
  /** true for headlines from the real world, false for in-simulation news */
  real: boolean;
}

/** source label of in-simulation bulletins */
export const LOCAL_SOURCE = 'Wiadomości z osiedla';
/** a new headline every this many game minutes while someone watches */
export const ROTATE_TICKS = 20;
/** at most this many in-sim bulletins are kept on the programme */
export const MAX_BULLETINS = 12;
/** in-sim bulletins leave the programme after this many game minutes */
export const BULLETIN_TTL = 36 * 60;
/** a resident remembers this many headlines … */
export const SEEN_CAP = 6;
/** … for this long (game minutes) */
export const SEEN_TTL = MINUTES_PER_DAY;
/** headlines offered to a conversation */
export const NEWS_FOR_MAX = 3;
/** in-sim bulletin titles are kept this short */
export const BULLETIN_MAX = 60;
/** a "📰" log line at most this often (game minutes) */
export const NEWS_LOG_EVERY = 6 * 60;
/** with a real feed, every n-th slot airs a fresh in-sim bulletin (if there is one) */
export const LOCAL_SLOT_EVERY = 4;
/** the morning weather bulletin is prepared at this hour */
const FORECAST_HOUR = 6;

interface Seen {
  title: string;
  tick: number;
}

interface Bulletin extends NewsItem {
  /** tick when created; newer first on ties */
  at: number;
  /** worth a log line when first aired */
  big: boolean;
}

interface NewsState {
  /** real headlines (newest first), null = none set → in-sim news only */
  feed: NewsItem[] | null;
  bulletins: Bulletin[];
  /** times each title was put on air */
  aired: Map<string, number>;
  current: NewsItem | null;
  shownAt: number;
  slot: number;
  /** someone is watching a working TV right now */
  on: boolean;
  tvUids: number[];
  watcherIds: number[];
  seen: Map<number, Seen[]>;
  /** titles each agent already talked about (as speaker or listener) */
  discussed: Map<number, Set<string>>;
  processed: WeakSet<SimEvent>;
  /** conversation lines already scanned for news mentions */
  scannedLines: WeakMap<Conversation, number>;
  lastWeather: WeatherKind | null;
  forecastDay: number;
  lastLog: number;
}

const states = new WeakMap<World, NewsState>();

function stateOf(world: World): NewsState {
  let s = states.get(world);
  if (!s) {
    s = {
      feed: null,
      bulletins: [],
      aired: new Map(),
      current: null,
      shownAt: -Infinity,
      slot: 0,
      on: false,
      tvUids: [],
      watcherIds: [],
      seen: new Map(),
      discussed: new Map(),
      processed: new WeakSet(),
      scannedLines: new WeakMap(),
      lastWeather: null,
      forecastDay: 0,
      lastLog: -Infinity,
    };
    states.set(world, s);
  }
  return s;
}

// ---------------------------------------------------------------- text helpers

/** shortens to `max` chars at a word boundary, adding "…" */
export function fitHeadline(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
const stripEmoji = (s: string): string => s.replace(EMOJI, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- in-sim bulletins

function addBulletin(world: World, s: NewsState, title: string, big: boolean): void {
  const t = fitHeadline(title, BULLETIN_MAX);
  // only the latest weather news stays on air; a repeated story moves to the top
  const weather = t.startsWith('Pogoda:');
  for (let i = s.bulletins.length - 1; i >= 0; i--) {
    const b = s.bulletins[i];
    if (b.title === t || (weather && b.title.startsWith('Pogoda:'))) {
      s.bulletins.splice(i, 1);
      s.aired.delete(b.title);
    }
  }
  // a repeated story is news again
  s.aired.delete(t);
  s.bulletins.push({ title: t, source: LOCAL_SOURCE, real: false, at: world.tick, big });
  if (s.bulletins.length > MAX_BULLETINS) {
    const dropped = s.bulletins.splice(0, s.bulletins.length - MAX_BULLETINS);
    for (const d of dropped) s.aired.delete(d.title);
  }
}

/** turns a simulation event into a bulletin title, or null when it is not news */
export function bulletinFor(ev: SimEvent): { title: string; big: boolean } | null {
  if (ev.text.startsWith('📰')) return null;
  const g = ev.gossip;
  if (g && !g.shared) {
    if (g.valence >= 0.5) return { title: `Dobre wieści: ${g.text}`, big: g.valence >= 0.6 };
    if (g.valence >= 0.4) return { title: `Z osiedla: ${g.text}`, big: false };
    if (g.valence <= -0.4) return { title: `Pilne: ${g.text}`, big: true };
    return null;
  }
  if (ev.kind !== 'info') return null;
  // breakdowns and repairs without a culprit (see world/incidents.ts)
  if (ev.text.includes('🔧')) return { title: `Pilne: na osiedlu ${stripEmoji(ev.text).replace(/^(\p{Lu})/u, (c) => c.toLowerCase())}`, big: true };
  if (ev.text.includes('🧰')) return { title: `Z osiedla: ${stripEmoji(ev.text)}`, big: false };
  return null;
}

const PART_OF_DAY: [number, number, string][] = [
  [0, 6, 'w nocy'],
  [6, 10, 'rano'],
  [10, 12, 'przed południem'],
  [12, 18, 'po południu'],
  [18, 22, 'wieczorem'],
  [22, 24, 'w nocy'],
];
const partOfDay = (h: number): string => PART_OF_DAY.find(([a, b]) => h >= a && h < b)?.[2] ?? 'dziś';

/** "Pogoda: po południu deszcz" — from today's forecast, starting at `fromHour` */
export function forecastBulletin(world: World, fromHour: number): string {
  const f = forecastOf(world);
  const rest = f.slice(Math.max(0, Math.min(23, fromHour)));
  const wet = rest.findIndex((w) => w.raining);
  if (wet >= 0) {
    const h = fromHour + wet;
    const storm = rest.slice(wet).some((w) => w.kind === 'storm');
    return `Pogoda: ${partOfDay(h)} ${storm ? 'burza' : 'deszcz'}${storm ? ', lepiej zostać w domu' : ', weźcie parasole'}`;
  }
  const cloudy = rest.filter((w) => w.kind === 'cloudy').length;
  return cloudy > rest.length / 2 ? 'Pogoda: pochmurno, ale bez deszczu' : 'Pogoda: słonecznie i bez deszczu';
}

function weatherBulletins(world: World, s: NewsState): void {
  const minute = (world.tick + START_MINUTE) % MINUTES_PER_DAY;
  const hour = Math.floor(minute / 60);
  const day = Math.floor((world.tick + START_MINUTE) / MINUTES_PER_DAY) + 1;
  // a forecast on the first tick and every morning
  if (s.forecastDay === 0 || (day !== s.forecastDay && hour >= FORECAST_HOUR)) {
    s.forecastDay = day;
    addBulletin(world, s, forecastBulletin(world, hour), false);
  }
  const kind = weatherOf(world).kind;
  const prev = s.lastWeather;
  s.lastWeather = kind;
  if (prev === null || prev === kind) return;
  if (kind === 'storm') addBulletin(world, s, 'Pogoda: nad osiedlem burza, lepiej zostać w domu', false);
  else if (kind === 'rain' && prev !== 'storm') addBulletin(world, s, 'Pogoda: nad osiedlem pada deszcz', false);
  else if (kind === 'sunny' && (prev === 'rain' || prev === 'storm')) addBulletin(world, s, 'Pogoda: przejaśnia się, wraca słońce', false);
}

function pruneBulletins(world: World, s: NewsState): void {
  while (s.bulletins.length && world.tick - s.bulletins[0].at > BULLETIN_TTL) s.aired.delete(s.bulletins.shift()!.title);
}

function scanEvents(world: World, s: NewsState): void {
  const fresh: SimEvent[] = [];
  for (let i = world.events.length - 1; i >= 0; i--) {
    const ev = world.events[i];
    if (s.processed.has(ev)) break;
    s.processed.add(ev);
    fresh.push(ev);
  }
  for (let i = fresh.length - 1; i >= 0; i--) {
    const b = bulletinFor(fresh[i]);
    if (b) addBulletin(world, s, b.title, b.big);
  }
}

// ---------------------------------------------------------------- programme

function watchers(world: World): { agents: Agent[]; tvs: number[] } {
  const agents: Agent[] = [];
  const tvs = new Set<number>();
  for (const a of world.agents) {
    const act = a.action;
    if (act?.kind !== 'use' || act.phase !== 'using') continue;
    const obj = world.objects.find((o) => o.uid === act.objectUid);
    if (!obj || obj.type !== 'tv' || isBroken(obj)) continue;
    agents.push(a);
    tvs.add(obj.uid);
  }
  return { agents, tvs: [...tvs].sort((x, y) => x - y) };
}

/** least aired first; ties → earlier in `list` */
function leastAired<T extends NewsItem>(list: readonly T[], aired: Map<string, number>): T | null {
  let best: T | null = null;
  let bestN = Infinity;
  for (const it of list) {
    const n = aired.get(it.title) ?? 0;
    if (n < bestN) {
      best = it;
      bestN = n;
    }
  }
  return best;
}

function nextItem(s: NewsState): NewsItem | null {
  const local = [...s.bulletins].reverse(); // newest first
  const slot = s.slot++;
  if (s.feed?.length) {
    if (slot % LOCAL_SLOT_EVERY === LOCAL_SLOT_EVERY - 1) {
      const fresh = local.find((b) => !s.aired.has(b.title));
      if (fresh) return fresh;
    }
    return leastAired(s.feed, s.aired);
  }
  return leastAired(local, s.aired);
}

function see(s: NewsState, agent: Agent, title: string, tick: number): void {
  let list = s.seen.get(agent.id);
  if (!list) s.seen.set(agent.id, (list = []));
  if (list.length && list[list.length - 1].title === title) return;
  const i = list.findIndex((x) => x.title === title);
  if (i >= 0) list.splice(i, 1);
  list.push({ title, tick });
  if (list.length > SEEN_CAP) list.splice(0, list.length - SEEN_CAP);
}

function markDiscussed(s: NewsState, agentId: number, title: string): void {
  let set = s.discussed.get(agentId);
  if (!set) s.discussed.set(agentId, (set = new Set()));
  set.add(title);
}

/** the quoted headline in a dialogue line ("… „Pilne: Ola psuje…”"), without the trailing "…" */
export function quotedHeadline(text: string): string | null {
  const m = /„([^”]+)”/.exec(text);
  if (!m) return null;
  const q = m[1].replace(/…$/, '').trim();
  return q.length >= 6 ? q : null;
}

/** marks headlines mentioned in new conversation lines as discussed by both participants */
function scanConversations(world: World, s: NewsState): void {
  for (const conv of world.conversations) {
    const from = s.scannedLines.get(conv) ?? 0;
    if (from >= conv.lines.length) continue;
    s.scannedLines.set(conv, conv.lines.length);
    for (let i = from; i < conv.lines.length; i++) {
      const line = conv.lines[i];
      const q = quotedHeadline(line.text);
      if (!q) continue;
      const known = s.seen.get(line.speakerId)?.find((x) => x.title.startsWith(q));
      if (!known) continue;
      for (const id of conv.participants) markDiscussed(s, id, known.title);
    }
  }
}

/** called once per tick */
export function tickNews(world: World): void {
  const s = stateOf(world);
  pruneBulletins(world, s);
  scanEvents(world, s);
  weatherBulletins(world, s);
  scanConversations(world, s);

  const { agents, tvs } = watchers(world);
  s.on = agents.length > 0;
  s.tvUids = tvs;
  s.watcherIds = agents.map((a) => a.id);
  if (!s.on) return;
  if (!s.current || world.tick - s.shownAt >= ROTATE_TICKS || !onProgramme(s, s.current)) {
    const item = nextItem(s);
    if (item) {
      const firstTime = !s.aired.has(item.title);
      s.aired.set(item.title, (s.aired.get(item.title) ?? 0) + 1);
      s.current = { title: item.title, source: item.source, real: item.real };
      s.shownAt = world.tick;
      const big = !item.real && (item as Partial<Bulletin>).big === true;
      if (big && firstTime && world.tick - s.lastLog >= NEWS_LOG_EVERY) {
        s.lastLog = world.tick;
        pushEvent(world, 'info', `📰 ${item.title}`, s.watcherIds.slice());
      }
    }
  }
  if (s.current) for (const a of agents) see(s, a, s.current.title, world.tick);
}

function onProgramme(s: NewsState, item: NewsItem): boolean {
  return item.real ? !!s.feed?.some((f) => f.title === item.title) : s.bulletins.some((b) => b.title === item.title);
}

/** what the TV shows right now (null when nobody watches a working TV) */
export function currentHeadline(world: World): NewsItem | null {
  const s = states.get(world);
  return s?.on && s.current ? s.current : null;
}

/** TVs that are on right now (object uids) */
export function activeTvs(world: World): readonly number[] {
  const s = states.get(world);
  return s?.on ? s.tvUids : [];
}

/** headlines this agent saw recently and might bring up in a chat (newest first, max 3) */
export function newsFor(world: World, agent: Agent): string[] {
  const s = states.get(world);
  const list = s?.seen.get(agent.id);
  if (!list?.length) return [];
  const done = s!.discussed.get(agent.id);
  const out: string[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < NEWS_FOR_MAX; i--) {
    const x = list[i];
    if (world.tick - x.tick > SEEN_TTL) break;
    if (!done?.has(x.title)) out.push(x.title);
  }
  return out;
}

/** in-sim bulletins currently on the programme (newest first), e.g. for tests / UI */
export function localBulletins(world: World): NewsItem[] {
  return stateOf(world)
    .bulletins.slice()
    .reverse()
    .map((b) => ({ title: b.title, source: b.source, real: false }));
}

// ---------------------------------------------------------------- real headlines

export const NEWS_API_URL = '/api/news';
export const NEWS_REFRESH_MS = 15 * 60_000;
const MAX_FEED_ITEMS = 30;

/** validates untrusted headlines (proxy response): trimmed, sane length, deduped, ≤ 30 */
export function sanitizeFeed(raw: unknown): NewsItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.title !== 'string') continue;
    const title = o.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 8 || title.length > 200 || seen.has(title)) continue;
    const source = typeof o.source === 'string' ? o.source.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    seen.add(title);
    out.push({ title, source: source || 'RSS', real: true });
    if (out.length >= MAX_FEED_ITEMS) break;
  }
  return out;
}

/**
 * Sets the real headlines shown on TV (newest first). null / [] → back to in-sim news only.
 * Call outside tickWorld; makes the run non-reproducible.
 */
export function setNewsFeed(world: World, items: readonly { title: string; source?: string }[] | null): void {
  const s = stateOf(world);
  const clean = items ? sanitizeFeed(items) : [];
  s.feed = clean.length ? clean : null;
  if (s.feed) {
    // forget air counts of headlines that left the feed
    const keep = new Set([...s.feed.map((f) => f.title), ...s.bulletins.map((b) => b.title)]);
    for (const t of [...s.aired.keys()]) if (!keep.has(t)) s.aired.delete(t);
  }
}

export function hasRealNews(world: World): boolean {
  return !!stateOf(world).feed;
}

/** fetches /api/news once and applies it; resolves true when real headlines are on. Never throws. */
export async function loadRealNews(
  world: World,
  opts: { fetch?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? (typeof fetch === 'function' ? (...a: Parameters<typeof fetch>) => fetch(...a) : null);
  if (!doFetch) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await doFetch(opts.url ?? NEWS_API_URL, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { items?: unknown };
    const items = sanitizeFeed(body?.items);
    // an empty answer keeps whatever was there (in-sim news or the previous list)
    if (items.length) setNewsFeed(world, items);
    return hasRealNews(world);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** loads real headlines now and every 15 minutes (wall clock); returns a stop function */
export function startNewsFeed(world: World, opts: { fetch?: typeof fetch; url?: string; intervalMs?: number } = {}): () => void {
  void loadRealNews(world, opts);
  const id = setInterval(() => void loadRealNews(world, opts), opts.intervalMs ?? NEWS_REFRESH_MS);
  return () => clearInterval(id);
}
