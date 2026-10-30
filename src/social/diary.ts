import type { Agent, NeedKey, Rng, SimEvent, Traits, World } from '../types';
import { createRng } from '../core/rng';
import { fromJson, registerWorldState, toJson, type Json } from '../core/state';
import { formatClock, timeFromTick } from '../core/time';
import { traceOf, type TraceEntry } from '../world/trace';
import { goalOf, type GoalKind } from '../agents/goals';
import { isAgentSleeping } from '../agents/actions';
import { statusOf, type RelationStatus } from './relationships';
import { agentMemories } from './memory';
import { newsFor } from '../world/news';
import { weatherOf, type WeatherKind } from '../world/incidents';
import { projectDayFacts, type ProjectDayFact } from '../world/projects';
import { topicAbout } from './conversation';
import { describeTraits } from './llmProvider';
import { createDiaryAiClient, DiaryAiError, type DiaryAiClient, type DiaryAiClientOptions, type LlmDiaryRequest } from './diaryAi';

// Residents' diaries: every evening each resident writes a first-person entry about their day,
// built from what really happened (trace, events, memories, goals, relationships, TV news).
//
// Facts are collected incrementally every tick (new trace entries and events, mood / needs
// samples), so nothing is lost to the trace / event caps. The entry is written when the resident
// turns in for the night (or at 23:30 at the latest) and covers that day (from 05:00 / waking up).
// The text is procedural and deterministic: its own RNG seeded from world seed + agent + day,
// never world.rng, and only read-only accessors are used — diaries never change the simulation.
// Polish rules: present tense narration, no gendered past tense or gendered adjectives about the
// writer, other people's names in the nominative only ("Ola i ja…", "Ola mówi, że…").
// Optional AI rewrite (setDiaryAiEnabled): the structured facts go to /api/llm/diary, a valid
// answer replaces the text (source 'ai'); any failure keeps the procedural entry.

export interface DiaryEntry {
  agentId: number;
  /** game day the entry is about (1-based) */
  day: number;
  /** tick when it was written */
  tick: number;
  /** Polish, first person, a few short paragraphs separated by "\n\n" */
  text: string;
  /** writer's mood (0..100) at writing time */
  mood: number;
  /** short emoji tags of the day's highlights, e.g. ["🎣", "💬", "🌧️"] */
  tags: string[];
  /** 'ai' once an AI rewrite has replaced the procedural text */
  source: 'procedural' | 'ai';
}

// ---------------------------------------------------------------- facts

export type DayPart = 'rano' | 'w południe' | 'po południu' | 'wieczorem';
export type TalkOutcome = 'great' | 'nice' | 'plain' | 'tense' | 'quarrel';
export type RelationChange = 'couple' | 'crush' | 'breakup' | 'rivals' | 'enemies' | 'best_friends' | 'friends' | 'peace';

export interface ActivityFact {
  /** object type ('fishing_spot', 'tv'…), 'nap' for a daytime sleep, 'repair' for repair work */
  type: string;
  part: DayPart;
  minutes: number;
  times: number;
}

export interface MealFact {
  kind: 'śniadanie' | 'obiad' | 'kolacja' | 'przekąska';
  /** object type: dining_table, stove, grill, fridge */
  where: string;
}

export interface TalkFact {
  with: string;
  topic: string;
  outcome: TalkOutcome;
  /** the writer started it */
  mine: boolean;
  /** writer's sympathy towards them at writing time (-100..100) */
  sympathy: number;
}

export interface DiaryFacts {
  agentId: number;
  name: string;
  day: number;
  /** "06:28" or null when not known (day 1, woke up before the diary day) */
  wake: string | null;
  /** clock time of writing */
  bedtime: string;
  /** the resident is still awake at writing time (23:30 fallback) */
  late: boolean;
  activities: ActivityFact[];
  meals: MealFact[];
  talks: TalkFact[];
  /** people who turned the writer's invitation down */
  refusedBy: { name: string; busy: boolean }[];
  /** people the writer turned down */
  refused: string[];
  gatherings: { kind: 'meal' | 'grill' | 'movie'; label: string; with: string[] }[];
  goal: { kind: GoalKind; done: boolean; partner: string | null } | null;
  relations: { with: string; change: RelationChange }[];
  /** quarrels about the TV remote; `mine` = the writer grabbed the remote */
  remote: { with: string; mine: boolean }[];
  heard: { text: string; from: string | null; valence: number }[];
  told: { text: string; to: string }[];
  /** TV headlines seen today, verbatim */
  news: string[];
  /** weather kinds through the day, in order, without repeats */
  weather: WeatherKind[];
  /** accusative object names, e.g. "lodówkę" */
  broke: string[];
  fixed: string[];
  /** first-person story beats ("Łowię szczupaka! 🐟") */
  moments: string[];
  mood: { start: number; end: number; min: number; max: number; minPart: DayPart | null };
  /** needs that dropped very low while awake */
  lowNeeds: NeedKey[];
  /** building projects: work done today, stages finished, proposal, completion (world/projects) */
  projects?: ProjectDayFact[];
  /** how the writer feels about the people met today (strongest first) */
  feelings: { with: string; status: RelationStatus; sympathy: number }[];
}

export interface DiaryPersona {
  name: string;
  traits: Traits;
  /** mood at writing time */
  mood: number;
}

// ---------------------------------------------------------------- state

const MAX_DAYS = 60;
/** night sleep: a sleep that still has this many minutes ahead (naps are 60–120 min) */
const NIGHT_SLEEP_LEFT = 180;
/** the diary day starts at 05:00 */
const DAY_START_MIN = 5 * 60;
const WRITE_DEADLINE = { hour: 23, minute: 30 };
const SAMPLE_EVERY = 15;
const LOW_NEED = 15;
const MIN_ACTIVITY = 8;
/** remembered story / headline texts per resident (dedupe across days) */
const SEEN_CAP = 400;

function remember(set: Set<string>, text: string): void {
  set.add(text);
  if (set.size > SEEN_CAP) set.delete(set.values().next().value as string);
}

interface Bucket {
  day: number;
  wake: string | null;
  activities: Map<string, ActivityFact>;
  meals: MealFact[];
  convTopic: Map<string, { topic: string; mine: boolean }>;
  talks: { with: string; withId: number; topic: string; outcome: TalkOutcome; mine: boolean }[];
  refusedBy: { name: string; busy: boolean }[];
  refused: string[];
  gatherings: DiaryFacts['gatherings'];
  relations: DiaryFacts['relations'];
  remote: DiaryFacts['remote'];
  heard: DiaryFacts['heard'];
  told: DiaryFacts['told'];
  news: string[];
  broke: string[];
  fixed: string[];
  moments: string[];
  moodStart: number | null;
  moodMin: number;
  moodMax: number;
  moodMinTick: number;
  lowNeeds: Set<NeedKey>;
  met: Set<number>;
}

interface AgentDiary {
  entries: DiaryEntry[];
  facts: Map<number, DiaryFacts>;
  bucket: Bucket | null;
  /** object in use (survives the day boundary: night sleep ends in the next diary day) */
  pendingUse: { type: string; uid: number; tick: number } | null;
  lastWritten: number;
  heardEver: Set<string>;
  newsEver: Set<string>;
  /** templates used recently (avoids repeating yesterday's sentences) */
  recent: string[];
  /** first sentence of the procedural entry per day (other residents avoid it the same day) */
  openers?: Map<number, string>;
}

interface AiState {
  enabled: boolean;
  client: DiaryAiClient;
  attempted: Set<string>;
  queue: DiaryEntry[];
  busy: boolean;
  blockedUntil: number;
  spacingMs: number;
  now: () => number;
}

interface DiaryState {
  enabled: boolean;
  agents: Map<number, AgentDiary>;
  lastTick: number;
  weather: Map<number, WeatherKind[]>;
  listeners: Set<(e: DiaryEntry) => void>;
  ai: AiState | null;
}

const states = new WeakMap<World, DiaryState>();

// snapshots (core/state.ts): entries, day facts, open buckets and dedupe sets; listeners and the
// AI rewrite state are hooks of the running page (re-attached with onDiaryChange / setDiaryAiEnabled)
registerWorldState('diary', {
  save: (world, opts) => {
    const s = states.get(world);
    if (!s) return null;
    let agents = s.agents;
    const keep = opts.diaryFactDays;
    if (keep !== undefined) {
      // facts only feed the AI rewrite of recent entries: network snapshots keep the last days
      agents = new Map(
        [...s.agents].map(([id, d]) => {
          const last = Math.max(0, ...d.facts.keys());
          return [id, { ...d, facts: new Map([...d.facts].filter(([day]) => day > last - keep)) }];
        }),
      );
    }
    return toJson({ enabled: s.enabled, agents, lastTick: s.lastTick, weather: s.weather });
  },
  load: (world, data) => {
    const d = fromJson<Pick<DiaryState, 'enabled' | 'agents' | 'lastTick' | 'weather'>>(data as Json);
    const prev = states.get(world);
    states.set(world, { ...d, listeners: prev?.listeners ?? new Set(), ai: prev?.ai ?? null });
  },
  // listeners and the AI rewrite state are hooks of the page: they survive an in-place update
  clear: (world) => {
    const s = states.get(world);
    if (s) states.set(world, { ...s, enabled: true, agents: new Map(), lastTick: Math.max(0, world.tick - 1), weather: new Map() });
  },
});

function stateOf(world: World): DiaryState {
  let s = states.get(world);
  if (!s) states.set(world, (s = { enabled: true, agents: new Map(), lastTick: Math.max(0, world.tick - 1), weather: new Map(), listeners: new Set(), ai: null }));
  return s;
}

function agentDiary(s: DiaryState, id: number): AgentDiary {
  let d = s.agents.get(id);
  if (!d) s.agents.set(id, (d = { entries: [], facts: new Map(), bucket: null, pendingUse: null, lastWritten: 0, heardEver: new Set(), newsEver: new Set(), recent: [] }));
  return d;
}

/** the diary day of a tick: days start at 05:00 */
export function diaryDayOf(tick: number): number {
  return timeFromTick(tick - DAY_START_MIN).day;
}

function freshBucket(day: number): Bucket {
  return {
    day, wake: null, activities: new Map(), meals: [], convTopic: new Map(), talks: [], refusedBy: [], refused: [],
    gatherings: [], relations: [], remote: [], heard: [], told: [], news: [], broke: [], fixed: [], moments: [],
    moodStart: null, moodMin: 101, moodMax: -1, moodMinTick: 0, lowNeeds: new Set(), met: new Set(),
  };
}

/** the open bucket of an agent for the current diary day; null once today's entry is written */
function bucketOf(s: DiaryState, id: number, tick: number): Bucket | null {
  const d = agentDiary(s, id);
  const day = diaryDayOf(tick);
  if (d.lastWritten >= day) return null;
  if (!d.bucket || d.bucket.day !== day) d.bucket = freshBucket(day);
  return d.bucket;
}

function partOf(tick: number): DayPart {
  const t = timeFromTick(tick);
  const h = t.hour + t.minute / 60;
  if (h >= 5 && h < 11) return 'rano';
  if (h >= 11 && h < 14) return 'w południe';
  if (h >= 14 && h < 18) return 'po południu';
  return 'wieczorem';
}

// ---------------------------------------------------------------- collecting

const nameOf = (world: World, id: number): string => world.agents.find((a) => a.id === id)?.name ?? '?';

const MEAL_TYPES = new Set(['dining_table', 'stove', 'grill', 'fridge']);

