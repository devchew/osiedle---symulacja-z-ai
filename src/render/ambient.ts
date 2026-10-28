// Cheap ambient touches: drifting cloud shadows by day, water shimmer, and
// fireflies over the garden at night. Sprites are pre-rendered once; each frame
// costs a few dozen drawImage / stroke calls.

import type { World } from '../types';
import { hash2 } from './colors';

interface Firefly {
  x: number;
  y: number;
  ph: number;
  sp: number;
}

function sprite(size: number, paint: (c: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d');
  if (c) paint(c, size);
  return cv;
}

export class Ambient {
  private cloud = sprite(128, (c, s) => {
    // a lumpy soft blob made of a few radial gradients
    const blobs: [number, number, number][] = [
      [0.5, 0.52, 0.34],
      [0.32, 0.56, 0.24],
      [0.68, 0.48, 0.26],
      [0.45, 0.38, 0.22],
      [0.6, 0.64, 0.2],
    ];
    for (const [x, y, r] of blobs) {
      const g = c.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s);
      g.addColorStop(0, 'rgba(20,30,40,0.55)');
      g.addColorStop(1, 'rgba(20,30,40,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    }
  });
  private glow = sprite(32, (c, s) => {
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,210,1)');
    g.addColorStop(0.18, 'rgba(236,255,140,0.9)');
    g.addColorStop(0.45, 'rgba(200,255,90,0.28)');
    g.addColorStop(1, 'rgba(200,255,90,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  });
  private water: { x: number; y: number; h: number }[] = [];
  private flies: Firefly[] = [];
  private mapW = 1;
  private mapH = 1;

  build(world: World): void {
    const g = world.grid;
    this.mapW = g.width;
    this.mapH = g.height;
    this.water = [];
    const garden: { x: number; y: number }[] = [];
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const k = g.tiles[y * g.width + x];
        if (k === 'water') this.water.push({ x, y, h: hash2(x, y, 41) });
        else if (k === 'grass' && !g.solid[y * g.width + x]) garden.push({ x, y });
      }
    }
    this.flies = [];
    const n = Math.min(28, Math.round(garden.length / 18));
    for (let i = 0; i < n && garden.length; i++) {
      const t = garden[Math.floor(hash2(i, 3, world.seed | 0) * garden.length)];
      this.flies.push({ x: t.x, y: t.y, ph: hash2(i, 5) * 100, sp: 0.6 + hash2(i, 7) * 0.8 });
    }
  }

  /** world-space effects drawn above the static layer and below agents */
  drawGround(ctx: CanvasRenderingContext2D, now: number, daylight: number): void {
    if (!this.water.length) return;
    const t = now / 1000;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.035;
    for (const w of this.water) {
      const a = Math.sin(t * (0.9 + w.h) + w.h * 40);
      if (a < 0.35) continue;
      const k = (a - 0.35) / 0.65;
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 * k * (0.35 + 0.65 * daylight)).toFixed(3)})`;
      const dx = Math.sin(t * 0.5 + w.h * 9) * 0.12;
      ctx.beginPath();
      ctx.arc(w.x - 0.15 + w.h * 0.3 + dx, w.y + (w.h - 0.5) * 0.4, 0.1 + 0.08 * k, Math.PI * 1.15, Math.PI * 1.75);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** soft cloud shadows sweeping over the map, only by day (drawn under lighting) */
  drawClouds(ctx: CanvasRenderingContext2D, now: number, daylight: number): void {
    if (daylight < 0.05) return;
    const t = now / 1000;
    ctx.save();
    ctx.globalAlpha = 0.11 * daylight;
    const span = this.mapW + 24;
    for (let i = 0; i < 2; i++) {
      const size = 10 + i * 4;
      const x = (((t * (0.32 + i * 0.07) + i * span * 0.37) % span) + span) % span - 12;
      const y = (this.mapH * (0.2 + i * 0.3)) % this.mapH - size / 2 + Math.sin(t * 0.05 + i) * 1.5;
      ctx.drawImage(this.cloud, x - size / 2, y, size, size * 0.7);
    }
    ctx.restore();
  }

  /** fireflies, drawn after the lighting so they glow in the dark */
  drawNight(ctx: CanvasRenderingContext2D, now: number, night: number): void {
    if (night < 0.3 || !this.flies.length) return;
    const t = now / 1000;
    const k = Math.min(1, (night - 0.3) / 0.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of this.flies) {
      const blink = Math.max(0, Math.sin(t * f.sp * 1.6 + f.ph));
      if (blink < 0.05) continue;
      const x = f.x + Math.sin(t * 0.37 * f.sp + f.ph) * 1.4 + Math.sin(t * 1.3 + f.ph * 2) * 0.2;
      const y = f.y + Math.cos(t * 0.29 * f.sp + f.ph * 1.7) * 1.1;
      ctx.globalAlpha = blink * k * 0.9;
      const s = 0.55;
      ctx.drawImage(this.glow, x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }
}
