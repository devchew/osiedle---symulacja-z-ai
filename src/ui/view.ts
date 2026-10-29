import type { SimControls, World } from '../types';
import type { Insets } from '../render/camera';
import { createRenderer, type Renderer } from '../render/renderer';
import { createHud, type Hud, type HudButton, type HudLive } from './hud';
import { createInspector, type Inspector } from './inspector';
import { createEventLog, type EventLog } from './eventLog';
import { createStatsPanel, type StatsPanel } from './statsPanel';
import { createDiaryPanel, type DiaryPanel } from './diary';
import { createProjectsPanel, type ProjectsPanel } from './projects';
import { createMoodHistory, type MoodHistory } from './history';
import { toast } from './toast';
import type { RelationOfFn, WeatherOfFn } from './extras';
import { relationOf } from '../social/relationships';
import { weatherOf } from '../world/incidents';
import { projectsOf } from '../world/projects';

// The common screen of every mode (live view, sandbox, /lab): canvas renderer, HUD, inspector,
// event log and the read-only panels (stats, diaries, projects), with selection, panel
// exclusivity and the 5 Hz UI refresh. The world it shows can be swapped (setWorld): the next
// live frame restored as a new object, or another place.

/** statuses worth an icon on the relationship network (the rest is shown by colour / thickness) */
const SPECIAL_STATUS = new Set(['couple', 'crush', 'enemies', 'rivals', 'best_friends']);
export const relationKind: RelationOfFn = (w, a, b) => {
  const r = relationOf(w, a, b);
  const extra = [r.romance >= 10 ? `romantyczność ${r.romance}` : '', r.rivalry >= 10 ? `rywalizacja ${r.rivalry}` : ''].filter(Boolean);
  return { label: r.label, icon: SPECIAL_STATUS.has(r.status) ? r.icon : undefined, detail: extra.join(' · ') || undefined };
};
const weather: WeatherOfFn = (w) => weatherOf(w);

/** a panel outside the view (e.g. /lab's save panel) taking part in "one panel at a time" */
export interface ExtraPanel {
  id: string;
  setOpen(open: boolean): void;
}

export interface ViewOptions {
  world: World;
  controls: SimControls;
  /** mood history fed by the owner (lab/sandbox: after each tick; live: after each frame) */
  history?: MoodHistory;
  /** extra HUD buttons placed after stats / diaries / projects */
  buttons?: HudButton[];
  /** extra panels closed when one of the view's panels opens (call `panelOpened` when they open) */
  panels?: ExtraPanel[];
  live?: HudLive;
  showPopulation?: boolean;
  help?: { keys: [string, string][]; note?: string };
  /** CSS px kept free when fitting the map */
  insets?: { wide: Insets; narrow: Insets };
  /** called with the selected resident (null = none), e.g. to keep the URL hash in sync */
  onSelect?(id: number | null): void;
  /** called on every UI refresh (5 Hz) */
  onUpdate?(): void;
}

export interface View {
  readonly world: World;
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly inspector: Inspector;
  readonly log: EventLog;
  readonly stats: StatsPanel;
  readonly diary: DiaryPanel;
  readonly projects: ProjectsPanel;
  readonly history: MoodHistory;
  select(id: number | null): void;
  /** closes the view's panels except `except` (extra panels call this when they open) */
  panelOpened(id: string): void;
  setWorld(world: World, sameScene: boolean): void;
  /** refreshes the UI now (also runs at 5 Hz) */
  update(): void;
}

const narrow = (): boolean => matchMedia('(max-width: 720px)').matches;