function mealKind(tick: number, where: string): MealFact['kind'] {
  if (where === 'fridge') return 'przekąska';
  const t = timeFromTick(tick);
  const h = t.hour + t.minute / 60;
  if (h >= 4 && h < 10.5) return 'śniadanie';
  if (h >= 10.5 && h < 16) return 'obiad';
  return 'kolacja';
}

function addActivity(b: Bucket, type: string, tick: number, minutes: number): void {
  const part = partOf(tick);
  const key = `${type}|${part}`;
  const a = b.activities.get(key);
  if (a) {
    a.minutes += minutes;
    a.times++;
  } else b.activities.set(key, { type, part, minutes, times: 1 });
}

function onTrace(world: World, s: DiaryState, e: TraceEntry): void {
  const d = agentDiary(s, e.agentId);
  if (e.kind === 'arrive') {
    const uid = Number(/#(\d+)/.exec(e.text)?.[1]);
    const obj = world.objects.find((o) => o.uid === uid);
    if (!obj) return;
    const type = obj.type.startsWith('repair_') ? 'repair' : obj.type;
    d.pendingUse = { type, uid, tick: e.tick };
    const b = bucketOf(s, e.agentId, e.tick);
    if (b && MEAL_TYPES.has(type)) {
      const kind = mealKind(e.tick, type);
      if (!b.meals.some((m) => m.kind === kind && m.where === type)) b.meals.push({ kind, where: type });
    }
    return;
  }
  if (e.kind === 'end') {
    const p = d.pendingUse;
    if (!p || !e.text.startsWith('używa:') || !e.text.includes(`#${p.uid} `)) return;
    d.pendingUse = null;
    const b = bucketOf(s, e.agentId, e.tick);
    if (!b) return;
    const minutes = e.tick - p.tick;
    if (p.type === 'bed') {
      const t = timeFromTick(e.tick);
      if (minutes >= NIGHT_SLEEP_LEFT && t.hour < 12) {
        if (!b.wake) b.wake = formatClock(t);
      } else if (minutes >= 20) addActivity(b, 'nap', p.tick, minutes);
      return;
    }
    if (MEAL_TYPES.has(p.type) && p.type !== 'grill' && p.type !== 'stove') return;
    if (minutes >= MIN_ACTIVITY || p.type === 'shower') addActivity(b, p.type, p.tick, minutes);
    return;
  }
  const b = bucketOf(s, e.agentId, e.tick);
  if (!b) return;
  if (e.kind === 'invite') {
    b.convTopic.set(e.text.split(' (')[0], { topic: '', mine: true });
  } else if (e.kind === 'conv-start') {
    const m = /^(?:przy okazji )?z (.+?), temat: ([^,]+)/.exec(e.text);
    if (!m) return;
    const prev = b.convTopic.get(m[1]);
    b.convTopic.set(m[1], { topic: m[2], mine: !!prev?.mine && !e.text.startsWith('przy okazji') });
  }
}

function outcomeOf(text: string): TalkOutcome {
  if (/kłótnia|sprzeczka|spięcie/.test(text)) return 'quarrel';
  if (/napięta|nie zgadzają|chłodna/.test(text)) return 'tense';
  if (/świetna|nadają|serdeczna/.test(text)) return 'great';
  if (/miła|sympatyczna|przyjemna/.test(text)) return 'nice';
  return 'plain';
}

const RELATION_PATTERNS: [RegExp, RelationChange][] = [
  [/są parą/, 'couple'],
  [/rozstają/, 'breakup'],
  [/mają się ku sobie/, 'crush'],
  [/zostają rywalami/, 'rivals'],
  [/nie mogą się znieść/, 'enemies'],
  [/najlepszymi przyjaciółmi/, 'best_friends'],
  [/się przyjaźnią/, 'friends'],
  [/topór wojenny|koniec rywalizacji/, 'peace'],
];

const GATHERING = /^(Wspólne śniadanie|Wspólny obiad|Wspólna kolacja|Wspólny grill|Wspólny seans|Wieczór filmowy): /;

/** narration beats (agents/narration.ts) retold in the first person */
const MOMENTS: [RegExp, string][] = [
  [/przypala (obiad|sos)/, 'Przypalam obiad. 🔥 Cały dom pachnie spalenizną.'],
  [/wymyśla nowy przepis/, 'Wymyślam nowy przepis! ✨'],
  [/przypala kiełbaski/, 'Kiełbaski na grillu — przypalone na węgiel. 🔥'],
  [/zimna woda/, 'Pod prysznicem lodowata woda! 🥶'],
  [/komputer się zawiesza/, 'Komputer zawiesza się w najgorszym momencie. 💻'],
  [/ćwiczy nowy utwór/, 'Ćwiczę nowy utwór na pianinie. 🎶'],
  [/w lodówce pustki/, 'W lodówce pustki…'],
  [/ulubiony serial/, 'W telewizji leci mój ulubiony serial! 📺'],
  [/piana po sam sufit/, 'Piana w wannie po sam sufit. 🛁'],
  [/szczupak/, 'Łowię szczupaka! 🐟'],
  [/karp/, 'Łowię pięknego karpia! 🐟'],
  [/ryba się zerwała/, 'Ryba zrywa się tuż przy brzegu… 😩'],
  [/wygrana partia/, 'Wygrywam partię na komputerze! 🏆'],
  [/rekord na bieżni/, 'Nowy rekord na bieżni! 🏅'],
  [/20 km na rowerku/, '20 km na rowerku! 🏅'],
  [/tulipany/, 'Tulipany w ogródku kwitną. 🌷'],
  [/chwila spokoju na ławce/, 'Chwila spokoju na ławce. 🌿'],
  [/książka skończona/, 'Kończę świetną książkę. 📖'],
];

function onEvent(world: World, s: DiaryState, e: SimEvent): void {
  const ids = e.agentIds;
  const bucket = (id: number): Bucket | null => bucketOf(s, id, e.tick);
  if (e.kind === 'conversation' && ids.length === 2) {
    const [a, b] = ids;
    if (e.text.includes(' ↔ ')) {
      const outcome = outcomeOf(e.text);
      for (const [self, other] of [[a, b], [b, a]] as const) {
        const bk = bucket(self);
        if (!bk) continue;
        const name = nameOf(world, other);
        const conv = bk.convTopic.get(name);
        bk.convTopic.delete(name);
        bk.talks.push({ with: name, withId: other, topic: conv?.topic ?? '', outcome, mine: conv?.mine ?? false });
        bk.met.add(other);
      }
      return;
    }
    const busy = / nie ma teraz czasu dla: /.test(e.text);
    if (busy || / nie ma ochoty na rozmowę z: /.test(e.text)) {
      // ids = [inviter, partner]
      bucket(a)?.refusedBy.push({ name: nameOf(world, b), busy });
      bucket(a)?.convTopic.delete(nameOf(world, b));
      if (!busy) bucket(b)?.refused.push(nameOf(world, a));
      return;
    }
    const g = /: plotka \((.+)\)$/.exec(e.text);
    if (g) {
      // ids = [speaker, listener]
      bucket(a)?.told.push({ text: g[1], to: nameOf(world, b) });
      const hb = bucket(b);
      if (hb && !hb.heard.some((h) => h.text === g[1])) {
        hb.heard.push({ text: g[1], from: nameOf(world, a), valence: 0 });
        remember(agentDiary(s, b).heardEver, g[1]);
      }
      return;
    }
    return;
  }
  if (e.kind === 'relationship' && ids.length === 2) {
    const [a, b] = ids;
    if (/kłótnia o pilota/.test(e.text)) {
      bucket(a)?.remote.push({ with: nameOf(world, b), mine: true });
      bucket(b)?.remote.push({ with: nameOf(world, a), mine: false });
      return;
    }
    const change = RELATION_PATTERNS.find(([re]) => re.test(e.text))?.[1];
    if (!change) return;
    bucket(a)?.relations.push({ with: nameOf(world, b), change });
    bucket(b)?.relations.push({ with: nameOf(world, a), change });
    return;
  }
  if (e.kind === 'info' && GATHERING.test(e.text)) {
    const label = GATHERING.exec(e.text)![1];
    const kind = /grill/.test(label) ? 'grill' : /seans|filmowy/.test(label) ? 'movie' : 'meal';
    for (const id of ids) {
      const bk = bucket(id);
      if (!bk) continue;
      bk.gatherings.push({ kind, label, with: ids.filter((x) => x !== id).map((x) => nameOf(world, x)) });
      for (const x of ids) if (x !== id) bk.met.add(x);
    }
    return;
  }
  if (e.kind === 'info' && e.text.startsWith('📰 ')) {
    const title = e.text.slice(3).trim();
    for (const id of ids) {
      const bk = bucket(id);
      if (bk && !bk.news.includes(title)) bk.news.push(title);
      remember(agentDiary(s, id).newsEver, title);
    }
    return;
  }
  if (ids.length !== 1) return;
  const me = ids[0];
  const name = nameOf(world, me);
  const bk = bucket(me);
  if (!bk) return;
  const gt = e.gossip?.text ?? '';
  if (gt.startsWith(`${name} psuje `)) {
    bk.broke.push(gt.slice(`${name} psuje `.length));
    return;
  }
  if (gt.startsWith(`${name} naprawia `)) {
    bk.fixed.push(gt.slice(`${name} naprawia `.length));
    return;
  }
  if (e.text.startsWith(`${name}: `)) {
    const beat = MOMENTS.find(([re]) => re.test(e.text))?.[1];
    if (beat && !bk.moments.includes(beat)) bk.moments.push(beat);
  }
}

function sample(world: World, s: DiaryState, agent: Agent): void {
  const b = bucketOf(s, agent.id, world.tick);
  if (!b || isAgentSleeping(world, agent)) return;
  const m = agent.mood;
  if (b.moodStart === null) b.moodStart = m;
  if (m < b.moodMin) {
    b.moodMin = m;
    b.moodMinTick = world.tick;
  }
  if (m > b.moodMax) b.moodMax = m;
  for (const k of ['hunger', 'energy', 'social', 'hygiene'] as NeedKey[]) if (agent.needs[k] < LOW_NEED) b.lowNeeds.add(k);
  if (world.tick % SAMPLE_EVERY !== 0) return;
  const d = agentDiary(s, agent.id);
  for (const title of newsFor(world, agent)) {
    if (d.newsEver.has(title)) continue;
    remember(d.newsEver, title);
    if (!b.news.includes(title)) b.news.push(title);
  }
  for (const mem of agentMemories(world, agent.id)) {
    if (mem.source !== 'heard' || d.heardEver.has(mem.gossip.text)) continue;
    remember(d.heardEver, mem.gossip.text);
    const from = mem.fromId !== undefined ? nameOf(world, mem.fromId) : null;
    const known = b.heard.find((h) => h.text === mem.gossip.text);
    if (known) known.valence = mem.gossip.valence;
    else b.heard.push({ text: mem.gossip.text, from, valence: mem.gossip.valence });
  }
  for (const h of b.heard) {
    if (h.valence !== 0) continue;
    const mem = agentMemories(world, agent.id).find((x) => x.gossip.text === h.text);
    if (mem) h.valence = mem.gossip.valence;
  }
}

function sampleWeather(world: World, s: DiaryState): void {
  if (world.tick % 30 !== 0) return;
  const t = timeFromTick(world.tick);
  if (t.hour < 6 || t.hour >= 23) return;
  const day = diaryDayOf(world.tick);
  const list = s.weather.get(day) ?? [];
  const kind = weatherOf(world).kind;
  if (list[list.length - 1] !== kind) list.push(kind);
  s.weather.set(day, list);
  for (const k of s.weather.keys()) if (k < day - 2) s.weather.delete(k);
}

function isNightSleep(world: World, agent: Agent, hour: number): boolean {
  if (!(hour >= 19 || hour < 5) || !isAgentSleeping(world, agent)) return false;
  const a = agent.action;
  return a?.kind === 'use' && a.ticksLeft >= NIGHT_SLEEP_LEFT;
}

// ---------------------------------------------------------------- writing

function buildFacts(world: World, s: DiaryState, agent: Agent, b: Bucket, late: boolean): DiaryFacts {
  const time = timeFromTick(world.tick);
  const goal = goalOf(agent, world);
  const sympathy = (id: number) => world.relationships.get(agent.id, id);
  const met = [...b.met].filter((id) => id !== agent.id && world.agents.some((a) => a.id === id));
  const feelings = met
    .map((id) => ({ with: nameOf(world, id), status: statusOf(world, agent.id, id), sympathy: Math.round(sympathy(id)) || 0 }))
    .sort((x, y) => Math.abs(y.sympathy) - Math.abs(x.sympathy));
  const order: DayPart[] = ['rano', 'w południe', 'po południu', 'wieczorem'];
  const activities = [...b.activities.values()].sort((x, y) => order.indexOf(x.part) - order.indexOf(y.part));
  return {
    agentId: agent.id,
    name: agent.name,
    day: b.day,
    wake: b.wake,
    bedtime: formatClock(time),
    late,
    activities,
    meals: b.meals,
    talks: b.talks.map((t) => ({ with: t.with, topic: t.topic, outcome: t.outcome, mine: t.mine, sympathy: Math.round(sympathy(t.withId)) || 0 })),
    refusedBy: b.refusedBy,
    refused: b.refused,
    gatherings: b.gatherings,
    goal: goal ? { kind: goal.kind, done: goal.done, partner: goal.partnerId !== undefined ? nameOf(world, goal.partnerId) : null } : null,
    relations: b.relations,
    remote: b.remote,
    heard: b.heard,
    told: b.told,
    news: b.news.slice(0, 3),
    weather: [...(s.weather.get(b.day) ?? [])],
    broke: b.broke,
    fixed: b.fixed,
    moments: b.moments,
    mood: {
      start: Math.round(b.moodStart ?? agent.mood),
      end: Math.round(agent.mood),
      min: Math.round(Math.min(b.moodMin, agent.mood)),
      max: Math.round(Math.max(b.moodMax, agent.mood)),
      minPart: b.moodMin <= agent.mood ? partOf(b.moodMinTick) : partOf(world.tick),
    },
    lowNeeds: [...b.lowNeeds],
    feelings,
    projects: projectDayFacts(world, agent.id, b.day),
  };
}

function write(world: World, s: DiaryState, agent: Agent, late: boolean): void {
  const d = agentDiary(s, agent.id);
  const b = bucketOf(s, agent.id, world.tick);
  if (!b) return;
  const facts = buildFacts(world, s, agent, b, late);
  const persona: DiaryPersona = { name: agent.name, traits: { ...agent.traits }, mood: agent.mood };
  const avoid = [...s.agents.values()].flatMap((x) => x.openers?.get(b.day) ?? []);
  const { text, tags, used, opener } = composeDiaryInternal(facts, persona, diarySeed(world.seed, agent.id, b.day), d.recent, avoid);
  d.recent = [...d.recent, ...used].slice(-60);
  (d.openers ??= new Map()).set(b.day, opener);
  for (const day of d.openers.keys()) if (day <= b.day - MAX_DAYS) d.openers.delete(day);
  const entry: DiaryEntry = { agentId: agent.id, day: b.day, tick: world.tick, text, mood: Math.round(agent.mood), tags, source: 'procedural' };
  d.entries.push(entry);
  d.facts.set(b.day, facts);
  if (d.entries.length > MAX_DAYS) {
    const drop = d.entries.splice(0, d.entries.length - MAX_DAYS);
    for (const x of drop) d.facts.delete(x.day);
  }
  d.lastWritten = b.day;
  d.bucket = null;
  notify(s, entry);
  if (s.ai?.enabled) queueAi(world, s, entry);
}

function notify(s: DiaryState, entry: DiaryEntry): void {
  for (const fn of [...s.listeners]) {
    try {
      fn(entry);
    } catch {
      /* a broken listener must not break the simulation */
    }
  }
}

/** called once per tick (after agents act): writes entries when residents turn in for the night */
export function tickDiary(world: World): void {
  const s = stateOf(world);
  if (!s.enabled) {
    s.lastTick = world.tick;
    return;
  }
  // new trace entries and events since the last call (both are appended in tick order)
  const trace = traceOf(world);
  let i = trace.length;
  while (i > 0 && trace[i - 1].tick > s.lastTick) i--;
  for (let k = i; k < trace.length; k++) onTrace(world, s, trace[k]);
  const events = world.events;
  let j = events.length;
  while (j > 0 && events[j - 1].tick > s.lastTick) j--;
  for (let k = j; k < events.length; k++) onEvent(world, s, events[k]);
  s.lastTick = world.tick;

  sampleWeather(world, s);
  const time = timeFromTick(world.tick);
  const deadline = (time.hour === WRITE_DEADLINE.hour && time.minute >= WRITE_DEADLINE.minute) || time.hour < 5;
  for (const agent of world.agents) {
    sample(world, s, agent);
    if (agentDiary(s, agent.id).lastWritten >= diaryDayOf(world.tick)) continue;
    const asleep = isNightSleep(world, agent, time.hour);
    if (asleep || deadline) write(world, s, agent, !asleep);
  }
}

/** turns diary writing on/off for a world (off = tickDiary does nothing; for tests / comparisons) */
export function setDiaryEnabled(world: World, enabled: boolean): void {
  stateOf(world).enabled = enabled;
}

/** all entries of one resident, oldest first */
export function diaryOf(world: World, agentId: number): readonly DiaryEntry[] {
  return states.get(world)?.agents.get(agentId)?.entries ?? [];
}

/** the facts an entry was written from (kept as long as the entry) */
export function diaryFactsOf(world: World, agentId: number, day: number): DiaryFacts | undefined {
  return states.get(world)?.agents.get(agentId)?.facts.get(day);
}

/** subscribe to new/updated entries (UI refresh); returns unsubscribe */
export function onDiaryChange(world: World, fn: (entry: DiaryEntry) => void): () => void {
  const s = stateOf(world);
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

// ---------------------------------------------------------------- export

/** short personality words (same idea as the inspector chips) */
export function personalityOf(t: Traits): string[] {
  const out: string[] = [];
  const add = (v: number, hi: string, lo: string) => {
    if (v >= 0.35) out.push(hi);
    else if (v <= -0.35) out.push(lo);
  };
  add(t.sociability, 'dusza towarzystwa', 'domator');
  add(t.activity, 'wulkan energii', 'śpioch');
  add(t.neatness, 'pedant', 'bałaganiarz');
  add(t.cheerfulness, 'optymista', 'maruda');
  return out.length ? out : ['złoty środek'];
}

function formatOne(world: World, agent: Agent): string {
  const entries = diaryOf(world, agent.id);
  const lines = [`Pamiętnik: ${agent.name}`, `Charakter: ${personalityOf(agent.traits).join(', ')}`, ''];
  if (!entries.length) lines.push('(jeszcze brak wpisów)');
  for (const e of entries) {
    const t = timeFromTick(e.tick);
    const meta = [`wpis o ${formatClock(t)}`, e.source === 'ai' ? 'AI' : ''].filter(Boolean).join(', ');
    lines.push(`=== Dzień ${e.day} (${meta}) ${e.tags.join(' ')}`.trimEnd(), '', e.text, '');
  }
  return lines.join('\n').trimEnd();
}

/** plain-text export of one resident's diary (or everyone's) */
export function formatDiary(world: World, agentId?: number): string {
  const agents = agentId === undefined ? world.agents : world.agents.filter((a) => a.id === agentId);
  return agents.map((a) => formatOne(world, a)).join('\n\n\n');
}

// ---------------------------------------------------------------- composing (pure, deterministic)

export function diarySeed(seed: number, agentId: number, day: number): number {
  let h = (seed ^ 0x6d1a7c3b) >>> 0;
  h = Math.imul(h ^ (agentId + 0x9e3779b9), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (day * 0x27d4eb2f), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

interface Sentence {
  para: 0 | 1 | 2 | 3;
  prio: number;
  text: string;
}

type Tone = 'pos' | 'neu' | 'neg';
type Pools = Partial<Record<Tone, readonly string[]>>;

const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
const firstSentence = (s: string): string => s.split(/(?<=[.!?…])\s+/)[0];
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

const ACT_NOUN: Record<string, string> = {
  fishing_spot: 'wędkowanie', bookshelf: 'książka', computer: 'gry na komputerze', piano: 'pianino', exercise_bike: 'rowerek',
  treadmill: 'bieżnia', tv: 'telewizja', bench: 'ławka w ogrodzie', flowerbed: 'praca w ogródku', bathtub: 'kąpiel w wannie',
  shower: 'prysznic', nap: 'drzemka', repair: 'naprawy', grill: 'grill', stove: 'gotowanie', altana: 'altana w ogrodzie',
  warzywnik: 'praca w warzywniku', console: 'granie na konsoli', board_game_table: 'planszówki',
};
const ACT_VERB: Record<string, readonly string[]> = {
  fishing_spot: ['Łowię ryby na pomoście', 'Siedzę z wędką nad wodą', 'Moczę wędkę w jeziorze'],
  bookshelf: ['Czytam książkę', 'Zaczytuję się w książce', 'Siedzę z nosem w książce'],
  computer: ['Gram na komputerze', 'Siedzę przy komputerze'],
  piano: ['Gram na pianinie', 'Ćwiczę na pianinie'],
  exercise_bike: ['Kręcę na rowerku treningowym', 'Pedałuję na rowerku'],
  treadmill: ['Biegam na bieżni', 'Trenuję na bieżni'],
  tv: ['Oglądam telewizję', 'Siedzę przed telewizorem'],
  bench: ['Odpoczywam na ławce w ogrodzie', 'Wygrzewam się na ławce'],
  flowerbed: ['Pielęgnuję kwiaty w ogródku', 'Grzebię w grządce'],
  bathtub: ['Relaksuję się w wannie', 'Moczę się w wannie'],
  nap: ['Ucinam sobie drzemkę', 'Drzemię w ciągu dnia'],
  repair: ['Majstruję przy naprawie', 'Zajmuję się naprawą'],
  grill: ['Stoję przy grillu', 'Grilluję w ogrodzie'],
  stove: ['Gotuję', 'Pichcę coś w kuchni'],
  altana: ['Odpoczywam w altanie', 'Siedzę w altanie w ogrodzie'],
  warzywnik: ['Pielę warzywnik', 'Doglądam grządek w warzywniku'],
  console: ['Gram na konsoli', 'Siedzę z padem przed telewizorem'],
  board_game_table: ['Gram w planszówki', 'Siedzę nad planszą i kartami'],
};
const ACT_ICON: Record<string, string> = {
  fishing_spot: '🎣', bookshelf: '📖', computer: '🎮', piano: '🎹', exercise_bike: '🚴', treadmill: '🏃', tv: '📺', bench: '🪑',
  flowerbed: '🌷', bathtub: '🛁', nap: '💤', repair: '🔧', grill: '🌭', stove: '🍳', altana: '🛖', warzywnik: '🥕',
  console: '🎮', board_game_table: '🎲',
};
const EXERCISE = new Set(['exercise_bike', 'treadmill']);
const LOUNGE = new Set(['tv', 'bench', 'nap', 'altana']);
const QUIET = new Set(['bookshelf', 'fishing_spot', 'piano', 'flowerbed', 'computer', 'warzywnik']);
const HYGIENE = new Set(['bathtub', 'shower']);
const SUMMARY_SKIP = new Set(['toilet', 'sink', 'fridge', 'dining_table', 'stove', 'grill']);
const MEAL_ORDER: MealFact['kind'][] = ['śniadanie', 'obiad', 'kolacja', 'przekąska'];

/** "śniadanie", "obiad z grilla", "kolacja własnej roboty", "przekąska z lodówki" — one per kind */
function mealLabels(meals: readonly MealFact[]): string[] {
  const out: string[] = [];
  for (const kind of MEAL_ORDER) {
    const of = meals.filter((m) => m.kind === kind);
    if (!of.length) continue;
    if (kind === 'przekąska') out.push('przekąska z lodówki');
    else if (of.some((m) => m.where === 'grill')) out.push(`${kind} z grilla`);
    else if (of.some((m) => m.where === 'stove')) out.push(`${kind} własnej roboty`);
    else out.push(kind);
  }
  return out;
}

function duration(min: number): string {
  if (min < 40) return 'pół godziny';
  if (min < 75) return 'godzinę';
  if (min < 105) return 'półtorej godziny';
  if (min < 150) return 'dwie godziny';
  return 'ponad dwie godziny';
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
}

const NUM_FEM: Record<number, string> = { 1: 'jedna', 2: 'dwie', 3: 'trzy', 4: 'cztery', 5: 'pięć', 6: 'sześć' };

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} i ${items[items.length - 1]}`;
}

const GOAL_INF: Record<GoalKind, string> = {
  cook: 'ugotować coś dobrego', exercise: 'poćwiczyć', fish: 'złowić rybę', read: 'poczytać', piano: 'pograć na pianinie',
  computer: 'pograć na komputerze', friend: 'pogadać z bliską osobą', reconcile: 'pogodzić się', grill: 'zrobić grilla ze znajomymi',
  garden: 'zadbać o ogród', rest: 'odpocząć', meet: 'poznać kogoś lepiej', movies: 'maraton filmowy',
};
const GOAL_ICON: Record<GoalKind, string> = {
  cook: '🍳', exercise: '🏋️', fish: '🎣', read: '📖', piano: '🎹', computer: '🎮', friend: '🤗', reconcile: '🕊️', grill: '🌭',
  garden: '🌷', rest: '🛁', meet: '🤝', movies: '🍿',
};

// ---- text pools (present tense, no gendered forms, names only in the nominative)

const OPEN_DAY1: Pools = {
  pos: [
    'Pierwszy dzień w nowym domu — zaczynamy!', 'Nowy dom, nowi sąsiedzi. Ale przygoda!', 'Wprowadzka za mną, a ja już czuję się tu jak u siebie.',
    'Nowy początek w nowym miejscu — ciekawe, co przyniesie.', 'Zaczynam zapisywać wspomnienia od pierwszego dnia. Będzie się działo!',
  ],
  neu: [
    'Pierwszy dzień w tym domu.', 'Pierwszy dzień tutaj. Zapisuję, co się dzieje.', 'Wprowadzka za mną. Rozglądam się po okolicy.',
    'Nowe miejsce, trzeba się przyzwyczaić.', 'Zaczynam pamiętnik od pierwszego dnia w osiedlu.',
  ],
  neg: [
    'Pierwszy dzień tutaj. Zobaczymy, co z tego wyjdzie.', 'Nowe miejsce, nowe twarze. Na razie bez zachwytów.', 'Wprowadzka za mną. Wszystko jeszcze obce.',
    'Nowy dom — ale do wszystkiego trzeba się dopiero przyzwyczaić.', 'Pierwszy dzień na osiedlu. Bez fajerwerków.',
  ],
};
const OPEN_WAKE: Pools = {
  pos: ['Pobudka o {t} i od razu dobry humor.', 'Dzień dobry, świecie! Na nogach od {t}.', 'Wstaję o {t}, a za oknem nowy dzień do zagospodarowania.'],
  neu: ['Pobudka o {t}.', 'Wstaję o {t}.', 'Budzik niepotrzebny — oczy otwierają się o {t}.'],
  neg: ['Pobudka o {t}. Zdecydowanie za wcześnie.', 'Wstaję o {t} i już mi się nie chce.', 'O {t} koniec spania. Niestety.'],
};
const OPEN_LATE_LAZY = ['Wstaję dopiero o {t} — i dobrze, pośpiech to nie dla mnie.', 'Pobudka o {t}. Wcześniej nie ma sensu.'];
const OPEN_EARLY_ACTIVE = ['Na nogach już od {t}!', 'O {t} — pobudka i od razu do działania.'];
const OPEN_PLAIN: Pools = {
  pos: ['Kolejny dobry dzień za mną.', 'Dzień jak co dzień — czyli całkiem miło.'],
  neu: ['Kolejny dzień za mną.', 'Krótko, co dziś się dzieje.'],
  neg: ['Kolejny dzień za mną. Uff.', 'No dobrze, krótko o dzisiejszym dniu.'],
};

const SUMMARY_STYLES = ['{P}: {L}.', '{P} {L}.'];
const MEALS = ['Posiłki: {L}.', 'Jedzenie: {L}.', 'Menu dnia: {L}.'];

const HIGHLIGHT_COMMENT: Record<string, Pools> = {
  exercise_active: { pos: ['Ruch to zdrowie!', 'Czuję, że żyję!'], neu: ['Trzeba dbać o formę.'], neg: ['Przynajmniej forma rośnie.'] },
  exercise_lazy: { pos: ['Niespodzianka — nawet przyjemne.'], neu: ['Mięśnie protestują.'], neg: ['Ile można się męczyć…'] },
  lounge_lazy: { pos: ['Tak powinien wyglądać każdy dzień.', 'Leniuchowanie to sztuka.'], neu: ['Odpoczynek też jest ważny.'], neg: ['Przynajmniej tu nikt mi nie przeszkadza.'] },
  lounge_active: { pos: ['Jutro więcej ruchu!'], neu: ['Za długo w miejscu, jutro więcej ruchu.'], neg: ['Nuda. Jutro trzeba się ruszyć.'] },
  quiet_intro: { pos: ['Cisza i spokój — tego mi trzeba.', 'Nikt nie przeszkadza. Cudownie.'], neu: ['Cisza i spokój.'], neg: ['Wreszcie trochę spokoju.'] },
  quiet_extro: { pos: ['Fajnie, choć w towarzystwie byłoby jeszcze lepiej.'], neu: ['Trochę samotnie, ale dobrze.'], neg: ['W pojedynkę trochę nudno.'] },
  hygiene_neat: { pos: ['Czystość przede wszystkim!', 'Pachnę jak wiosenna łąka.'], neu: ['Czystość przede wszystkim.'], neg: ['Przynajmniej czysto.'] },
};

const TALK: Record<TalkOutcome, Pools> = {
  great: {
    pos: ['{N} i ja gadamy {about} i czas po prostu znika. 💞', 'Świetna rozmowa {about} — {N} i ja nadajemy na tych samych falach.', '{N} i ja: długa, serdeczna rozmowa {about}.'],
    neu: ['{N} i ja: długa, dobra rozmowa {about}.', 'Rozmowa {about} — {N} ma ciekawe zdanie na ten temat.'],
    neg: ['Nawet miła rozmowa {about}. {N} czasem ma rację.', '{N} i ja: rozmowa {about}. Muszę przyznać, że udana.'],
  },
  nice: {
    pos: ['{N} i ja: miła pogawędka {about}.', 'Sympatyczna rozmowa {about}. {N} umie słuchać.', 'Chwila rozmowy {about} — {N} poprawia mi humor.'],
    neu: ['{N} i ja: przyjemna rozmowa {about}.', 'Pogawędka {about}. {N} jest dziś w dobrej formie.'],
    neg: ['{N} i ja: rozmowa {about}. Całkiem znośna.', 'Pogawędka {about}. {N} nawet da się lubić.'],
  },
  plain: {
    pos: ['{N} i ja zamieniamy kilka zdań {about}.', 'Krótka pogawędka {about}. {N} jak zwykle w biegu.'],
    neu: ['{N}: kilka słów {about}, nic wielkiego.', 'Krótka rozmowa {about} — {N} i ja, nic specjalnego.'],
    neg: ['{N} zagaduje {about}. Kilka zdań i tyle.', 'Krótka rozmowa {about}. {N} mówi, ja słucham. Albo nie.'],
  },
  tense: {
    pos: ['{N} i ja: trochę zgrzytów w rozmowie {about}. Może niepotrzebnie się upieram.', 'Rozmowa {about} idzie jak po grudzie. Następnym razem więcej cierpliwości z mojej strony.'],
    neu: ['{N} i ja: napięta rozmowa {about}.'],
    neg: ['{N} i ja: napięta rozmowa {about}. Nie wszystko trzeba komentować.', 'Rozmowa {about} i znowu zgrzyt. {N} widzi wszystko po swojemu.'],
  },
  quarrel: {
    pos: ['{N} i ja kłócimy się {about}. 💢 Szkoda… chyba niepotrzebnie się unoszę.', 'Rozmowa {about} kończy się kłótnią. Teraz mi głupio — {N} nie zasługuje na takie słowa.', 'Sprzeczka {about} — {N} i ja nie możemy się dogadać. Jutro trzeba to jakoś naprawić.'],
    neu: ['Rozmowa {about} kończy się kłótnią. 💢 {N} i ja — każde ma swoje racje.'],
    neg: ['{N} znowu się czepia, tym razem {about}. 💢 Mam tego dość.', 'Kłótnia podczas rozmowy {about}. {N} nie słucha żadnych argumentów! 💢', '{N} i ja skaczemy sobie do oczu {about}. Nie moja wina.'],
  },
};

const REMOTE: Record<'blame' | 'regret', Record<'mine' | 'theirs', readonly string[]>> = {
  blame: {
    mine: ['{N} nie chce oddać pilota! 📺 Ktoś tu nie umie się dzielić.', 'Kłótnia o pilota. 📺 {N} zawsze chce oglądać co innego!'],
    theirs: ['{N} wyrywa mi pilota! 📺 Co za maniery.', 'Kłótnia o pilota. 📺 {N} rządzi telewizorem jak swoim.'],
  },
  regret: {
    mine: ['Domagam się pilota, a {N} się złości. 📺 Trochę głupio z mojej strony.', 'Kłótnia o pilota 📺 — po co mi to było? {N} pewnie się gniewa.'],
    theirs: ['{N} chce pilota, a ja nie ustępuję. 📺 Następnym razem po prostu ustąpię.', '{N} i ja kłócimy się o pilota. 📺 Przecież to tylko telewizor.'],
  },
};

const TALKS_MANY_EXTRO = ['Do tego jeszcze {n} — uwielbiam takie dni!', 'A to nie koniec: jeszcze {n}. Ludzie dają mi energię.'];
const TALKS_MANY_INTRO = ['Do tego jeszcze {n}. Aż za dużo ludzi jak na jeden dzień.', 'I jeszcze {n}. Potrzebuję ciszy.'];
const NO_TALKS_EXTRO = ['Dziś prawie żadnych rozmów. Brakuje mi ludzi.', 'Cisza w domu… Nikt nie ma czasu pogadać.'];
const NO_TALKS_INTRO = ['Cały dzień bez zbędnych rozmów. Idealnie.', 'Dzień w ciszy, bez gadania. Tak lubię najbardziej.'];

const REFUSED_BY: Record<'busy' | 'no', Pools> = {
  busy: {
    pos: ['{N} nie ma dziś dla mnie czasu. Nic to, może jutro.', '{N} w biegu, rozmowa musi poczekać. Trudno!'],
    neu: ['{N} nie ma czasu na rozmowę.', '{N} ma swoje sprawy, rozmowa musi poczekać.'],
    neg: ['{N} nie ma dla mnie czasu. Jak zawsze.', '{N} znowu nie ma czasu. Typowe.'],
  },
  no: {
    pos: ['{N} nie ma ochoty na rozmowę. 🙁 Trudno, każdy ma gorsze chwile.', '{N} nie chce gadać. 🙁 Może jutro będzie lepiej.'],
    neu: ['{N} nie ma ochoty na rozmowę. 🙁', '{N} nie chce dziś rozmawiać. 🙁'],
    neg: ['{N} nie ma ochoty na rozmowę. 🙁 No i dobrze.', '{N} odwraca się na pięcie. 🙁 Phi.'],
  },
};
const REFUSED_MANY: Pools = {
  pos: ['{N} nie mają dziś dla mnie czasu. Nic to, może jutro.'],
  neu: ['{N} nie mają dziś czasu na rozmowę.'],
  neg: ['{N} nie mają dla mnie czasu. Jak zawsze.'],
};
const REFUSED = ['{N} chce pogadać, ale akurat nie mam głowy do rozmów.', '{N} zagaduje w złym momencie — muszę odmówić.'];

const GATHER: Record<'meal' | 'grill' | 'movie', Pools> = {
  meal: {
    pos: ['{L}: {W} i ja. 🍽️ Uwielbiam takie chwile.', '{L} w dobrym gronie: {W} i ja. 🍽️', '{L}: {W} i ja przy jednym stole. 🍽️ Śmiechu co niemiara.'],
    neu: ['{L}: {W} i ja. 🍽️', '{L} przy wspólnym stole: {W} i ja. 🍽️'],
    neg: ['{L}: {W} i ja. 🍽️ Jedzenie takie sobie, ale przynajmniej jest z kim pogadać.', '{L}: {W} i ja. 🍽️ Ktoś znowu zjada najlepsze kawałki.'],
  },
  grill: {
    pos: ['Grill w ogrodzie: {W} i ja. 🌭 Pachnie wakacjami!', 'Wspólne grillowanie: {W} i ja. 🌭 Kiełbaski palce lizać!'],
    neu: ['Wspólny grill: {W} i ja. 🌭', 'Grill w ogrodzie: {W} i ja. 🌭'],
    neg: ['Grill w ogrodzie: {W} i ja. 🌭 Dym w oczy, ale niech będzie.', 'Wspólny grill: {W} i ja. 🌭 Kiełbaski jak zwykle przypalone.'],
  },
  movie: {
    pos: ['{L}: {W} i ja przed telewizorem. 🍿 Świetna zabawa!', '{L}: {W} i ja, popcorn i kanapa. 🍿'],
    neu: ['{L}: {W} i ja przed telewizorem. 🍿'],
    neg: ['{L}: {W} i ja przed telewizorem. 🍿 Film taki sobie.', '{L}: {W} i ja. 🍿 Ktoś ciągle gada w trakcie filmu.'],
  },
};
/** introverts at a gathering */
const GATHER_INTRO: Pools = {
  pos: ['{L}: {W} i ja. Trochę tłoczno, ale miło.'],
  neu: ['{L}: {W} i ja. Tłoczno, ale da się wytrzymać.', '{L}: {W} i ja. Dużo gadania jak na mój gust.'],
  neg: ['{L}: {W} i ja. Tłoczno i głośno.', '{L}: {W} i ja. Najchętniej w ciszy, ale cóż.'],
};

const HEARD: Record<'good' | 'bad' | 'meh', Pools> = {
  good: {
    pos: ['{F} mówi, że {G}. Brawo!', 'Nowina od: {F} — {G}. Super!', '{F} opowiada, że {G}. Jak miło!'],
    neu: ['{F} mówi, że {G}.', 'Nowina od: {F} — {G}.'],
    neg: ['{F} mówi, że {G}. Phi, wielkie mi co.', '{F} opowiada, że {G}. No i co z tego?'],
  },
  bad: {
    pos: ['{F} mówi, że {G}. Ojej, każdemu się zdarza.', '{F} opowiada, że {G}. Szkoda.'],
    neu: ['{F} mówi, że {G}. No proszę.', 'Plotka od: {F} — {G}.'],
    neg: ['{F} mówi, że {G}. Wcale mnie to nie dziwi.', '{F} opowiada, że {G}. Typowe.'],
  },
  meh: {
    pos: ['{F} mówi, że {G}. Ciekawe!', 'Nowina od: {F} — {G}.'],
    neu: ['{F} mówi, że {G}.'],
    neg: ['{F} opowiada, że {G}. I co z tego?', '{F} mówi, że {G}. Też mi nowina.'],
  },
};
const TOLD = ['{T} słyszy ode mnie, że {G}.', 'Opowiadam nowinę: {G}. {T} słucha z zaciekawieniem.'];

const RELATION: Record<RelationChange, readonly string[]> = {
  couple: ['{N} i ja jesteśmy parą! 💕 Nie mogę przestać się uśmiechać.', 'To już oficjalne: {N} i ja — para. 💕'],
  crush: ['{N}… chyba coś zaczyna iskrzyć. 😊', 'Ciągle myślę o tym, jak się śmieje {N}. 😊'],
  breakup: ['{N} i ja — koniec. 💔 Smutno.', 'Rozstanie. 💔 {N} i ja idziemy każde w swoją stronę.'],
  rivals: ['{N} i ja to teraz rywale. ⚡ Zobaczymy, kto górą.', '{N} i ja — rywalizacja na całego. ⚡'],
  enemies: ['{N}… nie mogę tej osoby znieść. 💢', '{N} i ja — wojna. 💢'],
  best_friends: ['{N} to teraz najbliższa mi osoba w domu. 🌟', 'Przyjaźń na całego: {N} i ja. 🌟'],
  friends: ['{N} i ja coraz lepiej się dogadujemy. 🤝', 'Chyba mogę to powiedzieć: {N} i ja się przyjaźnimy. 🤝'],
  peace: ['{N} i ja zakopujemy topór wojenny. 🕊️', 'Zgoda! {N} i ja podajemy sobie ręce. 🕊️'],
};

const GOAL_DONE: Pools = {
  pos: ['Plan na dziś: {g}. Zrobione! ✔️', 'Cel dnia — {g} — zaliczony! ✔️', 'Plan na dziś: {g}. Jest! Mały sukces. ✔️'],
  neu: ['Plan na dziś: {g}. Zrobione. ✔️', 'Cel dnia: {g}. Zaliczony. ✔️'],
  neg: ['Plan na dziś: {g}. Nawet się udaje. ✔️', 'Cel dnia: {g}. Odhaczone. ✔️'],
};
const GOAL_FAILED: Pools = {
  pos: ['Plan na dziś: {g}. Nie wychodzi, ale jutro też jest dzień.', 'Plan na dziś: {g}. Tym razem nic z tego — trudno!'],
  neu: ['Plan na dziś: {g}. Nie wychodzi.', 'Miało być: {g}. Może jutro.'],
  neg: ['Plan na dziś: {g}. Oczywiście nic z tego.', 'Miało być: {g}. Nie wyszło. Jak zwykle.'],
};
const GOAL_PARTNER: Record<'friend' | 'reconcile' | 'meet', { done: readonly string[]; failed: readonly string[] }> = {
  friend: {
    done: ['Plan na dziś: czas z bliską osobą. {N} i ja wreszcie mamy chwilę dla siebie. ✔️', 'Plan na dziś: rozmowa od serca. {N} i ja — zaliczone! ✔️'],
    failed: ['Plan na dziś: pogadać od serca, ale {N} nie ma czasu.', 'Plan na dziś: rozmowa z bliską osobą. {N} cały dzień w biegu… może jutro.'],
  },
  reconcile: {
    done: ['Plan na dziś: pogodzić się. {N} i ja rozmawiamy na zgodę. 🕊️', 'Plan na dziś: zgoda. {N} i ja — udaje się! 🕊️'],
    failed: ['Plan na dziś: pogodzić się. {N} jednak nie daje szansy.', 'Plan na dziś: pogodzić się. Może jutro starczy mi odwagi.'],
  },
  meet: {
    done: ['Plan na dziś: poznać kogoś lepiej. {N} — ciekawa osoba! ✔️', 'Plan na dziś: nowa znajomość. {N} i ja — dobra rozmowa. ✔️'],
    failed: ['Plan na dziś: poznać kogoś lepiej. Nie tym razem.', 'Plan na dziś: nowa znajomość. Nic z tego, może jutro.'],
  },
};

// building projects (world/projects): {A} accusative, {G} genitive, {L} locative, {D} duration, {W} co-workers
const PROJECT_PROPOSE: Pools = {
  pos: ['Proponuję wszystkim: budujemy razem {A}! Już nie mogę się doczekać.', 'Rzucam hasło: wspólnie budujemy {A}. Będzie pięknie!'],
  neu: ['Proponuję wspólną budowę. Cel: {N} w ogrodzie. Zobaczymy, kto pomoże.', 'Pora na coś nowego — proponuję, by razem zrobić {A}.'],
  neg: ['Proponuję, by razem zrobić {A}. Ciekawe, czy ktoś w ogóle ruszy palcem.'],
};
const PROJECT_WORK_WITH = [
  'Pracuję przy {L} — {D}, razem z: {W}.',
  '{D} przy budowie {G}. Ekipa dnia: {W} i ja.',
  'Budowa {G} idzie do przodu: {D} pracy, a obok mnie {W}.',
];
const PROJECT_WORK_ALONE: Pools = {
  pos: ['Pracuję przy {L} — {D}, tym razem w pojedynkę. To też daje radość.', '{D} przy budowie {G}: tylko ja, deski i gwoździe.'],
  neu: ['Pracuję przy {L} — {D}, bez towarzystwa.', '{D} przy budowie {G}, w pojedynkę.'],
  neg: ['Pracuję przy {L} — {D}, i to w pojedynkę. Gdzie reszta?', '{D} przy budowie {G}. Cała robota na mojej głowie, nikt nie pomaga.'],
};
const PROJECT_STAGE = ['Kończymy etap: {S}! Coraz bliżej celu 💪', 'Etap „{S}” za nami. Widać postęp!', 'Następny etap: {S} — zrobione!'];
const PROJECT_DONE = [
  '{N} gotowa! Ekipa: {C}. Co za radość 🎉',
  'Udało się — {n} stoi gotowa! Ekipa: {C}. Świętujemy 🎉',
];
const PROJECT_DONE_M = ['{N} gotowy! Ekipa: {C}. Co za radość 🎉', 'Udało się — {n} gotowy! Ekipa: {C}. Świętujemy 🎉'];

const NEWS = ['W telewizji: „{H}”.', 'W telewizji mówią: „{H}”.', 'Z wiadomości: „{H}”.'];

const BROKE: Pools = {
  pos: ['Psuję {A}. 🔧 Ups… zdarza się.', 'Trach! Psuję {A}. 🔧 Na szczęście da się naprawić.'],
  neu: ['Psuję {A}. 🔧 Wstyd.', 'Psuję {A}. 🔧 Głupia sprawa.'],
  neg: ['Psuję {A}. 🔧 Naprawdę nie moja wina!', 'Psuję {A}. 🔧 Ten sprzęt to i tak złom.'],
};
const FIXED: Pools = {
  pos: ['Naprawiam {A}! 🔧 Działa jak nowe — satysfakcja gwarantowana.', 'Złota rączka w akcji: naprawiam {A}! 🔧', 'Naprawiam {A}. 🔧 Duma rozpiera!'],
  neu: ['Naprawiam {A}. 🔧 Działa.', 'Naprawiam {A}. 🔧 Gotowe.'],
  neg: ['Naprawiam {A}. 🔧 Ktoś musi.', 'Naprawiam {A}. 🔧 Jak zwykle wszystko na mojej głowie.'],
};

const WEATHER_TEXT: Record<'rain' | 'storm' | 'sunny' | 'cloudy', Pools> = {
  storm: {
    pos: ['Burza! ⛈️ Grzmi tak, że szyby drżą — ale w domu przytulnie.', 'Burza za oknem ⛈️, a w środku herbata i koc.'],
    neu: ['Burza. ⛈️ Grzmi tak, że szyby drżą.', 'Burza ⛈️ — błyska i grzmi.'],
    neg: ['Burza. ⛈️ Jeszcze tego brakowało.', 'Burza ⛈️ i od razu humor siada.'],
  },
  rain: {
    pos: ['Pada, ale w domu przytulnie. 🌧️', 'Deszcz bębni o parapet 🌧️ — lubię ten dźwięk.'],
    neu: ['Za oknem deszcz. 🌧️', 'Trochę pada. 🌧️'],
    neg: ['Znowu pada. 🌧️ Szaro i ponuro.', 'Deszcz. 🌧️ Ogród odpada.', 'Leje. 🌧️ Typowe.'],
  },
  sunny: {
    pos: ['Słońce przez cały dzień. ☀️', 'Piękna pogoda! ☀️', 'Słońce od rana do wieczora. ☀️ Aż chce się żyć.'],
    neu: ['Słonecznie. ☀️', 'Pogoda dopisuje. ☀️'],
    neg: ['Słońce świeci, a mnie i tak nic się nie chce.', 'Słońce praży. ☀️ Za gorąco.'],
  },
  cloudy: { pos: ['Pochmurno, ale ciepło. ☁️', 'Chmury, ale bez deszczu. ☁️'], neu: ['Pochmurno. ☁️', 'Niebo zachmurzone. ☁️'], neg: ['Szaro i pochmurno. ☁️', 'Szaro. ☁️ Jak zawsze.'] },
};

const NEED_TEXT: Partial<Record<NeedKey, readonly string[]>> = {
  hunger: ['W pewnym momencie burczy mi w brzuchu na cały dom.', 'Chwilami głód nie do wytrzymania.'],
  energy: ['Chwilami ledwo trzymam się na nogach.', 'Zmęczenie daje się dziś we znaki.'],
  social: ['Chwilami czuję się bardzo samotnie.', 'Chwilami brakuje mi towarzystwa.'],
  hygiene: ['Prysznic dziś zdecydowanie za późno.'],
};

const ARC = {
  rescue: ['{P} dołek, ale wieczór ratuje sytuację.', 'Bywa różnie: {p} kiepsko, wieczorem już dobrze.'],
  fall: ['Dzień zaczyna się świetnie, a kończy… różnie.', 'Rano wszystko gra, wieczorem już nie bardzo.'],
  rise: ['Słaby start, za to jaki finisz!', 'Rano kiepsko, ale z każdą godziną lepiej.'],
};

const FEEL: Record<'love' | 'crush' | 'like' | 'dislike', readonly string[]> = {
  love: ['{N} — myślę o tej osobie przed snem. 💕', 'Dobrze, że jest {N}. 💕'],
  crush: ['{N}… chyba coś do tej osoby czuję. 😊', 'Nie mogę przestać myśleć: {N}. 😊'],
  like: ['{N} to naprawdę fajna osoba.', 'Dobrze mieć kogoś takiego jak {N}.', '{N} ma w sobie coś, co lubię.'],
  dislike: ['{N} działa mi na nerwy.', '{N}… szkoda gadać.'],
};

const LATE = ['Późno już, a sen nie przychodzi.', 'Prawie północ, a tu jeszcze tyle myśli w głowie.'];

const CLOSE: Record<'great' | 'ok' | 'meh' | 'bad', Pools> = {
  great: {
    pos: ['Co za dzień! ☀️', 'Idę spać z uśmiechem. 😊', 'Oby jutro było tak samo!', 'Dzień jak marzenie. ✨'],
    neu: ['Bardzo dobry dzień. Dobranoc!', 'Tak może być codziennie.'],
    neg: ['Nawet nie najgorzej. Niespodzianka!', 'Dziś — wyjątkowo — nie ma na co narzekać.'],
  },
  ok: {
    pos: ['Całkiem dobry dzień. Dobranoc!', 'Jutro też będzie fajnie.', 'Dobranoc, pamiętniku!'],
    neu: ['Zwyczajny dzień. Dobranoc.', 'Tyle na dziś.', 'Dobranoc, pamiętniku.'],
    neg: ['Ujdzie.', 'Mogło być gorzej. Dobranoc.', 'Tyle. Idę spać.'],
  },
  meh: {
    pos: ['Jutro będzie lepiej!', 'Nie wszystko wychodzi, ale jutro nowy dzień.'],
    neu: ['Taki sobie dzień. Jutro będzie lepiej…', 'Średnio. Dobranoc.'],
    neg: ['Taki sobie dzień. Byle do jutra.', 'Szkoda gadać. Dobranoc.'],
  },
  bad: {
    pos: ['Ciężki dzień… Jutro będzie lepiej.', 'Trzeba się wyspać i zacząć od nowa.'],
    neu: ['Ciężki dzień. Byle do jutra.', 'Nie najlepiej. Dobranoc.'],
    neg: ['Fatalny dzień. Nic, tylko spać.', 'Dno. Jutro pewnie to samo.'],
  },
};

const FILLERS: Record<string, readonly string[]> = {
  extro: ['Uwielbiam, kiedy w domu coś się dzieje.', 'Ludzie dają mi energię.'],
  intro: ['Najlepiej odpoczywam w ciszy.', 'Czasem wystarczy mi własne towarzystwo.'],
  active: ['Trzeba się ruszać, inaczej rdzewieję.', 'Nie umiem usiedzieć w miejscu.'],
  lazy: ['Nie ma to jak kanapa.', 'Pośpiech to nie dla mnie.'],
  neat: ['Lubię, kiedy wszystko jest na swoim miejscu.', 'Jutro chcę zrobić porządek w szafie.'],
  messy: ['Porządki? Może kiedyś.', 'Bałagan to mój styl.'],
  cheer: ['Małe rzeczy cieszą najbardziej.', 'Lubię to miejsce.'],
  grump: ['Nie rozumiem, czemu wszyscy tu tacy radośni.', 'Kubki w kuchni same się nie umyją.'],
  plain: ['Zwykły dzień, a jednak coś się dzieje.', 'Dobrze mieć gdzie zapisać myśli.'],
};

export const DIARY_MIN_WORDS = 60;
export const DIARY_MAX_WORDS = 140;

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []).length;
}

class Writer {
  readonly used: string[] = [];
  constructor(
    private readonly rng: Rng,
    private readonly recent: readonly string[],
    readonly tone: Tone,
  ) {}

  /** picks a template, avoiding the ones used recently (yesterday's sentences) */
  pick(pool: readonly string[]): string {
    const fresh = pool.filter((p) => !this.recent.includes(p) && !this.used.includes(p));
    const list = fresh.length ? fresh : pool;
    const p = list[Math.floor(this.rng.next() * list.length)];
    this.used.push(p);
    return p;
  }

  /** template for the writer's tone (falls back to neutral) */
  toned(pools: Pools, tone: Tone = this.tone): string {
    return this.pick(pools[tone] ?? pools.neu ?? pools.pos ?? pools.neg ?? ['']);
  }

  chance(p: number): boolean {
    return this.rng.next() < p;
  }
}

function toneOf(p: DiaryPersona): Tone {
  const v = p.traits.cheerfulness + (p.mood - 55) / 60;
  if (v > 0.2) return 'pos';
  if (v < -0.2) return 'neg';
  return 'neu';
}

const TALK_RANK: Record<TalkOutcome, number> = { quarrel: 5, great: 4, tense: 3, nice: 2, plain: 1 };

/** pure: the entry text and tags for a day's facts (deterministic for a given seed and history) */
export function composeDiary(
  facts: DiaryFacts,
  persona: DiaryPersona,
  seed: number,
  recent: readonly string[] = [],
  avoidOpeners: readonly string[] = [],
): { text: string; tags: string[] } {
  const { text, tags } = composeDiaryInternal(facts, persona, seed, recent, avoidOpeners);
  return { text, tags };
}

function composeDiaryInternal(
  facts: DiaryFacts,
  persona: DiaryPersona,
  seed: number,
  recent: readonly string[],
  avoidOpeners: readonly string[],
): { text: string; tags: string[]; used: string[]; opener: string } {
  const w = new Writer(createRng(seed), recent, toneOf(persona));
  const t = persona.traits;
  const out: Sentence[] = [];
  const add = (para: Sentence['para'], prio: number, text: string): void => {
    if (text) out.push({ para, prio, text: cap(text.trim()) });
  };
  const tags: string[] = [];
  const tag = (x: string | undefined): void => {
    if (x && !tags.includes(x)) tags.push(x);
  };

  // --- paragraph 0: morning, activities, meals, moments, weather
  const opening = (tone: Tone): string => {
    if (facts.day === 1 && !facts.wake) return w.toned(OPEN_DAY1, tone);
    if (!facts.wake) return w.toned(OPEN_PLAIN, tone);
    const h = Number(facts.wake.slice(0, 2));
    let tpl: string;
    if (t.activity <= -0.35 && h >= 7) tpl = w.pick(OPEN_LATE_LAZY);
    else if (t.activity >= 0.35 && h < 7 && w.tone !== 'neg') tpl = w.pick(OPEN_EARLY_ACTIVE);
    else tpl = w.toned(OPEN_WAKE, tone);
    return fill(tpl, { t: facts.wake });
  };
  // the first sentence differs from the other residents' openers of the same day (when the pools allow it)
  const tones: Tone[] = [w.tone, ...(['pos', 'neu', 'neg'] as const).filter((x) => x !== w.tone)];
  let opener = '';
  const usedBefore = w.used.length;
  for (let i = 0; i < 9; i++) {
    opener = cap(opening(tones[Math.floor(i / 3)]).trim());
    if (!avoidOpeners.includes(firstSentence(opener))) break;
  }
  // only the template that was kept counts as used
  w.used.splice(usedBefore, Math.max(0, w.used.length - usedBefore - 1));
  add(0, 100, opener);

  const parts: DayPart[] = ['rano', 'w południe', 'po południu', 'wieczorem'];
  // one mention per activity: the same thing in several parts of the day merges ("Rano i po południu: kąpiel w wannie")
  const byType = new Map<string, { type: string; minutes: number; times: number; parts: DayPart[] }>();
  for (const a of facts.activities) {
    const x = byType.get(a.type);
    if (!x) byType.set(a.type, { type: a.type, minutes: a.minutes, times: a.times, parts: [a.part] });
    else {
      x.minutes += a.minutes;
      x.times += a.times;
      if (!x.parts.includes(a.part)) x.parts.push(a.part);
    }
  }
  const main = [...byType.values()]
    .filter((a) => ACT_VERB[a.type] && a.minutes >= 30 && a.type !== 'repair')
    .sort((x, y) => y.minutes - x.minutes)[0];
  const style = w.pick(SUMMARY_STYLES);
  const groups = new Map<string, { parts: DayPart[]; nouns: string[] }>();
  for (const a of byType.values()) {
    const n = ACT_NOUN[a.type];
    if (!n || SUMMARY_SKIP.has(a.type) || a === main) continue;
    const key = a.parts.join('|');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { parts: a.parts, nouns: [] }));
    g.nouns.push(a.parts.length === 1 && a.times > 1 && a.type !== 'shower' ? `${n} (${a.times} razy)` : n);
  }
  for (const g of [...groups.values()].sort((x, y) => parts.indexOf(x.parts[0]) - parts.indexOf(y.parts[0]))) {
    const items = g.nouns.slice(0, 3);
    const list = style.startsWith('{P}:') || items.length === 1 ? joinList(items) : `${items.slice(0, -1).join(', ')}, potem ${items[items.length - 1]}`;
    add(0, 76 - parts.indexOf(g.parts[0]), fill(style, { P: cap(joinList(g.parts)), L: list }));
  }
  const meals = mealLabels(facts.meals);
  if (meals.length) add(0, 50, fill(w.pick(MEALS), { L: joinList(meals) }));

  if (main) {
    add(0, 77, `${w.pick(ACT_VERB[main.type])} przez ${duration(main.minutes)}.`);
    tag(ACT_ICON[main.type]);
    let key = '';
    if (EXERCISE.has(main.type)) key = t.activity >= 0 ? 'exercise_active' : 'exercise_lazy';
    else if (LOUNGE.has(main.type)) key = t.activity < -0.2 ? 'lounge_lazy' : t.activity > 0.35 ? 'lounge_active' : '';
    else if (QUIET.has(main.type)) key = t.sociability < -0.2 ? 'quiet_intro' : t.sociability > 0.35 ? 'quiet_extro' : '';
    else if (HYGIENE.has(main.type) && t.neatness > 0.35) key = 'hygiene_neat';
    if (key) add(0, 35, w.toned(HIGHLIGHT_COMMENT[key]));
  }
  for (const m of facts.moments.slice(0, 2)) add(0, 70, m);
  for (const p of facts.projects ?? []) {
    const vars = { A: p.accusative, G: p.genitive, L: p.locative, N: cap(p.name), n: p.name };
    if (p.proposed) add(0, 80, fill(w.toned(PROJECT_PROPOSE), vars));
    if (p.minutes >= 15) {
      const tpl = p.with.length ? w.pick(PROJECT_WORK_WITH) : w.toned(PROJECT_WORK_ALONE);
      add(0, 74, fill(tpl, { ...vars, D: duration(p.minutes), W: joinList(p.with.slice(0, 3)) }));
    }
    const st = p.stages[p.stages.length - 1];
    if (st && !p.finished) add(0, 78, fill(w.pick(PROJECT_STAGE), { S: st }));
    if (p.finished) {
      const crew = p.crew.map((c) => (c === facts.name ? 'ja' : c));
      // "ja" last: "Ola, Bartek i ja"
      const ordered = [...crew.filter((c) => c !== 'ja'), ...crew.filter((c) => c === 'ja')];
      const pool = p.kindId === 'altana' ? PROJECT_DONE : PROJECT_DONE_M;
      add(0, 92, fill(w.pick(pool), { ...vars, C: joinList(ordered) }));
    }
    if (p.proposed || p.minutes >= 15 || p.finished) tag(p.finished ? '🎉' : '🔨');
  }
  if (facts.moments.some((m) => m.includes('🐟'))) tag('🐟');

  const wx = facts.weather;
  const wk = wx.includes('storm') ? 'storm' : wx.includes('rain') ? 'rain' : wx.length === 1 && wx[0] === 'sunny' ? 'sunny' : wx.length ? 'cloudy' : null;
  if (wk && (wk !== 'cloudy' || w.chance(0.5))) {
    add(0, wk === 'storm' || wk === 'rain' ? 45 : 30, w.toned(WEATHER_TEXT[wk]));
    tag(wk === 'storm' ? '⛈️' : wk === 'rain' ? '🌧️' : wk === 'sunny' ? '☀️' : undefined);
  }

  // --- paragraph 1: people
  const extro = t.sociability > 0.3;
  const intro = t.sociability < -0.3;
  const byPerson = new Map<string, TalkFact>();
  for (const x of facts.talks) {
    const prev = byPerson.get(x.with);
    if (!prev || TALK_RANK[x.outcome] > TALK_RANK[prev.outcome]) byPerson.set(x.with, x);
  }
  const talks = [...byPerson.values()].sort((a, b) => TALK_RANK[b.outcome] - TALK_RANK[a.outcome]);
  const maxTalks = extro ? 4 : intro ? 2 : 3;
  talks.slice(0, maxTalks).forEach((x, i) => {
    let tone: Tone = w.tone;
    if (x.outcome === 'quarrel' || x.outcome === 'tense') {
      // subjectivity: the same quarrel is the other one's fault (grump / dislike) or a regret (cheerful / fond)
      const fond = x.sympathy + 40 * t.cheerfulness;
      tone = fond > 5 ? 'pos' : fond < -5 ? 'neg' : 'neu';
    }
    const about = x.topic ? topicAbout(x.topic) : '';
    const text = fill(w.toned(TALK[x.outcome], tone), { N: x.with, about }).replace(/\s+([.,:!])/g, '$1').replace(/\s{2,}/g, ' ');
    add(1, (x.outcome === 'quarrel' ? 82 : x.outcome === 'great' ? 72 : 62) - i * 3 + (extro ? 4 : 0), text);
  });
  if (talks.length) tag(talks[0].outcome === 'quarrel' ? '💢' : '💬');
  const rest = talks.length - maxTalks;
  if (rest > 0 && (extro || intro)) {
    const n = `${NUM_FEM[rest] ?? rest} ${plural(rest, 'rozmowa', 'rozmowy', 'rozmów')}`;
    add(1, 40, fill(w.pick(extro ? TALKS_MANY_EXTRO : TALKS_MANY_INTRO), { n }));
  }
  if (!talks.length && !facts.gatherings.length && (extro || intro)) add(1, 50, w.pick(extro ? NO_TALKS_EXTRO : NO_TALKS_INTRO));

  for (const r of facts.remote.slice(0, 1)) {
    const fond = (facts.feelings.find((f) => f.with === r.with)?.sympathy ?? 0) + 40 * t.cheerfulness;
    add(1, 74, fill(w.pick(REMOTE[fond > 0 ? 'regret' : 'blame'][r.mine ? 'mine' : 'theirs']), { N: r.with }));
    tag('📺');
  }
  const refusers = [...new Set(facts.refusedBy.map((r) => r.name))];
  if (refusers.length > 1) add(1, 46, fill(w.toned(REFUSED_MANY), { N: joinList(refusers.slice(0, 3)) }));
  else if (refusers.length === 1) add(1, 46, fill(w.toned(REFUSED_BY[facts.refusedBy[0].busy ? 'busy' : 'no']), { N: refusers[0] }));
  for (const name of facts.refused.slice(0, 1)) add(1, 42, fill(w.pick(REFUSED), { N: name }));
  // gatherings of the same kind merge ("Wspólny grill: Ola, Kuba, Ewa i ja")
  const gatherings: { kind: 'meal' | 'grill' | 'movie'; label: string; with: string[] }[] = [];
  for (const g of facts.gatherings) {
    if (!g.with.length) continue;
    const same = gatherings.find((x) => x.kind === g.kind && (g.kind !== 'meal' || x.label === g.label));
    if (same) for (const n of g.with) if (!same.with.includes(n)) same.with.push(n);
    if (!same) gatherings.push({ kind: g.kind, label: g.label, with: [...g.with] });
  }
  for (const g of gatherings.slice(0, 2)) {
    const pools = intro ? GATHER_INTRO : GATHER[g.kind];
    add(1, 58 + (extro ? 6 : 0), fill(w.toned(pools), { L: g.label, W: g.with.join(', ') }));
    tag(g.kind === 'grill' ? '🌭' : g.kind === 'movie' ? '🍿' : '🍽️');
  }
  for (const h of facts.heard.slice(0, extro ? 2 : 1)) {
    if (!h.from) continue;
    const kind = h.valence > 0.15 ? 'good' : h.valence < -0.15 ? 'bad' : 'meh';
    add(1, 50, fill(w.toned(HEARD[kind]), { F: h.from, G: h.text }));
    tag('🗣️');
  }
  for (const x of facts.told.slice(0, 1)) add(1, 40, fill(w.pick(TOLD), { T: x.to, G: x.text }));
  const lastChange = new Map(facts.relations.map((r) => [r.with, r] as const));
  for (const r of lastChange.values()) {
    add(1, 88, fill(w.pick(RELATION[r.change]), { N: r.with }));
    tag(({ couple: '💕', crush: '😊', breakup: '💔', rivals: '⚡', enemies: '💢', best_friends: '🌟', friends: '🤝', peace: '🕊️' } as const)[r.change]);
  }

  // --- paragraph 2: goal, news, breakdowns, needs
  const g = facts.goal;
  if (g) {
    if ((g.kind === 'friend' || g.kind === 'reconcile' || g.kind === 'meet') && g.partner) {
      const pool = GOAL_PARTNER[g.kind][g.done ? 'done' : 'failed'];
      add(2, 80, fill(w.pick(pool), { N: g.partner }));
    } else {
      add(2, 80, fill(w.toned(g.done ? GOAL_DONE : GOAL_FAILED), { g: GOAL_INF[g.kind] }));
    }
    if (g.done) tag(GOAL_ICON[g.kind]);
  }
  if (facts.news.length) {
    add(2, 55, fill(w.pick(NEWS), { H: facts.news[0] }));
    tag('📰');
  }
  for (const a of facts.broke.slice(0, 1)) add(2, 66, fill(w.toned(BROKE), { A: a }));
  for (const a of facts.fixed.slice(0, 1)) add(2, 68, fill(w.toned(FIXED), { A: a }));
  if (facts.broke.length || facts.fixed.length) tag('🔧');
  for (const k of facts.lowNeeds.slice(0, 2)) {
    const pool = NEED_TEXT[k];
    if (pool) add(2, 44, w.pick(pool));
  }

  // --- paragraph 3: mood, feelings, closing
  const m = facts.mood;
  const partWord = m.minPart === 'rano' ? 'Rano' : m.minPart === 'w południe' ? 'W południe' : m.minPart === 'po południu' ? 'Po południu' : 'Wieczorem';
  if (m.min < 35 && m.end >= 55) add(3, 60, fill(w.pick(ARC.rescue), { P: partWord, p: partWord.toLowerCase() }));
  else if (m.start >= 70 && m.end < 45) add(3, 60, w.pick(ARC.fall));
  else if (m.start < 45 && m.end >= 70) add(3, 60, w.pick(ARC.rise));
  const f = facts.feelings.find((x) => !facts.relations.some((r) => r.with === x.with));
  if (f) {
    const kind =
      f.status === 'couple' ? 'love' : f.status === 'crush' ? 'crush' : f.status === 'rivals' || f.status === 'enemies' || f.sympathy <= -25 ? 'dislike' : f.sympathy >= 40 ? 'like' : null;
    if (kind) add(3, 32, fill(w.pick(FEEL[kind]), { N: f.with }));
  }
  if (facts.late) add(3, 34, w.pick(LATE));
  const band = m.end >= 75 ? 'great' : m.end >= 55 ? 'ok' : m.end >= 35 ? 'meh' : 'bad';
  // grumps stay grumpy on good days, optimists stay hopeful on bad ones
  const closeTone: Tone = t.cheerfulness > 0.35 ? 'pos' : t.cheerfulness < -0.35 ? 'neg' : w.tone;
  add(3, 100, w.toned(CLOSE[band], closeTone));
  if (m.end >= 80 && tags.length < 5) tag('☀️');

  // --- fit 60..140 words: drop the least important sentences, pad with personality thoughts
  const total = (): number => out.reduce((n, s) => n + wordCount(s.text), 0);
  while (total() > DIARY_MAX_WORDS) {
    let lo = -1;
    for (let i = 0; i < out.length; i++) if (out[i].prio < 100 && (lo < 0 || out[i].prio < out[lo].prio)) lo = i;
    if (lo < 0) break;
    out.splice(lo, 1);
  }
  const fillerKeys: string[] = [];
  if (t.sociability > 0.3) fillerKeys.push('extro');
  if (t.sociability < -0.3) fillerKeys.push('intro');
  if (t.activity > 0.3) fillerKeys.push('active');
  if (t.activity < -0.3) fillerKeys.push('lazy');
  if (t.neatness > 0.3) fillerKeys.push('neat');
  if (t.neatness < -0.3) fillerKeys.push('messy');
  if (t.cheerfulness > 0.3) fillerKeys.push('cheer');
  if (t.cheerfulness < -0.3) fillerKeys.push('grump');
  fillerKeys.push('plain');
  const pool = fillerKeys.flatMap((k) => FILLERS[k]);
  for (let guard = 0; total() < DIARY_MIN_WORDS && guard < 8; guard++) {
    const free = pool.filter((p) => !out.some((s) => s.text === p));
    if (!free.length) break;
    const text = w.pick(free);
    const para = (guard % 2 === 0 ? 2 : 1) as Sentence['para'];
    add(para, 10, text);
  }

  const paras: string[] = [];
  for (const p of [0, 1, 2, 3] as const) {
    const s = out.filter((x) => x.para === p).map((x) => x.text);
    if (s.length) paras.push(s.join(' '));
  }
  // short middle paragraphs merge (2–4 paragraphs, none of a single short sentence in the middle)
  while (paras.length > 2) {
    const i = paras.findIndex((p, k) => k > 0 && k < paras.length - 1 && wordCount(p) < 9);
    if (i < 0) break;
    paras[i - 1] = `${paras[i - 1]} ${paras[i]}`;
    paras.splice(i, 1);
  }
  return { text: paras.join('\n\n'), tags: tags.slice(0, 5), used: w.used, opener: firstSentence(opener) };
}

// ---------------------------------------------------------------- AI rewrite

export interface DiaryAiOptions extends DiaryAiClientOptions {
  /** pause between two diary requests (ms, default 4000): entries are not urgent */
  spacingMs?: number;
  /** injectable clock (cooldowns) */
  now?: () => number;
  /** custom client (tests) */
  client?: DiaryAiClient;
}

/** facts as short Polish lines for the model (no gendered forms needed) */
export function diaryFactLines(f: DiaryFacts): string[] {
  const out: string[] = [];
  if (f.wake) out.push(`pobudka: ${f.wake}`);
  out.push(f.late ? `jeszcze bez snu o ${f.bedtime}` : `pora snu: ${f.bedtime}`);
  const parts: DayPart[] = ['rano', 'w południe', 'po południu', 'wieczorem'];
  for (const p of parts) {
    const acts = f.activities.filter((a) => a.part === p && ACT_NOUN[a.type]).map((a) => `${ACT_NOUN[a.type]} (${a.minutes} min)`);
    if (acts.length) out.push(`${p}: ${acts.join(', ')}`);
  }
  const meals = mealLabels(f.meals);
  if (meals.length) out.push(`posiłki: ${meals.join(', ')}`);
  const words: Record<TalkOutcome, string> = { great: 'świetna, serdeczna', nice: 'miła', plain: 'krótka, zwykła', tense: 'napięta', quarrel: 'kłótnia' };
  for (const x of f.talks.slice(0, 5))
    out.push(`rozmowa: ${x.with} — ${words[x.outcome]}${x.topic ? `, temat: ${x.topic}` : ''}${x.mine ? ' (z mojej inicjatywy)' : ''}`);
  for (const r of f.remote.slice(0, 1)) out.push(`kłótnia o pilota do telewizora: ${r.with}`);
  for (const r of f.refusedBy.slice(0, 2)) out.push(`${r.name}: odmowa rozmowy${r.busy ? ' (brak czasu)' : ' (brak ochoty)'}`);
  for (const n of f.refused.slice(0, 1)) out.push(`moja odmowa rozmowy: ${n}`);
  for (const g of f.gatherings.slice(0, 2)) out.push(`${g.label.toLowerCase()}: ${g.with.join(', ')} i ja`);
  const STATUS: Record<RelationChange, string> = {
    couple: 'teraz para', crush: 'zauroczenie', breakup: 'rozstanie', rivals: 'teraz rywalizacja', enemies: 'wrogość', best_friends: 'najbliższa przyjaźń', friends: 'przyjaźń', peace: 'zgoda po sporze',
  };
  for (const r of new Map(f.relations.map((x) => [x.with, x] as const)).values()) out.push(`relacja: ${r.with} — ${STATUS[r.change]}`);
  for (const h of f.heard.slice(0, 2)) out.push(`plotka${h.from ? ` (mówi: ${h.from})` : ''}: ${h.text}`);
  for (const x of f.told.slice(0, 1)) out.push(`moja opowieść dla: ${x.to} — ${x.text}`);
  if (f.goal) {
    const label = GOAL_INF[f.goal.kind] + (f.goal.partner ? ` (${f.goal.partner})` : '');
    out.push(`cel dnia: ${label} — ${f.goal.done ? 'wykonany' : 'niewykonany'}`);
  }
  const W: Record<WeatherKind, string> = { sunny: 'słońce', cloudy: 'pochmurno', rain: 'deszcz', storm: 'burza' };
  if (f.weather.length) out.push(`pogoda: ${f.weather.map((k) => W[k]).join(', potem ')}`);
  for (const a of f.broke) out.push(`awaria z mojej winy: psuję ${a}`);
  for (const a of f.fixed) out.push(`naprawa: naprawiam ${a}`);
  for (const m of f.moments) out.push(`chwila dnia: ${m}`);
  for (const p of f.projects ?? []) {
    if (p.proposed) out.push(`moja propozycja: wspólna budowa — ${p.name}`);
    if (p.minutes >= 15) out.push(`pracuję przy ${p.locative} (${p.minutes} min${p.with.length ? `, z: ${p.with.join(', ')}` : ', w pojedynkę'})`);
    for (const st of p.stages) out.push(`budowa (${p.name}): etap ${st} — gotowe`);
    if (p.finished) out.push(`${p.name} — budowa ukończona, ekipa: ${p.crew.join(', ')}`);
  }
  const NEED: Partial<Record<NeedKey, string>> = { hunger: 'silny głód', energy: 'duże zmęczenie', social: 'samotność', hygiene: 'potrzeba prysznica' };
  const needs = f.lowNeeds.map((k) => NEED[k]).filter(Boolean);
  if (needs.length) out.push(`w ciągu dnia: ${needs.join(', ')}`);
  return [...new Set(out)].slice(0, 24).map((l) => l.slice(0, 160));
}

export function buildDiaryRequest(facts: DiaryFacts, persona: DiaryPersona): LlmDiaryRequest {
  const m = facts.mood;
  return {
    name: persona.name,
    traits: describeTraits(persona.traits),
    mood: Math.round(persona.mood),
    moodArc: `rano ${m.start}, wieczorem ${m.end}, najniżej ${m.min}${m.minPart ? ` (${m.minPart})` : ''}`,
    day: facts.day,
    facts: diaryFactLines(facts),
    news: facts.news.slice(0, 2).map((n) => n.slice(0, 160)),
  };
}

const AI_COOLDOWN = { rate: 60_000, daily: 30 * 60_000, error: 10_000 };
const AI_QUEUE_MAX = 12;

/**
 * turns the AI rewrite on/off (wire it to the AI dialogue toggle). Only entries written while
 * it is on are sent, at most one request per resident per game day; failures keep the text.
 */
export function setDiaryAiEnabled(world: World, enabled: boolean, opts: DiaryAiOptions = {}): void {
  const s = stateOf(world);
  if (!enabled) {
    if (s.ai) {
      s.ai.enabled = false;
      s.ai.queue = [];
    }
    return;
  }
  const client = opts.client ?? createDiaryAiClient(opts);
  if (s.ai) {
    s.ai.enabled = true;
    if (opts.client || opts.fetch || opts.baseUrl || opts.timeoutMs) s.ai.client = client;
    if (opts.spacingMs !== undefined) s.ai.spacingMs = opts.spacingMs;
    if (opts.now) s.ai.now = opts.now;
    return;
  }
  s.ai = { enabled: true, client, attempted: new Set(), queue: [], busy: false, blockedUntil: 0, spacingMs: opts.spacingMs ?? 4000, now: opts.now ?? Date.now };
}

/** same as setDiaryAiEnabled(world, true, opts) */
export function enableDiaryAi(world: World, opts: DiaryAiOptions = {}): void {
  setDiaryAiEnabled(world, true, opts);
}

export function isDiaryAiEnabled(world: World): boolean {
  return !!states.get(world)?.ai?.enabled;
}

function queueAi(world: World, s: DiaryState, entry: DiaryEntry): void {
  const ai = s.ai!;
  const key = `${entry.agentId}:${entry.day}`;
  if (ai.attempted.has(key)) return;
  ai.attempted.add(key);
  if (ai.attempted.size > 2000) ai.attempted.delete(ai.attempted.values().next().value as string);
  ai.queue.push(entry);
  if (ai.queue.length > AI_QUEUE_MAX) ai.queue.shift();
  pumpAi(world, s);
}

/** entries waiting for / in an AI rewrite (for tests and UI hints) */
export function diaryAiPending(world: World): number {
  const ai = states.get(world)?.ai;
  return ai ? ai.queue.length + (ai.busy ? 1 : 0) : 0;
}

function pumpAi(world: World, s: DiaryState): void {
  const ai = s.ai;
  if (!ai || !ai.enabled || ai.busy) return;
  const entry = ai.queue.shift();
  if (!entry) return;
  // over budget / rate limited: skip (the procedural entry stays; one attempt per resident per day)
  if (ai.now() < ai.blockedUntil) {
    pumpAi(world, s);
    return;
  }
  const facts = diaryFactsOf(world, entry.agentId, entry.day);
  const agent = world.agents.find((a) => a.id === entry.agentId);
  if (!facts || !agent) {
    pumpAi(world, s);
    return;
  }
  const req = buildDiaryRequest(facts, { name: agent.name, traits: agent.traits, mood: entry.mood });
  ai.busy = true;
  const names = world.agents.map((a) => a.name);
  void ai.client
    .write(req, names)
    .then((text) => {
      if (!diaryOf(world, entry.agentId).includes(entry)) return;
      entry.text = text;
      entry.source = 'ai';
      notify(s, entry);
    })
    .catch((err: unknown) => {
      const e = err instanceof DiaryAiError ? err : null;
      const wait = e?.status === 429 ? (/daily|budget/.test(e.reason) ? AI_COOLDOWN.daily : AI_COOLDOWN.rate) : AI_COOLDOWN.error;
      ai.blockedUntil = Math.max(ai.blockedUntil, ai.now() + wait);
    })
    .finally(() => {
      ai.busy = false;
      if (!ai.queue.length) return;
      if (ai.spacingMs <= 0) pumpAi(world, s);
      else setTimeout(() => pumpAi(world, s), ai.spacingMs);
    });
}

