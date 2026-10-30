// Canvas 2D renderer: camera, static layer cache, agents, bubbles, lighting.
// Reads the World only; never mutates simulation state.

import type { Agent, Bubble, World } from '../types';
import { Ambient } from './ambient';
import { Camera, type Insets } from './camera';
import { UI_FONT, EMOJI_FONT, rr } from './colors';
import { createBubblePresenter, drawBubbles, type BubbleItem, type Obstacle } from './bubbles';
import { Lighting, lightStateAt } from './lighting';
import { AGENT_SCALE, drawAgent, drawJointBadges, drawPet, drawPetSelection, drawSelection, headTop, petTop, type AgentPose, type PetPose, type PoseMode } from './sprites';
import { buildStaticLayer, staticSignature, type StaticLayer } from './tiles';
import { WeatherFx, drawIncidentBadges, drawIncidents, weatherDim } from './weather';
import { drawProjectBadges } from './projects';
import { drawTvNews, drawTvScreens } from './tv';
import { MotionTracker } from './motion';
import { trailOf } from '../agents/movement';
import { petsOf, type Pet } from '../agents/pets';
import { isRealtime } from '../realtime/state';

export interface Renderer {
  /** draws one frame; alpha in [0, 1] = fraction of the way from the previous tick to the current one */
  render(alpha: number): void;
  /** re-reads the canvas CSS size / devicePixelRatio (also done automatically on window resize) */
  resize(): void;
  /** agent under the given client (viewport) coordinates, or null */
  pickAgent(clientX: number, clientY: number): Agent | null;
  /** pet under the given client coordinates, or null (checked after pickAgent: residents win) */
  pickPet(clientX: number, clientY: number): Pet | null;
  setSelected(id: number | null): void;
  /** highlights a pet (ids are separate from the residents'); null = none */
  setSelectedPet(id: number | null): void;
  /** smoothly keeps the camera centred on the agent; any drag / key pan cancels it (double-click an agent to follow) */
  follow(id: number | null): void;
  /** id of the followed agent, or null */
  readonly following: number | null;
  /** re-fits the camera to the map, leaving room for the HUD and the log */
  fitView(): void;
  /** how many times the static layer (tiles, objects, lighting…) was rebuilt — for tests / debugging */
  readonly staticBuilds: number;
  /** world (tile) coordinates to client (CSS px) coordinates */
  toScreen(wx: number, wy: number): { x: number; y: number };
  /** where the agent is drawn (tile units) and whether it is visually walking — for tests / debugging */
  visualOf(id: number): { x: number; y: number; moving: boolean } | null;
  /** where the pets are drawn (tile units) — for tests / debugging */
  petVisuals(): { id: number; name: string; x: number; y: number; activity: string }[];
  /**
   * shows another World object (live view: a new frame restored as a new world, or another place).
   * `sameScene` keeps the camera and the residents' walking cursors (next frame of the same place);
   * otherwise the camera is re-fitted and walking starts over.
   */
  setWorld(world: World, sameScene: boolean): void;
  /** CSS px kept free for the overlay UI when fitting the map (wide / narrow screens) */
  setFitInsets(wide: Insets, narrow: Insets): void;
}

const BG = '#6f9b5c';
const DRAG_THRESHOLD = 4;
/** CSS px kept free for the overlay UI when fitting the map */
const FIT_INSETS: Insets = { top: 68, right: 16, bottom: 16, left: 16 };
const FIT_INSETS_NARROW: Insets = { top: 96, right: 8, bottom: 110, left: 8 };
const KEY_PAN_SPEED = 700; // CSS px per second

function overlapRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  m = 0,
): boolean {
  return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
}

function poseModeFor(type: string): PoseMode {
  const t = type.toLowerCase();
  // repairing a broken object: standing at it
  if (t.startsWith('repair_')) return 'stand';
  if (/shower|prysznic/.test(t)) return 'shower';
  if (/bath|tub|wann/.test(t)) return 'bath';
  if (/bike|rower/.test(t)) return 'pedal';
  if (/treadmill|bie[zż]ni/.test(t)) return 'run';
  if (/sofa|couch|kanap|\btv\b|^tv|telewiz|bench|[lł]awk|table|st[oó][lł]|computer|desk|komput|piano|pianin|toilet|toalet|chair|krzes|fotel|altan|^domek_na_drzewie$/.test(t)) return 'sit';
  return 'stand';
}

