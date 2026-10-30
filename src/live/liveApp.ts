import type { SimControls, World } from '../types';
import { createLoop } from '../core/loop';
import { timeOf } from '../core/calendar';
import { timeFromTick } from '../core/time';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../core/state';
import { formatTrace } from '../world/trace';
import { projectsOf } from '../world/projects';
import { createChroniclePanel } from '../ui/chronicle';
import { createView, type View } from '../ui/view';
import { createReplayBar, type ReplayBar } from '../ui/replayBar';
import { toast } from '../ui/toast';
import { createConnBanner, createPlaceBar, placeIcon } from '../ui/places';
import { el } from '../ui/dom';
import '../ui/debug';
import { PLACES, placeById, LIVE_TIME_ZONE, type LiveFrame, type LiveMeta, type PlaceId } from './protocol';
import { connectLive, fetchChronicle, fetchPlaces, fetchReplay, type LiveStream } from './client';
import { createReplayPlayer, REPLAY_SPEEDS, type ReplayPlayer } from './replayPlayer';
import { applyFrame } from './frames';
import { livePath, parseRoute } from './routes';
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
  ['⏪', 'powtórka ostatnich 24 godzin w przyspieszeniu'],
  ['przeciągnij', 'przesuń widok'],
  ['WASD / strzałki', 'przesuń widok'],
  ['kółko / szczypnięcie', 'przybliż i oddal'],
  ['klik', 'szczegóły postaci'],
  ['dwuklik', 'śledź postać kamerą'],
  ['[ / ]', 'poprzednia / następna postać'],
  ['Tab', 'przejście po przyciskach i liście mieszkańców'],
  ['Esc', 'zamknij panel'],
];
const LIVE_NOTE =
  'Każde miejsce żyje na serwerze bez przerwy, w czasie rzeczywistym — wszyscy widzą ten sam świat. ' +
  '„⏪” odtwarza ostatnie 24 godziny w przyspieszeniu (tylko podgląd). ' +
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
  /** the server's world as of the last frame; `view.world` is a replay copy while `replay` is set */
  let liveWorld: World | null = null;
  let replay: ReplayPlayer | null = null;
  let replayLoading = false;
  let replayDriveAt = 0;
  let replayShown = '';
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
  });

  const controls: SimControls = {
    paused: false,
    speed: 1,
    setPaused: () => {},
    setSpeed: () => {},
    time: () => (view ? timeOf(view.world) : timeFromTick(0)),
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

  const replayBar: ReplayBar = createReplayBar({
    speeds: [
      [REPLAY_SPEEDS[0], '1 h / 6 s', 'Wolno: godzina w 6 sekund'],
      [REPLAY_SPEEDS[1], '1 h / 3 s', 'Normalnie: godzina w 3 sekundy'],
      [REPLAY_SPEEDS[2], '1 h / 1,5 s', 'Szybko: godzina w 1,5 sekundy'],
    ],
    onPlayPause: () => replay?.setPlaying(!replay.playing),
    onSpeed: (tps) => {
      if (replay) replay.speed = tps;
    },
    onSeek: (tick) => replay?.seek(tick),
    onExit: () => exitReplay(),
  });
  document.body.append(replayBar.root);

  function createLiveView(world: World): View {
    const v = createView({
      world,
      controls,
      showPopulation: false,
      insets: INSETS,
      help: { keys: LIVE_HELP, note: LIVE_NOTE },
      buttons: [
        { id: 'chronicle', icon: '📜', title: 'Kronika miejsca (K)', onClick: () => chronicle.setOpen(!chronicle.isOpen) },
        { id: 'replay', icon: '⏪', title: 'Powtórka ostatnich 24 godzin', onClick: () => (replay ? exitReplay() : void enterReplay()) },
      ],
      panels: [{ id: 'chronicle', setOpen: (o) => chronicle.setOpen(o) }],
      onSelect: (id) => hash.onSelect(id),
      live: {
        place: () => {
          const def = placeById(place);
          return def ? `${placeIcon(def.id)} ${def.name}` : '';
        },
        city: () => meta?.weather.city ?? placeById(place)?.city ?? '',
        temperature: () => (replay ? replay.temperature : (meta?.weather.temperature ?? null)),
        ai: () => !!meta?.ai,
        replay: () => !!replay,
        tooltip: () => {
          if (replay) return 'Powtórka: to już się wydarzyło (nagranie z serwera), nie dzieje się teraz. „Wróć na żywo” kończy powtórkę.';
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
    loop.setDriver((now) => {
      if (replay) return driveReplay(replay, now);
      return lastFrameAt ? Math.min(1, (performance.now() - lastFrameAt) / frameGap) : 1;
    });
    loop.start();
    v.hud.setActive('chronicle', chronicle.isOpen);
    return v;
  }

  function driveReplay(r: ReplayPlayer, now: number): number {
    const dt = replayDriveAt ? Math.min(0.25, (now - replayDriveAt) / 1000) : 0;
    replayDriveAt = now;
    const alpha = r.advance(dt);
    const key = `${r.tick}|${r.playing}|${r.speed}`;
    if (key !== replayShown) {
      replayShown = key;
      replayBar.update({ tick: r.tick, fromTick: r.data.fromTick, toTick: r.data.toTick, playing: r.playing, speed: r.speed });
    }
    return alpha;
  }

  async function enterReplay(): Promise<void> {
    if (replay || replayLoading || !view || !liveWorld) return;
    const forPlace = place;
    replayLoading = true;
    view.hud.setActive('replay', true);
    try {
      const data = await fetchReplay(forPlace);
      if (forPlace !== place || replay || !view || !liveWorld || shownPlace !== place) return;
      replay = createReplayPlayer(liveWorld, data);
      replayDriveAt = 0;
      replayShown = '';
      view.setWorld(replay.world, true);
      replayBar.setOpen(true);
      view.update();
    } catch (err) {
      console.error(err);
      toast('Powtórka jest niedostępna — spróbuj za chwilę.', 'warn');
    } finally {
      replayLoading = false;
      view?.hud.setActive('replay', !!replay);
    }
  }

  function exitReplay(): void {
    if (!replay) return;
    replay = null;
    replayBar.setOpen(false);
    view?.hud.setActive('replay', false);
    if (view && liveWorld) {
      view.setWorld(liveWorld, true);
      view.update();
    }
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
      res = applyFrame(liveWorld, shownPlace, frame);
    } catch (err) {
      // incompatible snapshot (server and client from different builds): ask for a reload
      console.error(err);
      conn.set('offline');
      loading.textContent = 'Strona została zaktualizowana — odśwież ją, by zobaczyć osiedle.';
      loading.hidden = false;
      return;
    }
    const samePlace = shownPlace === place;
    liveWorld = res.world;
    if (!view) {
      view = createLiveView(res.world);
      exposeDebug();
    } else if (res.swapped) {
      if (replay) exitReplay();
      view.setWorld(res.world, samePlace);
    }
    if (!samePlace) {
      shownPlace = place;
      frameGap = 60_000;
      view.history.clear();
      hash.apply();
    }
    frames++;
    loading.hidden = true;
    if (replay) return; // the live world keeps up in the background; the view shows the recording
    view.history.record(res.world);
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
    exitReplay();
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
    const r = parseRoute(location.pathname);
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
      get replay() {
        return replay ? { tick: replay.tick, fromTick: replay.data.fromTick, toTick: replay.data.toTick, playing: replay.playing } : null;
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
