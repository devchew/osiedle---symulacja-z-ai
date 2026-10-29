import type { SimControls, World } from '../types';
import { createLoop } from '../core/loop';
import { formatClock, timeFromTick } from '../core/time';
import { snapshotWorld, NETWORK_SNAPSHOT, type WorldSnapshot } from '../core/state';
import { tickWorld } from '../world/world';
import { formatTrace } from '../world/trace';
import { projectsOf } from '../world/projects';
import type { WeatherSample } from '../world/incidents';
import { createView, type View } from '../ui/view';
import { createSandboxBar } from '../ui/places';
import { el } from '../ui/dom';
import '../ui/debug';
import { placeById, type PlaceId } from './protocol';
import { fetchSnapshot } from './client';
import { forkWorld, liveWeatherSample } from './frames';
import { livePath } from './routes';
import { bindHashSelection } from './hashSelect';

// Sandbox ("🔮 Co będzie dalej?"): a copy of a live world taken now, running in this browser tab
// with pause and 1×–8×. It never goes back to the server. The copy is kept in sessionStorage, so
// reloading the tab continues it; a new tab or "⟳ Nowa kopia" starts from the live world again.

const STORE_KEY = 'osiedle.sandbox.v1';
const SAVE_EVERY_MS = 10_000;

export const SANDBOX_HELP: [string, string][] = [
  ['Spacja', 'pauza / wznów'],
  ['1–4', 'prędkość 1× · 2× · 4× · 8×'],
  ['T', 'statystyki: relacje, nastrój'],
  ['P', 'pamiętniki mieszkańców (← → dni)'],
  ['B', 'projekty budowlane'],
  ['przeciągnij', 'przesuń widok'],
  ['WASD / strzałki', 'przesuń widok'],
  ['kółko / szczypnięcie', 'przybliż i oddal'],
  ['klik', 'szczegóły postaci'],
  ['dwuklik', 'śledź postać kamerą'],
  ['Esc', 'zamknij panel'],
];
const SANDBOX_NOTE = 'To Twoja prywatna kopia: zmiany zostają w tej karcie. Świat na żywo toczy się dalej bez zmian.';

interface StoredFork {
  v: 1;
  place: PlaceId;
  /** tick of the live world when copied */
  forkTick: number;
  /** server time of the copy (ms) */
  forkedAt: number;
  /** live weather kept for the first game hour */
  sample: WeatherSample | null;
  snapshot: WorldSnapshot;
}

function readStored(place: PlaceId): StoredFork | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredFork;
    return s?.v === 1 && s.place === place && s.snapshot ? s : null;
  } catch {
    return null;
  }
}

function writeStored(s: StoredFork): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable: a reload starts a new copy */
  }
}

function clearStored(): void {
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

const when = (tick: number): string => {
  const t = timeFromTick(tick);
  return `dzień ${t.day}, ${formatClock(t)}`;
};

export async function startSandbox(place: PlaceId): Promise<void> {
  const def = placeById(place)!;
  document.title = `🔮 ${def.name} — co będzie dalej?`;
  const loading = el('div', 'ui-panel ui-loading', [el('span', 'conn-spinner'), `Kopiuję świat: ${def.name}…`]);
  loading.setAttribute('role', 'status');
  document.body.append(loading);

  let fork = readStored(place);
  let world: World;
  if (fork) world = forkWorld(fork.snapshot, fork.sample, fork.forkTick);
  else {
    try {
      const frame = await fetchSnapshot(place);
      const sample = liveWeatherSample(frame);
      world = forkWorld(frame.snapshot, sample);
      fork = { v: 1, place, forkTick: frame.snapshot.tick, forkedAt: frame.meta.serverTime, sample, snapshot: frame.snapshot };
    } catch (err) {
      console.error(err);
      const back = el('a', 'sbx-back', ['↩ Wróć na żywo']);
      back.href = livePath(place);
      const retry = el('button', 'sbx-refork', ['Spróbuj ponownie']);
      retry.type = 'button';
      retry.addEventListener('click', () => location.reload());
      loading.replaceChildren(el('p', '', ['Nie udało się skopiować świata — serwer nie odpowiada.']), el('div', 'sbx-actions', [back, retry]));
      return;
    }
  }
  const meta = fork;
  loading.remove();

  let view!: View;
  const step = (): void => {
    tickWorld(world);
    view.history.record(world);
  };
  const loop = createLoop({ ticksPerSecond: 5, tick: step, render: (alpha) => view.renderer.render(alpha) });
  const controls: SimControls = {
    get paused() {
      return loop.paused;
    },
    get speed() {
      return loop.speed;
    },
    setPaused: (p) => loop.setPaused(p),
    setSpeed: (s) => loop.setSpeed(s),
    time: () => timeFromTick(world.tick),
  };

  const hash = bindHashSelection(
    () => world,
    (id) => view.select(id),
  );
  view = createView({
    world,
    controls,
    showPopulation: false,
    insets: { wide: { top: 76, right: 16, bottom: 16, left: 284 }, narrow: { top: 120, right: 8, bottom: 110, left: 8 } },
    help: { keys: SANDBOX_HELP, note: SANDBOX_NOTE },
    onSelect: (id) => hash.onSelect(id),
  });
  view.history.record(world);
  document.getElementById('hud')?.classList.add('is-sandbox');

  createSandboxBar({
    placeName: def.name,
    forkedAt: when(meta.forkTick),
    backHref: livePath(place),
    onBack: () => {
      clearStored();
      location.assign(livePath(place));
    },
    onRefork: () => {
      clearStored();
      location.reload();
    },
  });

  // keep the copy for a reload of this tab
  const save = (): void => writeStored({ ...meta, snapshot: snapshotWorld(world, NETWORK_SNAPSHOT) });
  save();
  setInterval(save, SAVE_EVERY_MS);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  hash.apply();
  loop.start();

  window.__sim = {
    mode: 'sandbox',
    world,
    controls,
    renderer: view.renderer,
    select: view.select,
    tick: (n) => {
      for (let i = 0; i < n; i++) step();
    },
    stats: view.stats,
    diary: view.diary,
    projects: view.projects,
    projectList: () => projectsOf(world),
    trace: (agentId) => formatTrace(world, agentId),
    snapshot: () => snapshotWorld(world, NETWORK_SNAPSHOT),
    place,
  };
}
