import type { ObjectDef, ObjectInstance, World } from '../types';
import { EMOJI_FONT, UI_FONT, circle, ellipse, hash2, rr, shade } from './colors';
import { projectTypeInfo, projectsOf, type ProjectView } from '../world/projects';
import { timeFromTick } from '../core/time';
import { PLANK_TONES } from './pier';

// Drawing of construction sites and finished project buildings (world/projects).
// Stage sprites are drawn into the static layer through render/objects.ts drawObject (each stage
// is its own object type, so a stage change rebuilds the layer). The progress badge above a site
// is a screen-space overlay drawn every frame (drawProjectBadges, called by the renderer).

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  uid: number;
}

const WOOD = '#b98552';
const WOOD_DARK = '#8a5a32';
const WOOD_LIGHT = '#d9a873';
const SOIL = '#7a5434';
const SOIL_DARK = '#5e3f26';
const STONE = '#a9a39a';
const PAINT = '#f4efe6';
const ROOF = '#a8483a';
const LEAF = '#4f9a45';

/** true when this object type is drawn by drawProjectObject */
export function isProjectType(type: string): boolean {
  return projectTypeInfo(type) !== null;
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, color: string, w: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

function fillRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string): void {
  rr(ctx as CanvasRenderingContext2D, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.03;
    ctx.stroke();
  }
}

function shadow(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  fillRR(ctx, x + 0.06, y + 0.09, w, h, r, 'rgba(50,35,20,0.18)');
}

