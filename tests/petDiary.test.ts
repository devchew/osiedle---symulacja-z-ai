import { describe, expect, it } from 'vitest';
import { createWorld, tickWorld } from '../src/world/world';
import { composeDiary, diaryFactLines, diaryFactsOf, diaryOf, type DiaryFacts } from '../src/social/diary';
import { findGenderedForms } from '../src/social/diaryAi';
import { petsOf } from '../src/agents/pets';
import type { World } from '../src/types';

// Issue #9: the house pet in the residents' diaries.

const DAY = 24 * 60;

function runDays(seed: number, mapId: string, days: number): World {
  const w = createWorld(seed, { mapId });
  const end = days * DAY - 7 * 60 - 1;
  while (w.tick < end) tickWorld(w);
  return w;
}

function facts(over: Partial<DiaryFacts> = {}): DiaryFacts {
  return {
    agentId: 0, name: 'Ola', day: 3, wake: '06:40', bedtime: '21:10', late: false,
    activities: [{ type: 'dog_walk', part: 'po południu', minutes: 30, times: 1 }],
    meals: [], talks: [], refusedBy: [], refused: [], gatherings: [], goal: null, relations: [], remote: [],
    heard: [], told: [], news: [], weather: [], broke: [], fixed: [], moments: [],
    mood: { start: 60, end: 70, min: 55, max: 75, minPart: 'rano' },
    lowNeeds: [], feelings: [],
    ...over,
  };
}

const persona = { name: 'Ola', traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 }, mood: 65 };

describe('diary: house pet', () => {
  it('pet lines have no gendered forms and keep the name in the nominative', () => {
    const variants: DiaryFacts['pet'][] = [];
    for (const species of ['cat', 'dog'] as const)
      for (const n of [1, 2])
        variants.push({
          name: species === 'cat' ? 'Kluska' : 'Burek', species, fed: n, played: n, walked: species === 'dog' ? n : 0,
          moments: species === 'cat'
            ? ['Głaszczę kota, a Kluska mruczy z zadowolenia. 🐈', 'Kluska strąca kubek ze stołu, a sprzątanie skorup — na mojej głowie. 😾']
            : ['Burek kradnie mi skarpetkę i gonitwa po całym domu gotowa! 🧦'],
        });
    let mentioned = 0;
    for (const pet of variants)
      for (const weather of [[], ['rain']] as DiaryFacts['weather'][])
        for (let seed = 1; seed <= 40; seed++) {
          const f = facts({ pet, weather });
          const { text, tags } = composeDiary(f, persona, seed);
          expect(findGenderedForms(text, ['Ola', pet!.name]), text).toEqual([]);
          expect(text).not.toMatch(/Burka|Burkiem|Burkowi|Kluski|Kluską/);
          if (text.includes(pet!.name)) mentioned++;
          expect(tags).toContain(pet!.species === 'cat' ? '🐈' : '🐕');
          // the walk is told by the pet line, not repeated in the activity summary
          expect(text).not.toMatch(/: spacer z psem|Spaceruję z psem/);
          for (const line of diaryFactLines(f)) expect(findGenderedForms(line, ['Ola', pet!.name]), line).toEqual([]);
        }
    expect(mentioned).toBe(variants.length * 2 * 40);
  });

  it('without a pet fact the walk is an ordinary activity', () => {
    const { text } = composeDiary(facts(), persona, 7);
    expect(text).toMatch(/spacer z psem|z psem/i);
    expect(findGenderedForms(text, ['Ola'])).toEqual([]);
  });

  it('the AI facts name the pet and the care', () => {
    const lines = diaryFactLines(facts({ pet: { name: 'Azor', species: 'dog', fed: 1, played: 0, walked: 2, moments: [] } }));
    expect(lines.some((l) => l.startsWith('zwierzak domowy: Azor (pies') && /karmienie/.test(l) && /spacer \(2×\)/.test(l))).toBe(true);
  });

  it.each([['dom', 5], ['kamienica', 2]])('a %s world: after two days the pet shows up in someone\'s diary', (mapId, seed) => {
    const w = runDays(seed, mapId, 2);
    const pet = petsOf(w)[0];
    expect(pet).toBeDefined();
    const withPet = w.agents.flatMap((a) =>
      diaryOf(w, a.id).filter((e) => diaryFactsOf(w, a.id, e.day)?.pet && e.text.includes(pet.name)).map((e) => ({ a, e })),
    );
    expect(withPet.length, `${mapId}: no entry mentions ${pet.name}`).toBeGreaterThan(0);
    for (const { a, e } of withPet) {
      expect(findGenderedForms(e.text, [...w.agents.map((x) => x.name), pet.name]), e.text).toEqual([]);
      if (process.env.SHOW_PET_DIARY) console.log(`--- ${mapId} ${a.name} d${e.day}\n${e.text}`);
    }
  });
});
