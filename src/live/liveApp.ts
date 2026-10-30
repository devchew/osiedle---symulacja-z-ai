import type { SimControls, World } from '../types';
import { createLoop } from '../core/loop';
import { timeFromTick } from '../core/time';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../core/state';
import { formatTrace } from '../world/trace';
import { projectsOf } from '../world/projects';
import { createChroniclePanel } from '../ui/chronicle';
import { createView, type View } from '../ui/view';
import { createConnBanner, createPlaceBar, placeIcon } from '../ui/places';
import { el } from '../ui/dom';
import '../ui/debug';
import { PLACES, placeById, LIVE_TIME_ZONE, type LiveFrame, type LiveMeta, type PlaceId } from './protocol';
import { connectLive, fetchChronicle, fetchPlaces, type LiveStream } from './client';
import { applyFrame } from './frames';
import { livePath, parseRoute, sandboxPath } from './routes';
import { bindHashSelection } from './hashSelect';

// Live view (the main experience): one of the four server worlds, as it is right now.
// Frames arrive over SSE once per real minute; between frames residents walk along their recorded
// trails at real speed (renderer in real-time mode) and the light follows the minute. Read-only:
// no pause, speeds, saves or AI toggle. Switching places swaps the stream and the world without
// reloading the page.

export const LIVE_HELP: [string, string][] = [
  ['T', 'statystyki: relacje, nastrój'],
  ['P', 'pamiętniki mieszkańców (← → dni)'],
  ['B', 'projekty budowlane'],
  ['K', 'kronika miejsca z ostatnich dni'],
  ['przeciągnij', 'przesuń widok'],
  ['WASD / strzałki', 'przesuń widok'],
  ['kółko / szczypnięcie', 'przybliż i oddal'],
  ['klik', 'szczegóły postaci'],
  ['dwuklik', 'śledź postać kamerą'],
  ['Esc', 'zamknij panel'],
];
const LIVE_NOTE =
  'Każde miejsce żyje na serwerze bez przerwy, w czasie rzeczywistym — wszyscy widzą ten sam świat. ' +
  '„🔮 Co będzie dalej?” kopiuje go do Twojej przeglądarki, gdzie możesz przyspieszyć czas.';

const PLACES_REFRESH_MS = 60_000;
const INSETS = {
  wide: { top: 76, right: 16, bottom: 16, left: 284 },
  narrow: { top: 104, right: 8, bottom: 110, left: 8 },
};

function clockIn(ms: number): string {
  return new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: LIVE_TIME_ZONE });
}