function dot(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  circle(ctx as CanvasRenderingContext2D, x, y, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** trampled ground: an irregular soil patch inside the box */
function dirt(ctx: Ctx, b: Box, inset: number, color = SOIL): void {
  const x = b.x + inset;
  const y = b.y + inset;
  const w = b.w - 2 * inset;
  const h = b.h - 2 * inset;
  fillRR(ctx, x, y, w, h, 0.25, color);
  // clods and pebbles
  const n = Math.round(b.w * b.h * 6);
  for (let i = 0; i < n; i++) {
    const px = x + 0.1 + hash2(b.uid, i, 11) * (w - 0.2);
    const py = y + 0.1 + hash2(i, b.uid, 12) * (h - 0.2);
    dot(ctx, px, py, 0.025 + hash2(i, i, b.uid) * 0.035, hash2(i, 3, b.uid) < 0.5 ? shade(color, -0.2) : shade(color, 0.18));
  }
}

function peg(ctx: Ctx, x: number, y: number): void {
  fillRR(ctx, x - 0.05, y - 0.05, 0.1, 0.1, 0.02, WOOD_DARK);
  dot(ctx, x, y - 0.02, 0.025, WOOD_LIGHT);
}

function plank(ctx: Ctx, x: number, y: number, w: number, h: number, color = WOOD): void {
  fillRR(ctx, x, y, w, h, 0.03, color, shade(color, -0.35));
}

function post(ctx: Ctx, x: number, y: number, color = WOOD_DARK, s = 0.16): void {
  shadow(ctx, x - s / 2, y - s / 2, s, s, 0.03);
  fillRR(ctx, x - s / 2, y - s / 2, s, s, 0.03, color, shade(color, -0.4));
  fillRR(ctx, x - s / 2 + 0.02, y - s / 2 + 0.02, s * 0.35, s - 0.04, 0.02, shade(color, 0.25));
}

function shovel(ctx: Ctx, x: number, y: number, angle: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  line(ctx, 0, -0.32, 0, 0.12, WOOD_DARK, 0.045);
  fillRR(ctx, -0.08, 0.1, 0.16, 0.2, 0.05, '#8c939c', '#5d636b');
  ctx.restore();
}

function lumber(ctx: Ctx, x: number, y: number, n: number, len: number): void {
  shadow(ctx, x, y, len, n * 0.09, 0.03);
  for (let i = 0; i < n; i++) plank(ctx, x + (i % 2) * 0.05, y + i * 0.08, len, 0.08, i % 2 ? WOOD_LIGHT : WOOD);
}

function bucket(ctx: Ctx, x: number, y: number, paint: string): void {
  ellipse(ctx as CanvasRenderingContext2D, x + 0.03, y + 0.05, 0.15, 0.12);
  ctx.fillStyle = 'rgba(50,35,20,0.2)';
  ctx.fill();
  dot(ctx, x, y, 0.14, '#9aa3ad');
  dot(ctx, x, y, 0.105, paint);
  line(ctx, x + 0.04, y - 0.02, x + 0.24, y - 0.2, WOOD_DARK, 0.04);
}

function ladder(ctx: Ctx, x: number, y: number, len: number, angle: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  line(ctx, -0.09, 0, -0.09, len, '#c7a26b', 0.035);
  line(ctx, 0.09, 0, 0.09, len, '#c7a26b', 0.035);
  for (let t = 0.1; t < len; t += 0.17) line(ctx, -0.09, t, 0.09, t, '#c7a26b', 0.03);
  ctx.restore();
}

// ------------------------------------------------------------------ gazebo

/** octagon inscribed in the box (inset) */
function octagon(ctx: Ctx, b: Box, inset: number): void {
  const x0 = b.x + inset;
  const y0 = b.y + inset;
  const x1 = b.x + b.w - inset;
  const y1 = b.y + b.h - inset;
  const c = (x1 - x0) * 0.29;
  ctx.beginPath();
  ctx.moveTo(x0 + c, y0);
  ctx.lineTo(x1 - c, y0);
  ctx.lineTo(x1, y0 + c);
  ctx.lineTo(x1, y1 - c);
  ctx.lineTo(x1 - c, y1);
  ctx.lineTo(x0 + c, y1);
  ctx.lineTo(x0, y1 - c);
  ctx.lineTo(x0, y0 + c);
  ctx.closePath();
}

function octagonCorners(b: Box, inset: number): [number, number][] {
  const x0 = b.x + inset;
  const y0 = b.y + inset;
  const x1 = b.x + b.w - inset;
  const y1 = b.y + b.h - inset;
  const c = (x1 - x0) * 0.29;
  return [
    [x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c],
  ];
}

function deck(ctx: Ctx, b: Box, inset: number, boards: number, color = WOOD): void {
  ctx.save();
  octagon(ctx, b, inset);
  ctx.fillStyle = 'rgba(50,35,20,0.2)';
  ctx.translate(0.06, 0.09);
  ctx.fill();
  ctx.restore();
  ctx.save();
  octagon(ctx, b, inset);
  ctx.clip();
  const n = 12;
  const bw = (b.w - 2 * inset) / n;
  for (let i = 0; i < Math.min(n, boards); i++) {
    const c = hash2(b.uid, i, 7) < 0.5 ? color : shade(color, 0.07);
    ctx.fillStyle = c;
    ctx.fillRect(b.x + inset + i * bw, b.y, bw - 0.012, b.h);
  }
  ctx.restore();
  octagon(ctx, b, inset);
  ctx.strokeStyle = shade(color, -0.4);
  ctx.lineWidth = 0.035;
  ctx.stroke();
}

function foundationSlab(ctx: Ctx, b: Box): void {
  octagon(ctx, b, 0.12);
  ctx.fillStyle = STONE;
  ctx.fill();
  ctx.strokeStyle = shade(STONE, -0.35);
  ctx.lineWidth = 0.04;
  ctx.stroke();
  for (let i = 0; i < 14; i++) dot(ctx, b.x + 0.3 + hash2(b.uid, i, 3) * (b.w - 0.6), b.y + 0.3 + hash2(i, b.uid, 4) * (b.h - 0.6), 0.03, shade(STONE, -0.15));
}

function altanaFundament(ctx: Ctx, b: Box): void {
  dirt(ctx, b, 0.05, '#8d6a45');
  // dug trench along the outline
  ctx.save();
  octagon(ctx, b, 0.22);
  ctx.strokeStyle = SOIL_DARK;
  ctx.lineWidth = 0.22;
  ctx.stroke();
  ctx.restore();
  // pegs and the string between them
  const pts = octagonCorners(b, 0.1);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 0.02;
  ctx.stroke();
  for (const [x, y] of pts) peg(ctx, x, y);
  // soil heap, shovel and a wheelbarrow
  ellipse(ctx as CanvasRenderingContext2D, b.x + b.w - 0.55, b.y + b.h - 0.5, 0.38, 0.28);
  ctx.fillStyle = SOIL_DARK;
  ctx.fill();
  ellipse(ctx as CanvasRenderingContext2D, b.x + b.w - 0.6, b.y + b.h - 0.56, 0.24, 0.17);
  ctx.fillStyle = shade(SOIL, 0.1);
  ctx.fill();
  shovel(ctx, b.x + 0.75, b.y + b.h / 2 + 0.1, 0.5);
  fillRR(ctx, b.x + b.w / 2 - 0.25, b.y + 0.45, 0.5, 0.32, 0.08, '#4f7fb3', '#2f4f73');
  fillRR(ctx, b.x + b.w / 2 - 0.18, b.y + 0.5, 0.36, 0.2, 0.06, SOIL_DARK);
  dot(ctx, b.x + b.w / 2, b.y + 0.84, 0.07, '#333');
}

function altanaKonstrukcja(ctx: Ctx, b: Box): void {
  dirt(ctx, b, 0, '#8d6a45');
  foundationSlab(ctx, b);
  // first floor boards
  deck(ctx, b, 0.2, 6, WOOD_LIGHT);
  const pts = octagonCorners(b, 0.24);
  // beams between some posts
  for (let i = 0; i < 5; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    line(ctx, x1, y1, x2, y2, WOOD, 0.09);
  }
  for (const [x, y] of pts) post(ctx, x, y, WOOD_DARK, 0.18);
  lumber(ctx, b.x + b.w - 1.1, b.y + b.h - 0.62, 4, 0.9);
  // saw horse
  line(ctx, b.x + 0.55, b.y + b.h - 0.75, b.x + 1.15, b.y + b.h - 0.75, WOOD_DARK, 0.07);
  line(ctx, b.x + 0.6, b.y + b.h - 0.85, b.x + 0.6, b.y + b.h - 0.62, WOOD_DARK, 0.04);
  line(ctx, b.x + 1.1, b.y + b.h - 0.85, b.x + 1.1, b.y + b.h - 0.62, WOOD_DARK, 0.04);
}

function roofShingles(ctx: Ctx, b: Box, share: number, painted: boolean): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const pts = octagonCorners(b, 0.02);
  const n = pts.length;
  const segs = Math.round(n * share);
  for (let i = 0; i < segs; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    // one roof facet: a ring segment from the eave to 45% towards the centre (centre stays open)
    const k = 0.4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 + (cx - x2) * k, y2 + (cy - y2) * k);
    ctx.lineTo(x1 + (cx - x1) * k, y1 + (cy - y1) * k);
    ctx.closePath();
    const c = i % 2 ? ROOF : shade(ROOF, -0.08);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = shade(ROOF, -0.4);
    ctx.lineWidth = 0.025;
    ctx.stroke();
    // shingle rows
    for (const t of [0.15, 0.3]) {
      line(ctx, x1 + (cx - x1) * t, y1 + (cy - y1) * t, x2 + (cx - x2) * t, y2 + (cy - y2) * t, shade(ROOF, -0.22), 0.02);
    }
  }
  // eave trim
  if (painted) {
    octagon(ctx, b, 0.02);
    ctx.strokeStyle = PAINT;
    ctx.lineWidth = 0.06;
    ctx.stroke();
  }
}

