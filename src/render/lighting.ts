// Day/night lighting. A world-space light mask (indoor rooms + lamps) is baked
// once at low resolution, together with a pre-cut darkness layer (dark fill
// minus the mask, 'destination-out') and a warm-tinted copy of the mask. Each
// frame draws those two images with globalAlpha scaled by "night", plus a
// dawn/dusk colour grade (multiply + soft glow), so the per-frame cost is a
// handful of full-screen fills / drawImage calls.
//
// Light never leaks through walls: room light is filled per tile, and every
// light pool is clipped to the tiles reachable from its source without
// crossing a wall (flood fill within its radius).

import type { Grid, TileKind, World } from '../types';
import { MINUTES_PER_DAY, START_MINUTE, daylightAt } from '../core/time';
import { isLampObject } from './objects';

const MT = 10; // mask pixels per tile
const DARK = 'rgba(18,16,50,0.7)';

export interface LightState {
  hour: number;
  daylight: number;
}

export function lightStateAt(tick: number, alpha: number): LightState {
  const minute = (((tick + alpha + START_MINUTE) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = minute / 60;
  return { hour, daylight: daylightAt(hour) };
}

/** smooth bump: 0 outside [a, d], 1 in [b, c], smoothstep ramps in between */
function bump(h: number, a: number, b: number, c: number, d: number): number {
  const s = (t: number): number => t * t * (3 - 2 * t);
  if (h <= a || h >= d) return 0;
  if (h < b) return s((h - a) / (b - a));
  if (h <= c) return 1;
  return s((d - h) / (d - c));
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}

export interface TwilightGrade {
  /** multiply colours: near the sun (top-left) and away from it */
  mulNear: string;
  mulFar: string;
  mulA: number;
  /** additive (screen) glow from the sun side */
  glow: string;
  glowA: number;
}

/** twilight grade for a given hour, or null in full day / night */
export function twilightGrade(hour: number): TwilightGrade | null {
  // dusk: golden from ~17:30, rose/violet at ~20:30, fades into night by ~22
  const dusk = bump(hour, 17.3, 19.0, 20.6, 22.2);
  if (dusk > 0.001) {
    const t = Math.max(0, Math.min(1, (hour - 18.3) / 2.4)); // golden → rose
    return {
      mulNear: lerpRgb([255, 214, 168], [255, 176, 170], t),
      mulFar: lerpRgb([246, 190, 196], [196, 160, 222], t),
      mulA: dusk * 0.62,
      glow: lerpRgb([255, 160, 70], [255, 105, 120], t),
      glowA: dusk * 0.2,
    };
  }
  // dawn: soft lavender → peach, gentler than dusk
  const dawn = bump(hour, 4.6, 5.8, 6.6, 8.2);
  if (dawn > 0.001) {
    const t = Math.max(0, Math.min(1, (hour - 5) / 2));
    return {
      mulNear: lerpRgb([224, 214, 255], [255, 232, 214], t),
      mulFar: lerpRgb([206, 204, 246], [240, 226, 240], t),
      mulA: dawn * 0.4,
      glow: lerpRgb([210, 190, 255], [255, 200, 160], t),
      glowA: dawn * 0.12,
    };
  }
  return null;
}

const INDOOR: ReadonlySet<TileKind> = new Set<TileKind>(['floor', 'tile', 'door']);
const OUTDOOR: ReadonlySet<TileKind> = new Set<TileKind>(['grass', 'path', 'water', 'door']);

/** tiles reachable from (sx, sy) through tiles of the same class, within radius r */
function lightRegion(g: Grid, sx: number, sy: number, r: number): number[] {
  const start = g.tiles[sy * g.width + sx];
  const cls = INDOOR.has(start) && start !== 'door' ? INDOOR : OUTDOOR;
  const out: number[] = [];
  const seen = new Set<number>([sy * g.width + sx]);
  const queue: [number, number][] = [[sx, sy]];
  const rr = (r + 0.8) * (r + 0.8);
  while (queue.length) {
    const [x, y] = queue.pop()!;
    out.push(y * g.width + x);
    // doors pass light into the doorway but not beyond
    if (g.tiles[y * g.width + x] === 'door' && (x !== sx || y !== sy)) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.width || ny >= g.height) continue;
      const i = ny * g.width + nx;
      if (seen.has(i)) continue;
      seen.add(i);
      if ((nx - sx) * (nx - sx) + (ny - sy) * (ny - sy) > rr) continue;
      if (!cls.has(g.tiles[i])) continue;
      queue.push([nx, ny]);
    }
  }
  return out;
}

export class Lighting {
  private mask = document.createElement('canvas');
  private warm = document.createElement('canvas');
  private dark = document.createElement('canvas');
  private mapW = 1;
  private mapH = 1;

  build(world: World): void {
    const g = world.grid;
    this.mapW = g.width;
    this.mapH = g.height;
    const m = this.mask;
    m.width = g.width * MT;
    m.height = g.height * MT;
    const ctx = m.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, m.width, m.height);
    ctx.setTransform(MT, 0, 0, MT, MT / 2, MT / 2);

