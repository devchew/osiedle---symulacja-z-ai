// Procedural furniture / garden object sprites. Everything is drawn in world
// (tile) units: the context is expected to be scaled so that 1 unit = 1 tile and
// tile (x, y) has its centre at (x, y).

import type { ObjectDef, ObjectInstance } from '../types';
import { EMOJI_FONT, circle, ellipse, hash2, rr, shade, withAlpha } from './colors';
import { baseTypeOf } from '../world/incidents';
import { drawProjectObject, isProjectType } from './projects';

type Ctx = CanvasRenderingContext2D;

interface Box {
  /** top-left corner of the footprint in world units */
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  icon: string;
  uid: number;
  /** pixels per tile of the target canvas (for text) */
  T: number;
}

type Drawer = (ctx: Ctx, b: Box) => void;

const OUTLINE = 0.035;

function dropShadow(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.fillStyle = 'rgba(50,35,20,0.16)';
  rr(ctx, x + 0.05, y + 0.08, w, h, r);
  ctx.fill();
}

function block(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, shadow = true): void {
  if (shadow) dropShadow(ctx, x, y, w, h, r);
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = OUTLINE;
  ctx.strokeStyle = shade(fill, -0.38);
  ctx.stroke();
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, color: string, w: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

function emoji(ctx: Ctx, b: Box, text: string, cx: number, cy: number, sizeTiles: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1 / b.T, 1 / b.T);
  ctx.font = `${Math.round(sizeTiles * b.T)}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

const inset = (b: Box, p: number): [number, number, number, number] => [b.x + p, b.y + p, b.w - 2 * p, b.h - 2 * p];

// ------------------------------------------------------------------ kitchen

const fridge: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.08);
  block(ctx, x, y, w, h, 0.1, '#eef3f6');
  line(ctx, x + 0.03, y + h * 0.38, x + w - 0.03, y + h * 0.38, '#b9c4cc', 0.03);
  line(ctx, x + w - 0.14, y + 0.1, x + w - 0.14, y + h * 0.3, '#8a97a1', 0.045);
  line(ctx, x + w - 0.14, y + h * 0.46, x + w - 0.14, y + h * 0.75, '#8a97a1', 0.045);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  rr(ctx, x + 0.06, y + 0.06, w * 0.18, h - 0.12, 0.05);
  ctx.fill();
};

const counter: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.04);
  block(ctx, x, y, w, h, 0.06, '#e9dfcf');
  ctx.fillStyle = 'rgba(120,90,60,0.12)';
  ctx.fillRect(x, y + h - 0.12, w, 0.08);
};

const stove: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.05);
  block(ctx, x, y, w, h, 0.08, '#e7e3dc');
  rr(ctx, x + 0.07, y + 0.07, w - 0.14, h - 0.24, 0.06);
  ctx.fillStyle = '#2f3237';
  ctx.fill();
  const cols = Math.max(2, Math.round(w * 2));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < 2; j++) {
      const cx = x + 0.07 + ((i + 0.5) * (w - 0.14)) / cols;
      const cy = y + 0.07 + ((j + 0.5) * (h - 0.24)) / 2;
      circle(ctx, cx, cy, Math.min(w / cols, (h - 0.24) / 2) * 0.32);
      ctx.strokeStyle = (i + j) % 3 === 0 ? '#e0663e' : '#6b6f76';
      ctx.lineWidth = 0.03;
      ctx.stroke();
    }
  }
  for (let i = 0; i < 4; i++) {
    circle(ctx, x + 0.14 + (i * (w - 0.28)) / 3, y + h - 0.085, 0.03);
    ctx.fillStyle = '#5a5e66';
    ctx.fill();
  }
};

const sink: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.06);
  block(ctx, x, y, w, h, 0.08, '#f0ebe3');
  ellipse(ctx, x + w / 2, y + h * 0.56, w * 0.34, h * 0.28);
  ctx.fillStyle = '#c9dde7';
  ctx.fill();
  ctx.strokeStyle = '#9fb3bf';
  ctx.lineWidth = 0.025;
  ctx.stroke();
  circle(ctx, x + w / 2, y + h * 0.18, 0.05);
  ctx.fillStyle = '#9aa4ad';
  ctx.fill();
  line(ctx, x + w / 2, y + h * 0.18, x + w / 2, y + h * 0.36, '#9aa4ad', 0.035);
};

const table: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.14);
  const wood = '#c08a57';
  block(ctx, x, y, w, h, 0.14, wood);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  rr(ctx, x + 0.05, y + 0.05, w - 0.1, h * 0.35, 0.1);
  ctx.fill();
  // plates
  const places: [number, number][] = [];
  if (w >= h) for (let i = 0; i < Math.max(1, Math.round(w)); i++) places.push([x + ((i + 0.5) * w) / Math.round(w), y + h * 0.26], [x + ((i + 0.5) * w) / Math.round(w), y + h * 0.74]);
  else for (let i = 0; i < Math.max(1, Math.round(h)); i++) places.push([x + w * 0.26, y + ((i + 0.5) * h) / Math.round(h)], [x + w * 0.74, y + ((i + 0.5) * h) / Math.round(h)]);
  for (const [px, py] of places) {
    circle(ctx, px, py, 0.13);
    ctx.fillStyle = '#fbfaf6';
    ctx.fill();
    ctx.strokeStyle = '#d9d2c4';
    ctx.lineWidth = 0.02;
    ctx.stroke();
  }
  // vase
  circle(ctx, x + w / 2, y + h / 2, 0.09);
  ctx.fillStyle = '#7fb3d5';
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    circle(ctx, x + w / 2 + Math.cos(a) * 0.07, y + h / 2 + Math.sin(a) * 0.07, 0.05);
    ctx.fillStyle = ['#f28b82', '#fdd663', '#f6aea9', '#fff'][i];
    ctx.fill();
  }
};

const chair: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const s = 0.5;
  block(ctx, cx - s / 2, cy - s / 2 + 0.04, s, s, 0.1, '#c99a68');
  rr(ctx, cx - s / 2, cy - s / 2 - 0.04, s, 0.13, 0.06);
  ctx.fillStyle = '#8f6239';
  ctx.fill();
  rr(ctx, cx - s / 2 + 0.07, cy - s / 2 + 0.14, s - 0.14, s - 0.2, 0.08);
  ctx.fillStyle = b.color.startsWith('#') ? shade(b.color, 0.2) : '#e3b98a';
  ctx.fill();
};

// ------------------------------------------------------------------ bedroom

const bed: Drawer = (ctx, b) => {
  const horiz = b.w > b.h;
  const [x, y, w, h] = inset(b, 0.06);
  block(ctx, x, y, w, h, 0.12, '#9b6b43');
  rr(ctx, x + 0.06, y + 0.06, w - 0.12, h - 0.12, 0.1);
  ctx.fillStyle = '#f7f4ee';
  ctx.fill();
  const blanket = b.color;
  const pillows = Math.max(1, Math.round(horiz ? h : w));
  if (!horiz) {
    for (let i = 0; i < pillows; i++) {
      const pw = (w - 0.2) / pillows;
      rr(ctx, x + 0.1 + i * pw + 0.03, y + 0.13, pw - 0.06, 0.32, 0.1);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#d8d3ca';
      ctx.lineWidth = 0.02;
      ctx.stroke();
    }
    rr(ctx, x + 0.06, y + 0.58, w - 0.12, h - 0.64, 0.1);
    ctx.fillStyle = blanket;
    ctx.fill();
    rr(ctx, x + 0.06, y + 0.58, w - 0.12, 0.16, 0.06);
    ctx.fillStyle = shade(blanket, 0.3);
    ctx.fill();
    line(ctx, x + 0.12, y + h * 0.78, x + w - 0.12, y + h * 0.8, withAlpha(shade(blanket, -0.4), 0.35), 0.02);
  } else {
    for (let i = 0; i < pillows; i++) {
      const ph = (h - 0.2) / pillows;
      rr(ctx, x + 0.13, y + 0.1 + i * ph + 0.03, 0.32, ph - 0.06, 0.1);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#d8d3ca';
      ctx.lineWidth = 0.02;
      ctx.stroke();
    }
    rr(ctx, x + 0.58, y + 0.06, w - 0.64, h - 0.12, 0.1);
    ctx.fillStyle = blanket;
    ctx.fill();
    rr(ctx, x + 0.58, y + 0.06, 0.16, h - 0.12, 0.06);
    ctx.fillStyle = shade(blanket, 0.3);
    ctx.fill();
  }
};

const wardrobe: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.06);
  const wood = '#a8754b';
  block(ctx, x, y, w, h, 0.06, wood);
  rr(ctx, x + 0.05, y + 0.05, w - 0.1, h - 0.1, 0.04);
  ctx.fillStyle = shade(wood, 0.12);
  ctx.fill();
  const doors = Math.max(2, Math.round(w * 2));
  for (let i = 1; i < doors; i++) line(ctx, x + (i * w) / doors, y + 0.06, x + (i * w) / doors, y + h - 0.06, shade(wood, -0.35), 0.025);
  for (let i = 0; i < doors; i++) {
    circle(ctx, x + ((i + (i % 2 ? 0.2 : 0.8)) * w) / doors, y + h / 2, 0.03);
    ctx.fillStyle = '#e8c872';
    ctx.fill();
  }
};

const lamp: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const g = ctx.createRadialGradient(cx, cy, 0.05, cx, cy, 0.55);
  g.addColorStop(0, 'rgba(255,220,140,0.45)');
  g.addColorStop(1, 'rgba(255,220,140,0)');
  ctx.fillStyle = g;
  circle(ctx, cx, cy, 0.55);
  ctx.fill();
  dropShadow(ctx, cx - 0.22, cy - 0.22, 0.44, 0.44, 0.22);
  circle(ctx, cx, cy, 0.24);
  ctx.fillStyle = '#fbefd0';
  ctx.fill();
  ctx.strokeStyle = '#c9a868';
  ctx.lineWidth = OUTLINE;
  ctx.stroke();
  circle(ctx, cx, cy, 0.09);
  ctx.fillStyle = '#ffd77a';
  ctx.fill();
};

// ------------------------------------------------------------------ bathroom

const toilet: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const y = b.y;
  block(ctx, cx - 0.26, y + 0.08, 0.52, 0.22, 0.06, '#f6f8fa');
  dropShadow(ctx, cx - 0.2, y + 0.3, 0.4, 0.5, 0.2);
  ellipse(ctx, cx, y + 0.56, 0.21, 0.26);
  ctx.fillStyle = '#f6f8fa';
  ctx.fill();
  ctx.strokeStyle = '#a9b4bd';
  ctx.lineWidth = OUTLINE;
  ctx.stroke();
  ellipse(ctx, cx, y + 0.58, 0.12, 0.16);
  ctx.fillStyle = '#cfe3ec';
  ctx.fill();
};

const bathtub: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.07);
  block(ctx, x, y, w, h, 0.25, '#f7f9fb');
  rr(ctx, x + 0.09, y + 0.09, w - 0.18, h - 0.18, 0.2);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#a9daf0');
  g.addColorStop(1, '#7cc0e3');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 5; i++) {
    circle(ctx, x + 0.25 + hash2(b.uid, i) * (w - 0.5), y + 0.25 + hash2(i, b.uid) * (h - 0.5), 0.035 + hash2(i, i, b.uid) * 0.04);
    ctx.fill();
  }
  circle(ctx, b.w >= b.h ? x + 0.16 : x + w / 2, b.w >= b.h ? y + h / 2 : y + 0.16, 0.05);
  ctx.fillStyle = '#9aa4ad';
  ctx.fill();
};

const shower: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.05);
  rr(ctx, x, y, w, h, 0.06);
  ctx.fillStyle = '#d7e9f1';
  ctx.fill();
  ctx.strokeStyle = '#8fb3c4';
  ctx.lineWidth = OUTLINE;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,160,180,0.35)';
  ctx.lineWidth = 0.015;
  for (let i = 1; i < 4; i++) {
    line(ctx, x + (i * w) / 4, y, x + (i * w) / 4, y + h, 'rgba(120,160,180,0.3)', 0.015);
    line(ctx, x, y + (i * h) / 4, x + w, y + (i * h) / 4, 'rgba(120,160,180,0.3)', 0.015);
  }
  circle(ctx, x + w / 2, y + h / 2, 0.07);
  ctx.fillStyle = '#7d8c95';
  ctx.fill();
  circle(ctx, x + 0.17, y + 0.17, 0.11);
  ctx.fillStyle = '#b5c1c8';
  ctx.fill();
  ctx.strokeStyle = '#7d8c95';
  ctx.lineWidth = 0.025;
  ctx.stroke();
  // glass door
  line(ctx, x + w - 0.02, y + 0.05, x + w - 0.02, y + h - 0.05, 'rgba(255,255,255,0.9)', 0.05);
};

// ------------------------------------------------------------------ living room

const sofa: Drawer = (ctx, b) => {
  const horiz = b.w >= b.h;
  const [x, y, w, h] = inset(b, 0.05);
  const c = b.color;
  block(ctx, x, y, w, h, 0.16, shade(c, -0.12));
  if (horiz) {
    rr(ctx, x + 0.04, y + 0.03, w - 0.08, h * 0.32, 0.12);
    ctx.fillStyle = shade(c, -0.05);
    ctx.fill();
    const arm = 0.16;
    rr(ctx, x + arm, y + h * 0.33, w - 2 * arm, h * 0.62, 0.1);
    ctx.fillStyle = c;
    ctx.fill();
    const seats = Math.max(1, Math.round(w));
    for (let i = 1; i < seats; i++) line(ctx, x + arm + (i * (w - 2 * arm)) / seats, y + h * 0.36, x + arm + (i * (w - 2 * arm)) / seats, y + h * 0.92, shade(c, -0.3), 0.025);
    ctx.fillStyle = shade(c, 0.35);
    for (let i = 0; i < seats; i++) {
      rr(ctx, x + arm + ((i + 0.5) * (w - 2 * arm)) / seats - 0.15, y + h * 0.1, 0.3, h * 0.2, 0.06);
      ctx.fill();
    }
  } else {
    rr(ctx, x + 0.03, y + 0.04, w * 0.32, h - 0.08, 0.12);
    ctx.fillStyle = shade(c, -0.05);
    ctx.fill();
    const arm = 0.16;
    rr(ctx, x + w * 0.33, y + arm, w * 0.62, h - 2 * arm, 0.1);
    ctx.fillStyle = c;
    ctx.fill();
  }
};

const tv: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.06);
  block(ctx, x, y + h * 0.35, w, h * 0.6, 0.06, '#8a5d3b');
  // screen
  dropShadow(ctx, x + 0.12, y + 0.04, w - 0.24, 0.16, 0.03);
  rr(ctx, x + 0.12, y + 0.04, w - 0.24, 0.16, 0.03);
  ctx.fillStyle = '#1d2128';
  ctx.fill();
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, 'rgba(90,150,230,0.0)');
  g.addColorStop(0.5, 'rgba(120,180,255,0.55)');
  g.addColorStop(1, 'rgba(90,150,230,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(x + 0.16, y + 0.17, w - 0.32, 0.025);
  for (let i = 0; i < 2; i++) {
    rr(ctx, x + 0.2 + i * (w - 0.6), y + h * 0.5, 0.2, h * 0.32, 0.03);
    ctx.fillStyle = '#6e4a2e';
    ctx.fill();
  }
};

const BOOK_COLORS = ['#d9534f', '#5b8bd1', '#f0ad4e', '#5cb85c', '#8e6cc1', '#e8e2d0', '#3d6e70', '#c46a9d'];

const bookshelf: Drawer = (ctx, b) => {
  const horiz = b.w >= b.h;
  const [x, y, w, h] = inset(b, 0.05);
  const wood = '#8b5e3c';
  block(ctx, x, y, w, h, 0.05, wood);
  const along = horiz ? w : h;
  const n = Math.floor((along - 0.12) / 0.09);
  for (let i = 0; i < n; i++) {
    const hh = hash2(b.uid, i, 3);
    if (hh < 0.08) continue;
    ctx.fillStyle = BOOK_COLORS[Math.floor(hash2(i, b.uid, 7) * BOOK_COLORS.length)];
    const depth = 0.22 + hh * 0.18;
    if (horiz) ctx.fillRect(x + 0.06 + i * 0.09, y + 0.06, 0.075, Math.min(depth, h - 0.12));
    else ctx.fillRect(x + 0.06, y + 0.06 + i * 0.09, Math.min(depth, w - 0.12), 0.075);
  }
};

const rug: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.1);
  const c = b.color;
  rr(ctx, x, y, w, h, 0.12);
  ctx.fillStyle = c;
  ctx.fill();
  rr(ctx, x + 0.12, y + 0.12, w - 0.24, h - 0.24, 0.08);
  ctx.strokeStyle = shade(c, 0.35);
  ctx.lineWidth = 0.05;
  ctx.stroke();
  rr(ctx, x + 0.24, y + 0.24, w - 0.48, h - 0.48, 0.06);
  ctx.strokeStyle = withAlpha(shade(c, -0.25), 0.6);
  ctx.lineWidth = 0.025;
  ctx.stroke();
  // fringe on short sides
  ctx.strokeStyle = shade(c, 0.45);
  ctx.lineWidth = 0.02;
  const horiz = w >= h;
  const n = Math.floor((horiz ? h : w) / 0.1);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (horiz ? h : w);
    if (horiz) {
      line(ctx, x - 0.06, y + t, x, y + t, shade(c, 0.45), 0.02);
      line(ctx, x + w, y + t, x + w + 0.06, y + t, shade(c, 0.45), 0.02);
    } else {
      line(ctx, x + t, y - 0.06, x + t, y, shade(c, 0.45), 0.02);
      line(ctx, x + t, y + h, x + t, y + h + 0.06, shade(c, 0.45), 0.02);
    }
  }
};

const piano: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.06);
  block(ctx, x, y, w, h, 0.06, '#24262b');
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x + 0.05, y + 0.05, w - 0.1, 0.05);
  const ky = y + h * 0.58;
  const kh = h * 0.34;
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(x + 0.08, ky, w - 0.16, kh);
  const keys = Math.floor((w - 0.16) / 0.07);
  for (let i = 1; i < keys; i++) line(ctx, x + 0.08 + i * 0.07, ky, x + 0.08 + i * 0.07, ky + kh, '#c5c5c5', 0.008);
  ctx.fillStyle = '#1a1a1a';
  for (let i = 0; i < keys - 1; i++) {
    if ([2, 6].includes(i % 7)) continue;
    ctx.fillRect(x + 0.08 + i * 0.07 + 0.045, ky, 0.05, kh * 0.6);
  }
};

const guitar: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2 + 0.1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.5);
  ctx.fillStyle = 'rgba(50,35,20,0.16)';
  ellipse(ctx, 0.04, 0.08, 0.2, 0.17);
  ctx.fill();
  ctx.fillStyle = '#d48a3c';
  ctx.strokeStyle = '#7a4a1e';
  ctx.lineWidth = OUTLINE;
  circle(ctx, 0, 0.08, 0.17);
  ctx.fill();
  ctx.stroke();
  circle(ctx, 0, -0.13, 0.13);
  ctx.fill();
  ctx.stroke();
  circle(ctx, 0, -0.04, 0.05);
  ctx.fillStyle = '#3a2410';
  ctx.fill();
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(-0.03, -0.55, 0.06, 0.42);
  ctx.restore();
};

// ------------------------------------------------------------------ office / sport

const desk: Drawer = (ctx, b) => {
  const horiz = b.w >= b.h;
  const [x, y, w, h] = inset(b, 0.06);
  block(ctx, x, y, w, h, 0.06, '#d4b089');
  const cx = x + w / 2;
  // monitor
  dropShadow(ctx, cx - 0.3, y + 0.08, 0.6, 0.12, 0.03);
  rr(ctx, horiz ? cx - 0.3 : x + 0.08, horiz ? y + 0.08 : y + h / 2 - 0.3, horiz ? 0.6 : 0.12, horiz ? 0.12 : 0.6, 0.03);
  ctx.fillStyle = '#2a2e35';
  ctx.fill();
  ctx.fillStyle = '#6fb6ff';
  if (horiz) ctx.fillRect(cx - 0.26, y + 0.16, 0.52, 0.025);
  // keyboard + mouse
  rr(ctx, horiz ? cx - 0.22 : x + 0.3, horiz ? y + 0.32 : y + h / 2 - 0.22, horiz ? 0.44 : 0.14, horiz ? 0.14 : 0.44, 0.03);
  ctx.fillStyle = '#eef0f3';
  ctx.fill();
  ctx.strokeStyle = '#9aa0a8';
  ctx.lineWidth = 0.015;
  ctx.stroke();
  ellipse(ctx, horiz ? cx + 0.34 : x + 0.37, horiz ? y + 0.4 : y + h / 2 + 0.34, 0.045, 0.06);
  ctx.fillStyle = '#eef0f3';
  ctx.fill();
  ctx.stroke();
  // mug
  circle(ctx, x + w - 0.16, y + 0.18, 0.07);
  ctx.fillStyle = '#e57373';
  ctx.fill();
  circle(ctx, x + w - 0.16, y + 0.18, 0.045);
  ctx.fillStyle = '#5d3a22';
  ctx.fill();
};

const bike: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const vertical = b.h > b.w;
  ctx.save();
  ctx.translate(cx, cy);
  if (!vertical) ctx.rotate(Math.PI / 2);
  ctx.fillStyle = 'rgba(50,35,20,0.16)';
  rr(ctx, -0.16, -0.36, 0.36, 0.8, 0.12);
  ctx.fill();
  rr(ctx, -0.18, -0.42, 0.36, 0.8, 0.12);
  ctx.fillStyle = '#3b3f46';
  ctx.fill();
  rr(ctx, -0.07, -0.34, 0.14, 0.24, 0.05);
  ctx.fillStyle = b.color;
  ctx.fill();
  circle(ctx, 0, 0.12, 0.12);
  ctx.fillStyle = '#5a5f68';
  ctx.fill();
  line(ctx, -0.22, 0.3, 0.22, 0.3, '#2a2d33', 0.06);
  ellipse(ctx, 0, -0.08, 0.06, 0.09);
  ctx.fillStyle = '#1f1f1f';
  ctx.fill();
  ctx.restore();
};

const treadmill: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.08);
  block(ctx, x, y, w, h, 0.08, '#4a4f58');
  const vertical = h >= w;
  rr(ctx, vertical ? x + 0.08 : x + 0.3, vertical ? y + 0.3 : y + 0.08, vertical ? w - 0.16 : w - 0.38, vertical ? h - 0.38 : h - 0.16, 0.05);
  ctx.fillStyle = '#23262b';
  ctx.fill();
  rr(ctx, vertical ? x + 0.05 : x + 0.04, vertical ? y + 0.04 : y + 0.05, vertical ? w - 0.1 : 0.2, vertical ? 0.2 : h - 0.1, 0.04);
  ctx.fillStyle = b.color;
  ctx.fill();
};

// ------------------------------------------------------------------ garden

const bench: Drawer = (ctx, b) => {
  const horiz = b.w >= b.h;
  const [x, y, w, h] = inset(b, 0.12);
  const wood = '#b07a4a';
  dropShadow(ctx, x, y, w, h, 0.05);
  const n = 4;
  for (let i = 0; i < n; i++) {
    if (horiz) rr(ctx, x, y + (i * h) / n + 0.02, w, h / n - 0.05, 0.04);
    else rr(ctx, x + (i * w) / n + 0.02, y, w / n - 0.05, h, 0.04);
    ctx.fillStyle = i === 0 ? shade(wood, -0.15) : wood;
    ctx.fill();
    ctx.strokeStyle = shade(wood, -0.4);
    ctx.lineWidth = 0.02;
    ctx.stroke();
  }
  ctx.fillStyle = '#4b4b4b';
  if (horiz) {
    ctx.fillRect(x + 0.08, y - 0.03, 0.06, h + 0.06);
    ctx.fillRect(x + w - 0.14, y - 0.03, 0.06, h + 0.06);
  } else {
    ctx.fillRect(x - 0.03, y + 0.08, w + 0.06, 0.06);
    ctx.fillRect(x - 0.03, y + h - 0.14, w + 0.06, 0.06);
  }
};

const grill: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r = Math.min(b.w, b.h) * 0.36;
  ctx.fillStyle = 'rgba(50,35,20,0.2)';
  ellipse(ctx, cx + 0.06, cy + 0.1, r, r * 0.9);
  ctx.fill();
  circle(ctx, cx, cy, r);
  ctx.fillStyle = '#2b2d31';
  ctx.fill();
  circle(ctx, cx, cy, r * 0.8);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.8);
  g.addColorStop(0, '#ff9a3c');
  g.addColorStop(0.6, '#c2410c');
  g.addColorStop(1, '#3a1a0a');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  circle(ctx, cx, cy, r * 0.8);
  ctx.clip();
  for (let i = -3; i <= 3; i++) line(ctx, cx + i * r * 0.22, cy - r, cx + i * r * 0.22, cy + r, '#9aa0a8', 0.022);
  ctx.restore();
  // sausages
  for (let i = 0; i < 3; i++) {
    rr(ctx, cx - r * 0.5, cy - r * 0.45 + i * r * 0.32, r * 0.9, r * 0.17, 0.05);
    ctx.fillStyle = '#b5532a';
    ctx.fill();
  }
};

function pond(ctx: Ctx, b: Box): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  ellipse(ctx, cx, cy, b.w / 2 - 0.02, b.h / 2 - 0.02);
  ctx.fillStyle = '#d8c99c';
  ctx.fill();
  ellipse(ctx, cx, cy, b.w / 2 - 0.15, b.h / 2 - 0.15);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(b.w, b.h) / 2);
  g.addColorStop(0, '#4a95c4');
  g.addColorStop(1, '#86c8e3');
  ctx.fillStyle = g;
  ctx.fill();
}

const fishing: Drawer = (ctx, b) => {
  if (b.w * b.h >= 4) return pond(ctx, b);
  const [x, y, w, h] = inset(b, 0.1);
  // small wooden pier
  dropShadow(ctx, x, y, w, h, 0.03);
  const wood = '#b98a5a';
  for (let i = 0; i < 4; i++) {
    rr(ctx, x, y + (i * h) / 4, w, h / 4 - 0.025, 0.02);
    ctx.fillStyle = i % 2 ? wood : shade(wood, 0.08);
    ctx.fill();
  }
  // bucket + rod
  circle(ctx, x + 0.15, y + h - 0.16, 0.09);
  ctx.fillStyle = '#5b8bd1';
  ctx.fill();
  line(ctx, x + 0.3, y + h - 0.2, x + w + 0.35, y - 0.05, '#5b4636', 0.025);
};

const plant: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  ctx.fillStyle = 'rgba(50,35,20,0.18)';
  ellipse(ctx, cx + 0.05, cy + 0.08, 0.24, 0.2);
  ctx.fill();
  circle(ctx, cx, cy, 0.19);
  ctx.fillStyle = '#c9744a';
  ctx.fill();
  const leaf = b.color && b.color !== '#000' ? b.color : '#5fa356';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + hash2(b.uid, 1) * 3;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * 0.1, cy + Math.sin(a) * 0.1);
    ctx.rotate(a);
    ellipse(ctx, 0.08, 0, 0.16, 0.07);
    ctx.fillStyle = i % 2 ? leaf : shade(leaf, -0.18);
    ctx.fill();
    ctx.restore();
  }
  circle(ctx, cx, cy, 0.06);
  ctx.fillStyle = shade(leaf, 0.2);
  ctx.fill();
};

const tree: Drawer = (ctx, b) => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const R = Math.max(b.w, b.h) * 0.72 + 0.1;
  const base = '#5f9e4c';
  ctx.fillStyle = 'rgba(30,50,20,0.22)';
  ellipse(ctx, cx + 0.22, cy + 0.3, R * 0.95, R * 0.75);
  ctx.fill();
  const blobs = 6;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + hash2(b.uid, 2) * 6;
    circle(ctx, cx + Math.cos(a) * R * 0.45, cy + Math.sin(a) * R * 0.45 - 0.1, R * 0.52);
    ctx.fillStyle = shade(base, -0.12);
    ctx.fill();
  }
  circle(ctx, cx, cy - 0.12, R * 0.62);
  ctx.fillStyle = base;
  ctx.fill();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + hash2(b.uid, 5) * 6;
    circle(ctx, cx + Math.cos(a) * R * 0.3 - 0.08, cy + Math.sin(a) * R * 0.3 - 0.22, R * 0.3);
    ctx.fillStyle = shade(base, 0.12);
    ctx.fill();
  }
  circle(ctx, cx - R * 0.25, cy - R * 0.35, R * 0.18);
  ctx.fillStyle = shade(base, 0.28);
  ctx.fill();
  if (hash2(b.uid, 9) < 0.5) {
    for (let i = 0; i < 5; i++) {
      circle(ctx, cx + (hash2(b.uid, i, 1) - 0.5) * R * 1.1, cy - 0.1 + (hash2(i, b.uid, 2) - 0.5) * R * 1.1, 0.055);
      ctx.fillStyle = '#e8584a';
      ctx.fill();
    }
  }
};

const bush: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.05);
  const base = '#4f8f45';
  ctx.fillStyle = 'rgba(30,50,20,0.2)';
  ellipse(ctx, x + w / 2 + 0.07, y + h / 2 + 0.1, w / 2, h / 2.2);
  ctx.fill();
  const n = Math.max(3, Math.round(w * h * 3));
  for (let i = 0; i < n; i++) {
    circle(ctx, x + 0.2 + hash2(b.uid, i) * (w - 0.4), y + 0.2 + hash2(i, b.uid) * (h - 0.4), 0.22 + hash2(i, i, b.uid) * 0.08);
    ctx.fillStyle = i % 3 === 0 ? shade(base, 0.12) : base;
    ctx.fill();
  }
  for (let i = 0; i < n; i++) {
    circle(ctx, x + 0.15 + hash2(b.uid, i, 4) * (w - 0.3), y + 0.15 + hash2(i, b.uid, 4) * (h - 0.3), 0.035);
    ctx.fillStyle = '#f4a6c0';
    ctx.fill();
  }
};

const flowers: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.08);
  rr(ctx, x, y, w, h, 0.15);
  ctx.fillStyle = '#7a5a3c';
  ctx.fill();
  const n = Math.round(w * h * 7);
  const cols = ['#f28b82', '#fdd663', '#c58af9', '#ffffff', '#f6aea9'];
  for (let i = 0; i < n; i++) {
    const px = x + 0.1 + hash2(b.uid, i) * (w - 0.2);
    const py = y + 0.1 + hash2(i, b.uid) * (h - 0.2);
    circle(ctx, px, py, 0.08);
    ctx.fillStyle = '#4f8f45';
    ctx.fill();
    circle(ctx, px, py, 0.045);
    ctx.fillStyle = cols[i % cols.length];
    ctx.fill();
  }
};

// ------------------------------------------------------------------ games (joint activities)

/** games console corner: low cabinet against the wall, a big screen showing a race, the console and two pads */
const gameConsole: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.05);
  block(ctx, x, y + h * 0.3, w, h * 0.7, 0.06, '#3b3f4f');
  // screen on the cabinet, facing the players
  const sx = x + 0.12;
  const sy = y + 0.02;
  const sw = w - 0.24;
  const sh = h * 0.56;
  dropShadow(ctx, sx, sy, sw, sh, 0.04);
  rr(ctx, sx, sy, sw, sh, 0.04);
  ctx.fillStyle = '#14161c';
  ctx.fill();
  const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
  g.addColorStop(0, '#5ec8ff');
  g.addColorStop(0.5, '#9be7a1');
  g.addColorStop(1, '#3f9a52');
  rr(ctx, sx + 0.04, sy + 0.04, sw - 0.08, sh - 0.08, 0.025);
  ctx.fillStyle = g;
  ctx.fill();
  // race track and two little cars
  ctx.save();
  rr(ctx, sx + 0.04, sy + 0.04, sw - 0.08, sh - 0.08, 0.025);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(sx + sw * 0.3, sy + sh);
  ctx.lineTo(sx + sw * 0.47, sy + sh * 0.35);
  ctx.lineTo(sx + sw * 0.53, sy + sh * 0.35);
  ctx.lineTo(sx + sw * 0.7, sy + sh);
  ctx.closePath();
  ctx.fillStyle = '#5b5e66';
  ctx.fill();
  line(ctx, sx + sw * 0.5, sy + sh * 0.4, sx + sw * 0.5, sy + sh, '#f1f1f1', 0.012);
  for (const [cx, c] of [[0.44, '#e8453c'], [0.57, '#ffd23f']] as const) {
    rr(ctx, sx + sw * cx - 0.035, sy + sh * 0.7, 0.07, 0.05, 0.015);
    ctx.fillStyle = c;
    ctx.fill();
  }
  ctx.restore();
  // console box and pads on the cabinet
  rr(ctx, x + 0.08, y + h * 0.66, 0.34, 0.14, 0.03);
  ctx.fillStyle = '#f4f5f7';
  ctx.fill();
  circle(ctx, x + 0.36, y + h * 0.73, 0.018);
  ctx.fillStyle = '#4fd1ff';
  ctx.fill();
  for (const [px, c] of [[0.62, '#2b2d3a'], [0.95, '#c0392b']] as const) {
    rr(ctx, x + px, y + h * 0.68, 0.22, 0.1, 0.045);
    ctx.fillStyle = c;
    ctx.fill();
  }
  // a little glow under the screen
  ctx.fillStyle = 'rgba(120,200,255,0.18)';
  ellipse(ctx, x + w / 2, y + h * 0.62, w * 0.4, 0.06);
  ctx.fill();
};

/** small card / board game table: green felt, half a chessboard, cards and a die */
const gameTable: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.1);
  block(ctx, x, y, w, h, 0.12, '#8a6440');
  rr(ctx, x + 0.06, y + 0.06, w - 0.12, h - 0.12, 0.08);
  ctx.fillStyle = '#2f7d4f';
  ctx.fill();
  // chessboard on the left half
  const n = 4;
  const cs = (h - 0.24) / n;
  const bx = x + 0.12;
  const by = y + 0.12;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#3b2a1c' : '#efe2c4';
      ctx.fillRect(bx + i * cs, by + j * cs, cs, cs);
    }
  for (const [i, j, c] of [[0, 0, '#111'], [2, 1, '#111'], [1, 3, '#fff'], [3, 2, '#fff']] as const) {
    circle(ctx, bx + (i + 0.5) * cs, by + (j + 0.5) * cs, cs * 0.32);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.lineWidth = 0.01;
    ctx.strokeStyle = '#777';
    ctx.stroke();
  }
  // cards and a die on the right
  const rx = bx + n * cs + 0.06;
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.translate(rx + 0.07 + k * 0.03, y + 0.24);
    ctx.rotate(-0.3 + k * 0.3);
    rr(ctx, -0.045, -0.07, 0.09, 0.13, 0.015);
    ctx.fillStyle = k === 1 ? '#fdfcf7' : '#b8463c';
    ctx.fill();
    ctx.restore();
  }
  rr(ctx, rx + 0.04, y + h - 0.27, 0.11, 0.11, 0.02);
  ctx.fillStyle = '#fff';
  ctx.fill();
  for (const [dx, dy] of [[0.03, 0.03], [0.08, 0.08], [0.055, 0.055]]) {
    circle(ctx, rx + 0.04 + dx, y + h - 0.27 + dy, 0.012);
    ctx.fillStyle = '#222';
    ctx.fill();
  }
};

const fallback: Drawer = (ctx, b) => {
  const [x, y, w, h] = inset(b, 0.1);
  block(ctx, x, y, w, h, 0.14, b.color);
  emoji(ctx, b, b.icon || '?', x + w / 2, y + h / 2 + 0.02, Math.min(w, h) * 0.55);
};

const MATCHERS: [RegExp, Drawer][] = [
  [/console|konsol/, gameConsole],
  [/board_game|card_table|planszow/, gameTable],
  [/fridge|lodow/, fridge],
  [/stove|oven|cooker|kuchenk/, stove],
  [/bathtub|tub|wann/, bathtub],
  [/shower|prysznic/, shower],
  [/toilet|\bwc\b|toalet/, toilet],
  [/sink|umyw|zlew/, sink],
  [/sofa|couch|kanap/, sofa],
  [/\btv\b|^tv|tv_|television|telewiz/, tv],
  [/book|shelf|regal/, bookshelf],
  [/computer|desk|biurk|laptop|komput/, desk],
  [/treadmill|bie[zż]ni/, treadmill],
  [/bike|rower|exercise|gym/, bike],
  [/bench|[lł]awk/, bench],
  [/grill|bbq/, grill],
  [/fish|pond|w[eę]dk|staw/, fishing],
  [/tree|drzew/, tree],
  [/bush|hedge|krzak|krzew/, bush],
  [/flower|kwiat|garden_bed|grzadk|grządk/, flowers],
  [/plant|ro[sś]lin/, plant],
  [/rug|carpet|dywan/, rug],
  [/lamp/, lamp],
  [/wardrobe|closet|szaf|dresser/, wardrobe],
  [/piano|pianin/, piano],
  [/guitar|gitar/, guitar],
  [/chair|stool|krzes|armchair|fotel/, chair],
  [/table|st[oó][lł]/, table],
  [/bed|[lł][oó][zż]k/, bed],
  [/counter|blat|cabinet/, counter],
];

const drawerCache = new Map<string, Drawer>();

function drawerFor(type: string): Drawer {
  let d = drawerCache.get(type);
  if (!d) {
    const t = type.toLowerCase();
    d = MATCHERS.find(([re]) => re.test(t))?.[1] ?? fallback;
    drawerCache.set(type, d);
  }
  return d;
}

/** true for objects that should be drawn below everything else (flat on the floor) */
export function isFlatObject(type: string): boolean {
  return drawerFor(type) === rug;
}

/** objects whose top (tree canopy) should be drawn above walls */
export function isTallObject(type: string): boolean {
  return drawerFor(type) === tree;
}

export function isLampObject(type: string): boolean {
  return drawerFor(type) === lamp;
}

export function drawObject(ctx: Ctx, def: ObjectDef | undefined, inst: ObjectInstance, T: number): void {
  const b: Box = {
    x: inst.pos.x - 0.5,
    y: inst.pos.y - 0.5,
    w: def?.size.w ?? 1,
    h: def?.size.h ?? 1,
    color: def?.color ?? '#b8a48c',
    icon: def?.icon ?? '',
    uid: inst.uid,
    T,
  };
  ctx.save();
  if (isProjectType(inst.type)) drawProjectObject(ctx, def, inst, T);
  // a broken object (type "repair_<type>") still looks like the original
  else drawerFor(baseTypeOf(inst.type))(ctx, b);
  ctx.restore();
}
