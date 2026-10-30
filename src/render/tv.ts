// TV news on screen: a flickering lit screen on the TV cabinet (world space) and a small
// "lower third" above the TV with an animated picture, the 📺 WIADOMOŚCI badge, the source
// and a scrolling headline ticker (screen space, legible at any zoom).
// Reads the World only (world/news.ts); never mutates simulation state.

import type { World } from '../types';
import { activeTvs, currentHeadline, type NewsItem } from '../world/news';
import { EMOJI_FONT, UI_FONT, rr } from './colors';
import { SCROLL_SPEED, presentHeadline, scrollOffset, ticker } from './tvTicker';

type Ctx = CanvasRenderingContext2D;

/** world-space: the lit, gently flickering screen of every TV someone is watching */
export function drawTvScreens(ctx: Ctx, world: World, now: number): void {
  const uids = activeTvs(world);
  if (!uids.length) return;
  const item = presentHeadline(ticker, currentHeadline(world), now);
  const t = now / 1000;
  ctx.save();
  for (const uid of uids) {
    const o = world.objects.find((x) => x.uid === uid);
    const def = o && world.objectDefs[o.type];
    if (!o || !def) continue;
    // same geometry as the tv drawer in objects.ts (inset 0.06, screen strip at the top)
    const x = o.pos.x - 0.5 + 0.06 + 0.12;
    const y = o.pos.y - 0.5 + 0.06 + 0.04;
    const w = def.size.w - 0.12 - 0.24;
    const h = 0.16;
    const hue = item?.title.startsWith('Pilne:') ? 0 : item && !item.real ? 145 : 210;
    const g = ctx.createLinearGradient(x, y, x + w, y);
    for (let i = 0; i <= 4; i++) {
      const l = 45 + 20 * Math.sin(t * 2.1 + i * 1.7 + uid);
      g.addColorStop(i / 4, `hsl(${hue + i * 18}, 70%, ${l.toFixed(1)}%)`);
    }
    rr(ctx, x, y, w, h, 0.03);
    ctx.fillStyle = g;
    ctx.fill();
    // soft glow in front of the screen
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x + w / 2, y + h, 0.05, x + w / 2, y + h, w * 0.6);
    const a = 0.16 + 0.05 * Math.sin(t * 7 + uid);
    glow.addColorStop(0, `hsla(${hue}, 80%, 70%, ${a.toFixed(3)})`);
    glow.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - 0.3, y - 0.2, w + 0.6, 1.1);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

/** CSS px reserved for the HUD at the top of the screen */
const TOP_INSET = 70;

