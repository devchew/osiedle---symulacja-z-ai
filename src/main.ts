import type { SimControls } from './types';
import { createLoop } from './core/loop';
import { formatClock, timeFromTick } from './core/time';
import { createWorld, tickWorld } from './world/world';
import { bedCount, getMap } from './world/maps';
import { startRealtime } from './realtime/realtime';
import { hasRealNews, startNewsFeed } from './world/news';
import { createRenderer } from './render/renderer';
import { createHud } from './ui/hud';
import { createInspector } from './ui/inspector';
import { createEventLog } from './ui/eventLog';
import { createLlmToggle, type LlmToggle } from './ui/llmToggle';
import { createMoodHistory } from './ui/history';
import { replayTo } from './ui/replay';
import { parseStartParams, randomSeed, worldCheck } from './ui/saves';
import { createSavePanel } from './ui/savePanel';
import { createNewWorldDialog } from './ui/newWorld';
import { createStatsPanel } from './ui/statsPanel';
import { createDiaryPanel } from './ui/diary';
import { createProjectsPanel } from './ui/projects';
import { toast } from './ui/toast';
import { isTypingTarget } from './ui/dom';
import type { RelationOfFn, WeatherOfFn } from './ui/extras';

import { relationOf } from './social/relationships';
import { weatherOf } from './world/incidents';
import { formatTrace } from './world/trace';
import { setDiaryAiEnabled } from './social/diary';
import { projectsOf } from './world/projects';

// adapters from the simulation's views to the UI's small interfaces (ui/extras.ts)
/** statuses worth an icon on the relationship network (the rest is shown by colour / thickness) */
const SPECIAL_STATUS = new Set(['couple', 'crush', 'enemies', 'rivals', 'best_friends']);
const relationKind: RelationOfFn = (w, a, b) => {
  const r = relationOf(w, a, b);
  const extra = [r.romance >= 10 ? `romantyczność ${r.romance}` : '', r.rivalry >= 10 ? `rywalizacja ${r.rivalry}` : ''].filter(Boolean);
  return { label: r.label, icon: SPECIAL_STATUS.has(r.status) ? r.icon : undefined, detail: extra.join(' · ') || undefined };
};
const weather: WeatherOfFn = (w) => weatherOf(w);

// URL: ?seed, ?agents (≤ beds), ?tick (replay to that tick) or ?hour (that hour of day 1), ?check, ?paused
const params = new URLSearchParams(location.search);
// one bed per resident: more agents than beds would leave someone sleepless
const mapDef = getMap(params.get('map'));
const beds = bedCount(mapDef);
const start = parseStartParams(params, beds, randomSeed);
const world = createWorld(start.seed, { agentCount: start.agentCount, mapId: mapDef.id });
// ?mode=real: clock and weather follow the real world (no deterministic replay)
const realtimeMode = params.get('mode') === 'real';
const history = createMoodHistory();
history.record(world);

/** one simulation step plus the UI-side samplers (also used while replaying) */
function step(): void {
  tickWorld(world);
  history.record(world);
}