function rafters(ctx: Ctx, b: Box, color: string): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  for (const [x, y] of octagonCorners(b, 0.04)) line(ctx, x, y, x + (cx - x) * 0.62, y + (cy - y) * 0.62, color, 0.07);
  octagon(ctx, { ...b, x: b.x + b.w * 0.31, y: b.y + b.h * 0.31, w: b.w * 0.38, h: b.h * 0.38 }, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.06;
  ctx.stroke();
}

function benches(ctx: Ctx, b: Box, color: string): void {
  // left, right and top benches along the inside of the rail (the entrance is at the bottom)
  plank(ctx, b.x + 0.36, b.y + 0.95, 0.24, 1.1, color);
  plank(ctx, b.x + b.w - 0.6, b.y + 0.95, 0.24, 1.1, color);
  plank(ctx, b.x + 0.95, b.y + 0.36, 1.1, 0.24, color);
}

function altanaDach(ctx: Ctx, b: Box): void {
  dirt(ctx, b, 0, '#8f7350');
  foundationSlab(ctx, b);
  deck(ctx, b, 0.2, 12);
  benches(ctx, b, WOOD_LIGHT);
  for (const [x, y] of octagonCorners(b, 0.24)) post(ctx, x, y, WOOD_DARK, 0.18);
  rafters(ctx, b, WOOD_DARK);
  roofShingles(ctx, b, 0.5, false);
  ladder(ctx, b.x + b.w - 0.35, b.y + b.h - 0.2, 1.1, 2.6);
  // stack of shingles
  for (let i = 0; i < 3; i++) fillRR(ctx, b.x + 0.25 + i * 0.03, b.y + b.h - 0.55 - i * 0.06, 0.45, 0.2, 0.03, shade(ROOF, -0.05 * i), shade(ROOF, -0.4));
}

function altanaMalowanie(ctx: Ctx, b: Box): void {
  fillRR(ctx, b.x + 0.05, b.y + 0.05, b.w - 0.1, b.h - 0.1, 0.3, 'rgba(120,95,60,0.35)');
  foundationSlab(ctx, b);
  deck(ctx, b, 0.2, 12);
  benches(ctx, b, WOOD_LIGHT);
  const pts = octagonCorners(b, 0.24);
  // half of the posts already white
  pts.forEach(([x, y], i) => post(ctx, x, y, i < 4 ? PAINT : WOOD_DARK, 0.18));
  rafters(ctx, b, WOOD_DARK);
  roofShingles(ctx, b, 1, false);
  // painted trim on half of the eaves, drips
  const eave = octagonCorners(b, 0.02);
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = eave[i];
    const [x2, y2] = eave[i + 1];
    line(ctx, x1, y1, x2, y2, PAINT, 0.06);
  }
  bucket(ctx, b.x + 0.4, b.y + b.h - 0.35, PAINT);
  bucket(ctx, b.x + b.w - 0.42, b.y + b.h - 0.32, '#5a8f6a');
  ladder(ctx, b.x + b.w - 0.25, b.y + 0.3, 0.9, 0.7);
}

function altanaGotowa(ctx: Ctx, b: Box): void {
  // little flower border around the deck
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const x = b.x + b.w / 2 + Math.cos(a) * (b.w / 2 - 0.08);
    const y = b.y + b.h / 2 + Math.sin(a) * (b.h / 2 - 0.08);
    if (y > b.y + b.h - 0.35 && Math.abs(x - (b.x + b.w / 2)) < 0.6) continue; // entrance
    dot(ctx, x, y, 0.09, LEAF);
    dot(ctx, x, y, 0.045, ['#f28b82', '#fdd663', '#c58af9', '#ffffff'][i % 4]);
  }
  deck(ctx, b, 0.18, 12, '#c4915c');
  benches(ctx, b, '#7d9c6b');
  // small round table in the middle
  dot(ctx, b.x + b.w / 2 + 0.04, b.y + b.h / 2 + 0.07, 0.3, 'rgba(50,35,20,0.18)');
  dot(ctx, b.x + b.w / 2, b.y + b.h / 2, 0.28, '#a8774a');
  dot(ctx, b.x + b.w / 2 - 0.07, b.y + b.h / 2 - 0.07, 0.09, shade('#a8774a', 0.2));
  // white posts and rail with an opening at the entrance
  const pts = octagonCorners(b, 0.22);
  for (let i = 0; i < pts.length; i++) {
    if (i === 4) continue; // bottom side: entrance
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    line(ctx, x1, y1, x2, y2, PAINT, 0.06);
  }
  roofShingles(ctx, b, 1, true);
  rafters(ctx, b, PAINT);
  for (const [x, y] of pts) post(ctx, x, y, PAINT, 0.18);
  // finial and a lantern hanging from the centre ring
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  line(ctx, cx, cy - b.h * 0.19, cx, cy - 0.32, '#3b3b3b', 0.02);
  fillRR(ctx, cx - 0.1, cy - 0.34, 0.2, 0.22, 0.04, '#2f2f33');
  fillRR(ctx, cx - 0.065, cy - 0.3, 0.13, 0.14, 0.03, '#ffd77a');
}

// ------------------------------------------------------------------ vegetable garden

function bedRows(b: Box): { x: number; y: number; w: number; h: number }[] {
  const n = 3;
  const gap = 0.12;
  const w = (b.w - 0.3 - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: b.x + 0.15 + i * (w + gap), y: b.y + 0.15, w, h: b.h - 0.3 }));
}

function raisedBed(ctx: Ctx, r: { x: number; y: number; w: number; h: number }, uid: number): void {
  shadow(ctx, r.x, r.y, r.w, r.h, 0.06);
  fillRR(ctx, r.x, r.y, r.w, r.h, 0.06, WOOD, WOOD_DARK);
  fillRR(ctx, r.x + 0.07, r.y + 0.07, r.w - 0.14, r.h - 0.14, 0.05, SOIL_DARK);
  for (let i = 0; i < 6; i++) dot(ctx, r.x + 0.12 + hash2(uid, i, r.x * 10) * (r.w - 0.24), r.y + 0.12 + hash2(i, uid, r.y * 10) * (r.h - 0.24), 0.025, shade(SOIL_DARK, 0.25));
}

