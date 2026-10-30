// Weather and incident effects: rain streaks and ripples over the outdoor area,
// a wet tint, storm flashes, overcast dimming (applied through the lighting),
// smoke / sparks / badges on broken objects. Everything is procedural from the
// clock and a few hashes, so a frame costs one clipped stroke batch plus a few
// dozen small shapes.

import type { ObjectInstance, World } from '../types';
import { baseTypeOf, brokenObjects, isBroken, snowCoverOf, weatherOf, type WeatherInfo } from '../world/incidents';
import { EMOJI_FONT, hash2 } from './colors';

/** how much the weather dims daylight (0 = none); used to scale the lighting's "night" */
export function weatherDim(w: WeatherInfo): number {
  switch (w.kind) {
    case 'cloudy':
      return 0.08;
    case 'rain':
      return w.snow ? 0.1 + 0.2 * w.intensity : 0.2 + 0.3 * w.intensity;
    case 'storm':
      return 0.45 + 0.2 * w.intensity;
    default:
      return 0;
  }
}

const MAX_DROPS = 420;
const RIPPLES = 70;
const MAX_FLAKES = 260;

export class WeatherFx {
  /** outdoor tiles (grass, path, water) as one clip path, built per map */
  private outdoor: Path2D | null = null;
  /** walkable outdoor spots where puddles ripple */
  private puddles: { x: number; y: number; h: number }[] = [];
  private mapW = 1;
  private mapH = 1;
  /** smoothed weather intensity (rain fades in/out between ticks and across speed changes) */
  private rain = 0;
  /** the smoothed precipitation is snow (flakes instead of streaks) */
  private snowing = false;
  /** smoothed snow cover of the ground, 0..1 */
  private cover = 0;
  private coverSeen = false;
  /** grass tiles as one clip path, for the snow cover */
  private grass: Path2D | null = null;
  private flakeTiles: { x: number; y: number; h: number }[] = [];
  private flash = 0;
  private nextFlash = 0;

  build(world: World): void {
    const g = world.grid;
    this.mapW = g.width;
    this.mapH = g.height;
    const p = new Path2D();
    const grass = new Path2D();
    this.flakeTiles = [];
    this.puddles = [];
    for (let y = 0; y < g.height; y++) {
      // merge horizontal runs of outdoor tiles into one rect each
      let run = -1;
      for (let x = 0; x <= g.width; x++) {
        const k = x < g.width ? g.tiles[y * g.width + x] : 'wall';
        const out = k === 'grass' || k === 'path' || k === 'water';
        if (k === 'grass') {
          grass.rect(x - 0.5, y - 0.5, 1, 1);
          this.flakeTiles.push({ x, y, h: hash2(x, y, 33) });
        }
        if (out && run < 0) run = x;
        if (!out && run >= 0) {
          p.rect(run - 0.5, y - 0.5, x - run, 1);
          run = -1;
        }
        if (out && !g.solid[y * g.width + x] && (k === 'path' || k === 'water' || hash2(x, y, 77) < 0.12))
          this.puddles.push({ x, y, h: hash2(x, y, 91) });
      }
    }
    this.outdoor = p;
    this.grass = grass;
    // a stable subset, so ripples keep appearing in the same puddles
    this.puddles.sort((a, b) => a.h - b.h);
    this.puddles = this.puddles.slice(0, RIPPLES);
  }

  /** advances smoothing; returns the current weather */
  update(world: World, dt: number): WeatherInfo {
    const w = weatherOf(world);
    const target = w.raining ? 0.35 + 0.65 * w.intensity : 0;
    this.rain += (target - this.rain) * (1 - Math.exp(-dt * 1.5));
    if (this.rain < 0.002) this.rain = 0;
    if (w.raining) this.snowing = !!w.snow;
    const cover = snowCoverOf(world);
    // the first frame shows the ground as it is, no fade-in from bare grass
    this.cover = this.coverSeen ? this.cover + (cover - this.cover) * (1 - Math.exp(-dt * 0.8)) : cover;
    this.coverSeen = true;
    if (this.cover < 0.002) this.cover = 0;
    if (w.kind === 'storm') {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 3 + Math.random() * 7;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 2.8);
    return w;
  }

