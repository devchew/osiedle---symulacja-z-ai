import { join } from 'node:path';
import { chronicleFacts, type ChronicleDay, type ChronicleItem, type ChronicleStore } from '../src/social/chronicle';
import type { LlmChronicleRequest } from '../src/social/chronicleAi';
import type { PlaceDef, PlaceId } from '../src/live/protocol';

// Chronicle persistence + AI summary selection for the live worlds. The collecting itself
// (classifying events, trimming to 14 days) is src/social/chronicle.ts; server/worlds.ts calls it
// after every tick and writes this file next to the world snapshot (same cadence, atomically).

export const CHRONICLE_FILE_FORMAT = 1;
/** AI summaries are only written for days at most this many days old (saves the daily budget) */
export const CHRONICLE_AI_MAX_AGE_DAYS = 2;
/** days with fewer items are not worth an AI call */
export const CHRONICLE_AI_MIN_ITEMS = 3;

interface SavedChronicle {
  format: number;
  place: PlaceId;
  lastTick: number;
  days: ChronicleDay[];
}

export function chroniclePath(dataDir: string, place: PlaceId): string {
  return join(dataDir, `${place}.chronicle.json`);
}

export function encodeChronicle(place: PlaceId, store: ChronicleStore): string {
  const s: SavedChronicle = { format: CHRONICLE_FILE_FORMAT, place, lastTick: store.lastTick, days: store.days };
  return JSON.stringify(s);
}

const isItem = (v: unknown): v is ChronicleItem => {
  const i = v as Partial<ChronicleItem> | null;
  return !!i && typeof i.tick === 'number' && typeof i.kind === 'string' && typeof i.text === 'string' && typeof i.icon === 'string' && Array.isArray(i.agentIds) && typeof i.weight === 'number';
};

/** parses a chronicle file's content; throws on anything unusable */
export function decodeChronicle(text: string, place: PlaceDef): ChronicleStore {
  const s = JSON.parse(text) as Partial<SavedChronicle> | null;
  if (!s || s.format !== CHRONICLE_FILE_FORMAT || s.place !== place.id || typeof s.lastTick !== 'number' || !Array.isArray(s.days)) throw new Error(`not a chronicle of "${place.id}"`);
  const days: ChronicleDay[] = [];
  for (const d of s.days) {
    if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Array.isArray(d.items) || !d.items.every(isItem)) throw new Error('bad chronicle day');
    days.push({ date: d.date, items: d.items, ...(typeof d.ai === 'string' ? { ai: d.ai } : {}), ...(d.aiTried ? { aiTried: true } : {}) });
  }
  return { lastTick: s.lastTick, days };
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** the newest finished day (before `today`) that still wants an AI summary, undefined when none */
export function summaryCandidate(store: ChronicleStore, today: string): ChronicleDay | undefined {
  const oldest = shiftDate(today, -CHRONICLE_AI_MAX_AGE_DAYS);
  for (let i = store.days.length - 1; i >= 0; i--) {
    const d = store.days[i];
    if (d.date >= today) continue;
    if (d.date < oldest) return undefined;
    if (!d.ai && !d.aiTried && d.items.length >= CHRONICLE_AI_MIN_ITEMS) return d;
  }
  return undefined;
}

export function summaryRequest(place: PlaceDef, day: ChronicleDay, names: readonly string[]): LlmChronicleRequest {
  return { place: place.name, date: day.date, facts: chronicleFacts(day), names: names.slice(0, 12) };
}
