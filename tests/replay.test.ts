import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createWorld, tickWorld } from '../src/world/world';
import { restoreWorld, snapshotWorld, NETWORK_SNAPSHOT } from '../src/core/state';
import type { World } from '../src/types';
import { createReplayRecorder, REPLAY_MAX_EVENTS, REPLAY_WINDOW_TICKS } from '../src/live/replayRecorder';
import { createReplayPlayer, REPLAY_SPEEDS } from '../src/live/replayPlayer';

const r1 = (n: number): number => Math.round(n * 10) / 10;

function observe(w: World) {
  return {
    agents: w.agents.map((a) => ({
      id: a.id,
      x: r1(a.pos.x),
      y: r1(a.pos.y),
      action: a.action ? `${a.action.kind}:${a.action.label}` : null,
      bubble: a.bubble?.text ?? null,
    })),
    events: w.events.slice(-30).map((e) => `${e.tick}|${e.text}`),
  };
}

function run(seed: number, agentCount: number, ticks: number, windowTicks?: number) {
  const world = createWorld(seed, { agentCount, mapId: 'kamienica' });
  const rec = createReplayRecorder('kamienica', windowTicks);
  const seen = new Map<number, ReturnType<typeof observe>>();
  for (let i = 0; i < ticks; i++) {
    tickWorld(world);
    rec.record(world, 12.5);
    if (world.tick % 37 === 0) seen.set(world.tick, observe(world));
  }
  return { world, rec, seen };
}

describe('replay recording', () => {
  it('fits well under 1 MB for a busy 24 h (8 residents), raw and gzipped', () => {
    const { rec, world } = run(1912, 8, REPLAY_WINDOW_TICKS);
    const json = JSON.stringify(rec.data(Date.now()));
    expect(world.tick).toBe(REPLAY_WINDOW_TICKS);
    expect(json.length).toBeLessThan(1_000_000);
    expect(gzipSync(json).length).toBeLessThan(300_000);
  });

  it('stays bounded: a long run keeps only the last 24 h and a capped event list', () => {
    const { rec, world } = run(1912, 8, REPLAY_WINDOW_TICKS * 2 + 200);
    const data = rec.data(0);
    expect(data.toTick).toBe(world.tick);
    expect(data.toTick - data.fromTick).toBeLessThanOrEqual(REPLAY_WINDOW_TICKS);
    expect(data.fromTick).toBeGreaterThanOrEqual(world.tick - REPLAY_WINDOW_TICKS - 1);
    expect(data.events.every((e) => e[0] >= data.fromTick)).toBe(true);
    expect(data.events.length).toBeLessThanOrEqual(REPLAY_MAX_EVENTS);
    // another day of the same run does not grow the recording
    const more = run(1912, 8, REPLAY_WINDOW_TICKS * 3 + 200);
    expect(JSON.stringify(more.rec.data(0)).length).toBeLessThan(JSON.stringify(data).length * 1.3);
  });

  it('replays what the world showed live: positions, actions, bubbles and the event log', () => {
    const { world, rec, seen } = run(1912, 8, REPLAY_WINDOW_TICKS + 400);
    const data = rec.data(0);
    const player = createReplayPlayer(restoreWorld(snapshotWorld(world, NETWORK_SNAPSHOT)), data);
    let compared = 0;
    let withEvents = 0;
    for (const [tick, expected] of seen) {
      if (tick < data.fromTick) continue;
      player.seek(tick);
      expect(player.tick).toBe(tick);
      const got = observe(player.world);
      expect(got.agents).toEqual(expected.agents);
      // the log of the window starts empty: older events belong to the previous 24 h
      const fromWindow = (e: string): boolean => Number(e.split('|')[0]) >= data.fromTick;
      expect(got.events.filter(fromWindow)).toEqual(expected.events.filter(fromWindow));
      withEvents += got.events.filter(fromWindow).length > 0 ? 1 : 0;
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
    expect(withEvents).toBeGreaterThan(10);
    // the live world itself is untouched by building and playing a replay
    expect(world.tick).toBe(REPLAY_WINDOW_TICKS + 400);
  });

  it('survives a JSON round trip and a restart (restore + rewind re-records the same ticks)', () => {
    const { rec } = run(2026, 6, 300);
    const saved = JSON.parse(JSON.stringify(rec.data(5)));
    const again = createReplayRecorder('kamienica');
    again.restore(saved);
    expect(again.lastTick).toBe(rec.lastTick);
    expect(JSON.stringify(again.data(5))).toBe(JSON.stringify(rec.data(5)));
    again.rewind(200);
    expect(again.lastTick).toBe(200);
    // the restored world is replayed from the rewound tick: re-recording the same ticks gives the same rows
    const re = createWorld(2026, { agentCount: 6, mapId: 'kamienica' });
    const twin = createReplayRecorder('kamienica');
    for (let i = 0; i < 300; i++) {
      tickWorld(re);
      twin.record(re, 12.5);
    }
    expect(JSON.stringify(twin.data(5))).toBe(JSON.stringify(rec.data(5)));
    expect(() => again.restore({ format: 2 })).toThrow();
    expect(() => again.restore(null)).toThrow();
  });

  it('plays by wall time: speed, end of the recording and seeking', () => {
    const { world, rec } = run(1410, 4, 120);
    const data = rec.data(0);
    const player = createReplayPlayer(restoreWorld(snapshotWorld(world, NETWORK_SNAPSHOT)), data);
    expect(player.tick).toBe(data.fromTick);
    expect(player.playing).toBe(true);
    player.speed = REPLAY_SPEEDS[1];
    const alpha = player.advance(1.5);
    expect(player.tick).toBe(data.fromTick + 30);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
    player.advance(1000);
    expect(player.tick).toBe(data.toTick);
    expect(player.playing).toBe(false);
    player.setPlaying(true);
    player.advance(0);
    expect(player.tick).toBe(data.fromTick);
    player.seek(10_000_000);
    expect(player.tick).toBe(data.toTick);
    player.seek(-5);
    expect(player.tick).toBe(data.fromTick);
  });
});
