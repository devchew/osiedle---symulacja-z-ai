// Canvas 2D renderer: camera, static layer cache, agents, bubbles, lighting.
// Reads the World only; never mutates simulation state.

import type { Agent, World } from '../types';
import { Camera } from './camera';
import { UI_FONT, EMOJI_FONT, rr } from './colors';
import { drawBubbles, type BubbleItem } from './bubbles';
import { Lighting, lightStateAt } from './lighting';
import { drawAgent, drawSelection, type AgentPose } from './sprites';
import { buildStaticLayer, staticSignature, type StaticLayer } from './tiles';

export interface Renderer {
  /** draws one frame; alpha in [0, 1] = fraction of the way from the previous tick to the current one */
  render(alpha: number): void;
  /** re-reads the canvas CSS size / devicePixelRatio (also done automatically on window resize) */
  resize(): void;
  /** agent under the given client (viewport) coordinates, or null */
  pickAgent(clientX: number, clientY: number): Agent | null;
  setSelected(id: number | null): void;
  /** smoothly keeps the camera centred on the agent; any drag cancels it */
  follow(id: number | null): void;
}

const BG = '#6f9b5c';
const DRAG_THRESHOLD = 4;

interface Pose extends AgentPose {
  agent: Agent;
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context not available');

  // the canvas is a full-viewport background behind the HTML overlay
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    display: 'block',
    touchAction: 'none',
    cursor: 'grab',
  });

  const cam = new Camera();
  const lighting = new Lighting();
  let dpr = 1;
  let fitted = false;
  let layer: StaticLayer | null = null;
  let layerSig = NaN;
  let layerGrid: unknown = null;
  let selected: number | null = null;
  let followId: number | null = null;
  let lastNow = performance.now();
  let poses: Pose[] = [];
  const walk = new Map<number, { phase: number; x: number; y: number }>();

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width || window.innerWidth);
    const h = Math.max(1, rect.height || window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    cam.viewW = w;
    cam.viewH = h;
    cam.setMap(world.grid.width, world.grid.height);
    if (!fitted) {
      cam.fit(Math.min(48, Math.max(16, Math.min(w, h) * 0.05)));
      fitted = true;
    } else cam.updateLimits();
  }

  function ensureStatic(): void {
    const sig = staticSignature(world);
    if (layer && sig === layerSig && layerGrid === world.grid) return;
    layer = buildStaticLayer(world, layer ?? undefined);
    lighting.build(world);
    layerSig = sig;
    layerGrid = world.grid;
    cam.setMap(world.grid.width, world.grid.height);
  }

  // ------------------------------------------------------------------ input
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      followId = null;
      canvas.style.cursor = 'grabbing';
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    cam.panBy(dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const endDrag = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) {
      // swallow the click that follows a drag so it doesn't select/deselect
      const eat = (ev: Event): void => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
    }
    canvas.style.cursor = 'grab';
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0015);
      cam.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false },
  );
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ helpers
  interface SleepInfo {
    horiz: boolean;
    blanket: string;
    /** where to draw the sleeper so the head lies on the pillow */
    x: number;
    y: number;
  }

  function sleepingInfo(a: Agent, x: number, y: number): SleepInfo | null {
    const act = a.action;
    if (!act || act.kind !== 'use' || act.phase !== 'using') return null;
    const obj = world.objects.find((o) => o.uid === act.objectUid);
    const def = obj ? world.objectDefs[obj.type] : undefined;
    if (!obj || !def) return null;
    const sleeps = def.tags ? def.tags.includes('sleep') : /bed|łóżk/i.test(obj.type);
    if (!sleeps) return null;
    const horiz = def.size.w > def.size.h;
    const bx = obj.pos.x - 0.5;
    const by = obj.pos.y - 0.5;
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    return horiz
      ? { horiz, blanket: def.color, x: bx + 0.8, y: clamp(y, by + 0.5, by + def.size.h - 0.5) }
      : { horiz, blanket: def.color, x: clamp(x, bx + 0.5, bx + def.size.w - 0.5), y: by + 0.8 };
  }

  function computePoses(alpha: number): Pose[] {
    const out: Pose[] = [];
    for (const a of world.agents) {
      const jump = Math.hypot(a.pos.x - a.prevPos.x, a.pos.y - a.prevPos.y) > 2.5;
      const t = jump ? 1 : Math.max(0, Math.min(1, alpha));
      const x = a.prevPos.x + (a.pos.x - a.prevPos.x) * t;
      const y = a.prevPos.y + (a.pos.y - a.prevPos.y) * t;
      let w = walk.get(a.id);
      if (!w) {
        w = { phase: a.id * 1.7, x, y };
        walk.set(a.id, w);
      }
      const d = Math.hypot(x - w.x, y - w.y);
      if (d < 1.5) w.phase += d * Math.PI * 2.4;
      w.x = x;
      w.y = y;
      const moving = !jump && (a.pos.x !== a.prevPos.x || a.pos.y !== a.prevPos.y);
      const s = sleepingInfo(a, x, y);
      if (s) out.push({ agent: a, x: s.x, y: s.y, moving: false, phase: w.phase, sleeping: true, bedHorizontal: s.horiz, blanket: s.blanket });
      else out.push({ agent: a, x, y, moving, phase: w.phase, sleeping: false, bedHorizontal: false, blanket: '' });
    }
    out.sort((p, q) => p.y - q.y || p.agent.id - q.agent.id);
    return out;
  }

  function drawLabel(text: string, x: number, y: number, ui: number, highlight: boolean): void {
    const size = 11 * ui;
    ctx!.font = `600 ${size}px ${UI_FONT}`;
    const w = ctx!.measureText(text).width + 10 * ui;
    const h = size + 6 * ui;
    rr(ctx!, x - w / 2, y, w, h, h / 2);
    ctx!.fillStyle = highlight ? 'rgba(255,214,90,0.95)' : 'rgba(28,30,40,0.58)';
    ctx!.fill();
    ctx!.fillStyle = highlight ? '#2a2310' : '#ffffff';
    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'middle';
    ctx!.fillText(text, x, y + h / 2 + 0.5);
  }

  function drawIcon(icon: string, x: number, y: number, ui: number): void {
    const r = 11 * ui;
    ctx!.beginPath();
    ctx!.arc(x, y, r, 0, Math.PI * 2);
    ctx!.fillStyle = 'rgba(255,255,255,0.92)';
    ctx!.shadowColor = 'rgba(20,20,40,0.25)';
    ctx!.shadowBlur = 4;
    ctx!.shadowOffsetY = 1;
    ctx!.fill();
    ctx!.shadowColor = 'transparent';
    ctx!.font = `${Math.round(13 * ui)}px ${EMOJI_FONT}`;
    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'middle';
    ctx!.fillStyle = '#000';
    ctx!.fillText(icon, x, y + 1);
  }

  function drawZzz(x: number, y: number, ui: number, now: number): void {
    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) {
      const t = (now / 1000) * 0.45 + i / 3;
      const f = t - Math.floor(t);
      const a = Math.sin(Math.PI * f);
      ctx!.font = `800 ${Math.round((11 + f * 9) * ui)}px ${UI_FONT}`;
      const px = x + (6 + f * 16 + Math.sin(f * 6) * 3) * ui;
      const py = y - (4 + f * 26) * ui;
      ctx!.globalAlpha = a;
      ctx!.lineWidth = 3;
      ctx!.strokeStyle = 'rgba(255,255,255,0.9)';
      const ch = i % 2 ? 'z' : 'Z';
      ctx!.strokeText(ch, px, py);
      ctx!.fillStyle = '#5767b8';
      ctx!.fillText(ch, px, py);
    }
    ctx!.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ render
  function render(alpha: number): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    const rect = canvas.getBoundingClientRect();
    if (
      Math.abs(rect.width - cam.viewW) > 0.5 ||
      Math.abs(rect.height - cam.viewH) > 0.5 ||
      Math.min(window.devicePixelRatio || 1, 3) !== dpr
    )
      resize();
    ensureStatic();
    const c = ctx!;

    poses = computePoses(alpha);

    if (followId !== null) {
      const p = poses.find((q) => q.agent.id === followId);
      if (p) {
        const k = 1 - Math.exp(-dt * 5);
        cam.cx += (p.x - cam.cx) * k;
        cam.cy += (p.y - cam.cy) * k;
        cam.clamp();
      }
    }

    const z = cam.zoom;
    const s = z * dpr;
    const ox = (cam.viewW / 2 - cam.cx * z) * dpr;
    const oy = (cam.viewH / 2 - cam.cy * z) * dpr;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = BG;
    c.fillRect(0, 0, canvas.width, canvas.height);

    c.setTransform(s, 0, 0, s, ox, oy);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'medium';
    const g = world.grid;
    // map edge shadow
    c.fillStyle = 'rgba(30,50,25,0.25)';
    rr(c, -0.5 + 0.12, -0.5 + 0.18, g.width, g.height, 0.3);
    c.fill();
    if (layer) c.drawImage(layer.canvas, -0.5, -0.5, g.width, g.height);

    for (const p of poses) {
      if (p.agent.id === selected) drawSelection(c, p, now);
      drawAgent(c, p.agent, p, now);
    }

    lighting.draw(c, lightStateAt(world.tick, alpha), [s, ox, oy]);

    // ---------------------------------------------- screen-space overlays
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ui = Math.max(0.8, Math.min(1.15, z / 40));
    const bubbles: BubbleItem[] = [];
    for (const p of poses) {
      const a = p.agent;
      const feet = cam.toScreen(p.x, p.y + 0.4);
      if (feet.x < -200 || feet.y < -200 || feet.x > cam.viewW + 200 || feet.y > cam.viewH + 260) continue;
      if (z >= 14) drawLabel(a.name, feet.x, feet.y + 1, ui, a.id === selected);
      let anchorY: number;
      let anchorX: number;
      if (p.sleeping) {
        const head = p.bedHorizontal ? cam.toScreen(p.x - 0.36, p.y) : cam.toScreen(p.x, p.y - 0.36);
        drawZzz(head.x, head.y - 4 * ui, ui, now + a.id * 333);
        anchorX = head.x;
        anchorY = head.y - 30 * ui;
      } else {
        const top = cam.toScreen(p.x, p.y - 0.5);
        anchorX = top.x;
        anchorY = top.y - 2;
        if (a.action?.icon && z >= 10) {
          const iy = top.y - 12 * ui;
          drawIcon(a.action.icon, top.x, iy, ui);
          anchorY = iy - 12 * ui;
        }
      }
      if (a.bubble && a.bubble.text) bubbles.push({ agentId: a.id, bubble: a.bubble, ax: anchorX, ay: anchorY });
    }
    drawBubbles(c, bubbles, cam.viewW, cam.viewH);
  }

  function pickAgent(clientX: number, clientY: number): Agent | null {
    const rect = canvas.getBoundingClientRect();
    const w = cam.toWorld(clientX - rect.left, clientY - rect.top);
    const radius = Math.max(0.45, 14 / cam.zoom);
    let best: Agent | null = null;
    let bestD = Infinity;
    for (const p of poses) {
      const d = Math.hypot(w.x - p.x, w.y - (p.y - 0.08));
      if (d < radius && d < bestD) {
        bestD = d;
        best = p.agent;
      }
    }
    return best;
  }

  resize();
  return {
    render,
    resize,
    pickAgent,
    setSelected: (id) => {
      selected = id;
    },
    follow: (id) => {
      followId = id;
    },
  };
}
