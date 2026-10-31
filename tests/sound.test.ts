import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { effectForObject, newEffects, soundMix } from '../src/audio/mix';
import { importGraph } from './tools/importGraph';

describe('soundMix', () => {
  it('has birds by day and crickets by night', () => {
    const day = soundMix({ daylight: 1, weather: 'sunny', intensity: 0 });
    const night = soundMix({ daylight: 0, weather: 'sunny', intensity: 0 });
    expect(day.birds).toBeGreaterThan(0.9);
    expect(day.crickets).toBe(0);
    expect(night.birds).toBe(0);
    expect(night.crickets).toBeGreaterThan(0.9);
  });

  it('plays rain louder with intensity and silences the animals', () => {
    const light = soundMix({ daylight: 1, weather: 'rain', intensity: 0.1 });
    const heavy = soundMix({ daylight: 1, weather: 'rain', intensity: 1 });
    expect(heavy.rain).toBeGreaterThan(light.rain);
    expect(light.rain).toBeGreaterThan(0);
    expect(heavy.birds).toBe(0);
    expect(soundMix({ daylight: 0, weather: 'storm', intensity: 1 }).crickets).toBe(0);
    expect(soundMix({ daylight: 1, weather: 'sunny', intensity: 1 }).rain).toBe(0);
  });

  it('keeps every layer within 0..1', () => {
    for (const weather of ['sunny', 'cloudy', 'rain', 'storm'] as const)
      for (const daylight of [0, 0.3, 0.6, 1])
        for (const intensity of [-1, 0, 0.5, 2])
          for (const v of Object.values(soundMix({ daylight, weather, intensity }))) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
  });
});

describe('action effects', () => {
  const types: Record<number, string> = { 1: 'shower', 2: 'bed', 3: 'piano' };
  const using = (id: number, uid: number) => ({ id, action: { kind: 'use', phase: 'using', objectUid: uid } });

  it('maps only sounding objects', () => {
    expect(effectForObject('shower')).toBe('water');
    expect(effectForObject('stove')).toBe('sizzle');
    expect(effectForObject('bed')).toBeNull();
    expect(effectForObject(undefined)).toBeNull();
  });

  it('plays nothing for the first look at a world, then once per started use', () => {
    const typeOf = (uid: number) => types[uid];
    const first = newEffects(null, [using(0, 1)], typeOf);
    expect(first.effects).toEqual([]);

    const same = newEffects(first.next, [using(0, 1)], typeOf);
    expect(same.effects).toEqual([]);

    const started = newEffects(same.next, [using(0, 1), using(1, 3), using(2, 2), { id: 3, action: { kind: 'use', phase: 'walking', objectUid: 1 } }], typeOf);
    expect(started.effects).toEqual(['piano']);
  });
});

describe('module boundaries', () => {
  it('keeps audio and the UI out of the simulation', () => {
    const graph = importGraph(resolve(__dirname, '../src'));
    const sim = [...graph].filter(([file]) => /^(core|world|agents|social)\//.test(file));
    expect(sim.length).toBeGreaterThan(20);
    for (const [file, deps] of sim) expect(deps.filter((d) => /^(audio|ui|render)\//.test(d)), file).toEqual([]);
    for (const [file, deps] of graph) if (file.startsWith('audio/')) expect(deps.filter((d) => /^(ui|render)\//.test(d)), file).toEqual([]);
  });
});
