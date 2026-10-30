import { describe, expect, it } from 'vitest';
import { agentFromHash, hashFor, parseRoute, slug } from '../src/live/routes';
import { backoffDelay, parseFrame } from '../src/live/client';
import { applyFrame, liveWeatherSample } from '../src/live/frames';
import { createWorld, tickWorld } from '../src/world/world';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../src/core/state';
import { isRealtime } from '../src/realtime/state';
import { weatherOf } from '../src/world/incidents';
import { staticSignature } from '../src/render/tiles';
import type { LiveFrame } from '../src/live/protocol';

describe('live routes', () => {
  it('maps paths to modes and places', () => {
    expect(parseRoute('/')).toEqual({ kind: 'live', place: 'dom' });
    expect(parseRoute('/kamienica')).toEqual({ kind: 'live', place: 'kamienica' });
    expect(parseRoute('/Akademik/')).toEqual({ kind: 'live', place: 'akademik' });
    expect(parseRoute('/nieznane')).toEqual({ kind: 'live', place: 'dom' });
    expect(parseRoute('/sandbox')).toEqual({ kind: 'live', place: 'dom' });
    expect(parseRoute('/lab')).toEqual({ kind: 'live', place: 'dom' });
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
    expect(next.swapped).toBe(false);
    expect(next.world).toBe(first.world);
    expect(next.world.tick).toBe(31);
    expect(next.world.agents.map((a) => a.pos)).toEqual(server.agents.map((a) => a.pos));
    expect(isRealtime(next.world)).toBe(true);
  });

  it('the static layer signature follows what is drawn, not who uses it', () => {
    const w = createWorld(1410, { agentCount: 4, mapId: 'jezioro' });
    const before = staticSignature(w);
    w.objects[0].reservedBy = [3];
    expect(staticSignature(w)).toBe(before);
    // a construction stage swap keeps the name length but changes the picture
    const t = w.objects[0].type;
    w.objects[0].type = t.slice(0, -1) + (t.endsWith('x') ? 'y' : 'x');
    expect(staticSignature(w)).not.toBe(before);
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

  it('shows the exact weather sample the server sent (intensity, label, icon)', () => {
    const server = createWorld(1410, { agentCount: 4, mapId: 'jezioro' });
    tickWorld(server);
    const f = frameOf(server);
    const drizzle = { kind: 'rain', intensity: 0.17, label: 'Mżawka', icon: '🌦️' } as const;
    const sent = { ...f, meta: { ...f.meta, weather: { ...f.meta.weather, sample: drizzle } } } as LiveFrame;
    expect(weatherOf(applyFrame(null, null, sent).world)).toMatchObject({ ...drizzle, raining: true });
  });
});
