import { describe, expect, it } from 'vitest';
import type { Agent, World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { isWalkable } from '../src/world/grid';
import { timeOf } from '../src/core/calendar';
import { NETWORK_SNAPSHOT, applySnapshot, restoreWorld, snapshotWorld } from '../src/core/state';
import { GUEST_NAMES, GUEST_TUNING, guestEntrances, guestNameOf, setGuestsEnabled } from '../src/agents/guests';
import { isGuest, residentsOf } from '../src/agents/role';
import { bedOf } from '../src/agents/home';
import { goalOf } from '../src/agents/goals';
import { diaryOf } from '../src/social/diary';
import { classifyEvent } from '../src/social/chronicle';
import { createReplayRecorder } from '../src/live/replayRecorder';
import { createReplayPlayer } from '../src/live/replayPlayer';

const DAY = 24 * 60;
const MAPS = ['dom', 'kamienica', 'jezioro', 'akademik'];

interface Sighting {
  id: number;
  name: string;
  arrived: number;
  left: number | null;
  arrivedAt: { weekday: number; hour: number };
  entrance: { x: number; y: number };
}

/** runs a world and records every guest's stay */
function watch(seed: number, days: number, mapId = 'kamienica') {
  const world = createWorld(seed, { agentCount: 6, mapId });
  const stays: Sighting[] = [];
  const open = new Map<number, Sighting>();
  let maxPresent = 0;
  const perDay = new Map<number, number>();
  for (let i = 0; i < days * DAY; i++) {
    tickWorld(world);
    const here = world.agents.filter(isGuest);
    maxPresent = Math.max(maxPresent, here.length);
    for (const g of here) {
      if (open.has(g.id)) continue;
      const t = timeOf(world);
      const s: Sighting = { id: g.id, name: g.name, arrived: world.tick, left: null, arrivedAt: { weekday: t.weekday ?? 0, hour: t.hour }, entrance: guestEntrances(world).find((v) => v.id === g.id)!.at };
      open.set(g.id, s);
      stays.push(s);
      perDay.set(t.day, (perDay.get(t.day) ?? 0) + 1);
    }
    for (const [id, s] of open) {
      if (here.some((g) => g.id === id)) continue;
      s.left = world.tick;
      open.delete(id);
    }
  }
  return { world, stays, maxPresent, perDay };
}

describe('guests (issue #7)', () => {
  it('visit a few times a day at plausible hours, stay bounded and always leave', () => {
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const { world, stays, maxPresent, perDay } = watch(seed, 10);
      total += stays.length;
      expect(stays.length).toBeGreaterThan(0);
      expect(maxPresent).toBeLessThanOrEqual(GUEST_TUNING.MAX_PRESENT);
      for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(GUEST_TUNING.MAX_VISITS_PER_DAY + GUEST_TUNING.MAX_PRESENT);
      for (const s of stays) {
        if (s.left === null) continue;
        const kind = s.name === 'Kurier' ? 'courier' : ['Halina', 'Józef'].includes(s.name) ? 'neighbour' : 'friend';
        const stay = s.left - s.arrived;
        if (kind === 'courier') {
          expect(stay).toBeLessThan(60);
          expect(s.arrivedAt.hour).toBeGreaterThanOrEqual(9);
          expect(s.arrivedAt.hour).toBeLessThan(17);
        }
        if (kind === 'friend') expect([4, 5, 6]).toContain(s.arrivedAt.weekday);
        expect(stay).toBeLessThan(5 * 60);
      }
      // nobody is left on the map at night
      expect(world.agents.filter(isGuest).length === 0 || timeOf(world).hour >= 7).toBe(true);
    }
    // "a few per day" overall: not zero, not a crowd
    expect(total / 30).toBeGreaterThan(0.3);
    expect(total / 30).toBeLessThan(4);
  });

  it('are deterministic for a seed', () => {
    const a = watch(7, 4).stays.map((s) => `${s.id}@${s.arrived}-${s.left}`);
    const b = watch(7, 4).stays.map((s) => `${s.id}@${s.arrived}-${s.left}`);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('enter from the map edge, on every map', () => {
    for (const mapId of MAPS) {
      const { world, stays } = watch(11, 6, mapId);
      expect(stays.length, mapId).toBeGreaterThan(0);
      const w = world.grid.width;
      const h = world.grid.height;
      for (const s of stays) {
        const { x, y } = s.entrance;
        expect(x === 0 || y === 0 || x === w - 1 || y === h - 1, `${mapId} ${s.name} at ${x},${y}`).toBe(true);
        expect(isWalkable(world.grid, x, y)).toBe(true);
      }
    }
  });

  it('have no bed, goal or diary and never sleep or end up in the residents list', () => {
    const world = createWorld(3, { agentCount: 6, mapId: 'kamienica' });
    const residents = residentsOf(world).length;
    let seen = 0;
    for (let i = 0; i < 8 * DAY; i++) {
      tickWorld(world);
      expect(residentsOf(world).length).toBe(residents);
      for (const g of world.agents.filter(isGuest)) {
        seen++;
        expect(g.role).toBe('guest');
        expect(bedOf(g)).toBeUndefined();
        expect(goalOf(g, world)).toBeUndefined();
        expect(g.action?.label ?? '').not.toMatch(/spi|sen/i);
        expect(g.needs.energy).toBeGreaterThan(40);
      }
    }
    expect(seen).toBeGreaterThan(0);
    for (const id of GUEST_NAMES.map((_, i) => 1000 + i)) expect(diaryOf(world, id)).toEqual([]);
    expect(guestNameOf(1003)).toBe('Agata');
  });

  it('can be switched off', () => {
    const world = createWorld(3, { agentCount: 6, mapId: 'kamienica', guests: false });
    for (let i = 0; i < 6 * DAY; i++) tickWorld(world);
    expect(world.agents.some(isGuest)).toBe(false);
    const again = createWorld(3, { agentCount: 6, mapId: 'kamienica' });
    setGuestsEnabled(again, false);
    for (let i = 0; i < 2 * DAY; i++) tickWorld(again);
    expect(again.agents.some(isGuest)).toBe(false);
  });

  it('survive a network snapshot: applySnapshot adds and removes them in place', () => {
    const world = createWorld(5, { agentCount: 6, mapId: 'kamienica' });
    let withGuest: World | undefined;
    for (let i = 0; i < 10 * DAY && !withGuest; i++) {
      tickWorld(world);
      if (world.agents.some(isGuest)) withGuest = world;
    }
    expect(withGuest).toBeDefined();
    const snap = snapshotWorld(world, NETWORK_SNAPSHOT);
    const copy = restoreWorld(snap);
    expect(copy.agents.filter(isGuest).map((a) => a.id)).toEqual(world.agents.filter(isGuest).map((a) => a.id));

    // an older frame (no guests yet) removes the guest again, a newer one brings it back
    const empty = createWorld(5, { agentCount: 6, mapId: 'kamienica' });
    const before = snapshotWorld(empty, NETWORK_SNAPSHOT);
    const agentsRef = copy.agents;
    applySnapshot(copy, before);
    expect(copy.agents).toBe(agentsRef);
    expect(copy.agents.some(isGuest)).toBe(false);
    applySnapshot(copy, snap);
    expect(copy.agents.some(isGuest)).toBe(true);
    const g = copy.agents.find(isGuest) as Agent;
    expect(g.name).toBe(world.agents.find((a) => a.id === g.id)?.name);
  });

  it('are shown by the replay at the ticks they were on the map', () => {
    const world = createWorld(5, { agentCount: 6, mapId: 'kamienica' });
    const rec = createReplayRecorder('kamienica');
    const live = new Map<number, number[]>();
    for (let i = 0; i < 6 * DAY; i++) {
      tickWorld(world);
      rec.record(world, 12.5);
      if (world.tick % 11 === 0) live.set(world.tick, world.agents.filter(isGuest).map((a) => a.id));
    }
    const data = rec.data(0);
    const player = createReplayPlayer(restoreWorld(snapshotWorld(world, NETWORK_SNAPSHOT)), data);
    let withGuests = 0;
    for (const [tick, ids] of live) {
      if (tick < data.fromTick) continue;
      player.seek(tick);
      expect(player.world.agents.filter(isGuest).map((a) => a.id).sort()).toEqual([...ids].sort());
      if (ids.length) withGuests++;
    }
    expect(withGuests).toBeGreaterThan(5);
  });

  it('go into the chronicle as visits, in Polish without gendered forms', () => {
    const coffee = classifyEvent({ tick: 600, kind: 'info', text: 'Wizyta: Halina wpada na kawę ☕', agentIds: [1000] });
    const parcel = classifyEvent({ tick: 600, kind: 'info', text: 'Wizyta: Kurier przywozi paczkę 📦', agentIds: [1002] });
    expect(coffee?.kind).toBe('visit');
    expect(parcel?.kind).toBe('visit');
    expect(parcel!.weight).toBeLessThan(coffee!.weight);
  });
});
