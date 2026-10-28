import type { SimControls } from './types';
import { createLoop } from './core/loop';
import { timeFromTick } from './core/time';
import { createWorld, tickWorld } from './world/world';
import { createRenderer } from './render/renderer';
import { createHud } from './ui/hud';
import { createInspector } from './ui/inspector';
import { createEventLog } from './ui/eventLog';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
const world = createWorld(seed, { agentCount: Number(params.get('agents')) || 6 });

// ?hour=N fast-forwards to that hour of day 1 (handy for screenshots and tests)
const startHour = params.get('hour');
if (startHour !== null) {
  const target = ((Number(startHour) - 7 + 24) % 24) * 60;
  while (world.tick < target) tickWorld(world);
}

const canvas = document.getElementById('world') as HTMLCanvasElement;
const renderer = createRenderer(canvas, world);

const loop = createLoop({
  ticksPerSecond: 5,
  tick: () => tickWorld(world),
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

const hud = createHud(document.getElementById('hud')!, controls, world);
const inspector = createInspector(document.getElementById('inspector')!, world, {
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
});

setInterval(() => {
  hud.update();
  inspector.update();
  log.update();
}, 200);

if (params.has('paused')) loop.setPaused(true);
loop.start();

declare global {
  interface Window {
    __sim: { world: typeof world; controls: SimControls; renderer: typeof renderer; select: typeof select; tick: (n: number) => void };
  }
}
window.__sim = {
  world,
  controls,
  renderer,
  select,
  tick: (n) => {
    for (let i = 0; i < n; i++) tickWorld(world);
  },
};
