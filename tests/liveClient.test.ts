import { describe, expect, it } from 'vitest';
import { agentFromHash, hashFor, parseRoute, sandboxPath, slug } from '../src/live/routes';
import { backoffDelay, parseFrame } from '../src/live/client';
import { applyFrame, forkWorld, liveWeatherSample } from '../src/live/frames';
import { createWorld, tickWorld } from '../src/world/world';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../src/core/state';
import { isRealtime } from '../src/realtime/state';
import { weatherOf } from '../src/world/incidents';
import type { LiveFrame } from '../src/live/protocol';

describe('live routes', () => {
  it('maps paths to modes and places', () => {
    expect(parseRoute('/')).toEqual({ kind: 'live', place: 'dom' });
    expect(parseRoute('/kamienica')).toEqual({ kind: 'live', place: 'kamienica' });
    expect(parseRoute('/Akademik/')).toEqual({ kind: 'live', place: 'akademik' });
    expect(parseRoute('/nieznane')).toEqual({ kind: 'live', place: 'dom' });
    expect(parseRoute('/sandbox', '?from=jezioro')).toEqual({ kind: 'sandbox', place: 'jezioro' });
    expect(parseRoute('/sandbox', '?from=xyz')).toEqual({ kind: 'sandbox', place: 'dom' });
    expect(parseRoute('/lab', '?seed=7')).toEqual({ kind: 'lab' });
    expect(sandboxPath('kamienica')).toBe('/sandbox?from=kamienica');
  });

  it('finds residents by hash name (any case, diacritics) or id', () => {
    const agents = [
      { id: 0, name: 'Ola' },
      { id: 3, name: 'Łucja' },
    ];
    expect(agentFromHash('#ola', agents)?.id).toBe(0);
    expect(agentFromHash(`#${encodeURIComponent('Łucja')}`, agents)?.id).toBe(3);
    expect(agentFromHash('#lucja', agents)?.id).toBe(3);
    expect(agentFromHash('#3', agents)?.id).toBe(3);
    expect(agentFromHash('#nikt', agents)).toBeNull();
    expect(agentFromHash('', agents)).toBeNull();
    expect(hashFor({ name: 'Łucja' })).toBe(`#${encodeURIComponent('Łucja')}`);
    expect(slug('ŁÓDŹ')).toBe('lodz');
  });
});

describe('live client', () => {
  it('backs off exponentially with a cap', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, 1000, 30_000, mid)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, mid)).toBe(8000);
    expect(backoffDelay(20, 1000, 30_000, mid)).toBe(30_000);
  });

  it('rejects malformed frames', () => {
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame('{"meta":{}}')).toBeNull();
  });
});

function frameOf(world: ReturnType<typeof createWorld>): LiveFrame {
  return {
    meta: {
      place: 'jezioro',
      serverTime: Date.now(),
      tick: world.tick,
      weather: { city: 'Giżycko', temperature: 12, source: 'open-meteo', updatedAt: Date.now() },
      ai: false,
      news: false,
    },
    snapshot: JSON.parse(JSON.stringify(snapshotWorld(world, NETWORK_SNAPSHOT))),
  };
}

describe('live frames', () => {
  it('builds a real-time world from frames and follows the server', () => {
    const server = createWorld(1410, { agentCount: 4, mapId: 'jezioro' });
    for (let i = 0; i < 30; i++) tickWorld(server);
    const first = applyFrame(null, null, frameOf(server));
    expect(first.swapped).toBe(true);
    expect(first.world.tick).toBe(30);
    expect(isRealtime(first.world)).toBe(true);
    tickWorld(server);
    const next = applyFrame(first.world, 'jezioro', frameOf(server));
    expect(next.world.tick).toBe(31);
    expect(next.world.agents.map((a) => a.pos)).toEqual(server.agents.map((a) => a.pos));
    expect(isRealtime(next.world)).toBe(true);
  });

  it('uses the weather the server saw', () => {
    const server = createWorld(1410, { agentCount: 4, mapId: 'jezioro' });
    tickWorld(server);
    const f = frameOf(server);
    const sample = liveWeatherSample(f);
    expect(sample?.kind).toBe(weatherOf(server).kind);
    const sent = { ...f, meta: { ...f.meta, weather: { ...f.meta.weather, sample: { kind: 'storm', intensity: 1 } } } } as LiveFrame;
    expect(weatherOf(applyFrame(null, null, sent).world).kind).toBe('storm');
  });

  it('a sandbox fork runs on its own and leaves the source untouched', () => {
    const server = createWorld(1912, { agentCount: 8, mapId: 'kamienica' });
    for (let i = 0; i < 20; i++) tickWorld(server);
    const f = frameOf(server);
    const before = JSON.stringify(f.snapshot);
    const fork = forkWorld(f.snapshot, { kind: 'rain', intensity: 0.6 });
    for (let i = 0; i < 120; i++) tickWorld(fork);
    expect(fork.tick).toBe(140);
    expect(isRealtime(fork)).toBe(false);
    expect(JSON.stringify(f.snapshot)).toBe(before);
    expect(server.tick).toBe(20);
  });
});
