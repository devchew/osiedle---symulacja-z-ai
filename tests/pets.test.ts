import { describe, expect, it } from 'vitest';
import type { World } from '../src/types';
import { createWorld, restoreWorld, snapshotWorld, tickWorld } from '../src/world/world';
import { checkSnapshot, type WorldSnapshot } from '../src/core/state';
import { PET_OBJECT_TYPES, petsOf, type PetActivity } from '../src/agents/pets';
import { isOutdoorTile } from '../src/world/incidents';
import { MAPS } from '../src/world/maps';
import { timeFromTick } from '../src/core/time';
import { findGenderedForms } from '../src/social/diaryAi';

// Issue #9: one cat or dog per place, looked after by the residents.

const DAYS = 4;

interface PetRun {
  world: World;
  /** longest run of ticks with hunger ≤ 1 */
  starving: number;
  minHunger: number;
  outdoorTicks: number;
  outdoorAtNight: number;
  activity: Partial<Record<PetActivity, number>>;
  /** ticks spent walking, per game day */
  walkTicksPerDay: number[];
}

function runPet(mapId: string, seed: number): PetRun {
  const world = createWorld(seed, { mapId });
  const r: PetRun = { world, starving: 0, minHunger: 100, outdoorTicks: 0, outdoorAtNight: 0, activity: {}, walkTicksPerDay: [] };
  let low = 0;
  for (let t = 0; t < DAYS * 24 * 60; t++) {
    tickWorld(world);
    const pet = petsOf(world)[0];
    const time = timeFromTick(world.tick);
    r.minHunger = Math.min(r.minHunger, pet.needs.hunger);
    low = pet.needs.hunger <= 1 ? low + 1 : 0;
    r.starving = Math.max(r.starving, low);
    r.activity[pet.activity] = (r.activity[pet.activity] ?? 0) + 1;
    if (isOutdoorTile(world.grid, Math.round(pet.pos.x), Math.round(pet.pos.y))) {
      r.outdoorTicks++;
      if (time.hour >= 22 || time.hour < 6) r.outdoorAtNight++;
    }
    if (pet.activity === 'walk') r.walkTicksPerDay[time.day - 1] = (r.walkTicksPerDay[time.day - 1] ?? 0) + 1;
  }
  return r;
}

const runs = MAPS.flatMap((m) => [1, 2].map((seed) => ({ mapId: m.id, seed, ...runPet(m.id, seed) })));

