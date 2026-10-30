import type { SimEvent } from '../types';
import { PROJECT_KINDS } from '../world/projects/defs';

// Place chronicle: the most important events of the last days, kept far longer than world.events
// (capped at 200). Pure functions only (no DOM, no world state): the live server feeds new events
// through collectEvents after every tick, keeps the store in <place>.chronicle.json and serves
// toView() to the browser. Texts are the events' own Polish texts (names in the nominative, no
// gendered forms); the procedural day summary below follows the same rules.

export type ChronicleKind = 'couple' | 'breakup' | 'friends' | 'quarrel' | 'project' | 'built' | 'together' | 'breakdown' | 'weather' | 'moment';

export interface ChronicleItem {
  tick: number;
  kind: ChronicleKind;
  icon: string;
  /** Polish, as in the event log */
  text: string;
  agentIds: number[];
  /** importance 0..1 (ranking inside a day) */
  weight: number;
}

export interface ChronicleDay {
  /** local calendar date YYYY-MM-DD */
  date: string;
  /** chronological */
  items: ChronicleItem[];
  /** AI summary of the (finished) day */
  ai?: string;
  /** an AI summary was already requested for this day (one attempt per day) */
  aiTried?: boolean;
}

export interface ChronicleStore {
  /** events up to this tick are already collected */
  lastTick: number;
  /** oldest first */
  days: ChronicleDay[];
}

export interface ChronicleDayView {
  date: string;
  summary: string;
  summarySource: 'procedural' | 'ai';
  /** all stored items of the day */
  total: number;
  /** the most important ones, chronological */
  items: ChronicleItem[];
}

export interface ChronicleResponse {
  place: string;
  tick: number;
  /** newest day first */
  days: ChronicleDayView[];
}

export const CHRONICLE_DAYS = 14;
/** stored items per day (the least important go first) */
export const CHRONICLE_MAX_ITEMS = 60;
/** items per day sent to the browser */
export const CHRONICLE_VIEW_ITEMS = 14;

export const CHRONICLE_ICONS: Record<ChronicleKind, string> = {
  couple: '💕',
  breakup: '💔',
  friends: '🤝',
  quarrel: '💢',
  project: '🔨',
  built: '🎉',
  together: '👥',
  breakdown: '🔧',
  weather: '🌦️',
  moment: '✨',
};

export const CHRONICLE_LABELS: Record<ChronicleKind, string> = {
  couple: 'Pary',
  breakup: 'Rozstania',
  friends: 'Przyjaźnie',
  quarrel: 'Kłótnie',
  project: 'Budowa',
  built: 'Ukończone projekty',
  together: 'Wspólne zajęcia',
  breakdown: 'Awarie',
  weather: 'Pogoda',
  moment: 'Wydarzenia',
};

// project texts come from the project definitions, so they stay recognisable when texts change
const TRAILING_EMOJI = /\s*\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u200D]*\s*$/u;
const stripTrailingEmoji = (t: string): string => t.replace(TRAILING_EMOJI, '').trim();
const PROJECT_START = new Set<string>();
const PROJECT_DONE: string[] = [];
const PROJECT_PROPOSALS: string[] = [];
for (const kind of Object.values(PROJECT_KINDS)) {
  for (const st of kind.stages) PROJECT_START.add(stripTrailingEmoji(st.startText));
  PROJECT_DONE.push(kind.doneText);
  PROJECT_PROPOSALS.push(kind.proposal);
}

function item(ev: SimEvent, kind: ChronicleKind, weight: number): ChronicleItem {
  return { tick: ev.tick, kind, icon: CHRONICLE_ICONS[kind], text: ev.text, agentIds: ev.agentIds.slice(), weight };
}

/** the chronicle entry for an event, null when it is not worth keeping */
export function classifyEvent(ev: SimEvent): ChronicleItem | null {
  const t = ev.text;
  if (t.startsWith('📰')) return null;
  const bare = stripTrailingEmoji(t);

  if (PROJECT_DONE.some((d) => t.startsWith(d))) return item(ev, 'built', 1);
  if (t.startsWith('Ekipa świętuje')) return item(ev, 'built', 0.7);
  if (PROJECT_PROPOSALS.some((p) => t.includes(p))) return item(ev, 'project', 0.8);
  if (PROJECT_START.has(bare) || [...PROJECT_START].some((s) => bare.startsWith(s))) return item(ev, 'project', 0.6);

  if (ev.kind === 'relationship') {
    if (/są parą/.test(t)) return item(ev, 'couple', 1);
    if (/się rozstają/.test(t)) return item(ev, 'breakup', 0.9);
    if (/mają się ku sobie/.test(t)) return item(ev, 'couple', 0.7);
    if (/kłótnia|nie mogą się znieść|rywalami/.test(t)) return item(ev, 'quarrel', /kłótnia/.test(t) ? 0.55 : 0.75);
    if (/najlepszymi przyjaciółmi|przyjaźnią|topór/.test(t)) return item(ev, 'friends', /najlepszymi/.test(t) ? 0.7 : 0.6);
    return item(ev, 'moment', 0.3);
  }

  if (t.includes('🔧') || t.includes('🧰')) return item(ev, 'breakdown', 0.5);
  if (/[Bb]urz/.test(t) && /(Nadciąga|Zaczyna się|przechodzi)/.test(t)) return item(ev, 'weather', t.startsWith('Burza przechodzi') ? 0.3 : 0.5);
  if (/^Zaczyna padać/.test(t)) return item(ev, 'weather', 0.3);
  if (/^(Przejaśnia się|Przestaje padać)/.test(t)) return item(ev, 'weather', 0.2);

  if (ev.agentIds.length >= 2 && (ev.gossip || /^(Wspólne|Wspólny|Wspólna|Wieczór filmowy)/.test(t))) return item(ev, 'together', 0.5);
  if (ev.gossip && Math.abs(ev.gossip.valence) >= 0.4) return item(ev, 'moment', 0.2 + 0.3 * Math.min(1, Math.abs(ev.gossip.valence)));
  return null;
}

