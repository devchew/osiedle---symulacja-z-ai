import './realtime.css';
import type { SimControls, World } from '../types';
import type { Loop } from '../core/loop';
import { setWeatherOverride } from '../world/incidents';
import { replayTo } from '../ui/replay';
import { el } from '../ui/dom';
import { baseDayFor, catchUp, localTimeOf, minuteFraction, targetTick } from './clock';
import { markRealtime, updateRealtimeStatus, type RealtimeStatus } from './state';
import { DEFAULT_LOCATION, fetchRealWeather, reverseGeocode, weatherSource, type RealWeather } from './weather';

// Real-time mode: the game clock follows the local clock and the weather follows real weather.
//
// Clock: on start the world is fast-forwarded from tick 0 (day 1, 07:00) to the
// current local time; afterwards a per-frame driver computes the target tick
// from the wall clock and steps until caught up (a slice per frame, or a
// chunked fast-forward with the replay overlay when more than 3 h behind —
// sleeping tab, long pause). Speed is locked at 1 (1 tick = 1 real minute).
// Pause is allowed: it freezes the simulation; on resume the driver catches up
// to the wall clock again, so the clock never stays out of sync.
//
// Weather: Open-Meteo for the browser's location (asked politely), ?lat=&lon=,
// or Warsaw; refreshed every 15 min and fed to incidents' weather override.

export interface RealtimeOptions {
  world: World;
  loop: Loop;
  controls: SimControls;
  /** advances the simulation by one tick (also records UI history) */
  step(): void;
  /** where to mount UI hints (e.g. location prompt) */
  parent: HTMLElement;
}

/**
 * optional loop hook (see the wave 7 notes): when set, the loop calls the driver
 * every frame instead of its own accumulator and renders with the returned alpha
 */
type FrameDriver = (now: number) => number;
type DrivableLoop = Loop & { setDriver?(driver: FrameDriver | null): void };

const WEATHER_REFRESH_MS = 15 * 60_000;
const LOCATION_KEY = 'sim.realtime.location';
const PROMPT_TIMEOUT_MS = 20_000;

interface Coords {
  lat: number;
  lon: number;
}

function parseCoords(params: URLSearchParams): Coords | null {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!params.has('lat') || !params.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

type StoredChoice = { kind: 'gps'; lat: number; lon: number } | { kind: 'declined' } | null;

function readChoice(): StoredChoice {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    return raw ? (JSON.parse(raw) as StoredChoice) : null;
  } catch {
    return null;
  }
}

function storeChoice(c: StoredChoice): void {
  try {
    if (c) localStorage.setItem(LOCATION_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable: ask again next time */
  }
}

function getPosition(timeoutMs: number): Promise<Coords | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 30 * 60_000, enableHighAccuracy: false },
    );
  });
}

async function permissionState(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions?.query({ name: 'geolocation' }))?.state ?? null;
  } catch {
    return null;
  }
}

/** small Polish prompt: use my location? resolves true (yes) / false (no, dismissed or timed out) */
function askForLocation(parent: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    const yes = el('button', 'rt-btn rt-btn--primary', ['📍 Użyj mojej lokalizacji']);
    const no = el('button', 'rt-btn', ['Nie, Warszawa']);
    yes.type = 'button';
    no.type = 'button';
    const box = el('div', 'ui-panel rt-prompt', [
      el('div', 'rt-prompt-title', ['⏱ Tryb na żywo']),
      el('p', 'rt-prompt-text', ['Pogoda w grze może być taka jak za Twoim oknem. Pokazać pogodę z Twojej okolicy?']),
      el('div', 'rt-prompt-actions', [yes, no]),
      el('p', 'rt-prompt-note', ['Współrzędne trafią tylko do Open-Meteo (pogoda) i BigDataCloud (nazwa miejscowości); zapamiętamy je wyłącznie w tej przeglądarce.']),
    ]);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Lokalizacja dla pogody');
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      box.remove();
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), PROMPT_TIMEOUT_MS);
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => {
      storeChoice({ kind: 'declined' });
      finish(false);
    });
    parent.append(box);
  });
}

function note(parent: HTMLElement, text: string): void {
  const n = el('div', 'ui-panel rt-prompt rt-note', [text]);
  n.setAttribute('role', 'status');
  parent.append(n);
  setTimeout(() => n.remove(), 5000);
}