export function createView(opts: ViewOptions): View {
  let world = opts.world;
  const history = opts.history ?? createMoodHistory();
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const renderer = createRenderer(canvas, world);
  if (opts.insets) {
    renderer.setFitInsets(opts.insets.wide, opts.insets.narrow);
    renderer.fitView();
  }

  const extraPanels = opts.panels ?? [];
  function panelOpened(id: string): void {
    if (id !== 'stats') stats.setOpen(false);
    if (id !== 'diary') diary.setOpen(false);
    if (id !== 'projects') projects.setOpen(false);
    for (const p of extraPanels) if (p.id !== id) p.setOpen(false);
  }

  const stats = createStatsPanel(world, {
    history,
    relationOf: relationKind,
    onSelectAgent: (id) => {
      // on phones the stats sheet covers the inspector sheet
      if (narrow()) stats.setOpen(false);
      select(id);
    },
    onToggle: (open) => {
      hud.setActive('stats', open);
      if (open) panelOpened('stats');
    },
  });
  // residents' diaries (P): everyone's latest entries, one resident's notebook from the inspector
  const diary = createDiaryPanel(world, {
    onToggle: (open) => {
      hud.setActive('diary', open);
      if (open) panelOpened('diary');
    },
    onUnreadChange: (n) => hud.setBadge('diary', n > 0, n ? `nowe wpisy (${n})` : undefined),
  });
  // building projects (B): the gazebo under construction, progress, crew, milestones
  const projects = createProjectsPanel(world, {
    onSelectAgent: (id) => {
      if (narrow()) projects.setOpen(false);
      select(id);
    },
    onToggle: (open) => {
      hud.setActive('projects', open);
      if (open) panelOpened('projects');
    },
  });

  const hud = createHud(document.getElementById('hud')!, opts.controls, world, {
    weatherOf: weather,
    live: opts.live,
    showPopulation: opts.showPopulation,
    help: opts.help,
    buttons: [
      { id: 'stats', icon: '📊', title: 'Statystyki (T)', onClick: () => stats.setOpen(!stats.isOpen) },
      { id: 'diary', icon: '📔', title: 'Pamiętniki (P)', onClick: () => (diary.isOpen ? diary.setOpen(false) : diary.openOverview()) },
      { id: 'projects', icon: '🔨', title: 'Projekty budowlane (B)', onClick: () => projects.setOpen(!projects.isOpen) },
      ...(opts.buttons ?? []),
    ],
  });
  const inspector = createInspector(document.getElementById('inspector')!, world, {
    relationOf: relationKind,
    onClose: () => select(null),
    onFollow: (id) => renderer.follow(id),
    diary: { count: diary.entryCount, unread: diary.hasUnread, open: diary.openFor },
  });
  const log = createEventLog(document.getElementById('log')!, world, { onSelectAgent: (id) => select(id) });

  let selected: number | null = null;
  function select(id: number | null): void {
    if (id !== null && !world.agents.some((a) => a.id === id)) id = null;
    selected = id;
    renderer.setSelected(id);
    inspector.show(id);
    if (id === null) renderer.follow(null);
    opts.onSelect?.(id);
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
  });

  // toasts for project milestones (proposal, stage changes, completion) from now on (not the past)
  let seenMilestones = new Map(projectsOf(world).map((p) => [p.id, p.milestones.length] as const));
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

  function update(): void {
    hud.update();
    inspector.update();
    log.update();
    stats.update();
    diary.update();
    projects.update();
    projectToasts();
    opts.onUpdate?.();
  }
  setInterval(update, 200);

  return {
    get world() {
      return world;
    },
    renderer,
    hud,
    inspector,
    log,
    stats,
    diary,
    projects,
    history,
    select,
    panelOpened,
    update,
    setWorld(w, sameScene) {
      if (w === world) return;
      world = w;
      renderer.setWorld(w, sameScene);
      hud.setWorld(w);
      log.setWorld(w, sameScene);
      stats.setWorld(w);
      diary.setWorld(w, sameScene);
      projects.setWorld(w);
      inspector.setWorld(w);
      if (!sameScene) {
        history.clear();
        seenMilestones = new Map(projectsOf(w).map((p) => [p.id, p.milestones.length] as const));
        select(null);
      } else if (selected !== null) {
        // keep the selection (the resident is a new object with the same id)
        renderer.setSelected(selected);
        if (!w.agents.some((a) => a.id === selected)) select(null);
      }
      update();
    },
  };
}
