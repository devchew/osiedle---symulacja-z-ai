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
  /** higher = placed first and kept when crowded (e.g. the selected agent) */
  priority?: number;
  /** conversation the speaker takes part in; at most MAX_PER_CONVERSATION bubbles each */
  conversationId?: number | null;
  /** opacity from the presenter (real-time fade); default: fade by the remaining ticks */
  fade?: number;
}

/** screen rect the bubbles should avoid (agent bodies, name labels) */
export interface Obstacle {
  agentId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  item: BubbleItem;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** CSS px, independent of zoom */
const FONT_SIZE = 13.5;
const LINE_H = 17;
const PAD_X = 10;
const PAD_Y = 7;
const MAX_W = 200;
const MAX_PER_CONVERSATION = 2;
const MAX_BUBBLES = 8;
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

function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, m = 0): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + m;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + m;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Lays out and draws bubbles. Each bubble tries a set of candidate spots above
 * its speaker (centred, shifted sideways, raised) and takes the one with the
 * least overlap with already placed bubbles (heavy penalty) and other agents'
 * bodies / labels (light penalty), preferring spots close to the speaker.
 */
export function drawBubbles(ctx: Ctx, items: BubbleItem[], viewW: number, viewH: number, obstacles: Obstacle[] = []): void {
  if (!items.length) return;
  // pick which bubbles to show: priority, then speech over thoughts, then fresher
  const ranked = [...items].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (a.bubble.kind === 'speech' ? 0 : 1) - (b.bubble.kind === 'speech' ? 0 : 1) ||
      b.bubble.ttl - a.bubble.ttl,
  );
  const perConv = new Map<number, number>();
  const chosen: BubbleItem[] = [];
  for (const it of ranked) {
    if (chosen.length >= MAX_BUBBLES) break;
    if (it.conversationId != null) {
      const n = perConv.get(it.conversationId) ?? 0;
      if (n >= MAX_PER_CONVERSATION) continue;
      perConv.set(it.conversationId, n + 1);
    }
    chosen.push(it);
  }
  // place lower bubbles first so upper ones stack above them
  const order = chosen.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.ay - a.ay);
  const placed: Placed[] = [];
  for (const item of order) {
    const thought = item.bubble.kind === 'thought';
    const font = `${thought ? 'italic ' : ''}500 ${FONT_SIZE}px ${UI_FONT}`;
    const { lines, width } = wrap(ctx, item.bubble.text, font);
    const w = Math.ceil(width + PAD_X * 2 + 4 + (thought ? 6 : 0));
    const h = lines.length * LINE_H + PAD_Y * 2 + (thought ? 4 : 0);
    const nx = item.ax - w / 2;
    const ny = item.ay - TAIL - h;
    const xs = [nx, nx - w * 0.38, nx + w * 0.38, item.ax - 24, item.ax - w + 24];
    const ys = [ny, ny - 18, ny - 40, ny - 64, ny - 92];
    let best: Placed | null = null;
    let bestScore = Infinity;
    for (const yy of ys) {
      for (const xx of xs) {
        const cand: Placed = {
          item,
          lines,
          w,
          h,
          x: Math.max(4, Math.min(viewW - w - 4, xx)),
          y: Math.max(4, Math.min(viewH - h - 4, yy)),
        };
        let score = Math.abs(cand.x - nx) * 0.4 + Math.abs(cand.y - ny) * 1.2;
        for (const q of placed) score += overlapArea(cand, q, 6) * 4;
        for (const o of obstacles) if (o.agentId !== item.agentId) score += overlapArea(cand, o) * 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      if (bestScore < 1) break;
    }
    placed.push(best!);
  }
  // draw top-most first so tails of stacked bubbles pass under the lower ones
  placed.sort((a, b) => a.y - b.y);
  for (const p of placed) drawOne(ctx, p);
}