/** switches the running simulation into real-time mode; resolves once synced */
export async function startRealtime(opts: RealtimeOptions): Promise<void> {
  const { world, controls, step, parent } = opts;
  const loop = opts.loop as DrivableLoop;
  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- location + weather
  const fromUrl = parseCoords(params);
  const stored = fromUrl ? null : readChoice();
  let source: RealtimeStatus['source'] = 'default';
  let coords: Coords = { lat: DEFAULT_LOCATION.lat, lon: DEFAULT_LOCATION.lon };
  if (fromUrl) {
    coords = fromUrl;
    source = 'url';
  } else if (stored?.kind === 'gps') {
    coords = { lat: stored.lat, lon: stored.lon };
    source = 'gps';
  }
  const status: RealtimeStatus = {
    place: source === 'default' ? `${DEFAULT_LOCATION.name} (domyślnie)` : `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`,
    lat: coords.lat,
    lon: coords.lon,
    source,
    temperature: null,
    weatherUpdatedAt: null,
  };
  markRealtime(world, status);

  const now0 = localTimeOf(new Date());
  const baseDay = baseDayFor(now0);
  let real: RealWeather | null = null;
  setWeatherOverride(
    world,
    weatherSource(
      () => real,
      () => baseDay,
    ),
  );

  let fetchId = 0;
  async function refreshWeather(): Promise<void> {
    const id = ++fetchId;
    const { lat, lon } = coords;
    try {
      const w = await fetchRealWeather(lat, lon);
      if (id !== fetchId) return; // the location changed meanwhile
      real = w;
      updateRealtimeStatus(world, { temperature: w.current?.temperature ?? null, weatherUpdatedAt: Date.now() });
    } catch {
      // keep the last reading (or the seeded plan when there is none)
    }
  }
  async function refreshPlace(): Promise<void> {
    if (status.source === 'default') return;
    const { lat, lon } = coords;
    const name = await reverseGeocode(lat, lon);
    if (name && coords.lat === lat && coords.lon === lon) updateRealtimeStatus(world, { place: name });
  }
  async function useCoords(c: Coords, src: RealtimeStatus['source']): Promise<void> {
    coords = c;
    updateRealtimeStatus(world, { lat: c.lat, lon: c.lon, source: src, place: `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}` });
    await Promise.all([refreshWeather(), refreshPlace()]);
  }

  // first reading before the fast-forward, so the hours already behind us get their real weather too
  await refreshWeather();
  void refreshPlace();
  setInterval(() => void refreshWeather(), WEATHER_REFRESH_MS);

  // ask for the browser's location without blocking the start (Warsaw until answered)
  if (!fromUrl && !stored) {
    void (async () => {
      const perm = await permissionState();
      if (perm === 'denied') return;
      if (perm !== 'granted' && !(await askForLocation(parent))) return;
      const pos = await getPosition(10_000);
      if (!pos) {
        note(parent, 'Nie udało się ustalić lokalizacji — pogoda dla Warszawy.');
        return;
      }
      storeChoice({ kind: 'gps', lat: pos.lat, lon: pos.lon });
      await useCoords(pos, 'gps');
    })();
  }

  // ---------------------------------------------------------------- clock
  let userPaused = false;
  let fastForwarding = false;
  const behind = (): number => targetTick(localTimeOf(new Date()), baseDay) - world.tick;

  async function fastForward(): Promise<void> {
    if (fastForwarding) return;
    fastForwarding = true;
    try {
      // the target moves on while we replay: loop until within a live step
      for (let i = 0; i < 3 && behind() > 0; i++) await replayTo(world, world.tick + behind(), { step, parent });
    } finally {
      fastForwarding = false;
    }
  }

  // speed locked at 1×; pause stops the simulation, resume catches up with the wall clock
  Object.defineProperties(controls, {
    paused: { get: () => userPaused, configurable: true },
    speed: { get: () => 1, configurable: true },
    setPaused: { value: (p: boolean) => void (userPaused = p), configurable: true, writable: true },
    setSpeed: { value: () => {}, configurable: true, writable: true },
  });

  const driver: FrameDriver = () => {
    if (userPaused || fastForwarding) return 1;
    const c = catchUp(behind());
    if (c.mode === 'fastForward') {
      void fastForward();
      return 1;
    }
    if (c.mode === 'step') for (let i = 0; i < c.ticks; i++) step();
    return behind() === 0 ? minuteFraction(new Date()) : 1;
  };

  // initial sync: day 1 07:00 → now
  await fastForward();

  if (loop.setDriver) loop.setDriver(driver);
  else {
    // no loop hook: stop the loop's own accumulator (it keeps rendering) and drive the ticks ourselves;
    // rendering then shows whole ticks (alpha 1) — no interpolation within the minute
    loop.setPaused(true);
    const frame = (): void => {
      driver(performance.now());
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
