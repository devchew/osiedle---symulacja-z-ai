// Day/night lighting. A world-space light mask (indoor rooms + lamps) is baked
// once at low resolution, together with a pre-cut darkness layer (dark fill
// minus the mask, 'destination-out') and a warm-tinted copy of the mask. Each
// frame just draws those two images with globalAlpha scaled by "night", plus a
// dawn/dusk colour grade, so the per-frame cost is two drawImage calls.

import type { World } from '../types';
import { MINUTES_PER_DAY, START_MINUTE, daylightAt } from '../core/time';
import { isLampObject } from './objects';

const MT = 10; // mask pixels per tile
const DARK = 'rgba(12,18,46,0.68)';

export interface LightState {
  hour: number;
  daylight: number;
}

export function lightStateAt(tick: number, alpha: number): LightState {
  const minute = (((tick + alpha + START_MINUTE) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = minute / 60;
  return { hour, daylight: daylightAt(hour) };
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
    ctx.clearRect(0, 0, m.width, m.height);
    ctx.setTransform(MT, 0, 0, MT, MT / 2, MT / 2);

    // indoor tiles (floor / tile / door) get a soft, even room light
    ctx.save();
    ctx.filter = `blur(${Math.round(MT * 0.6)}px)`;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.beginPath();
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const k = g.tiles[y * g.width + x];
        if (k === 'floor' || k === 'tile' || k === 'door') ctx.rect(x - 0.5, y - 0.5, 1, 1);
      }
    }
    ctx.fill();
    ctx.restore();

    // lamps (and a few outdoor glows) as radial pools
    for (const o of world.objects) {
      const def = world.objectDefs[o.type];
      const w = def?.size.w ?? 1;
      const h = def?.size.h ?? 1;
      const cx = o.pos.x + (w - 1) / 2;
      const cy = o.pos.y + (h - 1) / 2;
      let r = 0;
      let a = 0;
      const k = g.tiles[Math.round(cy) * g.width + Math.round(cx)];
      const outdoor = k === 'grass' || k === 'path' || k === 'water';
      if (isLampObject(o.type)) {
        r = outdoor ? 2.8 : 3.6;
        a = outdoor ? 0.75 : 1;
      } else if (/grill|bbq|fire|ognisk/i.test(o.type)) {
        r = 1.8;
        a = 0.6;
      } else if (/\btv\b|^tv|tv_|telewiz|computer|komput|desk/i.test(o.type)) {
        r = 1.5;
        a = 0.5;
      }
      if (!r) continue;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(0,0,0,${a})`);
      grad.addColorStop(0.5, `rgba(0,0,0,${a * 0.55})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // warm-tinted copy of the mask
    const w = this.warm;
    w.width = m.width;
    w.height = m.height;
    const wctx = w.getContext('2d');
    if (!wctx) return;
    wctx.clearRect(0, 0, w.width, w.height);
    wctx.drawImage(m, 0, 0);
    wctx.globalCompositeOperation = 'source-in';
    wctx.fillStyle = '#ffb45e';
    wctx.fillRect(0, 0, w.width, w.height);
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    // dawn / dusk colour grade
    const twilight = Math.sin(Math.PI * Math.max(0, Math.min(1, light.daylight)));
    if (twilight > 0.01) {
      ctx.globalAlpha = twilight * 0.16;
      ctx.fillStyle = light.hour < 12 ? '#ff8f7a' : '#ff7a2a';
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    if (night > 0.01) {
      ctx.setTransform(s, 0, 0, s, ox, oy);
      ctx.globalAlpha = night;
      ctx.drawImage(this.dark, -0.5, -0.5, this.mapW, this.mapH);
      // darkness outside the map
      ctx.fillStyle = DARK;
      const big = 2000;
      ctx.fillRect(-0.5 - big, -0.5 - big, this.mapW + 2 * big, big);
      ctx.fillRect(-0.5 - big, this.mapH - 0.5, this.mapW + 2 * big, big);
      ctx.fillRect(-0.5 - big, -0.5, big, this.mapH);
      ctx.fillRect(this.mapW - 0.5, -0.5, big, this.mapH);
      // warm light pools
      ctx.globalAlpha = 0.2 * night;
      ctx.drawImage(this.warm, -0.5, -0.5, this.mapW, this.mapH);
    }
    ctx.restore();
  }
}