describe('house pets', () => {
  it('every place has its pet, a bowl, a cushion and a toy corner (dogs also a walk spot)', () => {
    for (const m of MAPS) {
      const w = createWorld(3, { mapId: m.id });
      const pets = petsOf(w);
      expect(pets, m.id).toHaveLength(1);
      const types = w.objects.map((o) => o.type);
      for (const t of ['pet_bowl', 'pet_cushion', 'pet_toy']) expect(types, `${m.id} ${t}`).toContain(t);
      expect(types.includes('dog_walk'), m.id).toBe(pets[0].species === 'dog');
    }
  });

  it('residents keep the pet fed and entertained', () => {
    for (const r of runs) {
      const label = `${r.mapId} seed ${r.seed}`;
      expect(r.starving, label).toBeLessThanOrEqual(60);
      expect(r.minHunger, label).toBeGreaterThan(20);
      expect(r.activity.eat ?? 0, label).toBeGreaterThan(0);
      expect(r.activity.play ?? 0, label).toBeGreaterThan(0);
      // sleeps at night, but not all day
      expect(r.activity.sleep ?? 0, label).toBeGreaterThan(DAYS * 6 * 60);
      expect(r.activity.sleep ?? 0, label).toBeLessThan(DAYS * 14 * 60);
    }
  });

  it('a cat stays indoors; a dog goes out only on walks, in the daytime, most days', () => {
    for (const r of runs) {
      const label = `${r.mapId} seed ${r.seed}`;
      const pet = petsOf(r.world)[0];
      if (pet.species === 'cat') {
        expect(r.outdoorTicks, label).toBe(0);
        expect(r.activity.walk ?? 0, label).toBe(0);
        continue;
      }
      expect(r.outdoorAtNight, label).toBe(0);
      expect(r.outdoorTicks, label).toBeLessThanOrEqual((r.activity.walk ?? 0) + 30);
      const walkedDays = r.walkTicksPerDay.filter((n) => (n ?? 0) >= 15).length;
      expect(walkedDays, label).toBeGreaterThanOrEqual(DAYS - 2);
    }
  });

  it('pet stories name the resident and the pet in the nominative, without gendered forms', () => {
    let stories = 0;
    for (const r of runs) {
      const pet = petsOf(r.world)[0];
      for (const e of r.world.events) {
        if (!e.text.includes(pet.name)) continue;
        stories++;
        expect(findGenderedForms(e.text), e.text).toEqual([]);
        if (e.gossip) {
          expect(e.gossip.aboutIds.length, e.text).toBeGreaterThan(0);
          for (const id of e.gossip.aboutIds) expect(e.text).toContain(r.world.agents.find((a) => a.id === id)!.name);
        }
      }
    }
    expect(stories).toBeGreaterThan(10);
  });

  it('is deterministic and survives a snapshot round trip', () => {
    const a = createWorld(5, { mapId: 'dom' });
    for (let i = 0; i < 1500; i++) tickWorld(a);
    const b = restoreWorld(JSON.parse(JSON.stringify(snapshotWorld(a))) as WorldSnapshot);
    for (let i = 0; i < 1500; i++) {
      tickWorld(a);
      tickWorld(b);
    }
    expect(petsOf(b)).toEqual(petsOf(a));
    expect(snapshotWorld(b).modules.pets).toEqual(snapshotWorld(a).modules.pets);
  });
});

describe('house pets: worlds saved before #9', () => {
  /** a snapshot as the live worlds stored it before pets: no pets module, no pet objects */
  function oldSnapshot(mapId: string): WorldSnapshot {
    const w = createWorld(7, { mapId });
    for (let i = 0; i < 600; i++) tickWorld(w);
    const snap = JSON.parse(JSON.stringify(snapshotWorld(w))) as WorldSnapshot;
    delete snap.modules.pets;
    snap.objects = snap.objects.filter((o) => !(PET_OBJECT_TYPES as readonly string[]).includes(o.type));
    for (const a of snap.agents) if (a.action?.kind === 'use' && !snap.objects.some((o) => o.uid === (a.action as { objectUid: number }).objectUid)) a.action = null;
    return snap;
  }

  it('load and get their pet and its objects', () => {
    for (const m of MAPS) {
      const snap = oldSnapshot(m.id);
      expect(() => checkSnapshot(snap)).not.toThrow();
      const w = restoreWorld(snap);
      expect(petsOf(w), m.id).toHaveLength(1);
      expect(w.objects.some((o) => o.type === 'pet_bowl'), m.id).toBe(true);
      const uids = w.objects.map((o) => o.uid);
      expect(new Set(uids).size, m.id).toBe(uids.length);
      for (let i = 0; i < 600; i++) tickWorld(w);
      expect(petsOf(w)[0].needs.hunger, m.id).toBeGreaterThan(0);
    }
  });

  it('migrate the same way every time (the server restores, then keeps ticking)', () => {
    const snap = oldSnapshot('jezioro');
    const a = restoreWorld(snap);
    const b = restoreWorld(snap);
    for (let i = 0; i < 1440; i++) {
      tickWorld(a);
      tickWorld(b);
    }
    expect(snapshotWorld(b)).toEqual(snapshotWorld(a));
  });

  it('still reject snapshots that miss a required module', () => {
    const snap = oldSnapshot('dom');
    delete snap.modules.diary;
    expect(() => checkSnapshot(snap)).toThrow();
  });
});
