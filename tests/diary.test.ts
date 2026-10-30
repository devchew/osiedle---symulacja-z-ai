import { describe, expect, it, vi } from 'vitest';
import { timeFromTick } from '../src/core/time';
import { createWorld, tickWorld } from '../src/world/world';
import { traceOf } from '../src/world/trace';
import { worldCheck } from '../src/ui/saves';
import {
  DIARY_MAX_WORDS,
  DIARY_MIN_WORDS,
  buildDiaryRequest,
  composeDiary,
  diaryAiPending,
  diaryDayOf,
  diaryFactLines,
  diaryFactsOf,
  diaryOf,
  formatDiary,
  isDiaryAiEnabled,
  onDiaryChange,
  setDiaryAiEnabled,
  setDiaryEnabled,
  type DiaryEntry,
  type DiaryFacts,
} from '../src/social/diary';
import { DiaryAiError, countWords, findGenderedForms, type DiaryAiClient, type LlmDiaryRequest } from '../src/social/diaryAi';
import type { World } from '../src/types';

const DAY = 24 * 60;

/** runs a world to the given game day's 23:59 (the sim starts on day 1 at 07:00) */
function runDays(seed: number, days: number, setup?: (w: World) => void): World {
  const w = createWorld(seed);
  setup?.(w);
  const end = days * DAY - 7 * 60 - 1;
  while (w.tick < end) tickWorld(w);
  return w;
}

const cache = new Map<number, World>();
function world3(seed: number): World {
  let w = cache.get(seed);
  if (!w) cache.set(seed, (w = runDays(seed, 3)));
  return w;
}

const all = (w: World): DiaryEntry[] => w.agents.flatMap((a) => [...diaryOf(w, a.id)]);
const names = (w: World): string[] => w.agents.map((a) => a.name);