export function startLive(initialPlace: PlaceId): void {
  let place = initialPlace;
  let meta: LiveMeta | null = null;
  let view: View | null = null;
  let frames = 0;
  /** place whose world `view` shows (frames of another place restore a new world) */
  let shownPlace: PlaceId | null = null;
  let lastFrameAt = 0;
  /** measured real ms between frames (60 s live; faster with LIVE_SPEED on test servers) */
  let frameGap = 60_000;
  let stream: LiveStream | null = null;

  const conn = createConnBanner();
  const loading = el('div', 'ui-panel ui-loading', [el('span', 'conn-spinner'), 'Łączenie z osiedlem…']);
  loading.setAttribute('role', 'status');
  document.body.append(loading);

  const bar = createPlaceBar({
    places: PLACES,
    current: place,
    href: livePath,
    onSelect: (id) => switchPlace(id, true),
    forkHref: sandboxPath,
    onFork: (id) => location.assign(sandboxPath(id)),
  });

  const controls: SimControls = {
    paused: false,
    speed: 1,
    setPaused: () => {},
    setSpeed: () => {},
    time: () => timeFromTick(view?.world.tick ?? 0),
  };

  const hash = bindHashSelection(
    () => view?.world ?? null,
    (id) => view?.select(id),
  );

  function setTitle(): void {
    const def = placeById(place);
    document.title = def ? `${def.name} — Osiedle na żywo` : 'Osiedle na żywo';
  }

  const chronicle = createChroniclePanel(place, {
    load: fetchChronicle,
    onToggle: (open) => {
      view?.hud.setActive('chronicle', open);
      if (open) view?.panelOpened('chronicle');
    },
    onSelectAgent: (id) => view?.select(id),
    hasDiary: (id) => !!view && view.diary.entryCount(id) > 0,
    onOpenDiary: (id) => view?.diary.openFor(id),
  });

  function createLiveView(world: World): View {
    const v = createView({
      world,
      controls,
      showPopulation: false,
      insets: INSETS,
      help: { keys: LIVE_HELP, note: LIVE_NOTE },
      buttons: [{ id: 'chronicle', icon: '📜', title: 'Kronika miejsca (K)', onClick: () => chronicle.setOpen(!chronicle.isOpen) }],
      panels: [{ id: 'chronicle', setOpen: (o) => chronicle.setOpen(o) }],
      onSelect: (id) => hash.onSelect(id),
      live: {
        place: () => {
          const def = placeById(place);
          return def ? `${placeIcon(def.id)} ${def.name}` : '';
        },
        city: () => meta?.weather.city ?? placeById(place)?.city ?? '',
        temperature: () => meta?.weather.temperature ?? null,
        ai: () => !!meta?.ai,
        tooltip: () => {
          const w = meta?.weather;
          const upd = w?.updatedAt ? clockIn(w.updatedAt) : null;
          return (
            'Na żywo: ten świat działa bez przerwy na serwerze, zegar to czas w Polsce (1 minuta = 1 minuta).\n' +
            (w?.source === 'open-meteo' && upd
              ? `Pogoda prawdziwa: ${w.city} · Open-Meteo, aktualizacja ${upd}.`
              : `Brak aktualnej pogody dla: ${w?.city ?? '—'} — pogoda symulowana.`)
          );
        },
      },
    });
    const loop = createLoop({ ticksPerSecond: 1, tick: () => {}, render: (alpha) => v.renderer.render(alpha) });
    // no ticking in the browser: render only, the light glides through the minute until the next frame
    loop.setDriver(() => (lastFrameAt ? Math.min(1, (performance.now() - lastFrameAt) / frameGap) : 1));
    loop.start();
    v.hud.setActive('chronicle', chronicle.isOpen);
    return v;
  }

  function onFrame(frame: LiveFrame): void {
    if (frame.meta.place !== place) return; // a late frame of the place we just left
    const now = performance.now();
    if (lastFrameAt && shownPlace === place) {
      const gap = now - lastFrameAt;
      if (gap > 200 && gap < 120_000) frameGap += (gap - frameGap) * 0.5;
    }
    lastFrameAt = now;
    meta = frame.meta;
    let res;
    try {
      res = applyFrame(view?.world ?? null, shownPlace, frame);
    } catch (err) {
      // incompatible snapshot (server and client from different builds): ask for a reload
      console.error(err);
      conn.set('offline');
      loading.textContent = 'Strona została zaktualizowana — odśwież ją, by zobaczyć osiedle.';
      loading.hidden = false;
      return;
    }
    const samePlace = shownPlace === place;
    if (!view) {
      view = createLiveView(res.world);
      exposeDebug();
    } else if (res.swapped) view.setWorld(res.world, samePlace);
    if (!samePlace) {
      shownPlace = place;
      frameGap = 60_000;
      view.history.clear();
      hash.apply();
    }
    view.history.record(res.world);
    frames++;
    loading.hidden = true;
    view.update();
  }

  function connect(): void {
    stream?.close();
    stream = connectLive(place, {
      frame: onFrame,
      status: (s, info) => {
        conn.set(s, info.retryInMs);
        if (window.__sim) window.__sim.status = s;
      },
    });
  }

  function switchPlace(id: PlaceId, push: boolean): void {
    if (id === place) return;
    place = id;
    if (push) history.pushState(null, '', livePath(id));
    bar.setCurrent(id);
    chronicle.setPlace(id);
    setTitle();
    meta = null;
    lastFrameAt = 0;
    loading.hidden = !!view; // the old place stays visible until the new one arrives
    connect();
    void refreshPlaces();
  }

  window.addEventListener('popstate', () => {
    const r = parseRoute(location.pathname, location.search);
    if (r.kind === 'live') switchPlace(r.place, false);
    else location.reload();
  });

  async function refreshPlaces(): Promise<void> {
    try {
      bar.setSummaries(await fetchPlaces());
    } catch {
      /* the cards just stay without highlights */
    }
  }

  function exposeDebug(): void {
    const v = view!;
    window.__sim = {
      mode: 'live',
      get world() {
        return v.world;
      },
      controls,
      renderer: v.renderer,
      select: v.select,
      tick: () => {},
      stats: v.stats,
      diary: v.diary,
      projects: v.projects,
      projectList: () => projectsOf(v.world),
      trace: (agentId) => formatTrace(v.world, agentId),
      snapshot: () => snapshotWorld(v.world, NETWORK_SNAPSHOT),
      get place() {
        return place;
      },
      get frames() {
        return frames;
      },
      status: stream?.status,
    };
  }

  setTitle();
  connect();
  void refreshPlaces();
  setInterval(() => void refreshPlaces(), PLACES_REFRESH_MS);
}