function drawOne(ctx: Ctx, p: Placed): void {
  const b = p.item.bubble;
  ctx.save();
  // presenter fade (real time), else fade out over the last couple of ticks
  ctx.globalAlpha = p.item.fade ?? Math.max(0.35, Math.min(1, 0.35 + b.ttl * 0.33));
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

// ---------------------------------------------------------------- real-time presentation

// The simulation keeps a bubble for `ttl` ticks, but a tick lasts 0.2 s in the sandbox and a whole
// minute in the live view. The presenter decides in wall-clock time what is on screen: a bubble shows
// from `at` (fraction of the tick it was said in), stays for its reading time and fades out; at fast
// speeds each bubble is held at least MIN_SHOW_MS before a newer one replaces it or it disappears.

/** a bubble stays at least this long (ms), so lines stay readable when ticks fly by */
export const MIN_SHOW_MS = 1500;
const FADE_MS = 450;

/** how long (ms) a bubble stays on screen: a few seconds, longer for longer text */
export function readingTimeMs(text: string): number {
  return Math.max(3500, Math.min(9000, 2500 + text.length * 55));
}

interface Shown {
  kind: Bubble['kind'];
  text: string;
  /** last seen ttl: a bubble with the same text but a higher ttl was said again */
  ttl: number;
  /** tick when the simulation bubble was first seen (its `at` applies only in that tick) */
  tick: number;
  /** performance.now() when it went on screen, null while waiting for `at` */
  since: number | null;
  /** copy drawn on screen (kept while lingering after the simulation dropped it) */
  bubble: Bubble;
}

export interface BubblePresenter {
  /** the bubble to draw for the agent now and its opacity, or null */
  present(agentId: number, bubble: Bubble | null, tick: number, alpha: number, now: number): { bubble: Bubble; fade: number } | null;
  /** forgets agents not in `ids` (another world / place) */
  retain(ids: ReadonlySet<number>): void;
  clear(): void;
}

export function createBubblePresenter(): BubblePresenter {
  /** what each agent shows (or waits to show) */
  const cur = new Map<number, Shown>();
  /** a bubble said while the current one is still within MIN_SHOW_MS */
  const next = new Map<number, Shown>();

  const fresh = (b: Bubble, tick: number): Shown => ({ kind: b.kind, text: b.text, ttl: b.ttl, tick, since: null, bubble: { ...b } });
  const same = (s: Shown | undefined, b: Bubble): boolean => !!s && s.kind === b.kind && s.text === b.text && b.ttl <= s.ttl;
  const due = (s: Shown, tick: number, alpha: number): boolean => tick > s.tick || alpha >= (s.bubble.at ?? 0);
  const maxShow = (s: Shown): number => (s.text === '…' ? Infinity : readingTimeMs(s.text));

  return {
    present(agentId, bubble, tick, alpha, now) {
      const b = bubble && bubble.text ? bubble : null;
      let s = cur.get(agentId);
      if (b) {
        if (same(s, b)) s!.ttl = b.ttl;
        else {
          const q = next.get(agentId);
          if (same(q, b)) q!.ttl = b.ttl;
          else next.set(agentId, fresh(b, tick));
        }
      } else if (s?.since == null) {
        // gone before it ever showed
        cur.delete(agentId);
        s = undefined;
      }
      // promote the newer bubble once it is due and the current one had its minimum time
      const q = next.get(agentId);
      if (q && due(q, tick, alpha) && (!s || s.since === null || now - s.since >= MIN_SHOW_MS)) {
        next.delete(agentId);
        cur.set(agentId, (s = q));
      }
      if (!s) return null;
      if (s.since === null) {
        if (!due(s, tick, alpha)) return null;
        s.since = now;
      }
      const age = now - s.since;
      const live = !!b && same(s, b);
      // the simulation dropped it (or moved on): linger for the minimum time, then fade out
      const end = live ? maxShow(s) : Math.min(maxShow(s), Math.max(MIN_SHOW_MS, age));
      if (age >= end) {
        if (!live) cur.delete(agentId);
        return null;
      }
      const fade = end === Infinity ? 1 : Math.max(0, Math.min(1, (end - age) / FADE_MS));
      return { bubble: s.bubble, fade };
    },
    retain(ids) {
      for (const m of [cur, next]) for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id);
    },
    clear() {
      cur.clear();
      next.clear();
    },
  };
}