function sprout(ctx: Ctx, x: number, y: number, s: number): void {
  line(ctx, x, y + 0.05 * s, x, y - 0.02 * s, '#3d7a35', 0.02);
  ellipse(ctx as CanvasRenderingContext2D, x - 0.04 * s, y - 0.03 * s, 0.05 * s, 0.025 * s);
  ctx.fillStyle = '#6cbf55';
  ctx.fill();
  ellipse(ctx as CanvasRenderingContext2D, x + 0.04 * s, y - 0.04 * s, 0.05 * s, 0.025 * s);
  ctx.fill();
}

function warzywnikKopanie(ctx: Ctx, b: Box): void {
  // half dug: dark rows on the left, grass with string on the right
  const rows = bedRows(b);
  rows.forEach((r, i) => {
    if (i < 2) {
      fillRR(ctx, r.x, r.y, r.w, r.h, 0.1, SOIL);
      for (let k = 0; k < 4; k++) line(ctx, r.x + 0.08, r.y + 0.2 + k * 0.32, r.x + r.w - 0.08, r.y + 0.2 + k * 0.32, SOIL_DARK, 0.06);
    }
  });
  const x0 = b.x + 0.12;
  const y0 = b.y + 0.12;
  const x1 = b.x + b.w - 0.12;
  const y1 = b.y + b.h - 0.12;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 0.02;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) peg(ctx, x, y);
  shovel(ctx, b.x + b.w - 0.55, b.y + b.h / 2, -0.6);
}

function warzywnikGrzadki(ctx: Ctx, b: Box): void {
  dirt(ctx, b, 0.05, '#8d6a45');
  for (const r of bedRows(b)) raisedBed(ctx, r, b.uid);
  // watering can
  fillRR(ctx, b.x + b.w - 0.45, b.y + b.h - 0.38, 0.26, 0.2, 0.05, '#4f9fb8', '#2d6476');
  line(ctx, b.x + b.w - 0.45, b.y + b.h - 0.3, b.x + b.w - 0.6, b.y + b.h - 0.42, '#2d6476', 0.035);
}

function warzywnikSadzenie(ctx: Ctx, b: Box): void {
  dirt(ctx, b, 0.05, '#8d6a45');
  bedRows(b).forEach((r, i) => {
    raisedBed(ctx, r, b.uid);
    const n = i < 2 ? 5 : 2;
    for (let k = 0; k < n; k++) sprout(ctx, r.x + r.w / 2 + (k % 2 ? 0.1 : -0.1), r.y + 0.25 + k * ((r.h - 0.5) / 4), 1);
  });
  // seedling tray
  fillRR(ctx, b.x + b.w - 0.55, b.y + b.h - 0.3, 0.42, 0.22, 0.03, '#2f2f2f');
  for (let k = 0; k < 4; k++) sprout(ctx, b.x + b.w - 0.48 + k * 0.1, b.y + b.h - 0.2, 0.7);
}

function warzywnikGotowy(ctx: Ctx, b: Box): void {
  bedRows(b).forEach((r, i) => {
    raisedBed(ctx, r, b.uid);
    for (let k = 0; k < 5; k++) {
      const x = r.x + r.w / 2 + (k % 2 ? 0.09 : -0.09);
      const y = r.y + 0.25 + k * ((r.h - 0.5) / 4);
      if (i === 0) {
        // carrots: feathery tops with an orange shoulder
        dot(ctx, x, y + 0.03, 0.05, '#ef8a2f');
        for (let a = 0; a < 3; a++) line(ctx, x, y, x + (a - 1) * 0.07, y - 0.12, '#4c9a3c', 0.025);
      } else if (i === 1) {
        // cabbages
        dot(ctx, x, y, 0.12, '#7fbf68');
        dot(ctx, x - 0.02, y - 0.02, 0.07, '#a9d98f');
      } else {
        // tomatoes
        dot(ctx, x, y, 0.1, LEAF);
        dot(ctx, x + 0.04, y + 0.03, 0.045, '#e5483b');
        dot(ctx, x - 0.05, y - 0.02, 0.04, '#e5483b');
      }
    }
  });
  // small sign
  line(ctx, b.x + 0.2, b.y + 0.15, b.x + 0.2, b.y + 0.45, WOOD_DARK, 0.04);
  fillRR(ctx, b.x + 0.06, b.y + 0.05, 0.3, 0.16, 0.03, '#efe3c5', WOOD_DARK);
}

// ------------------------------------------------------------------ tree house
// Top view: a tree of its own (leaf ring around the box), a platform in the crown on the south
// side and the cabin on the north side. The ladder and the work spots are on the ground below.

const BARK = '#7a5230';
const LEAVES = ['#4f9a45', '#5aa84e', '#43873d', '#62b055'];

function treeShadow(ctx: Ctx, b: Box): void {
  ellipse(ctx as CanvasRenderingContext2D, b.x + b.w / 2 + 0.1, b.y + b.h / 2 + 0.15, 1.45, 1.35);
  ctx.fillStyle = 'rgba(30,50,25,0.2)';
  ctx.fill();
}

/** ring of leaf clusters around the edge of the box; `inner` adds the ones above the platform */
function canopyRing(ctx: Ctx, b: Box, inner: boolean): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash2(b.uid, 5) * 0.4;
    const r = 1.0 + hash2(b.uid, i, 21) * 0.1;
    dot(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.5 + hash2(i, b.uid, 22) * 0.12, LEAVES[i % LEAVES.length]);
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    dot(ctx, cx + Math.cos(a) * 1.08, cy + Math.sin(a) * 1.05, 0.14, shade(LEAVES[(i + 1) % LEAVES.length], 0.18));
  }
  if (inner) for (const [x, y] of [[-0.95, -0.95], [0.95, -0.95]]) dot(ctx, cx + x, cy + y, 0.34, LEAVES[2]);
}