interface Pose extends AgentPose {
  agent: Agent;
}

interface PetDraw extends PetPose {
  pet: Pet;
}

export function createRenderer(canvas: HTMLCanvasElement, initialWorld: World): Renderer {
  let world = initialWorld;
  // bubbles run on a presentation clock: wall time that stops while the picture stands still (pause)
  const presenter = createBubblePresenter();
  let bubbleClock = 0;
  let bubbleTick = -1;
  let bubbleAlpha = -1;
  let fitInsets = FIT_INSETS;
  let fitInsetsNarrow = FIT_INSETS_NARROW;
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
  const ambient = new Ambient();
  const weather = new WeatherFx();
  let dpr = 1;
  let fitted = false;
  let layer: StaticLayer | null = null;
  let layerSig = NaN;
  let layerGrid: unknown = null;
  let staticBuilds = 0;
  let selected: number | null = null;
  let followId: number | null = null;
  let lastNow = performance.now();
  let poses: Pose[] = [];
  const walk = new Map<number, { phase: number }>();
  // residents walk along the path they actually took (see motion.ts)
  let motion = new MotionTracker<Agent>(trailOf);
  // pets: own tracker (their ids overlap the residents'); live frames bring new Pet objects, keyed by id
  let petMotion = new MotionTracker<Pet>(trailOf);
  const petWalk = new Map<number, number>();
  let petPoses: PetDraw[] = [];
  let selectedPet: number | null = null;

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
      fitView();
      fitted = true;
    } else cam.updateLimits();
  }

  /** bounding box of the house (wall tiles), used when the whole map would be too small */
  function houseArea(): { x: number; y: number; w: number; h: number } | undefined {
    const g = world.grid;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++)
        if (g.tiles[y * g.width + x] === 'wall') {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    return x0 === Infinity ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function fitView(): void {
    cam.setMap(world.grid.width, world.grid.height);
    const narrow = cam.viewW < 720;
    const insets = narrow ? fitInsetsNarrow : fitInsets;
    cam.fit(insets);
    // on small screens the whole plot is tiny: show the house instead
    if (cam.zoom < 16) {
      const house = houseArea();
      if (house) cam.fit(insets, house);
    }
  }

  function ensureStatic(): void {
    const sig = staticSignature(world);
    if (layer && sig === layerSig && layerGrid === world.grid) return;
    layer = buildStaticLayer(world, layer ?? undefined);
    staticBuilds++;
    lighting.build(world);
    ambient.build(world);
    weather.build(world);
    layerSig = sig;
    layerGrid = world.grid;
    cam.setMap(world.grid.width, world.grid.height);
  }

  // ------------------------------------------------------------------ input
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; mx: number; my: number } | null = null;
  const pinchIds = new Set<number>();

  const eatNextClick = (): void => {
    // swallow the click that follows a drag so it doesn't select/deselect
    const eat = (ev: Event): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
  };

  function pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...pointers.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // second finger: switch from drag to pinch
      pinch = pinchState();
      for (const id of pointers.keys()) pinchIds.add(id);
      drag = null;
      followId = null;
      return;
    }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const now = pinchState();
      const rect = canvas.getBoundingClientRect();
      cam.panBy(now.mx - pinch.mx, now.my - pinch.my);
      cam.zoomAt(now.mx - rect.left, now.my - rect.top, now.dist / pinch.dist);
      pinch = now;
      return;
    }
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
  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pinchIds.has(e.pointerId)) {
      // fingers of a pinch never count as a tap (stops the app's click-to-select on this element)
      pinchIds.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      e.stopImmediatePropagation();
      eatNextClick();
      drag = null;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) eatNextClick();
    canvas.style.cursor = 'grab';
    drag = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // trackpad pinch arrives as ctrl+wheel with small deltas: make it a bit stronger
      const k = e.ctrlKey ? 0.006 : 0.0015;
      const factor = Math.exp(-Math.max(-300, Math.min(300, e.deltaY * unit)) * k);
      cam.zoomSmooth(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', (e) => {
    const a = pickAgent(e.clientX, e.clientY);
    if (a) followId = a.id;
    else {
      const rect = canvas.getBoundingClientRect();
      cam.zoomSmooth(e.clientX - rect.left, e.clientY - rect.top, 1.6);
    }
  });

  // keyboard: arrows / WASD pan, + / - zoom
  const keys = new Set<string>();
  const PAN_KEYS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    KeyA: [-1, 0],
    ArrowRight: [1, 0],
    KeyD: [1, 0],
    ArrowUp: [0, -1],
    KeyW: [0, -1],
    ArrowDown: [0, 1],
    KeyS: [0, 1],
  };
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  };
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (PAN_KEYS[e.code]) {
      keys.add(e.code);
      followId = null;
      if (e.code.startsWith('Arrow')) e.preventDefault();
    } else if (e.key === '+' || e.key === '=') cam.zoomSmooth(cam.viewW / 2, cam.viewH / 2, 1.35);
    else if (e.key === '-' || e.key === '_') cam.zoomSmooth(cam.viewW / 2, cam.viewH / 2, 1 / 1.35);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
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

  /**
   * positions come from the motion cursors (the walked path replayed at a visual pace),
   * not from prevPos→pos interpolation: walks finish within a tick and must not cut corners.
   * (`_alpha` stays in the signature: lighting still uses it.)
   */
  function computePoses(_alpha: number, now: number, dt: number): Pose[] {
    const out: Pose[] = [];
    motion.update(world.agents, world.tick, now, dt, isRealtime(world));
    for (const a of world.agents) {
      const m = motion.of(a.id)!;
      const x = m.x;
      const y = m.y;
      let w = walk.get(a.id);
      if (!w) {
        w = { phase: a.id * 1.7 };
        walk.set(a.id, w);
      }
      const moving = m.moving;
      // legs: about 2.4 steps per tile, but never a frantic shuffle in the fast lab
      if (moving) w.phase += Math.min(m.moved * Math.PI * 2.4, dt * Math.PI * 2 * 3.2);
      const facing = moving && m.facing !== 0 ? m.facing : undefined;
      const s = moving ? null : sleepingInfo(a, x, y);
      if (s) {
        out.push({ agent: a, x: s.x, y: s.y, moving: false, phase: w.phase, sleeping: true, bedHorizontal: s.horiz, blanket: s.blanket, mode: 'sleep' });
        continue;
      }
      let mode: PoseMode = moving ? 'walk' : 'stand';
      let walking = moving;
      const act = a.action;
      // still walking there on screen: the activity's pose starts on arrival
      if (!moving && act && act.kind === 'use' && act.phase === 'using') {
        // the pose follows the action (the short glide from the stand tile onto the seat is not a walk)
        const obj = world.objects.find((o) => o.uid === act.objectUid);
        if (obj) mode = poseModeFor(obj.type);
        if (mode !== 'walk' && mode !== 'stand') walking = false;
      }
      out.push({ agent: a, x, y, moving: walking, phase: w.phase, sleeping: false, bedHorizontal: false, blanket: '', mode, facing });
    }
    out.sort((p, q) => p.y - q.y || p.agent.id - q.agent.id);
    return out;
  }

  function computePetPoses(now: number, dt: number): PetDraw[] {
    const pets = petsOf(world);
    if (!pets.length) return [];
    petMotion.update(pets, world.tick, now, dt, isRealtime(world));
    return pets.map((pet) => {
      const m = petMotion.of(pet.id)!;
      let phase = petWalk.get(pet.id) ?? pet.id * 2.3;
      // short legs: quicker steps than a resident's
      if (m.moving) phase += Math.min(m.moved * Math.PI * 4, dt * Math.PI * 2 * 5);
      petWalk.set(pet.id, phase);
      const facing = m.moving && m.facing !== 0 ? m.facing : pet.facing;
      return { pet, x: m.x, y: m.y, moving: m.moving, phase, facing };
    });
  }

  function labelWidth(text: string, ui: number): number {
    ctx!.font = `650 ${Math.max(10.5, 11 * ui)}px ${UI_FONT}`;
    return ctx!.measureText(text).width + 12 * ui;
  }

  /** draws a name pill centred at x with its top at y; returns its rect */
  function drawLabel(text: string, x: number, y: number, ui: number, highlight: boolean): { w: number; h: number } {
    const size = Math.max(10.5, 11 * ui);
    ctx!.font = `650 ${size}px ${UI_FONT}`;
    const w = ctx!.measureText(text).width + 12 * ui;
    const h = size + 6 * ui;
    rr(ctx!, x - w / 2, y, w, h, h / 2);
    ctx!.fillStyle = highlight ? 'rgba(255,214,90,0.96)' : 'rgba(24,26,38,0.62)';
    ctx!.fill();
    ctx!.fillStyle = highlight ? '#2a2310' : '#ffffff';
    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'middle';
    ctx!.fillText(text, x, y + h / 2 + 0.5);
    return { w, h };
  }

  /** action badge: emoji in a white disc with a small pointer towards the head */
  function drawIcon(icon: string, x: number, y: number, ui: number): void {
    const r = 12 * ui;
    const c = ctx!;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.moveTo(x - 4 * ui, y + r - 1);
    c.lineTo(x, y + r + 5 * ui);
    c.lineTo(x + 4 * ui, y + r - 1);
    c.closePath();
    c.fillStyle = 'rgba(255,255,255,0.95)';
    c.shadowColor = 'rgba(20,20,40,0.3)';
    c.shadowBlur = 5;
    c.shadowOffsetY = 1;
    c.fill();
    c.shadowColor = 'transparent';
    c.font = `${Math.round(14.5 * ui)}px ${EMOJI_FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#000';
    c.fillText(icon, x, y + 1);
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

    poses = computePoses(alpha, now, dt);
    petPoses = computePetPoses(now, dt);
    if (world.tick !== bubbleTick || alpha !== bubbleAlpha) bubbleClock += dt * 1000;
    bubbleTick = world.tick;
    bubbleAlpha = alpha;

    // camera: keyboard pan, zoom animation, follow
    if (keys.size) {
      let kx = 0;
      let ky = 0;
      for (const k of keys) {
        const d = PAN_KEYS[k];
        if (d) {
          kx += d[0];
          ky += d[1];
        }
      }
      cam.panBy(-kx * KEY_PAN_SPEED * dt, -ky * KEY_PAN_SPEED * dt);
    }
    const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    cam.update(dt, reduceMotion);
    if (followId !== null) {
      const p = poses.find((q) => q.agent.id === followId);
      if (p) {
        const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 5);
        cam.cx += (p.x - cam.cx) * k;
        cam.cy += (p.y - cam.cy) * k;
        cam.clamp();
      } else followId = null;
    }

    const z = cam.zoom;
    const s = z * dpr;
    const ox = (cam.viewW / 2 - cam.cx * z) * dpr;
    const oy = (cam.viewH / 2 - cam.cy * z) * dpr;
    const sky = weather.update(world, dt);
    const clear = lightStateAt(world, alpha);
    // overcast and rain dim the daylight: the lighting then shows lit windows and lamps
    const light = { hour: clear.hour, daylight: clear.daylight * (1 - weatherDim(sky)) };

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
    weather.drawSnowCover(c, light.daylight);
    ambient.drawGround(c, now, light.daylight);
    drawIncidents(c, world, now);
    drawTvScreens(c, world, now);

    // residents and pets in one y-sorted pass (a pet behind a resident is hidden by them)
    let pi = 0;
    const drawPetsAbove = (y: number): void => {
      for (; pi < petPoses.length && petPoses[pi].y < y; pi++) {
        const q = petPoses[pi];
        if (q.pet.id === selectedPet) drawPetSelection(c, q, now);
        drawPet(c, q.pet, q, now);
      }
    };
    petPoses.sort((p, q) => p.y - q.y || p.pet.id - q.pet.id);
    for (const p of poses) {
      drawPetsAbove(p.y);
      if (p.agent.id === selected) drawSelection(c, p, now);
      drawAgent(c, p.agent, p, now);
    }
    drawPetsAbove(Infinity);
    ambient.drawClouds(c, now, clear.daylight, sky.kind === 'sunny' ? 1 : sky.kind === 'cloudy' ? 2 : 3);
    weather.drawWorld(c, now, light.daylight);

    lighting.draw(c, light, [s, ox, oy]);
    c.setTransform(s, 0, 0, s, ox, oy);
    ambient.drawNight(c, now, sky.raining ? 0 : 1 - light.daylight);

    // ---------------------------------------------- screen-space overlays
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    weather.drawScreen(c, cam.viewW, cam.viewH);
    drawIncidentBadges(c, world, (x, y) => cam.toScreen(x, y), z, now);
    drawProjectBadges(c, world, (x, y) => cam.toScreen(x, y), z, now);
    drawJointBadges(c, world, (x, y) => cam.toScreen(x, y), z);
    const tvPanels = drawTvNews(c, world, (x, y) => cam.toScreen(x, y), z, now, cam.viewW, cam.viewH);
    const ui = Math.max(0.85, Math.min(1.2, z / 34));
    const convOf = new Map<number, number>();
    for (const cv of world.conversations) for (const id of cv.participants) convOf.set(id, cv.id);
    const bubbles: BubbleItem[] = [];
    const shown = new Map<number, { bubble: Bubble; fade: number }>();
    for (const a of world.agents) {
      const b = presenter.present(a.id, a.bubble, world.tick, alpha, bubbleClock);
      if (b) shown.set(a.id, b);
    }
    // speech bubbles steer clear of the TV news panel
    const obstacles: Obstacle[] = tvPanels.map((r) => ({ agentId: -1, ...r }));
    interface Overlay {
      p: Pose;
      feet: { x: number; y: number };
      top: { x: number; y: number };
      icon: { x: number; y: number } | null;
      head: { x: number; y: number } | null;
      isSel: boolean;
    }
    // pass 1: geometry (icons first, so name pills can dodge them)
    const items: Overlay[] = [];
    const iconR = 12 * ui;
    for (const p of poses) {
      const a = p.agent;
      const feet = cam.toScreen(p.x, p.y + 0.29 + 0.04);
      if (feet.x < -200 || feet.y < -200 || feet.x > cam.viewW + 200 || feet.y > cam.viewH + 260) continue;
      const isSel = a.id === selected;
      const top = cam.toScreen(p.x, p.y + headTop(p.mode));
      obstacles.push({ agentId: a.id, x: feet.x - 0.3 * AGENT_SCALE * z, y: top.y, w: 0.6 * AGENT_SCALE * z, h: feet.y - top.y });
      let icon: Overlay['icon'] = null;
      let head: Overlay['head'] = null;
      if (p.sleeping) head = p.bedHorizontal ? cam.toScreen(p.x - 0.36, p.y) : cam.toScreen(p.x, p.y - 0.36);
      else {
        const speaking = shown.get(a.id)?.bubble.kind === 'speech';
        if (a.action?.icon && z >= 10 && (!speaking || isSel)) {
          icon = { x: top.x, y: top.y - 17 * ui };
          obstacles.push({ agentId: a.id, x: icon.x - iconR, y: icon.y - iconR, w: iconR * 2, h: iconR * 2 + 5 * ui });
        }
      }
      items.push({ p, feet, top, icon, head, isSel });
    }
    // pass 2: name pills, nudged down while they collide with another pill or someone else's icon
    if (z >= 14 || selected !== null) {
      const placedLabels: { id: number; x: number; y: number; w: number; h: number }[] = [];
      const lh = Math.max(10.5, 11 * ui) + 6 * ui;
      for (const it of items) {
        if (z < 14 && !it.isSel) continue;
        const a = it.p.agent;
        const lw = labelWidth(a.name, ui);
        let ly = it.feet.y + 1;
        for (let guard = 0; guard < 5; guard++) {
          const r = { x: it.feet.x - lw / 2, y: ly, w: lw, h: lh };
          const hitLabel = placedLabels.find((q) => overlapRect(r, q, 2));
          const hitIcon = items.find((q) => q !== it && q.icon && overlapRect(r, { x: q.icon.x - iconR, y: q.icon.y - iconR, w: iconR * 2, h: iconR * 2 + 4 }, 1));
          if (hitLabel) ly = hitLabel.y + hitLabel.h + 2;
          else if (hitIcon?.icon) ly = hitIcon.icon.y + iconR + 6 * ui;
          else break;
        }
        const lab = drawLabel(a.name, it.feet.x, ly, ui, it.isSel);
        placedLabels.push({ id: a.id, x: it.feet.x - lab.w / 2, y: ly, w: lab.w, h: lab.h });
        obstacles.push({ agentId: a.id, x: it.feet.x - lab.w / 2, y: ly, w: lab.w, h: lab.h });
      }
    }
    // pass 3: icons, Zzz, bubble anchors
    for (const it of items) {
      const a = it.p.agent;
      let anchorX = it.top.x;
      let anchorY = it.top.y - 3;
      if (it.head) {
        drawZzz(it.head.x, it.head.y - 4 * ui, ui, now + a.id * 333);
        anchorX = it.head.x;
        anchorY = it.head.y - 30 * ui;
      } else if (it.icon && a.action) {
        drawIcon(a.action.icon, it.icon.x, it.icon.y, ui);
        anchorY = it.icon.y - 13 * ui;
      }
      const sb = shown.get(a.id);
      if (sb)
        bubbles.push({
          agentId: a.id,
          bubble: sb.bubble,
          fade: sb.fade,
          ax: anchorX,
          ay: anchorY,
          priority: it.isSel ? 2 : a.id === followId ? 1 : 0,
          conversationId: convOf.get(a.id) ?? null,
        });
    }
    // selected pet: name pill above it
    const sp = petPoses.find((q) => q.pet.id === selectedPet);
    if (sp) {
      const top = cam.toScreen(sp.x, sp.y + petTop(sp.pet));
      const lh = Math.max(10.5, 11 * ui) + 6 * ui;
      drawLabel(sp.pet.name, top.x, top.y - lh - 3 * ui, ui, true);
    }
    drawBubbles(c, bubbles, cam.viewW, cam.viewH, obstacles);
  }

  function pickAgent(clientX: number, clientY: number): Agent | null {
    const rect = canvas.getBoundingClientRect();
    const w = cam.toWorld(clientX - rect.left, clientY - rect.top);
    const radius = Math.max(0.55, 16 / cam.zoom);
    let best: Agent | null = null;
    let bestD = Infinity;
    for (const p of poses) {
      // centre of the (scaled) figure sits a bit above the tile centre
      const d = Math.hypot(w.x - p.x, w.y - (p.y - 0.15));
      if (d < radius && d < bestD) {
        bestD = d;
        best = p.agent;
      }
    }
    return best;
  }

  function pickPet(clientX: number, clientY: number): Pet | null {
    const rect = canvas.getBoundingClientRect();
    const w = cam.toWorld(clientX - rect.left, clientY - rect.top);
    const radius = Math.max(0.4, 12 / cam.zoom);
    let best: Pet | null = null;
    let bestD = Infinity;
    for (const p of petPoses) {
      const d = Math.hypot(w.x - p.x, w.y - (p.y + 0.05));
      if (d < radius && d < bestD) {
        bestD = d;
        best = p.pet;
      }
    }
    return best;
  }

  resize();
  return {
    render,
    resize,
    pickAgent,
    pickPet,
    setSelected: (id) => {
      selected = id;
    },
    setSelectedPet: (id) => {
      selectedPet = id;
    },
    follow: (id) => {
      followId = id;
    },
    get following() {
      return followId;
    },
    fitView,
    get staticBuilds() {
      return staticBuilds;
    },
    toScreen: (wx, wy) => {
      const r = canvas.getBoundingClientRect();
      const p = cam.toScreen(wx, wy);
      return { x: p.x + r.left, y: p.y + r.top };
    },
    visualOf: (id) => {
      const m = motion.of(id);
      return m ? { x: m.x, y: m.y, moving: m.moving } : null;
    },
    petVisuals: () => petPoses.map((p) => ({ id: p.pet.id, name: p.pet.name, x: p.x, y: p.y, activity: p.pet.activity })),
    setWorld: (w, sameScene) => {
      if (w === world) return;
      world = w;
      presenter.retain(new Set(w.agents.map((a) => a.id)));
      if (!sameScene) {
        presenter.clear();
        motion = new MotionTracker<Agent>(trailOf);
        walk.clear();
        petMotion = new MotionTracker<Pet>(trailOf);
        petWalk.clear();
        petPoses = [];
        selectedPet = null;
        poses = [];
        layer = null;
        followId = null;
        ensureStatic();
        fitView();
      }
    },
    setFitInsets: (wide, narrow) => {
      fitInsets = wide;
      fitInsetsNarrow = narrow;
    },
  };
}