  /** world-space: snow lying on the grass (call right after the static layer, before residents) */
  drawSnowCover(ctx: CanvasRenderingContext2D, daylight: number): void {
    const c = this.cover;
    if (c <= 0 || !this.grass) return;
    ctx.save();
    ctx.clip(this.grass);
    ctx.fillStyle = `rgba(238,244,252,${(0.85 * c).toFixed(3)})`;
    ctx.fillRect(-0.5, -0.5, this.mapW, this.mapH);
    // uneven cover: a few bare grass spots show through while it is thin, drifts glitter when it is deep
    const spots = Math.round(this.flakeTiles.length * 0.18 * (1 - c));
    ctx.fillStyle = `rgba(86,128,70,${(0.45 * (1 - c)).toFixed(3)})`;
    for (let i = 0; i < spots; i++) {
      const tile = this.flakeTiles[Math.floor(hash2(i, 41) * this.flakeTiles.length)];
      ctx.beginPath();
      ctx.ellipse(tile.x + (tile.h - 0.5) * 0.5, tile.y + (hash2(i, 43) - 0.5) * 0.5, 0.28, 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(255,255,255,${(0.35 * c * (0.4 + 0.6 * daylight)).toFixed(3)})`;
    const drifts = Math.round(this.flakeTiles.length * 0.25 * c);
    for (let i = 0; i < drifts; i++) {
      const tile = this.flakeTiles[Math.floor(hash2(i, 47) * this.flakeTiles.length)];
      ctx.beginPath();
      ctx.ellipse(tile.x + (tile.h - 0.5) * 0.6, tile.y + 0.12 + (hash2(i, 49) - 0.5) * 0.4, 0.24, 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** world-space: falling snow, or wet tint, puddle ripples and rain streaks, over the outdoor area (call with the world transform) */
  drawWorld(ctx: CanvasRenderingContext2D, now: number, daylight: number): void {
    const k = this.rain;
    if (k <= 0 || !this.outdoor) return;
    const t = now / 1000;
    if (this.snowing) {
      this.drawFlakes(ctx, t, k, daylight);
      return;
    }
    ctx.save();
    ctx.clip(this.outdoor);
    // wet, darker ground
    ctx.fillStyle = `rgba(35,55,85,${(0.22 * k).toFixed(3)})`;
    ctx.fillRect(-0.5, -0.5, this.mapW, this.mapH);

    // ripples in puddles
    ctx.lineWidth = 0.03;
    const light = 0.35 + 0.65 * daylight;
    const n = Math.round(this.puddles.length * Math.min(1, k * 1.2));
    for (let i = 0; i < n; i++) {
      const p = this.puddles[i];
      const ph = (t * (0.9 + p.h * 0.6) + p.h * 13) % 1;
      const r = 0.06 + ph * 0.32;
      ctx.strokeStyle = `rgba(225,238,255,${(0.5 * (1 - ph) * light).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(p.x + (p.h - 0.5) * 0.6, p.y + (hash2(i, 5) - 0.5) * 0.6, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // falling streaks (slanted), one batched stroke
    const drops = Math.round(MAX_DROPS * k);
    const len = 0.7;
    const slant = 0.22;
    ctx.strokeStyle = `rgba(215,228,248,${((0.45 + 0.25 * k) * light).toFixed(3)})`;
    ctx.lineWidth = 0.045;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const H = this.mapH + 2;
    for (let i = 0; i < drops; i++) {
      const hx = hash2(i, 1);
      const hy = hash2(i, 2);
      const sp = 9 + hash2(i, 3) * 5;
      const y = ((hy * H + t * sp) % H) - 1;
      const x = hx * (this.mapW + 2) - 1 - y * slant;
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * slant, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawFlakes(ctx: CanvasRenderingContext2D, t: number, k: number, daylight: number): void {
    ctx.save();
    ctx.fillStyle = `rgba(250,252,255,${((0.55 + 0.3 * k) * (0.5 + 0.5 * daylight)).toFixed(3)})`;
    const flakes = Math.round(MAX_FLAKES * k);
    const H = this.mapH + 2;
    ctx.beginPath();
    for (let i = 0; i < flakes; i++) {
      const sp = 0.9 + hash2(i, 3) * 1.1;
      const y = ((hash2(i, 2) * H + t * sp) % H) - 1;
      const x = hash2(i, 1) * (this.mapW + 2) - 1 + Math.sin(t * (0.6 + hash2(i, 4)) + i) * 0.35;
      const r = 0.035 + hash2(i, 5) * 0.035;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  /** screen-space: storm flash and a cool overcast grade (call with an identity/dpr transform) */
  drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.rain > 0) {
      ctx.fillStyle = `rgba(55,70,100,${((this.snowing ? 0.07 : 0.12) * this.rain).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.flash > 0) {
      // double flicker
      const f = this.flash;
      const a = f > 0.7 ? (f - 0.7) / 0.3 : f > 0.45 && f < 0.6 ? 0.6 : f * 0.4;
      ctx.fillStyle = `rgba(235,240,255,${(0.55 * a).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

// ---------------------------------------------------------------- broken objects

function centerOf(world: World, o: ObjectInstance): { x: number; y: number; w: number; h: number } {
  const def = world.objectDefs[o.type];
  const w = def?.size.w ?? 1;
  const h = def?.size.h ?? 1;
  return { x: o.pos.x + (w - 1) / 2, y: o.pos.y + (h - 1) / 2, w, h };
}

/** world-space smoke over broken objects and sparks while someone repairs them */
export function drawIncidents(ctx: CanvasRenderingContext2D, world: World, now: number): void {
  const broken = brokenObjects(world);
  if (!broken.length) return;
  const t = now / 1000;
  ctx.save();
  for (const b of broken) {
    const o = world.objects.find((x) => x.uid === b.uid);
    if (!o) continue;
    const c = centerOf(world, o);
    // smoke puffs rising and fading
    for (let i = 0; i < 4; i++) {
      const ph = (t * 0.45 + i / 4 + b.uid * 0.13) % 1;
      const x = c.x + Math.sin(t * 1.3 + i * 2 + b.uid) * 0.12 + ph * 0.25;
      const y = c.y - 0.2 - ph * 1.1;
      ctx.fillStyle = `rgba(90,90,95,${(0.32 * (1 - ph)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.1 + ph * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    if (b.repairerIds.length) {
      // sparks: short bright lines bursting from the object
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 0.035;
      ctx.lineCap = 'round';
      const burst = Math.floor(t * 6);
      for (let i = 0; i < 7; i++) {
        const h1 = hash2(burst, i, b.uid);
        if (h1 < 0.3) continue;
        const ph = (t * 6) % 1;
        const ang = hash2(burst, i + 9, b.uid) * Math.PI * 2;
        const r0 = 0.1 + ph * 0.35;
        const sx = c.x + Math.cos(ang) * r0;
        const sy = c.y + 0.1 + Math.sin(ang) * r0 * 0.7;
        ctx.strokeStyle = `rgba(255,${200 + Math.floor(h1 * 55)},90,${(1 - ph).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(ang) * 0.14, sy + Math.sin(ang) * 0.1);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}

/**
 * screen-space badges above broken objects: ⚠️ while waiting, 🔧 with a progress ring while being repaired.
 * `toScreen` maps world tiles to CSS px; call with a dpr transform.
 */
export function drawIncidentBadges(
  ctx: CanvasRenderingContext2D,
  world: World,
  toScreen: (x: number, y: number) => { x: number; y: number },
  zoom: number,
  now: number,
): void {
  const broken = brokenObjects(world);
  if (!broken.length) return;
  const ui = Math.max(0.8, Math.min(1.25, zoom / 34));
  const r = 11 * ui;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of broken) {
    const o = world.objects.find((x) => x.uid === b.uid);
    if (!o) continue;
    const c = centerOf(world, o);
    const p = toScreen(c.x, c.y - c.h / 2 - 0.15);
    const y = p.y - r - 2 + Math.sin(now / 300 + b.uid) * 2;
    const working = b.repairerIds.length > 0;
    ctx.fillStyle = working ? 'rgba(255,248,225,0.95)' : 'rgba(255,236,200,0.95)';
    ctx.strokeStyle = working ? '#e0a020' : '#d9534f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (b.progress > 0) {
      ctx.strokeStyle = '#3c9a5f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * b.progress);
      ctx.stroke();
    }
    ctx.font = `${Math.round(13 * ui)}px ${EMOJI_FONT}`;
    ctx.fillStyle = '#000';
    ctx.fillText(working ? '🔧' : '⚠️', p.x, y + 1);
  }
  ctx.restore();
}

/** the type to draw for an instance (a broken fridge still looks like a fridge) */
export function visualType(o: ObjectInstance): string {
  return isBroken(o) ? baseTypeOf(o.type) : o.type;
}