function trunk(ctx: Ctx, b: Box, withBranches: boolean): void {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (withBranches) for (let i = 0; i < 5; i++) line(ctx, cx, cy, cx + Math.cos(i * 1.3 + 0.4) * 0.95, cy + Math.sin(i * 1.3 + 0.4) * 0.95, BARK, 0.13);
  dot(ctx, cx, cy, 0.3, BARK);
  dot(ctx, cx - 0.04, cy - 0.04, 0.2, shade(BARK, 0.12));
  dot(ctx, cx, cy, 0.09, shade(BARK, -0.2));
}

const DECK = { x: 0.3, y: 1.15, w: 2.4, h: 1.3 };

/** platform planks (vertical boards); `share` of them laid, the beams below it always */
function platform(ctx: Ctx, b: Box, share: number, color = WOOD_LIGHT): void {
  const { x, y, w, h } = DECK;
  shadow(ctx, b.x + x, b.y + y, w, h, 0.04);
  fillRR(ctx, b.x + x, b.y + y, w, h, 0.04, WOOD_DARK, shade(WOOD_DARK, -0.4));
  for (const by of [0.18, h - 0.18]) line(ctx, b.x + x + 0.04, b.y + y + by, b.x + x + w - 0.04, b.y + y + by, WOOD, 0.1);
  const n = 10;
  const bw = w / n;
  for (let i = 0; i < Math.round(n * share); i++) {
    ctx.fillStyle = hash2(b.uid, i, 31) < 0.5 ? color : shade(color, 0.07);
    ctx.fillRect(b.x + x + i * bw, b.y + y, bw - 0.014, h);
  }
  fillRR(ctx, b.x + x, b.y + y, w, h, 0.04, 'rgba(0,0,0,0)', shade(WOOD_DARK, -0.3));
}

const CABIN = { x: 0.55, y: 0.2, w: 1.9, h: 1.0 };

function cabinWalls(ctx: Ctx, b: Box, sides: number): void {
  const { x, y, w, h } = CABIN;
  fillRR(ctx, b.x + x, b.y + y, w, h, 0.03, shade(WOOD_LIGHT, 0.08));
  const t = 0.12;
  const x0 = b.x + x;
  const y0 = b.y + y;
  const x1 = x0 + w;
  const y1 = y0 + h;
  const walls: [number, number, number, number][] = [
    [x0, y0, x1, y0],
    [x0, y0, x0, y1],
    [x1, y0, x1, y1],
  ];
  for (const [ax, ay, bx, by] of walls.slice(0, sides)) line(ctx, ax, ay, bx, by, WOOD, t);
  // front wall with the doorway
  if (sides >= 3) {
    line(ctx, x0, y1, x0 + w * 0.32, y1, WOOD, t);
    line(ctx, x0 + w * 0.68, y1, x1, y1, WOOD, t);
  }
  // window in the back wall
  if (sides >= 1) fillRR(ctx, x0 + w * 0.4, y0 - 0.05, w * 0.2, 0.1, 0.02, '#9ed0e6', WOOD_DARK);
}

