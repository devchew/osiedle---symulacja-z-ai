import type { SimControls } from '../types';
import { createLoop } from '../core/loop';
import { setCalendar, timeOf } from '../core/calendar';
import { formatClock } from '../core/time';
import { snapshotWorld, NETWORK_SNAPSHOT } from '../core/state';
import { createWorld, tickWorld } from '../world/world';
import { bedCount, getMap } from '../world/maps';
import { startRealtime } from '../realtime/realtime';
import { hasRealNews, startNewsFeed } from '../world/news';
import { createLlmToggle, type LlmToggle } from './llmToggle';
import { createMoodHistory } from './history';
import { replayTo } from './replay';
import { parseStartParams, randomSeed, worldCheck } from './saves';
import { createSavePanel } from './savePanel';
import { createNewWorldDialog } from './newWorld';
import { toast } from './toast';
import { isTypingTarget } from './dom';
import { HELP_KEYS } from './hud';
import { createView, type View } from './view';
import { formatTrace } from '../world/trace';
import { setDiaryAiEnabled } from '../social/diary';
import { projectsOf } from '../world/projects';
import { residentsOf } from '../agents/role';

// /lab — hidden developer and test route: the standalone simulation as before wave 10
// (URL: ?seed, ?agents (≤ beds), ?map, ?tick (replay to that tick) or ?hour, ?check, ?paused,
// ?mode=real, ?news=off, ?date=2026-12-20 = calendar date of day 1: season and weekday), with saves, links, the new-world dialog and the LLM toggle.
// Not linked anywhere in the public UI.

export async function startLab(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // one bed per resident: more agents than beds would leave someone sleepless
  const mapDef = getMap(params.get('map'));
  const beds = bedCount(mapDef);
  const start = parseStartParams(params, beds, randomSeed);
  const world = createWorld(start.seed, { agentCount: start.agentCount, mapId: mapDef.id });
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.get('date') ?? '');
  if (date) setCalendar(world, Math.round(Date.UTC(+date[1], +date[2] - 1, +date[3]) / 86_400_000));
  // ?mode=real: clock and weather follow the real world (no deterministic replay)
  const realtimeMode = params.get('mode') === 'real';
  const history = createMoodHistory();
  history.record(world);

  /** one simulation step plus the UI-side samplers (also used while replaying) */
  function step(): void {
    tickWorld(world);
    history.record(world);
  }

  // rebuild a saved / linked moment by replaying the deterministic simulation
  await replayTo(world, start.tick, { step, parent: document.body });
  const mismatch = start.check !== null && start.tick === world.tick && start.check !== worldCheck(world);
  // real TV headlines (dev/preview proxy) start after the replay: from here on runs are not reproducible
  if (params.get('news') !== 'off') startNewsFeed(world);

  let view!: View;
  const loop = createLoop({
    ticksPerSecond: 5,
    tick: step,
    render: (alpha) => view?.renderer.render(alpha),
  });

  const controls: SimControls = {
    get paused() {
      return loop.paused;
    },
    get speed() {
      return loop.speed;
    },
    setPaused: (p) => loop.setPaused(p),
    setSpeed: (s) => loop.setSpeed(s),
    time: () => timeOf(world),
  };

  if (start.paused && !realtimeMode) loop.setPaused(true);
  if (realtimeMode) await startRealtime({ world, loop, controls, step, parent: document.body });
  let llm: LlmToggle | undefined;

  const newWorld = createNewWorldDialog({ seed: world.seed, agentCount: residentsOf(world).length, maxAgents: beds });
  const savePanel = createSavePanel(world, {
    // saves marked like AI ones: real headlines also make a replay differ
    isAi: () => !!llm?.enabled || hasRealNews(world),
    isPaused: () => controls.paused,
    onNewWorld: () => newWorld.setOpen(true),
    onToggle: (open) => {
      view.hud.setActive('save', open);
      if (open) view.panelOpened('save');
    },
  });

  view = createView({
    world,
    controls,
    history,
    buttons: [{ id: 'save', icon: '💾', title: 'Zapis i wczytanie (Z)', onClick: () => savePanel.setOpen(!savePanel.isOpen) }],
    panels: [{ id: 'save', setOpen: (o) => savePanel.setOpen(o) }],
    help: { keys: HELP_KEYS },
  });
  const { renderer, stats, diary, projects, select } = view;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyN' && !e.repeat && !isTypingTarget(e)) newWorld.setOpen(true);
    else if (e.code === 'KeyL' && !e.repeat && !isTypingTarget(e)) downloadTrace();
  });

  // L: download the detailed activity trace (decisions, action starts/ends with reasons, chats)
  function downloadTrace(): void {
    const blob = new Blob([formatTrace(world)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `osiedle-log-seed${world.seed}-t${world.tick}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  let diaryAi = false;
  let lastAutosaveHour = Math.floor(world.tick / 60);
  setInterval(() => {
    // diary entries rewritten by AI follow the dialogue toggle
    if (!!llm?.enabled !== diaryAi) {
      diaryAi = !!llm?.enabled;
      setDiaryAiEnabled(world, diaryAi);
    }
    // autosave every game hour
    const hour = Math.floor(world.tick / 60);
    if (hour !== lastAutosaveHour) {
      lastAutosaveHour = hour;
      savePanel.autosave();
    }
  }, 200);

  loop.start();
  if (mismatch) toast('Odtworzony stan różni się od zapisu (inna wersja gry albo dialogi AI).', 'warn', 6000);
  else if (start.tick > 0 && params.has('tick')) toast(`Wczytano: dzień ${timeOf(world).day}, ${formatClock(timeOf(world))}`);

  window.__sim = {
    mode: 'lab',
    world,
    controls,
    renderer,
    select,
    tick: (n) => {
      for (let i = 0; i < n; i++) step();
    },
    stats,
    savePanel,
    diary,
    projects,
    projectList: () => projectsOf(world),
    trace: (agentId) => formatTrace(world, agentId),
    snapshot: () => snapshotWorld(world, NETWORK_SNAPSHOT),
  };

  // optional LLM dialogue (needs OPENROUTER_API_KEY on the dev/preview server); procedural otherwise
  void createLlmToggle(document.body, world).then((t) => {
    llm = t;
    window.__sim.llm = t;
  });
}
