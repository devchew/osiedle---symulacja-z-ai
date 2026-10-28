import type { SimControls } from './types';
import { createLoop } from './core/loop';
import { formatClock, timeFromTick } from './core/time';
import { createWorld, tickWorld } from './world/world';
import { createDefaultMap } from './world/map';
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
import { toast } from './ui/toast';
import { isTypingTarget } from './ui/dom';
import type { RelationOfFn, WeatherOfFn } from './ui/extras';

import { relationOf } from './social/relationships';
import { weatherOf } from './world/incidents';
import { formatTrace } from './world/trace';

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
const beds = createDefaultMap().objects.filter((o) => o.type === 'bed').length;
const start = parseStartParams(params, beds, randomSeed);
const world = createWorld(start.seed, { agentCount: start.agentCount });
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

  if (start.paused) loop.setPaused(true);
  let llm: LlmToggle | undefined;

  const newWorld = createNewWorldDialog({ seed: world.seed, agentCount: world.agents.length, maxAgents: beds });
  const savePanel = createSavePanel(world, {
    isAi: () => !!llm?.enabled,
    isPaused: () => loop.paused,
    onNewWorld: () => newWorld.setOpen(true),
    onToggle: (open) => {
      hud.setActive('save', open);
      if (open) stats.setOpen(false);
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
      if (open) savePanel.setOpen(false);
    },
  });

  const hud = createHud(document.getElementById('hud')!, controls, world, {
    weatherOf: weather,
    buttons: [
      { id: 'stats', icon: '📊', title: 'Statystyki (T)', onClick: () => stats.setOpen(!stats.isOpen) },
      { id: 'save', icon: '💾', title: 'Zapis i wczytanie (Z)', onClick: () => savePanel.setOpen(!savePanel.isOpen) },
    ],
  });
  const inspector = createInspector(document.getElementById('inspector')!, world, {
    relationOf: relationKind,
    onClose: () => select(null),
    onFollow: (id) => renderer.follow(id),
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

  let lastAutosaveHour = Math.floor(world.tick / 60);
  setInterval(() => {
    hud.update();
    inspector.update();
    log.update();
    stats.update();
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
      /** detailed activity trace as text (optionally one agent) */
      trace: (agentId?: number) => string;
      /** set once /api/llm/status has answered */
      llm?: LlmToggle;
    };
  }
}

void main();