describe('diary: writing schedule', () => {
  it.each([3, 11])('one entry per resident per day over 3 days (seed %i), written at bedtime', (seed) => {
    const w = world3(seed);
    for (const a of w.agents) {
      const entries = diaryOf(w, a.id);
      expect(entries.map((e) => e.day)).toEqual([1, 2, 3]);
      for (const e of entries) {
        const t = timeFromTick(e.tick);
        expect(diaryDayOf(e.tick)).toBe(e.day);
        expect(t.hour >= 19 || t.hour < 5).toBe(true);
        const facts = diaryFactsOf(w, a.id, e.day)!;
        if (facts.late) {
          // fallback: still awake at 23:30
          expect(t.hour).toBe(23);
          expect(t.minute).toBe(30);
        } else {
          // written in the very tick the resident lay down for the night
          const bed = traceOf(w).find((x) => x.agentId === a.id && x.tick === e.tick && x.kind === 'arrive' && x.text.startsWith('Łóżko'));
          expect(bed).toBeDefined();
        }
        expect(e.source).toBe('procedural');
        expect(e.mood).toBeGreaterThanOrEqual(0);
        expect(e.tags.length).toBeGreaterThan(0);
        expect(e.tags.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('diary: content', () => {
  it('is natural-sized: 60–140 words, 2–4 paragraphs, first person, no gendered forms', () => {
    for (const seed of [3, 11]) {
      const w = world3(seed);
      for (const e of all(w)) {
        const words = countWords(e.text);
        expect(words, e.text).toBeGreaterThanOrEqual(DIARY_MIN_WORDS);
        expect(words, e.text).toBeLessThanOrEqual(DIARY_MAX_WORDS);
        const paras = e.text.split('\n\n');
        expect(paras.length).toBeGreaterThanOrEqual(2);
        expect(paras.length).toBeLessThanOrEqual(4);
        expect(findGenderedForms(e.text, names(w)), e.text).toEqual([]);
        // first person: "ja", "mi", "mnie" or a 1st-person verb
        expect(e.text).toMatch(/\b(ja|mi|mnie|moj\p{L}*|mam|wstaję|łowię|oglądam|czytam|gram|naprawiam|psuję)\b|\p{L}+(ę|em|am)\b/u);
      }
    }
  });

  it('facts follow the trace: activities, conversations and goals reach the text', () => {
    let fished = 0;
    let talked = 0;
    let goals = 0;
    for (const seed of [3, 11]) {
      const w = world3(seed);
      const trace = traceOf(w);
      for (const a of w.agents) {
        for (const e of diaryOf(w, a.id)) {
          const f = diaryFactsOf(w, a.id, e.day)!;
          // fishing in the trace that day (arrival before the entry) ⇒ fishing in the facts and in the text
          const fishArrive = trace.some(
            (x) => x.agentId === a.id && x.kind === 'arrive' && x.text.startsWith('Pomost wędkarski') && diaryDayOf(x.tick) === e.day && x.tick < e.tick - 40,
          );
          const fishFact = f.activities.find((x) => x.type === 'fishing_spot');
          if (fishArrive) expect(fishFact, `${a.name} d${e.day}`).toBeDefined();
          if (fishFact && fishFact.minutes >= 20) {
            fished++;
            expect(e.text).toMatch(/wędk|ryb|pomoś|szczupak|karp/);
          }
          // the most notable conversation partner is named
          if (f.talks.length) {
            talked++;
            const rank = { quarrel: 5, great: 4, tense: 3, nice: 2, plain: 1 } as const;
            const top = [...f.talks].sort((x, y) => rank[y.outcome] - rank[x.outcome])[0];
            expect(e.text, e.text).toContain(top.with);
          }
          // goal of the day: done ⇒ celebrated, not done ⇒ "nie wychodzi"
          if (f.goal) {
            goals++;
            expect(e.text).toMatch(/Plan na dziś|Cel dnia|Miało być/);
            if (f.goal.done) expect(e.text).toMatch(/✔️|🕊️/);
          }
        }
      }
    }
    expect(fished).toBeGreaterThan(0);
    expect(talked).toBeGreaterThan(5);
    expect(goals).toBeGreaterThan(20);
  });

  it('collects meals, weather, mood and conversations as structured facts', () => {
    const w = world3(3);
    const f = diaryFactsOf(w, w.agents[0].id, 2)!;
    expect(f.meals.length).toBeGreaterThan(0);
    expect(f.weather.length).toBeGreaterThan(0);
    expect(f.wake).toMatch(/^\d\d:\d\d$/);
    expect(f.mood.min).toBeLessThanOrEqual(f.mood.max);
    const lines = diaryFactLines(f);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.length).toBeLessThanOrEqual(24);
  });
});

/** a fixed day with a quarrel, for tone / subjectivity checks */
function sampleFacts(over: Partial<DiaryFacts> = {}): DiaryFacts {
  return {
    agentId: 0, name: 'Ola', day: 4, wake: '06:40', bedtime: '21:10', late: false,
    activities: [
      { type: 'fishing_spot', part: 'rano', minutes: 95, times: 1 },
      { type: 'tv', part: 'wieczorem', minutes: 60, times: 1 },
    ],
    meals: [{ kind: 'śniadanie', where: 'dining_table' }, { kind: 'obiad', where: 'stove' }],
    talks: [
      { with: 'Bartek', topic: 'polityka', outcome: 'quarrel', mine: true, sympathy: 0 },
      { with: 'Kasia', topic: 'muzyka', outcome: 'nice', mine: false, sympathy: 30 },
    ],
    refusedBy: [], refused: [], gatherings: [], goal: { kind: 'fish', done: true, partner: null }, relations: [], remote: [],
    heard: [{ text: 'Tomek przypala obiad', from: 'Kasia', valence: -0.5 }], told: [], news: [], weather: ['sunny'],
    broke: [], fixed: [], moments: ['Łowię szczupaka! 🐟'],
    mood: { start: 60, end: 60, min: 45, max: 72, minPart: 'po południu' }, lowNeeds: [], feelings: [],
    ...over,
  };
}

describe('diary: tone and subjectivity', () => {
  const POSITIVE = /super|świetn|brawo|fajn|miło|cudown|uwielbiam|uśmiech|przytulnie|lubię|marzenie|jutro będzie lepiej|nic to|szkoda… chyba|głupio|ups|☀️|😊|!/giu;
  const NEGATIVE = /niestety|nie chce|nuda|mam tego dość|nie moja wina|typowe|phi|szkoda gadać|byle do jutra|jak zwykle|jak zawsze|ponuro|ujdzie|no i dobrze|nie dziwi|czepia/giu;
  const score = (text: string): number => (text.match(POSITIVE)?.length ?? 0) - (text.match(NEGATIVE)?.length ?? 0);

  it('cheerful residents write measurably brighter entries than grumpy ones about the same day', () => {
    let cheer = 0;
    let grump = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const facts = sampleFacts();
      const base = { sociability: 0, activity: 0, neatness: 0 };
      cheer += score(composeDiary(facts, { name: 'Ola', traits: { ...base, cheerfulness: 0.9 }, mood: 60 }, seed).text);
      grump += score(composeDiary(facts, { name: 'Ola', traits: { ...base, cheerfulness: -0.9 }, mood: 60 }, seed).text);
    }
    expect(cheer / 40).toBeGreaterThan(grump / 40 + 1.5);
  });

  it('the same quarrel reads as blame from a grump and as regret from an optimist', () => {
    const facts = sampleFacts();
    const base = { sociability: 0, activity: 0, neatness: 0 };
    const regret = /szkoda|głupio|naprawić|unoszę|cierpliwości|upieram/i;
    const blame = /czepia|dość|nie słucha|nie moja wina|po swojemu|komentować/i;
    for (let seed = 1; seed <= 20; seed++) {
      const nice = composeDiary(facts, { name: 'Ola', traits: { ...base, cheerfulness: 0.8 }, mood: 55 }, seed).text;
      const grumpy = composeDiary({ ...facts, talks: [{ ...facts.talks[0], sympathy: -20 }] }, { name: 'Bartek', traits: { ...base, cheerfulness: -0.8 }, mood: 55 }, seed).text;
      expect(nice).toMatch(regret);
      expect(grumpy).toMatch(blame);
      expect(nice).toContain('Bartek');
    }
  });

  it('introverts and extroverts dwell on different things', () => {
    const facts = sampleFacts({ talks: [], gatherings: [] });
    const base = { activity: 0, neatness: 0, cheerfulness: 0 };
    const intro = composeDiary(facts, { name: 'Ola', traits: { ...base, sociability: -0.9 }, mood: 60 }, 5).text;
    const extro = composeDiary(facts, { name: 'Ola', traits: { ...base, sociability: 0.9 }, mood: 60 }, 5).text;
    expect(intro).toMatch(/cisz|bez zbędnych rozmów|bez gadania/i);
    expect(extro).toMatch(/brakuje mi ludzi|nikt nie ma czasu|ludzi/i);
  });

  it('mood shapes the closing line', () => {
    const traits = { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0.6 };
    const good = composeDiary(sampleFacts({ mood: { start: 70, end: 90, min: 60, max: 92, minPart: 'rano' } }), { name: 'Ola', traits, mood: 90 }, 7).text;
    const bad = composeDiary(sampleFacts({ mood: { start: 50, end: 20, min: 15, max: 55, minPart: 'wieczorem' } }), { name: 'Ola', traits, mood: 20 }, 7).text;
    expect(good.split('\n\n').pop()).toMatch(/Co za dzień|uśmiechem|tak samo|marzenie/);
    expect(bad.split('\n\n').pop()).toMatch(/Ciężki dzień|od nowa/);
  });

  it('does not repeat the same sentences day after day', () => {
    const w = world3(3);
    for (const a of w.agents) {
      const [d1, d2, d3] = diaryOf(w, a.id).map((e) => new Set(e.text.split(/(?<=[.!?…])\s+/)));
      const overlap = [...d2].filter((s) => d1.has(s) || d3.has(s)).length;
      expect(overlap / d2.size).toBeLessThan(0.35);
    }
  });
});

describe('diary: repetitions', () => {
  const persona = { name: 'Ola', traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 }, mood: 60 };
  const firstSentence = (text: string): string => text.split(/(?<=[.!?…])\s+/)[0];

  it('mentions an activity repeated in several parts of the day once', () => {
    const facts = sampleFacts({
      activities: [
        { type: 'bathtub', part: 'rano', minutes: 25, times: 1 },
        { type: 'bathtub', part: 'po południu', minutes: 20, times: 1 },
        { type: 'tv', part: 'wieczorem', minutes: 60, times: 1 },
      ],
    });
    for (let seed = 1; seed <= 20; seed++) {
      const { text } = composeDiary(facts, persona, seed);
      expect(text.match(/wann/g)?.length, text).toBe(1);
      expect(text, text).toMatch(/[Rr]ano i po południu/);
    }
  });

  it('never states the same activity twice in an entry', () => {
    for (const seed of [3, 11]) {
      for (const e of all(world3(seed))) {
        for (const noun of ['wędkowanie', 'kąpiel w wannie', 'telewizja', 'drzemka', 'gry na komputerze']) {
          expect(e.text.split(noun).length - 1, `${noun}: ${e.text}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('residents do not open the same day with the same sentence', () => {
    for (const seed of [3, 11]) {
      const w = world3(seed);
      for (const day of [1, 2, 3]) {
        const firsts = w.agents.map((a) => firstSentence(diaryOf(w, a.id).find((e) => e.day === day)!.text));
        expect(new Set(firsts).size, firsts.join('\n')).toBe(firsts.length);
      }
    }
  });

  it('avoids the given openers and still writes one when every template is taken', () => {
    const facts = sampleFacts({ wake: null, day: 1 });
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) {
      const first = composeDiary(facts, persona, 10 + i, [], taken).text.split('\n\n')[0];
      const opener = first.split(/(?<=[.!?…])\s+/)[0];
      expect(taken).not.toContain(opener);
      taken.push(opener);
    }
    const all15 = composeDiary(facts, persona, 99, [], taken.concat(Array.from({ length: 30 }, (_, i) => `x${i}`)));
    expect(all15.text.length).toBeGreaterThan(0);
  });
});

describe('diary: determinism and isolation', () => {
  it('is deterministic per seed (a replay recreates the same entries)', () => {
    const a = runDays(5, 2);
    const b = runDays(5, 2);
    expect(all(a).map((e) => [e.agentId, e.day, e.tick, e.text, e.tags.join('')])).toEqual(all(b).map((e) => [e.agentId, e.day, e.tick, e.text, e.tags.join('')]));
    expect(composeDiary(sampleFacts(), { name: 'Ola', traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 }, mood: 60 }, 42)).toEqual(
      composeDiary(sampleFacts(), { name: 'Ola', traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 }, mood: 60 }, 42),
    );
  });

  it('never changes the simulation: the world with diaries equals the world without', () => {
    const fingerprint = (w: World) => ({
      check: worldCheck(w),
      rng: w.rng.state(),
      events: w.events.map((e) => `${e.tick}|${e.text}`).join('\n'),
      trace: traceOf(w).length,
      agents: w.agents.map((a) => [a.mood, ...Object.values(a.needs), a.pos.x, a.pos.y, a.action?.kind ?? '-'].map((v) => (typeof v === 'number' ? v.toFixed(6) : v)).join(',')),
      rel: w.relationships.all().map((r) => r.value.toFixed(6)).join(','),
    });
    const on = runDays(9, 2);
    const off = runDays(9, 2, (w) => setDiaryEnabled(w, false));
    expect(all(on).length).toBe(12);
    expect(all(off)).toEqual([]);
    expect(fingerprint(on)).toEqual(fingerprint(off));
  });
});

describe('diary: API', () => {
  it('notifies subscribers about new entries and unsubscribes', () => {
    const w = createWorld(2);
    const seen: DiaryEntry[] = [];
    const off = onDiaryChange(w, (e) => seen.push(e));
    while (w.tick < DAY - 7 * 60) tickWorld(w);
    expect(seen.length).toBe(w.agents.length);
    off();
    while (w.tick < 2 * DAY - 7 * 60) tickWorld(w);
    expect(seen.length).toBe(w.agents.length);
    expect(diaryOf(w, w.agents[0].id).length).toBe(2);
  });

  it('exports a readable text file', () => {
    const w = world3(3);
    const a = w.agents[0];
    const txt = formatDiary(w, a.id);
    expect(txt.startsWith(`Pamiętnik: ${a.name}\nCharakter: `)).toBe(true);
    for (const d of [1, 2, 3]) expect(txt).toContain(`=== Dzień ${d} (wpis o `);
    const everyone = formatDiary(w);
    for (const x of w.agents) expect(everyone).toContain(`Pamiętnik: ${x.name}`);
  });
});

// ------------------------------------------------------------------ AI rewrite

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('diary: AI rewrite', () => {
  it('replaces the text on success (source "ai"), sends structured facts, notifies', async () => {
    const requests: LlmDiaryRequest[] = [];
    const client: DiaryAiClient = {
      write: vi.fn(async (req: LlmDiaryRequest) => {
        requests.push(req);
        return `Dziś dużo się dzieje, a ja wszystko zapisuję. ${req.name} kończy dzień z uśmiechem i pełnym brzuchem. Jutro nowy dzień!`;
      }),
    };
    const w = createWorld(4);
    const updates: DiaryEntry[] = [];
    onDiaryChange(w, (e) => updates.push({ ...e }));
    setDiaryAiEnabled(w, true, { client, spacingMs: 0 });
    expect(isDiaryAiEnabled(w)).toBe(true);
    while (w.tick < DAY - 7 * 60) tickWorld(w);
    await flush();
    const entries = all(w);
    expect(entries.length).toBe(w.agents.length);
    expect(entries.every((e) => e.source === 'ai' && e.text.startsWith('Dziś dużo'))).toBe(true);
    expect(client.write).toHaveBeenCalledTimes(w.agents.length);
    expect(updates.filter((u) => u.source === 'ai').length).toBe(w.agents.length);
    const r = requests[0];
    expect(r.facts.length).toBeGreaterThan(2);
    expect(r.facts.some((f) => /^cel dnia: /.test(f))).toBe(true);
    expect(r.traits.length).toBeGreaterThan(3);
    expect(diaryAiPending(w)).toBe(0);
  });

  it('keeps the procedural text on failure and tries each resident-day only once', async () => {
    const write = vi.fn(async () => {
      throw new DiaryAiError('diary ai http 503', 503, 'upstream error');
    });
    const w = createWorld(4);
    const procedural = runDays(4, 1);
    setDiaryAiEnabled(w, true, { client: { write }, spacingMs: 0, now: () => 0 });
    while (w.tick < DAY - 7 * 60) tickWorld(w);
    await flush();
    // the first failure starts a short cooldown: the rest of tonight's entries are skipped, never retried
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(write.mock.calls.length).toBeLessThanOrEqual(w.agents.length);
    expect(all(w).map((e) => [e.source, e.text])).toEqual(all(procedural).map((e) => [e.source, e.text]));
    // re-enabling does not resend entries already attempted / written
    setDiaryAiEnabled(w, false);
    setDiaryAiEnabled(w, true);
    await flush();
    expect(write.mock.calls.length).toBeLessThanOrEqual(w.agents.length);
  });

  it('builds a compact request from facts + persona', () => {
    const req = buildDiaryRequest(sampleFacts({ news: ['Burza nad Bałtykiem'] }), {
      name: 'Ola', traits: { sociability: 0.8, activity: 0, neatness: 0, cheerfulness: -0.6 }, mood: 64,
    });
    expect(req.name).toBe('Ola');
    expect(req.mood).toBe(64);
    expect(req.news).toEqual(['Burza nad Bałtykiem']);
    expect(req.facts).toContain('rozmowa: Bartek — kłótnia, temat: polityka (z mojej inicjatywy)');
    expect(req.facts).toContain('cel dnia: złowić rybę — wykonany');
    expect(req.traits).toMatch(/towarzystwo/);
    expect(JSON.stringify(req).length).toBeLessThan(4000);
  });
});

describe('gendered-form detector', () => {
  it('flags gendered past tense and adjectives about the writer', () => {
    expect(findGenderedForms('Dziś zrobiłam obiad.')).toEqual(['zrobiłam']);
    expect(findGenderedForms('Bartek poszedł spać, a Ola była zła.')).toEqual(['poszedł', 'była']);
    expect(findGenderedForms('Byli tu wszyscy.')).toEqual(['byli']);
    expect(findGenderedForms('Jestem zmęczona.')).toEqual(['jestem zmęczona']);
  });

  it('does not flag nouns, neuter impersonal forms, names or quotes', () => {
    expect(findGenderedForms('Pół godziny przy stole, cały dzień w ogrodzie. Udało się! Działa jak nowe. Mogło być gorzej.')).toEqual([]);
    expect(findGenderedForms('W telewizji: „Rząd przyjął ustawę”.')).toEqual([]);
    expect(findGenderedForms('Jestem w ogrodzie, czuję się dobrze.')).toEqual([]);
    expect(findGenderedForms('Michał i ja.', ['Michał'])).toEqual([]);
  });
});