function gableRoof(ctx: Ctx, b: Box, share: number, trim: string | null): void {
  const x0 = b.x + CABIN.x - 0.1;
  const x1 = b.x + CABIN.x + CABIN.w + 0.1;
  const y0 = b.y + CABIN.y - 0.1;
  const y1 = b.y + CABIN.y + CABIN.h + 0.12;
  const ym = (y0 + y1) / 2;
  const slopes: [number, number, string][] = [[y0, ym, shade(ROOF, -0.06)], [ym, y1, ROOF]];
  slopes.slice(0, share >= 1 ? 2 : 1).forEach(([ya, yb, c]) => {
    fillRR(ctx, x0, ya, x1 - x0, yb - ya, 0.03, c, shade(ROOF, -0.4));
    for (let yy = ya + 0.14; yy < yb - 0.05; yy += 0.14) line(ctx, x0 + 0.02, yy, x1 - 0.02, yy, shade(c, -0.18), 0.02);
  });
  if (share >= 1) line(ctx, x0, ym, x1, ym, shade(ROOF, -0.45), 0.05);
  else for (let i = 0; i < 6; i++) line(ctx, x0 + 0.15 + i * ((x1 - x0 - 0.3) / 5), ym, x0 + 0.15 + i * ((x1 - x0 - 0.3) / 5), y1, WOOD_DARK, 0.05);
  if (trim) {
    ctx.strokeStyle = trim;
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}

function deckRail(ctx: Ctx, b: Box, color: string): void {
  const { x, y, w, h } = DECK;
  const x0 = b.x + x + 0.04;
  const x1 = b.x + x + w - 0.04;
  const y1 = b.y + y + h - 0.04;
  line(ctx, x0, b.y + y + 0.3, x0, y1, color, 0.05);
  line(ctx, x1, b.y + y + 0.3, x1, y1, color, 0.05);
  // front rail with a gap above the ladder
  line(ctx, x0, y1, b.x + 1.15, y1, color, 0.05);
  line(ctx, b.x + 1.85, y1, x1, y1, color, 0.05);
  for (const [px, py] of [[x0, y1], [x1, y1], [b.x + 1.15, y1], [b.x + 1.85, y1], [x0, b.y + y + 0.3], [x1, b.y + y + 0.3]]) post(ctx, px, py, color, 0.1);
}

function domekBelki(ctx: Ctx, b: Box): void {
  treeShadow(ctx, b);
  canopyRing(ctx, b, false);
  trunk(ctx, b, true);
  // three of four frame beams on the branches, the fourth still on the ground
  const { x, y, w, h } = DECK;
  const x0 = b.x + x;
  const y0 = b.y + y;
  line(ctx, x0, y0, x0 + w, y0, WOOD, 0.12);
  line(ctx, x0, y0 + h, x0 + w, y0 + h, WOOD, 0.12);
  line(ctx, x0, y0, x0, y0 + h, WOOD, 0.12);
  line(ctx, x0 + w * 0.5, y0, x0 + w * 0.5, y0 + h, WOOD_LIGHT, 0.08);
  for (const [px, py] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) peg(ctx, px, py);
  lumber(ctx, b.x + 1.75, b.y + 2.62, 3, 0.95);
  ladder(ctx, b.x + 0.75, b.y + 2.98, 0.75, Math.PI);
}

function domekPlatforma(ctx: Ctx, b: Box): void {
  treeShadow(ctx, b);
  canopyRing(ctx, b, false);
  trunk(ctx, b, true);
  platform(ctx, b, 0.6);
  dot(ctx, b.x + 1.5, b.y + 1.5, 0.3, BARK);
  dot(ctx, b.x + 1.46, b.y + 1.46, 0.19, shade(BARK, 0.12));
  lumber(ctx, b.x + 1.75, b.y + 2.62, 4, 0.95);
  ladder(ctx, b.x + 0.75, b.y + 2.98, 1.0, Math.PI);
  // saw horse
  line(ctx, b.x + 0.15, b.y + 0.55, b.x + 0.85, b.y + 0.55, WOOD_DARK, 0.07);
  line(ctx, b.x + 0.2, b.y + 0.45, b.x + 0.2, b.y + 0.7, WOOD_DARK, 0.04);
  line(ctx, b.x + 0.8, b.y + 0.45, b.x + 0.8, b.y + 0.7, WOOD_DARK, 0.04);
}

function domekSciany(ctx: Ctx, b: Box): void {
  treeShadow(ctx, b);
  canopyRing(ctx, b, false);
  platform(ctx, b, 1);
  cabinWalls(ctx, b, 3);
  deckRail(ctx, b, WOOD_DARK);
  ladder(ctx, b.x + 0.75, b.y + 2.98, 1.0, Math.PI);
  lumber(ctx, b.x + 1.9, b.y + 2.62, 3, 0.85);
  canopyOverhang(ctx, b);
}

function domekDach(ctx: Ctx, b: Box): void {
  treeShadow(ctx, b);
  canopyRing(ctx, b, false);
  platform(ctx, b, 1);
  cabinWalls(ctx, b, 3);
  deckRail(ctx, b, WOOD_DARK);
  gableRoof(ctx, b, 0.5, null);
  ladder(ctx, b.x + 2.4, b.y + 1.0, 1.0, Math.PI);
  for (let i = 0; i < 3; i++) fillRR(ctx, b.x + 0.2 + i * 0.03, b.y + 2.7 - i * 0.06, 0.45, 0.2, 0.03, shade(ROOF, -0.05 * i), shade(ROOF, -0.4));
  canopyOverhang(ctx, b);
}

/** a few leaf clusters over the corners of the deck, so the house sits inside the tree */
function canopyOverhang(ctx: Ctx, b: Box): void {
  for (const [x, y, r] of [[0.1, 0.15, 0.3], [2.9, 0.12, 0.3], [0.05, 2.1, 0.22], [2.95, 2.15, 0.22]]) {
    dot(ctx, b.x + x, b.y + y, r, LEAVES[(Math.round(x * 3) + b.uid) % LEAVES.length]);
    dot(ctx, b.x + x + 0.05, b.y + y + 0.05, r * 0.5, shade(LEAVES[1], 0.15));
  }
}

function domekGotowy(ctx: Ctx, b: Box): void {
  treeShadow(ctx, b);
  canopyRing(ctx, b, false);
  platform(ctx, b, 1, '#c4915c');
  cabinWalls(ctx, b, 3);
  deckRail(ctx, b, PAINT);
  gableRoof(ctx, b, 1, PAINT);
  // pennant on the ridge and a lantern at the entrance
  const rx = b.x + CABIN.x + CABIN.w - 0.15;
  const ry = b.y + CABIN.y + CABIN.h / 2 + 0.06;
  line(ctx, rx, ry, rx, ry - 0.4, '#3b3b3b', 0.025);
  ctx.beginPath();
  ctx.moveTo(rx, ry - 0.4);
  ctx.lineTo(rx - 0.26, ry - 0.32);
  ctx.lineTo(rx, ry - 0.24);
  ctx.closePath();
  ctx.fillStyle = '#e5483b';
  ctx.fill();
  fillRR(ctx, b.x + 2.38, b.y + 1.22, 0.14, 0.18, 0.03, '#2f2f33');
  fillRR(ctx, b.x + 2.41, b.y + 1.26, 0.08, 0.1, 0.02, '#ffd77a');
  ladder(ctx, b.x + 1.5, b.y + 2.98, 1.0, Math.PI);
  canopyOverhang(ctx, b);
  // a few flowers by the ladder
  for (let i = 0; i < 4; i++) {
    const x = b.x + 0.35 + i * 0.28;
    dot(ctx, x, b.y + 2.75, 0.07, LEAF);
    dot(ctx, x, b.y + 2.75, 0.035, ['#f28b82', '#fdd663', '#c58af9', '#ffffff'][i]);
  }
}

// ------------------------------------------------------------------ pier
// Drawn over the water (the footprint is water): boards run along the pier, like pier tiles in
// render/tiles.ts. The shore is on the west side.

const PIER_BEAM = '#7a5530';

function waterShadow(ctx: Ctx, b: Box): void {
  ctx.fillStyle = 'rgba(20,55,85,0.28)';
  ctx.fillRect(b.x + 0.04, b.y + 0.1, b.w, b.h);
}

/** one pile in the water with ripples around it */
function pile(ctx: Ctx, x: number, y: number, h = 1): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 0.025;
  ellipse(ctx as CanvasRenderingContext2D, x, y + 0.04, 0.17, 0.12);
  ctx.stroke();
  dot(ctx, x + 0.03, y + 0.04, 0.1 * h, 'rgba(20,55,85,0.35)');
  dot(ctx, x, y, 0.095, WOOD_DARK);
  dot(ctx, x - 0.02, y - 0.02, 0.05, WOOD);
}