    // indoor tiles get an even room light; walls a little (so the house outline reads)
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const k = g.tiles[y * g.width + x];
        if (k === 'floor' || k === 'tile' || k === 'door') ctx.rect(x - 0.5, y - 0.5, 1, 1);
      }
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    const indoorAt = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= g.width || y >= g.height) return false;
      const k = g.tiles[y * g.width + x];
      return k === 'floor' || k === 'tile';
    };
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        if (g.tiles[y * g.width + x] !== 'wall') continue;
        // walls touching the inside of the house (8-neighbourhood, so junctions are lit too)
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = indoorAt(x + dx, y + dy);
        if (near) ctx.rect(x - 0.5, y - 0.5, 1, 1);
      }
    }
    ctx.fill();

    // lamps (and a few other glows) as radial pools clipped to their region
    for (const o of world.objects) {
      const def = world.objectDefs[o.type];
      const w = def?.size.w ?? 1;
      const h = def?.size.h ?? 1;
      const cx = o.pos.x + (w - 1) / 2;
      const cy = o.pos.y + (h - 1) / 2;
      const tx = Math.max(0, Math.min(g.width - 1, Math.round(cx)));
      const ty = Math.max(0, Math.min(g.height - 1, Math.round(cy)));
      let r = 0;
      let a = 0;
      const k = g.tiles[ty * g.width + tx];
      const outdoor = k === 'grass' || k === 'path' || k === 'water';
      if (isLampObject(o.type)) {
        r = outdoor ? 3 : 3.8;
        a = outdoor ? 0.8 : 1;
      } else if (/grill|bbq|fire|ognisk/i.test(o.type)) {
        r = 2;
        a = 0.65;
      } else if (/\btv\b|^tv|tv_|telewiz|computer|komput|desk/i.test(o.type)) {
        r = 1.6;
        a = 0.45;
      }
      if (!r) continue;
      // light sources standing on a solid footprint: start from a neighbouring free tile of the same side
      let sx = tx;
      let sy = ty;
      if (g.tiles[sy * g.width + sx] === 'wall' || (!outdoor && !INDOOR.has(g.tiles[sy * g.width + sx]))) {
        const below = Math.min(g.height - 1, o.pos.y + h);
        sx = Math.round(cx);
        sy = below;
      }
      const region = lightRegion(g, sx, sy, r);
      // the footprint itself is lit too
      for (let yy = o.pos.y; yy < o.pos.y + h; yy++) for (let xx = o.pos.x; xx < o.pos.x + w; xx++) region.push(yy * g.width + xx);
      ctx.save();
      ctx.beginPath();
      for (const i of region) ctx.rect((i % g.width) - 0.52, Math.floor(i / g.width) - 0.52, 1.04, 1.04);
      ctx.clip();
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(0,0,0,${a})`);
      grad.addColorStop(0.5, `rgba(0,0,0,${a * 0.55})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    }

    // warm-tinted copy of the mask
    const wc = this.warm;
    wc.width = m.width;
    wc.height = m.height;
    const wctx = wc.getContext('2d');
    if (!wctx) return;
    wctx.clearRect(0, 0, wc.width, wc.height);
    wctx.drawImage(m, 0, 0);
    wctx.globalCompositeOperation = 'source-in';
    wctx.fillStyle = '#ffb45e';
    wctx.fillRect(0, 0, wc.width, wc.height);
    wctx.globalCompositeOperation = 'source-over';

    // pre-cut darkness layer: drawn each frame with globalAlpha = night
    const d = this.dark;
    d.width = m.width;
    d.height = m.height;
    const dctx = d.getContext('2d');
    if (!dctx) return;
    dctx.globalCompositeOperation = 'source-over';
    dctx.fillStyle = DARK;
    dctx.fillRect(0, 0, d.width, d.height);
    dctx.globalCompositeOperation = 'destination-out';
    dctx.drawImage(m, 0, 0);
    dctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Draws the lighting over the already rendered world.
   * `world2px` = [scale, offsetX, offsetY] mapping world units to device pixels.
   */
  draw(ctx: CanvasRenderingContext2D, light: LightState, world2px: [number, number, number]): void {
    const night = 1 - light.daylight;
    const [s, ox, oy] = world2px;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    if (night > 0.01) {
      ctx.setTransform(s, 0, 0, s, ox, oy);
      // ease the darkness in so dusk keeps its colour before night falls
      ctx.globalAlpha = Math.pow(night, 1.5);
      ctx.drawImage(this.dark, -0.5, -0.5, this.mapW, this.mapH);
      // darkness outside the map
      ctx.fillStyle = DARK;
      const big = 2000;
      ctx.fillRect(-0.5 - big, -0.5 - big, this.mapW + 2 * big, big);
      ctx.fillRect(-0.5 - big, this.mapH - 0.5, this.mapW + 2 * big, big);
      ctx.fillRect(-0.5 - big, -0.5, big, this.mapH);
      ctx.fillRect(this.mapW - 0.5, -0.5, big, this.mapH);
      // warm light pools
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.16 * night;
      ctx.drawImage(this.warm, -0.5, -0.5, this.mapW, this.mapH);
      ctx.globalCompositeOperation = 'source-over';
    }
    // dawn / dusk colour grade: multiply tints shadows & greens, a faint additive glow keeps it luminous
    const grade = twilightGrade(light.hour);
    if (grade) {
      // sun sits low on the west (left) side: warm near it, rose/violet away from it
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const lin = ctx.createLinearGradient(0, 0, W, H * 0.6);
      lin.addColorStop(0, grade.mulNear);
      lin.addColorStop(1, grade.mulFar);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = grade.mulA;
      ctx.fillStyle = lin;
      ctx.fillRect(0, 0, W, H);
      // sun glow: only the quarter of the screen it actually reaches is filled
      const R = Math.min(W, H) * 0.95;
      const rad = ctx.createRadialGradient(0, H * 0.3, 0, 0, H * 0.3, R);
      rad.addColorStop(0, grade.glow);
      rad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = grade.glowA * 0.8;
      ctx.fillStyle = rad;
      ctx.fillRect(0, Math.max(0, H * 0.3 - R), Math.min(W, R), Math.min(H, R * 2));
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
}
