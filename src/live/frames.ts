import type { World } from '../types';
import * as state from '../core/state';
import { restoreWorld, type WorldSnapshot } from '../core/state';
import '../world/world'; // registers the world base and every module's state codec (restoreWorld needs them)
import { setWeatherOverride, type WeatherKind, type WeatherSample } from '../world/incidents';
import { markRealtime } from '../realtime/state';
import { placeById, type LiveFrame, type LiveMeta } from './protocol';

// Turning live frames into a World the renderer and the panels can show.
//
// The first frame builds the world (restoreWorld). Every later frame of the same place is applied
// in place when core/state provides `applySnapshot(world, snap)` (same World object: panels,
// listeners and WeakMap state keep working); otherwise a fresh world is restored and the caller
// swaps it into the view (setWorld). The live world is never ticked in the browser.
//
// Hooks are not part of a snapshot: after each frame the live weather override (the server's real
// weather) and the real-time flag (renderer: residents walk at real speed) are attached again.

type ApplyFn = (world: World, snap: WorldSnapshot) => void;

/** core/state's in-place apply, when this build has it */
function inPlaceApply(): ApplyFn | null {
  // looked up by a computed name: the bundler would warn about a missing export otherwise
  const name = ['apply', 'Snapshot'].join('');
  const fn = (state as unknown as Record<string, ApplyFn | undefined>)[name];
  return typeof fn === 'function' ? fn : null;
}

export interface FrameResult {
  world: World;
  /** true when `world` is a different object than before (the view must swap it in) */
  swapped: boolean;
}

/**
 * the world after `frame`: `current` updated in place when possible, else a new one.
 * `current` = null (first frame) or a world of another place always restores.
 */
export function applyFrame(current: World | null, currentPlace: string | null, frame: LiveFrame): FrameResult {
  const apply = inPlaceApply();
  let world: World;
  let swapped = true;
  if (current && apply && currentPlace === frame.meta.place) {
    apply(current, frame.snapshot);
    world = current;
    swapped = false;
  } else world = restoreWorld(frame.snapshot);
  attachLive(world, frame);
  return { world, swapped };
}

const KINDS: readonly WeatherKind[] = ['sunny', 'cloudy', 'rain', 'storm'];
const DEFAULT_INTENSITY: Record<WeatherKind, number> = { sunny: 0, cloudy: 0.5, rain: 0.6, storm: 1 };

/**
 * the weather the server shows right now: `meta.weather.sample` when the server sends it (preferred),
 * else the kind the server's incidents module saw last (in the snapshot), else null (seeded plan)
 */
export function liveWeatherSample(frame: LiveFrame): WeatherSample | null {
  const w = frame.meta.weather as LiveMeta['weather'] & { sample?: WeatherSample | null };
  if (w?.sample && KINDS.includes(w.sample.kind)) return { ...w.sample };
  const inc = frame.snapshot.modules?.incidents as { last?: unknown } | null | undefined;
  const last = inc && typeof inc === 'object' ? inc.last : null;
  if (typeof last === 'string' && (KINDS as readonly string[]).includes(last)) {
    const kind = last as WeatherKind;
    return { kind, intensity: DEFAULT_INTENSITY[kind] };
  }
  return null;
}

/** marks a world restored from a live frame: real-time view, the server's weather, place/temperature for the HUD */
export function attachLive(world: World, frame: LiveFrame): void {
  const sample = liveWeatherSample(frame);
  if (sample) setWeatherOverride(world, () => sample);
  const def = placeById(frame.meta.place);
  const w = frame.meta.weather;
  markRealtime(world, {
    place: w?.city ?? def?.city ?? '',
    lat: def?.lat ?? 0,
    lon: def?.lon ?? 0,
    source: 'url',
    temperature: w?.temperature ?? null,
    weatherUpdatedAt: w?.updatedAt ?? null,
  });
}