/** decking of whole tiles from the shore: 4 boards across the walking direction per tile, gaps, nails */
function pierDeck(ctx: Ctx, b: Box, tiles: number): void {
  const boards = 4;
  for (let tx = 0; tx < tiles; tx++) {
    for (let ty = 0; ty < b.h; ty++) {
      const x = b.x + tx;
      const y = b.y + ty;
      for (let i = 0; i < boards; i++) {
        const tone = PLANK_TONES[Math.floor(hash2(tx * 4 + i, ty, b.uid + 5) * PLANK_TONES.length)];
        ctx.fillStyle = shade(tone, (hash2(ty, tx * 4 + i, b.uid + 6) - 0.5) * 0.1);
        ctx.fillRect(x + i / boards, y, 1 / boards + 0.002, 1.002);
      }
      ctx.fillStyle = 'rgba(70,45,20,0.5)';
      for (let i = 0; i < boards; i++) ctx.fillRect(x + i / boards, y, 0.025, 1);
      for (let i = 0; i < boards; i++) for (const e of [0.1, 0.9]) dot(ctx, x + (i + 0.5) / boards, y + e, 0.018, 'rgba(60,40,20,0.55)');
    }
  }
  // edge beams on both long sides
  ctx.fillStyle = PIER_BEAM;
  ctx.fillRect(b.x, b.y, tiles, 0.07);
  ctx.fillRect(b.x, b.y + b.h - 0.07, tiles, 0.07);
}

function stringers(ctx: Ctx, b: Box): void {
  for (const y of [0.2, b.h - 0.2]) line(ctx, b.x, b.y + y, b.x + b.w, b.y + y, WOOD, 0.1);
}

function pomostPale(ctx: Ctx, b: Box): void {
  waterShadow(ctx, b);
  // piles driven in from the shore side, the last column only started
  for (const x of [0.2, 1.0, 1.8]) for (const y of [0.2, b.h - 0.2]) pile(ctx, b.x + x, b.y + y);
  pile(ctx, b.x + 2.6, b.y + 0.2, 0.8);
  // string along the first row of piles
  line(ctx, b.x + 0.2, b.y + 0.2, b.x + 2.6, b.y + 0.2, 'rgba(255,255,255,0.85)', 0.02);
  // raft with a stack of piles waiting to go in
  fillRR(ctx, b.x + 1.35, b.y + 0.7, 1.35, 0.6, 0.05, WOOD_LIGHT, WOOD_DARK);
  for (let i = 0; i < 3; i++) dot(ctx, b.x + 1.65 + i * 0.3, b.y + 1.0, 0.09, WOOD_DARK);
  line(ctx, b.x + 2.3, b.y + 0.82, b.x + 2.3, b.y + 1.15, WOOD_DARK, 0.04);
  fillRR(ctx, b.x + 2.2, b.y + 0.78, 0.22, 0.1, 0.03, '#8c939c', '#5d636b');
}

function pomostDeski(ctx: Ctx, b: Box): void {
  waterShadow(ctx, b);
  for (const x of [0.2, 1.0, 1.8, 2.6]) for (const y of [0.2, b.h - 0.2]) pile(ctx, b.x + x, b.y + y);
  stringers(ctx, b);
  line(ctx, b.x + 2.5, b.y + 0.2, b.x + 2.5, b.y + b.h - 0.2, WOOD, 0.08);
  pierDeck(ctx, b, 2);
  // planks waiting at the unfinished end
  lumber(ctx, b.x + 2.1, b.y + 0.5, 4, 0.8);
  line(ctx, b.x + 1.7, b.y + 1.65, b.x + 1.95, b.y + 1.4, WOOD_DARK, 0.04);
  fillRR(ctx, b.x + 1.85, b.y + 1.32, 0.2, 0.1, 0.03, '#8c939c', '#5d636b');
}

function railSegment(ctx: Ctx, b: Box, y: number, from: number, to: number, color: string): void {
  line(ctx, b.x + from, b.y + y, b.x + to, b.y + y, color, 0.05);
  const n = Math.round((to - from) / 0.75);
  for (let i = 0; i <= n; i++) post(ctx, b.x + from + (i * (to - from)) / n, b.y + y, color, 0.1);
}

function pomostBarierki(ctx: Ctx, b: Box): void {
  waterShadow(ctx, b);
  for (const x of [0.2, 1.0, 1.8, 2.6]) for (const y of [0.2, b.h - 0.2]) pile(ctx, b.x + x, b.y + y);
  pierDeck(ctx, b, b.w);
  // rail on the north side done, the south side only posts
  railSegment(ctx, b, 0.1, 0.1, 2.9, WOOD_DARK);
  for (const x of [0.1, 1.0, 1.9]) post(ctx, b.x + x, b.y + b.h - 0.1, WOOD_DARK, 0.1);
  lumber(ctx, b.x + 1.45, b.y + 1.1, 3, 0.8);
  bucket(ctx, b.x + 0.5, b.y + 1.3, '#d9a873');
}