async function main(): Promise<void> {
  // rebuild a saved / linked moment by replaying the deterministic simulation
  await replayTo(world, start.tick, { step, parent: document.body });
  const mismatch = start.check !== null && start.tick === world.tick && start.check !== worldCheck(world);
  // real TV headlines (dev/preview proxy) start after the replay: from here on runs are not reproducible
  if (params.get('news') !== 'off') startNewsFeed(world);

  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const renderer = createRenderer(canvas, world);

  const loop = createLoop({
    ticksPerSecond: 5,
    tick: step,
    render: (alpha) => renderer.render(alpha),
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
    time: () => timeFromTick(world.tick),
  };

  if (start.paused && !realtimeMode) loop.setPaused(true);
  if (realtimeMode) await startRealtime({ world, loop, controls, step, parent: document.body });
  let llm: LlmToggle | undefined;

  const newWorld = createNewWorldDialog({ seed: world.seed, agentCount: world.agents.length, maxAgents: beds });
  const savePanel = createSavePanel(world, {
    // saves marked like AI ones: real headlines also make a replay differ
    isAi: () => !!llm?.enabled || hasRealNews(world),
    isPaused: () => controls.paused,
    onNewWorld: () => newWorld.setOpen(true),
    onToggle: (open) => {
      hud.setActive('save', open);
      if (open) {
        stats.setOpen(false);
        diary.setOpen(false);
        projects.setOpen(false);
      }
    },
  });
  const stats = createStatsPanel(world, {
    history,
    relationOf: relationKind,
    onSelectAgent: (id) => {
      // on phones the stats sheet covers the inspector sheet
      if (matchMedia('(max-width: 720px)').matches) stats.setOpen(false);
      select(id);
    },
    onToggle: (open) => {
      hud.setActive('stats', open);
      if (open) {
        savePanel.setOpen(false);
        diary.setOpen(false);
        projects.setOpen(false);
      }
    },
  });
  // residents' diaries (P): everyone's latest entries, one resident's notebook from the inspector
  const diary = createDiaryPanel(world, {
    onToggle: (open) => {
      hud.setActive('diary', open);
      if (open) {
        stats.setOpen(false);
        savePanel.setOpen(false);
        projects.setOpen(false);
      }
    },
    onUnreadChange: (n) => hud.setBadge('diary', n > 0, n ? `nowe wpisy (${n})` : undefined),
  });
  // building projects (B): the gazebo under construction, progress, crew, milestones
  const projects = createProjectsPanel(world, {
    onSelectAgent: (id) => {
      if (matchMedia('(max-width: 720px)').matches) projects.setOpen(false);
      select(id);
    },
    onToggle: (open) => {
      hud.setActive('projects', open);
      if (open) {
        stats.setOpen(false);
        savePanel.setOpen(false);
        diary.setOpen(false);
      }
    },
  });

  const hud = createHud(document.getElementById('hud')!, controls, world, {
    weatherOf: weather,
    buttons: [
      { id: 'stats', icon: '📊', title: 'Statystyki (T)', onClick: () => stats.setOpen(!stats.isOpen) },
      { id: 'diary', icon: '📔', title: 'Pamiętniki (P)', onClick: () => (diary.isOpen ? diary.setOpen(false) : diary.openOverview()) },
      { id: 'projects', icon: '🔨', title: 'Projekty budowlane (B)', onClick: () => projects.setOpen(!projects.isOpen) },
      { id: 'save', icon: '💾', title: 'Zapis i wczytanie (Z)', onClick: () => savePanel.setOpen(!savePanel.isOpen) },
    ],
  });
  const inspector = createInspector(document.getElementById('inspector')!, world, {
    relationOf: relationKind,
    onClose: () => select(null),
    onFollow: (id) => renderer.follow(id),
    diary: { count: diary.entryCount, unread: diary.hasUnread, open: diary.openFor },
  });
  const log = createEventLog(document.getElementById('log')!, world, { onSelectAgent: (id) => select(id) });

  function select(id: number | null): void {
    renderer.setSelected(id);
    inspector.show(id);
    if (id === null) renderer.follow(null);
  }

  // a click (not a drag) on an agent opens the inspector
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      select(renderer.pickAgent(e.clientX, e.clientY)?.id ?? null);
    }
    down = null;
  });
  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') select(null);
    else if (e.code === 'KeyN' && !e.repeat && !isTypingTarget(e)) newWorld.setOpen(true);
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

  // toasts for project milestones (proposal, stage changes, completion) from now on (not the replayed past)
  const seenMilestones = new Map(projectsOf(world).map((p) => [p.id, p.milestones.length] as const));
  function projectToasts(): void {
    const all = projectsOf(world);
    for (const p of all) {
      const seen = seenMilestones.get(p.id) ?? 0;
      const fresh = p.milestones.length - seen;
      if (fresh <= 0) continue;
      seenMilestones.set(p.id, p.milestones.length);
      // milestones are capped (oldest dropped): show at most the newest two
      for (const m of p.milestones.slice(-Math.min(fresh, 2))) toast(`${p.icon} ${m.text}`);
    }
    const building = all.find((p) => p.status === 'building');
    hud.setBadge('projects', !!building && building.workerIds.length > 0, building ? `${building.short}: ${Math.floor(building.progress * 100)}%` : undefined);
  }

  let diaryAi = false;
  let lastAutosaveHour = Math.floor(world.tick / 60);
  setInterval(() => {
    hud.update();
    inspector.update();
    log.update();
    stats.update();
    diary.update();
    projects.update();
    projectToasts();
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
  else if (start.tick > 0 && params.has('tick')) toast(`Wczytano: dzień ${timeFromTick(world.tick).day}, ${formatClock(timeFromTick(world.tick))}`);

  window.__sim = {
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
  };

  // optional LLM dialogue (needs OPENROUTER_API_KEY on the dev/preview server); procedural otherwise
  void createLlmToggle(document.body, world).then((t) => {
    llm = t;
    window.__sim.llm = t;
  });
}

declare global {
  interface Window {
    __sim: {
      world: typeof world;
      controls: SimControls;
      renderer: ReturnType<typeof createRenderer>;
      select: (id: number | null) => void;
      tick: (n: number) => void;
      stats: ReturnType<typeof createStatsPanel>;
      savePanel: ReturnType<typeof createSavePanel>;
      diary: ReturnType<typeof createDiaryPanel>;
      projects: ReturnType<typeof createProjectsPanel>;
      /** building projects (world/projects), for tests and debugging */
      projectList: () => ReturnType<typeof projectsOf>;
      /** detailed activity trace as text (optionally one agent) */
      trace: (agentId?: number) => string;
      /** set once /api/llm/status has answered */
      llm?: LlmToggle;
    };
  }
}

void main();
