// Speech / thought bubbles, drawn in screen space (CSS pixels) so they stay
// readable at every zoom level. Bubbles are laid out greedily to avoid overlap.

import type { Bubble } from '../types';
import { UI_FONT, circle, rr } from './colors';

type Ctx = CanvasRenderingContext2D;

export interface BubbleItem {
  agentId: number;
  bubble: Bubble;
  /** screen point the bubble should point at (CSS px) */
  ax: number;
  ay: number;
}

interface Placed {
  item: BubbleItem;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

const FONT_SIZE = 12.5;
const LINE_H = 16;
const PAD_X = 10;
const PAD_Y = 7;
const MAX_W = 190;
const MAX_LINES = 3;
const TAIL = 11;

const TONE_BORDER: Record<string, string> = {
  positive: '#55b56a',
  negative: '#e0574b',
  neutral: '#a3acb8',
};

const wrapCache = new Map<string, { lines: string[]; width: number }>();

function wrap(ctx: Ctx, text: string, font: string): { lines: string[]; width: number } {
  const key = font + '|' + text;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= MAX_W || !cur) cur = test;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    let last = lines[MAX_LINES - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > MAX_W) last = last.slice(0, -1);
    lines[MAX_LINES - 1] = last.replace(/[\s,.;:]+$/, '') + '…';
  }
  // hard-break single overlong words
  for (let i = 0; i < lines.length; i++) {
    while (ctx.measureText(lines[i]).width > MAX_W && lines[i].length > 2) lines[i] = lines[i].slice(0, -2) + '…';
  }
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
  const res = { lines, width };
  if (wrapCache.size > 400) wrapCache.clear();
  wrapCache.set(key, res);
  return res;
}

const overlaps = (a: Placed, b: Placed, m = 4): boolean =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

export function drawBubbles(ctx: Ctx, items: BubbleItem[], viewW: number, viewH: number): void {
  if (!items.length) return;
  const sorted = [...items].sort((a, b) => b.ay - a.ay);
  const placed: Placed[] = [];
  for (const item of sorted) {
    const thought = item.bubble.kind === 'thought';
    const font = `${thought ? 'italic ' : ''}500 ${FONT_SIZE}px ${UI_FONT}`;
    const { lines, width } = wrap(ctx, item.bubble.text, font);
    const w = Math.ceil(width + PAD_X * 2 + (thought ? 6 : 0));
    const h = lines.length * LINE_H + PAD_Y * 2 + (thought ? 4 : 0);
    const x0 = Math.max(6, Math.min(viewW - w - 6, item.ax - w / 2));
    const y0 = item.ay - TAIL - h;
    const p: Placed = { item, lines, w, h, x: x0, y: y0 };
    // try the natural spot, then sliding sideways next to each placed bubble
    const tries: number[] = [x0];
    for (const q of placed) tries.push(q.x + q.w + 6, q.x - w - 6);
    tries.sort((a, b) => Math.abs(a - x0) - Math.abs(b - x0));
    let ok = false;
    for (const tx of tries) {
      if (tx < 4 || tx + w > viewW - 4) continue;
      if (item.ax < tx - 36 || item.ax > tx + w + 36) continue;
      p.x = tx;
      if (!placed.some((q) => overlaps(p, q))) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      p.x = x0;
      for (let guard = 0; guard < 12; guard++) {
        const hit = placed.find((q) => overlaps(p, q));
        if (!hit) break;
        p.y = hit.y - p.h - 6;
      }
    }
    p.y = Math.max(4, Math.min(viewH - h - 4, p.y));
    placed.push(p);
  }
  // draw top-most first so tails of stacked bubbles pass under the lower ones
  placed.sort((a, b) => a.y - b.y);
  for (const p of placed) drawOne(ctx, p);
}

function drawOne(ctx: Ctx, p: Placed): void {
  const b = p.item.bubble;
  ctx.save();
  // fade out over the last couple of ticks
  ctx.globalAlpha = Math.max(0.35, Math.min(1, 0.35 + b.ttl * 0.33));
  if (b.kind === 'thought') drawThought(ctx, p);
  else drawSpeech(ctx, p);
  ctx.restore();
}

function drawSpeech(ctx: Ctx, p: Placed): void {
  const border = TONE_BORDER[p.item.bubble.tone ?? 'neutral'] ?? TONE_BORDER.neutral;
  const { x, y, w, h } = p;
  const tipX = p.item.ax;
  const tipY = p.item.ay;
  const baseX = Math.max(x + 14, Math.min(x + w - 14, tipX));
  const bottom = y + h;
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, bottom, r);
  ctx.arcTo(x + w, bottom, x, bottom, r);
  ctx.lineTo(baseX + 6, bottom);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(baseX - 6, bottom);
  ctx.arcTo(x, bottom, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.shadowColor = 'rgba(20,20,40,0.22)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 2;
  ctx.strokeStyle = border;
  ctx.stroke();
  // tone accent bar
  ctx.fillStyle = border;
  rr(ctx, x + 5, y + 6, 3, h - 12, 1.5);
  ctx.fill();
  ctx.font = `500 ${FONT_SIZE}px ${UI_FONT}`;
  ctx.fillStyle = '#26262e';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  p.lines.forEach((l, i) => ctx.fillText(l, x + PAD_X + 2, y + PAD_Y + LINE_H * (i + 0.5)));
}

function drawThought(ctx: Ctx, p: Placed): void {
  const { x, y, w, h } = p;
  const fill = 'rgba(246,248,253,0.97)';
  const stroke = '#a9b3c6';
  // cloud = rounded body + bumps along top/bottom edges
  const shapes: (() => void)[] = [];
  shapes.push(() => rr(ctx, x, y, w, h, h / 2));
  const bumps = Math.max(2, Math.round(w / 26));
  for (let i = 0; i < bumps; i++) {
    const bx = x + h * 0.4 + ((i + 0.5) * (w - h * 0.8)) / bumps;
    shapes.push(() => circle(ctx, bx, y + 2, 9));
    shapes.push(() => circle(ctx, bx + 6, y + h - 2, 8));
  }
  // trailing dots towards the head
  const tipX = p.item.ax;
  const tipY = p.item.ay;
  const sx = Math.max(x + 12, Math.min(x + w - 12, tipX));
  const sy = y + h + 4;
  shapes.push(() => circle(ctx, sx + (tipX - sx) * 0.35, sy + (tipY - sy) * 0.3, 4.5));
  shapes.push(() => circle(ctx, sx + (tipX - sx) * 0.75, sy + (tipY - sy) * 0.75, 3));
  ctx.shadowColor = 'rgba(20,20,40,0.18)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = stroke;
  for (const s of shapes) {
    s();
    ctx.stroke();
  }
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fill;
  for (const s of shapes) {
    s();
    ctx.fill();
  }
  ctx.font = `italic 500 ${FONT_SIZE}px ${UI_FONT}`;
  ctx.fillStyle = '#4a5063';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  p.lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + PAD_Y + 2 + LINE_H * (i + 0.5)));
}