function pomostGotowy(ctx: Ctx, b: Box): void {
  waterShadow(ctx, b);
  for (const x of [0.2, 1.0, 1.8, 2.6]) for (const y of [0.2, b.h - 0.2]) pile(ctx, b.x + x, b.y + y);
  pierDeck(ctx, b, b.w);
  railSegment(ctx, b, 0.1, 0.1, 2.9, PAINT);
  railSegment(ctx, b, b.h - 0.1, 0.1, 2.9, PAINT);
  // bollard with a rope coil and a lantern post at the head
  post(ctx, b.x + 2.85, b.y + 1.0, '#3b3b3b', 0.12);
  dot(ctx, b.x + 2.85, b.y + 1.0, 0.07, '#ffd77a');
  dot(ctx, b.x + 0.35, b.y + 1.7, 0.09, '#d8c08a');
  dot(ctx, b.x + 0.35, b.y + 1.7, 0.05, WOOD_DARK);
}

const DRAWERS: Record<string, (ctx: Ctx, b: Box) => void> = {
  altana_fundament: altanaFundament,
  altana_konstrukcja: altanaKonstrukcja,
  altana_dach: altanaDach,
  altana_malowanie: altanaMalowanie,
  altana: altanaGotowa,
  warzywnik_przekopywanie: warzywnikKopanie,
  warzywnik_grzadki: warzywnikGrzadki,
  warzywnik_sadzenie: warzywnikSadzenie,
  warzywnik: warzywnikGotowy,
  domek_belki: domekBelki,
  domek_platforma: domekPlatforma,
  domek_sciany: domekSciany,
  domek_dach: domekDach,
  domek_na_drzewie: domekGotowy,
  pomost_pale: pomostPale,
  pomost_deski: pomostDeski,
  pomost_barierki: pomostBarierki,
  pomost: pomostGotowy,
};

export function drawProjectObject(ctx: Ctx, def: ObjectDef | undefined, inst: ObjectInstance, _T: number): void {
  const b: Box = { x: inst.pos.x - 0.5, y: inst.pos.y - 0.5, w: def?.size.w ?? 1, h: def?.size.h ?? 1, uid: inst.uid };
  (DRAWERS[inst.type] ?? altanaFundament)(ctx, b);
}

// ------------------------------------------------------------------ screen-space badge

/** below this zoom (px per tile) the badge is hidden */
const BADGE_MIN_ZOOM = 12;

function badgeText(p: ProjectView): string {
  return p.status === 'done' ? `🎉 ${p.doneText}` : `🔨 ${p.short} ${Math.floor(p.progress * 100)}%`;
}

/**
 * progress pill above each construction site ("🔨 Altana 45%" with a bar and the stage name);
 * a short "gotowa!" pill on the day a building is finished. Called by the renderer in screen space.
 */
export function drawProjectBadges(
  ctx: CanvasRenderingContext2D,
  world: World,
  toScreen: (x: number, y: number) => { x: number; y: number },
  zoom: number,
  now: number,
): void {
  if (zoom < BADGE_MIN_ZOOM) return;
  const projects = projectsOf(world);
  if (!projects.length) return;
  const day = timeFromTick(world.tick).day;
  const ui = Math.max(0.8, Math.min(1.2, zoom / 34));
  ctx.save();
  for (const p of projects) {
    const done = p.status === 'done';
    if (done && (p.finishedTick === null || timeFromTick(p.finishedTick).day !== day)) continue;
    const top = toScreen(p.pos.x + (p.size.w - 1) / 2, p.pos.y - 0.5);
    const text = badgeText(p);
    const sub = done ? '' : p.stageLabel;
    ctx.font = `700 ${Math.round(12 * ui)}px ${UI_FONT}, ${EMOJI_FONT}`;
    const tw = ctx.measureText(text).width;
    ctx.font = `${Math.round(10 * ui)}px ${UI_FONT}`;
    const sw = sub ? ctx.measureText(sub).width : 0;
    const w = Math.max(tw, sw) + 18 * ui;
    const h = (sub ? 34 : 22) * ui;
    const working = p.workerIds.length > 0;
    const bob = working ? Math.sin(now / 260) * 1.5 : 0;
    const x = top.x - w / 2;
    const y = top.y - h - 8 * ui + bob;
    ctx.fillStyle = done ? 'rgba(255,244,214,0.96)' : 'rgba(20,24,36,0.86)';
    ctx.strokeStyle = done ? '#e0a020' : working ? '#f2b84b' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8 * ui);
    ctx.fill();
    ctx.stroke();
    // pointer
    ctx.beginPath();
    ctx.moveTo(top.x - 5 * ui, y + h);
    ctx.lineTo(top.x + 5 * ui, y + h);
    ctx.lineTo(top.x, y + h + 6 * ui);
    ctx.closePath();
    ctx.fillStyle = done ? 'rgba(255,244,214,0.96)' : 'rgba(20,24,36,0.86)';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(12 * ui)}px ${UI_FONT}, ${EMOJI_FONT}`;
    ctx.fillStyle = done ? '#5a3d00' : '#f1f4fb';
    ctx.fillText(text, top.x, y + 11 * ui);
    if (sub) {
      // progress bar with stage ticks, then the stage name
      const bx = x + 8 * ui;
      const bw = w - 16 * ui;
      const by = y + 19 * ui;
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 4 * ui, 2 * ui);
      ctx.fill();
      ctx.fillStyle = '#f2b84b';
      ctx.beginPath();
      ctx.roundRect(bx, by, Math.max(2, bw * p.progress), 4 * ui, 2 * ui);
      ctx.fill();
      ctx.fillStyle = 'rgba(20,24,36,0.9)';
      for (const st of p.stages.slice(0, -1)) ctx.fillRect(bx + bw * st.until - 0.75, by, 1.5, 4 * ui);
      ctx.font = `${Math.round(10 * ui)}px ${UI_FONT}`;
      ctx.fillStyle = '#a9b2c7';
      ctx.fillText(sub, top.x, y + 28 * ui);
    }
  }
  ctx.restore();
}