export function createChronicle(): ChronicleStore {
  return { lastTick: 0, days: [] };
}

function dayOf(store: ChronicleStore, date: string): ChronicleDay {
  let i = store.days.length;
  while (i > 0 && store.days[i - 1].date > date) i--;
  if (i > 0 && store.days[i - 1].date === date) return store.days[i - 1];
  const day: ChronicleDay = { date, items: [] };
  store.days.splice(i, 0, day);
  return day;
}

/**
 * adds the chronicle-worthy events newer than store.lastTick (events are newest last), then trims
 * to the last CHRONICLE_DAYS days and CHRONICLE_MAX_ITEMS items per day. `dateOf` maps a tick to
 * its local calendar date. Returns the number of items added.
 */
export function collectEvents(store: ChronicleStore, events: readonly SimEvent[], tick: number, dateOf: (tick: number) => string): number {
  let from = events.length;
  while (from > 0 && events[from - 1].tick > store.lastTick) from--;
  let added = 0;
  for (let i = from; i < events.length; i++) {
    const it = classifyEvent(events[i]);
    if (!it) continue;
    const day = dayOf(store, dateOf(it.tick));
    day.items.push(it);
    added++;
    if (day.items.length > CHRONICLE_MAX_ITEMS) {
      let low = 0;
      for (let k = 1; k < day.items.length; k++) if (day.items[k].weight < day.items[low].weight) low = k;
      day.items.splice(low, 1);
    }
  }
  store.lastTick = Math.max(store.lastTick, tick);
  if (store.days.length > CHRONICLE_DAYS) store.days.splice(0, store.days.length - CHRONICLE_DAYS);
  return added;
}

/** drops everything after `tick` (a restored world is behind the saved chronicle and replays it) */
export function rewindChronicle(store: ChronicleStore, tick: number): void {
  if (store.lastTick <= tick) return;
  store.lastTick = tick;
  for (const d of store.days) d.items = d.items.filter((i) => i.tick <= tick);
  store.days = store.days.filter((d) => d.items.length > 0 || d.ai);
}

// ---------------------------------------------------------------- summary

/** Polish plural: 1 → one, 2–4 (not 12–14) → few, else many */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** one procedural sentence about the day, built from the counts of what happened */
export function proceduralSummary(items: readonly ChronicleItem[]): string {
  const n = (k: ChronicleKind): number => items.filter((i) => i.kind === k).length;
  const couples = items.filter((i) => i.kind === 'couple' && /są parą/.test(i.text)).length;
  const parts: string[] = [];
  if (couples) parts.push(`${couples} ${plural(couples, 'nowa para', 'nowe pary', 'nowych par')}`);
  if (n('breakup')) parts.push(`${n('breakup')} ${plural(n('breakup'), 'rozstanie', 'rozstania', 'rozstań')}`);
  if (n('quarrel')) parts.push(`${n('quarrel')} ${plural(n('quarrel'), 'kłótnia', 'kłótnie', 'kłótni')}`);
  if (n('friends')) parts.push(`${n('friends')} ${plural(n('friends'), 'nowa przyjaźń', 'nowe przyjaźnie', 'nowych przyjaźni')}`);
  if (n('built')) parts.push(`${n('built')} ${plural(n('built'), 'ukończony projekt', 'ukończone projekty', 'ukończonych projektów')}`);
  else if (n('project')) parts.push('budowa idzie naprzód');
  if (n('together')) parts.push(`${n('together')} ${plural(n('together'), 'wspólne zajęcie', 'wspólne zajęcia', 'wspólnych zajęć')}`);
  if (n('breakdown')) parts.push(`${n('breakdown')} ${plural(n('breakdown'), 'awaria', 'awarie', 'awarii')}`);
  if (items.some((i) => i.kind === 'weather' && /burz/i.test(i.text))) parts.push('burza');
  else if (items.some((i) => i.kind === 'weather' && /pada/.test(i.text))) parts.push('deszcz');
  if (parts.length === 0) return 'Spokojny dzień — nic wielkiego się nie wydarzyło.';
  return `Najważniejsze: ${parts.join(', ')}.`;
}

/** the most important items of a day, chronological */
export function topItems(items: readonly ChronicleItem[], max = CHRONICLE_VIEW_ITEMS): ChronicleItem[] {
  if (items.length <= max) return items.slice();
  const keep = new Set(
    items
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => b.it.weight - a.it.weight || b.it.tick - a.it.tick)
      .slice(0, max)
      .map((x) => x.idx),
  );
  return items.filter((_, idx) => keep.has(idx));
}

export function toView(store: ChronicleStore, place: string, tick: number): ChronicleResponse {
  const days = store.days
    .filter((d) => d.items.length > 0)
    .map((d): ChronicleDayView => ({
      date: d.date,
      summary: d.ai ?? proceduralSummary(d.items),
      summarySource: d.ai ? 'ai' : 'procedural',
      total: d.items.length,
      items: topItems(d.items),
    }))
    .reverse();
  return { place, tick, days };
}

/** fact lines for the AI summary: the day's most important items without trailing emoji */
export function chronicleFacts(day: ChronicleDay, max = 12): string[] {
  return topItems(day.items, max).map((i) => i.text.replace(/\s*\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u200D]*/gu, '').trim());
}
