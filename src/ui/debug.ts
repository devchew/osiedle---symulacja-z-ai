import type { SimControls, World } from '../types';
import type { Renderer } from '../render/renderer';
import type { WorldSnapshot } from '../core/state';
import type { StatsPanel } from './statsPanel';
import type { DiaryPanel } from './diary';
import type { ProjectsPanel } from './projects';
import type { SavePanel } from './savePanel';
import type { LlmToggle } from './llmToggle';
import type { projectsOf } from '../world/projects';

// window.__sim: handles for e2e tests and debugging in every mode.

export interface SimDebug {
  mode: 'lab' | 'live';
  /** the world on screen (live view: replaced or updated by every frame) */
  readonly world: World;
  controls: SimControls;
  renderer: Renderer;
  select(id: number | null): void;
  /** advances the simulation (lab; no-op in the live view) */
  tick(n: number): void;
  stats: StatsPanel;
  diary: DiaryPanel;
  projects: ProjectsPanel;
  /** building projects (world/projects), for tests and debugging */
  projectList(): ReturnType<typeof projectsOf>;
  /** detailed activity trace as text (optionally one agent) */
  trace(agentId?: number): string;
  /** NETWORK_SNAPSHOT of the world on screen (lab: e2e fixtures for the live view) */
  snapshot(): WorldSnapshot;
  /** lab only */
  savePanel?: SavePanel;
  /** lab: set once /api/llm/status has answered */
  llm?: LlmToggle;
  /** live view: current place and the number of frames received */
  place?: string;
  frames?: number;
  /** live view: the replay being shown (null = live) */
  replay?: { tick: number; fromTick: number; toTick: number; playing: boolean } | null;
  /** live view: stream status */
  status?: string;
}

declare global {
  interface Window {
    __sim: SimDebug;
  }
}
