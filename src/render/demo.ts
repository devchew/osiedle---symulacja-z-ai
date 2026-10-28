// Standalone render demo: mock world + simple fixed-step loop.
// Query params: ?hour=22 (start hour), ?speed=8 (ticks per real second), ?paused=1

import { formatClock, timeFromTick } from '../core/time';
import { createMockWorld, stepMockWorld } from './mockWorld';
import { createRenderer } from './renderer';

const params = new URLSearchParams(location.search);
const { world, scripts } = createMockWorld(7);

const hour = params.get('hour');
if (hour !== null) {
  const target = Math.round(Number(hour) * 60) - 7 * 60;
  world.tick = ((target % 1440) + 1440) % 1440;
}
// warm up so bubbles are visible on the first frame
for (let i = 0; i < 3; i++) stepMockWorld(world, scripts);

const canvas = document.getElementById('world') as HTMLCanvasElement;
const renderer = createRenderer(canvas, world);

// optional camera setup for screenshots: ?zoom=2.5&follow=3&select=3
const zoom = Number(params.get('zoom') ?? 1);
if (zoom !== 1) {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new WheelEvent('wheel', { deltaY: -Math.log(zoom) / 0.0015, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, cancelable: true }),
  );
}
if (params.get('follow')) renderer.follow(Number(params.get('follow')));

let selected: number | null = params.get('select') ? Number(params.get('select')) : null;
renderer.setSelected(selected);
canvas.addEventListener('click', (e) => {
  const a = renderer.pickAgent(e.clientX, e.clientY);
  selected = a ? a.id : null;
  renderer.setSelected(selected);
});
canvas.addEventListener('dblclick', (e) => {
  const a = renderer.pickAgent(e.clientX, e.clientY);
  renderer.follow(a ? a.id : null);
});

const info = document.getElementById('info');
let speed = Number(params.get('speed') ?? 8);
let paused = params.get('paused') === '1';
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') paused = !paused;
  if (e.key === 'n') world.tick += 60;
  if (e.key === '+') speed = Math.min(240, speed * 2);
  if (e.key === '-') speed = Math.max(1, speed / 2);
});

const step = (): number => 1000 / speed;
let acc = 0;
let last = performance.now();
let frames = 0;
let fpsT = last;
let fps = 0;
function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  if (!paused) {
    acc += dt;
    while (acc >= step()) {
      stepMockWorld(world, scripts);
      acc -= step();
    }
  }
  renderer.render(paused ? 1 : acc / step());
  frames++;
  if (now - fpsT > 500) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
  }
  if (info) {
    const t = timeFromTick(world.tick);
    info.textContent = `Dzień ${t.day} · ${formatClock(t)} · ${t.phase} · światło ${t.daylight.toFixed(2)} · ${fps} fps · ${speed} t/s`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, { __demo: { world, renderer } });