export interface TvPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const widthCache = new Map<string, number>();
function textWidth(ctx: Ctx, text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (widthCache.size > 300) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

type Scene = 'world' | 'weather' | 'urgent' | 'local';
function sceneOf(item: NewsItem): Scene {
  if (item.real) return 'world';
  if (item.title.startsWith('Pogoda:')) return 'weather';
  if (item.title.startsWith('Pilne:')) return 'urgent';
  return 'local';
}

/** the tiny animated picture in the corner of the lower third */
function drawPicture(ctx: Ctx, item: NewsItem, x: number, y: number, w: number, h: number, t: number): void {
  ctx.save();
  rr(ctx, x, y, w, h, 3);
  ctx.clip();
  const scene = sceneOf(item);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) * 0.34;
  if (scene === 'world') {
    // spinning globe in a blue studio
    const bg = ctx.createLinearGradient(x, y, x, y + h);
    bg.addColorStop(0, '#1b3c78');
    bg.addColorStop(1, '#0d1d3d');
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3f86d8';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    for (let i = 0; i < 4; i++) {
      // meridians drift across the globe
      const ph = ((t * 0.35 + i / 4) % 1) * 2 - 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(ph) * r, r, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const k of [-0.45, 0, 0.45]) {
      ctx.beginPath();
      ctx.moveTo(cx - r, cy + k * r);
      ctx.lineTo(cx + r, cy + k * r);
      ctx.stroke();
    }
    // land blobs sliding by
    ctx.fillStyle = 'rgba(120,200,120,0.85)';
    for (let i = 0; i < 3; i++) {
      const px = cx - r + (((t * 0.35 * 2 * r + i * r * 0.9) % (2.6 * r)) - 0.3 * r);
      ctx.beginPath();
      ctx.ellipse(px, cy + (i - 1) * r * 0.45, r * 0.28, r * 0.18, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (scene === 'weather') {
    const wet = /deszcz|burz|pada/.test(item.title) && !/bez deszczu/.test(item.title);
    ctx.fillStyle = wet ? '#6d7f96' : '#7cc3f0';
    ctx.fillRect(x, y, w, h);
    if (!wet) {
      ctx.save();
      ctx.translate(cx - r * 0.3, cy - r * 0.1);
      ctx.rotate(t * 0.8);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 8; i++) {
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(r * 0.75, 0);
        ctx.lineTo(r * 1.05, 0);
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx - r * 0.3, cy - r * 0.1, r * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd34d';
      ctx.fill();
    }
    // cloud
    const drift = Math.sin(t * 0.7) * w * 0.08;
    ctx.fillStyle = wet ? '#e4e8ee' : '#ffffff';
    for (const [dx, dy, rr2] of [[-0.35, 0.1, 0.42], [0.05, -0.08, 0.55], [0.45, 0.12, 0.4]] as const) {
      ctx.beginPath();
      ctx.arc(cx + r * 0.4 + dx * r + drift, cy + r * 0.25 + dy * r, rr2 * r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (wet) {
      ctx.strokeStyle = '#b9dcff';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        const ph = (t * 1.6 + i * 0.37) % 1;
        const dx = x + 6 + ((i * 7.3) % (w - 10));
        const dy = cy + r * 0.6 + ph * (h * 0.35);
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.lineTo(dx - 1.5, dy + 4);
        ctx.stroke();
      }
    }
  } else if (scene === 'urgent') {
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    ctx.fillStyle = `rgb(${170 + Math.round(pulse * 50)}, 30, 40)`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(h * 0.6)}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', cx, cy + 1);
  } else {
    // the estate: a little house under a twinkling sky
    ctx.fillStyle = '#9fd18a';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#8ccbf2';
    ctx.fillRect(x, y, w, h * 0.55);
    ctx.fillStyle = '#f3e3c4';
    ctx.fillRect(cx - r * 0.7, cy - r * 0.1, r * 1.4, r * 0.95);
    ctx.fillStyle = '#c4553b';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.95, cy - r * 0.05);
    ctx.lineTo(cx, cy - r * 0.85);
    ctx.lineTo(cx + r * 0.95, cy - r * 0.05);
    ctx.fill();
    const lit = Math.sin(t * 3) > 0;
    ctx.fillStyle = lit ? '#ffe28a' : '#6a7d99';
    ctx.fillRect(cx - r * 0.45, cy + r * 0.15, r * 0.3, r * 0.3);
    ctx.fillStyle = '#7a4e2d';
    ctx.fillRect(cx + r * 0.1, cy + r * 0.25, r * 0.3, r * 0.6);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 3; i++) {
      const s = 0.5 + 0.5 * Math.sin(t * 4 + i * 2);
      ctx.beginPath();
      ctx.arc(x + 6 + i * (w * 0.33), y + 5 + (i % 2) * 3, 1 + s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // scanlines + "live" dot
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let sy = y; sy < y + h; sy += 3) ctx.fillRect(x, sy, w, 1);
  ctx.restore();
}

/**
 * screen-space lower third above every TV that is on; `toScreen` maps tiles to CSS px.
 * Call with a dpr transform. Returns the drawn rectangles (bubbles can avoid them).
 */
export function drawTvNews(
  ctx: Ctx,
  world: World,
  toScreen: (x: number, y: number) => { x: number; y: number },
  zoom: number,
  now: number,
  viewW: number,
  viewH: number,
): TvPanelRect[] {
  const item = presentHeadline(ticker, currentHeadline(world), now);
  const uids = activeTvs(world);
  if (!item || !uids.length || zoom < 9) return [];
  const ui = Math.max(1, Math.min(1.25, zoom / 30));
  const t = now / 1000;
  const rects: TvPanelRect[] = [];
  ctx.save();
  for (const uid of uids) {
    const o = world.objects.find((x) => x.uid === uid);
    const def = o && world.objectDefs[o.type];
    if (!o || !def) continue;
    const anchor = toScreen(o.pos.x - 0.5 + def.size.w / 2, o.pos.y - 0.5);
    const W = Math.round(300 * ui);
    const H = Math.round(54 * ui);
    let x = anchor.x - W / 2;
    let y = anchor.y - H - 9 * ui;
    if (x + W < 0 || x > viewW || y + H < -40 || y > viewH) continue;
    x = Math.max(6, Math.min(viewW - W - 6, x));
    // keep clear of the HUD bar at the top
    y = Math.max(TOP_INSET, y);

    // panel + pointer
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    rr(ctx, x, y, W, H, 7 * ui);
    ctx.fillStyle = 'rgba(16,22,36,0.93)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    const px = Math.max(x + 14, Math.min(x + W - 14, anchor.x));
    ctx.moveTo(px - 6 * ui, y + H - 0.5);
    ctx.lineTo(px, y + H + 6 * ui);
    ctx.lineTo(px + 6 * ui, y + H - 0.5);
    ctx.fill();
    rr(ctx, x + 0.5, y + 0.5, W - 1, H - 1, 7 * ui);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // picture
    const pad = 5 * ui;
    const pw = Math.round(48 * ui);
    drawPicture(ctx, item, x + pad, y + pad, pw, H - 2 * pad, t);

    const left = x + pad * 2 + pw;
    const right = x + W - pad - 2;
    // badge: 📺 WIADOMOŚCI
    const badgeFont = `800 ${Math.round(10 * ui)}px ${UI_FONT}`;
    const label = 'WIADOMOŚCI';
    const lw = textWidth(ctx, label, badgeFont);
    const bh = Math.round(15 * ui);
    const bw = lw + 24 * ui;
    rr(ctx, left, y + pad, bw, bh, 3 * ui);
    ctx.fillStyle = item.title.startsWith('Pilne:') && Math.sin(t * 6) > 0 ? '#ff4b4b' : '#d7263d';
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(10 * ui)}px ${EMOJI_FONT}`;
    ctx.fillText('📺', left + 3 * ui, y + pad + bh / 2 + 0.5);
    ctx.font = badgeFont;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, left + 18 * ui, y + pad + bh / 2 + 0.5);
    // live dot + source attribution
    const srcFont = `${Math.round(9.5 * ui)}px ${UI_FONT}`;
    const src = item.real ? `źródło: ${item.source}` : item.source;
    ctx.font = srcFont;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(220,228,240,0.85)';
    ctx.fillText(src, right, y + pad + bh / 2 + 0.5);
    const sw = textWidth(ctx, src, srcFont);
    if (Math.sin(t * 4) > -0.3) {
      ctx.beginPath();
      ctx.arc(right - sw - 7 * ui, y + pad + bh / 2, 2.6 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#ff5a5a';
      ctx.fill();
    }

    // ticker band
    const ty = y + pad + bh + 4 * ui;
    const th = y + H - pad - ty;
    rr(ctx, left, ty, right - left, th, 3 * ui);
    ctx.fillStyle = '#f7f4ea';
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(left + 4 * ui, ty, right - left - 8 * ui, th);
    ctx.clip();
    const font = `700 ${Math.round(12.5 * ui)}px ${UI_FONT}`;
    ctx.font = font;
    ctx.fillStyle = '#1a2233';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const text = item.title;
    const tw = textWidth(ctx, text, font);
    const avail = right - left - 8 * ui;
    const tyMid = ty + th / 2 + 0.5;
    if (tw <= avail) {
      ticker.dist = 0;
      ctx.fillText(text, left + 4 * ui, tyMid);
    } else {
      // one pass from the first word (pause, scroll, rest); the ticker holds the headline until it ends
      const dist = tw - avail;
      ticker.dist = dist;
      ticker.speed = SCROLL_SPEED * ui;
      const off = scrollOffset((now - ticker.since) / 1000, dist, ticker.speed);
      ctx.fillText(text, left + 4 * ui - off, tyMid);
    }
    ctx.restore();
    rects.push({ x, y, w: W, h: H + 6 * ui });
  }
  ctx.restore();
  return rects;
}
