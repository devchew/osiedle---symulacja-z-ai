// Static layer: ground tiles, water, walls, doors, room labels and objects,
// pre-rendered once into an offscreen canvas in world space.

import type { Grid, Room, TileKind, World } from '../types';
import { UI_FONT, circle, hash2, rr, shade } from './colors';
import { drawObject, isFlatObject, isTallObject } from './objects';
import { baseTypeOf } from '../world/incidents';
import { pierTiles } from './pier';

export interface StaticLayer {
  canvas: HTMLCanvasElement;
  /** pixels per tile */
  T: number;
}

type Ctx = CanvasRenderingContext2D;

const GRASS = '#97c870';
const PATH = '#dccaa2';
const WALL_TOP = '#f1e8da';
const WALL_EDGE = '#6e5d4b';
const WALL_FRONT = '#c7b298';

/**
 * cheap signature of everything baked into the static layer: grid size, and every object's uid,
 * position and (unbroken) type — a project stage change swaps the type, so the whole name counts
 */
export function staticSignature(world: World): number {
  let h = world.grid.width * 131 + world.grid.height;
  for (const o of world.objects) {
    h = (Math.imul(h, 31) + o.uid * 7 + o.pos.x * 131 + o.pos.y * 197) | 0;
    const t = baseTypeOf(o.type);
    for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  }
  return (Math.imul(h, 31) + world.objects.length) | 0;
}

function kindAt(g: Grid, x: number, y: number): TileKind | null {
  if (x < 0 || y < 0 || x >= g.width || y >= g.height) return null;
  return g.tiles[y * g.width + x];
}

const isWallish = (k: TileKind | null): boolean => k === 'wall';

function roomAt(g: Grid, x: number, y: number): Room | undefined {
  // smallest containing room wins (so a garden room does not swallow the house)
  let best: Room | undefined;
  for (const r of g.rooms) {
    if (x >= r.rect.x && y >= r.rect.y && x < r.rect.x + r.rect.w && y < r.rect.y + r.rect.h) {
      if (!best || r.rect.w * r.rect.h < best.rect.w * best.rect.h) best = r;
    }
  }
  return best;
}

function isWetRoom(r: Room | undefined): boolean {
  if (!r) return false;
  return /bath|łaz|laz|wc|toal/i.test(r.id + ' ' + r.name);
}

/** what a door tile should show underneath: the nearest indoor surface */
function doorFloor(g: Grid, x: number, y: number): TileKind {
  const ns = [kindAt(g, x, y - 1), kindAt(g, x, y + 1), kindAt(g, x - 1, y), kindAt(g, x + 1, y)];
  if (ns.includes('floor')) return 'floor';
  if (ns.includes('tile')) return 'tile';
  if (ns.includes('path')) return 'path';
  return 'grass';
}

const FLOOR_TONES = ['#dcb98b', '#d4ad7c', '#e0c197', '#cfa676'];

function drawFloor(ctx: Ctx, g: Grid, x: number, y: number): void {
  const room = roomAt(g, x, y);
  const base = FLOOR_TONES[room ? Math.floor(hash2(room.id.length, room.rect.x + room.rect.y * 7) * FLOOR_TONES.length) : 0];
  const rows = 4;
  const rh = 1 / rows;
  const L = 2.3;
  for (let r = 0; r < rows; r++) {
    const rowG = y * rows + r;
    const yy = y - 0.5 + r * rh;
    const off = hash2(rowG, 11) * L;
    let sx = x - 0.5;
    const ex = x + 0.5;
    while (sx < ex - 1e-6) {
      // epsilon: when sx lands exactly on a seam, floor() may round down and stall the loop
      const idx = Math.floor((sx + off) / L + 1e-9);
      const seam = (idx + 1) * L - off;
      let segEnd = Math.min(ex, seam);
      if (segEnd <= sx + 1e-9) segEnd = Math.min(ex, sx + L);
      ctx.fillStyle = shade(base, (hash2(idx, rowG, 5) - 0.5) * 0.16);
      ctx.fillRect(sx, yy, segEnd - sx + 0.002, rh + 0.002);
      if (segEnd < ex - 1e-6) {
        ctx.fillStyle = 'rgba(90,60,30,0.28)';
        ctx.fillRect(segEnd - 0.008, yy, 0.016, rh);
      }
      sx = segEnd;
    }
    ctx.fillStyle = 'rgba(90,60,30,0.2)';
    ctx.fillRect(x - 0.5, yy, 1, 0.014);
  }
}

function drawTileFloor(ctx: Ctx, g: Grid, x: number, y: number): void {
  const wet = isWetRoom(roomAt(g, x, y));
  const a = wet ? '#eef5f8' : '#f4efe7';
  const b = wet ? '#d3e5ee' : '#e2d6c5';
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (x * 2 + i + y * 2 + j) % 2 === 0 ? a : b;
      ctx.fillRect(x - 0.5 + i * 0.5, y - 0.5 + j * 0.5, 0.5 + 0.002, 0.5 + 0.002);
    }
  }
  ctx.fillStyle = 'rgba(120,130,140,0.18)';
  ctx.fillRect(x - 0.5, y - 0.5, 1, 0.012);
  ctx.fillRect(x - 0.5, y - 0.5, 0.012, 1);
  ctx.fillRect(x - 0.5, y, 1, 0.008);
  ctx.fillRect(x, y - 0.5, 0.008, 1);
}

function drawGrass(ctx: Ctx, g: Grid, seed: number): void {
  ctx.fillStyle = GRASS;
  ctx.fillRect(-0.5, -0.5, g.width, g.height);
  // soft mottling
  const n = Math.round(g.width * g.height * 0.5);
  for (let i = 0; i < n; i++) {
    const x = hash2(i, 1, seed) * g.width - 0.5;
    const y = hash2(i, 2, seed) * g.height - 0.5;
    const r = 0.5 + hash2(i, 3, seed) * 1.4;
    circle(ctx, x, y, r);
    ctx.fillStyle = hash2(i, 4, seed) < 0.5 ? 'rgba(178,215,128,0.14)' : 'rgba(110,165,85,0.1)';
    ctx.fill();
  }
  // tufts + flowers
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (g.tiles[y * g.width + x] !== 'grass') continue;
      const k = 1 + Math.floor(hash2(x, y, seed + 1) * 3);
      for (let t = 0; t < k; t++) {
        const tx = x - 0.4 + hash2(x, y, seed + 10 + t) * 0.8;
        const ty = y - 0.35 + hash2(y, x, seed + 20 + t) * 0.75;
        ctx.strokeStyle = 'rgba(70,125,55,0.55)';
        ctx.lineWidth = 0.03;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx - 0.06, ty - 0.08);
        ctx.lineTo(tx - 0.02, ty + 0.02);
        ctx.lineTo(tx + 0.01, ty - 0.1);
        ctx.moveTo(tx - 0.02, ty + 0.02);
        ctx.lineTo(tx + 0.07, ty - 0.06);
        ctx.stroke();
      }
      const f = hash2(x, y, seed + 99);
      if (f < 0.07) {
        const fx = x - 0.3 + hash2(x, y, seed + 7) * 0.6;
        const fy = y - 0.3 + hash2(y, x, seed + 7) * 0.6;
        const col = ['#ffffff', '#ffe27a', '#f7a8c4', '#c9b6ff'][Math.floor(f * 57) % 4];
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2;
          circle(ctx, fx + Math.cos(a) * 0.045, fy + Math.sin(a) * 0.045, 0.035);
          ctx.fillStyle = col;
          ctx.fill();
        }
        circle(ctx, fx, fy, 0.025);
        ctx.fillStyle = '#e8a33c';
        ctx.fill();
      }
    }
  }
}

function drawPath(ctx: Ctx, x: number, y: number, seed: number): void {
  ctx.fillStyle = PATH;
  ctx.fillRect(x - 0.5, y - 0.5, 1.002, 1.002);
  // two stepping stones per tile, alternating layout
  const alt = (x + y) % 2 === 0;
  const stones: [number, number, number, number][] = alt
    ? [
        [x - 0.44, y - 0.44, 0.5, 0.42],
        [x + 0.1, y - 0.02, 0.36, 0.46],
      ]
    : [
        [x - 0.42, y - 0.02, 0.46, 0.44],
        [x + 0.06, y - 0.44, 0.4, 0.42],
      ];
  stones.forEach(([sx, sy, sw, sh], i) => {
    const j = (hash2(x, y, seed + i) - 0.5) * 0.06;
    rr(ctx, sx + j, sy - j, sw, sh, 0.12);
    ctx.fillStyle = shade('#c9b896', (hash2(y, x, seed + i) - 0.5) * 0.14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,120,90,0.35)';
    ctx.lineWidth = 0.02;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    rr(ctx, sx + j + 0.05, sy - j + 0.04, sw * 0.5, sh * 0.25, 0.06);
    ctx.fill();
  });
  // pebbles
  for (let i = 0; i < 2; i++) {
    circle(ctx, x - 0.45 + hash2(x, y, seed + 30 + i) * 0.9, y - 0.45 + hash2(y, x, seed + 40 + i) * 0.9, 0.025);
    ctx.fillStyle = 'rgba(130,110,80,0.45)';
    ctx.fill();
  }
}

const PLANK_TONES = ['#b98a57', '#a97b4a', '#c39563', '#b08052'];

/** boards across the walking direction, a shadow on the water and side beams */
function drawPier(ctx: Ctx, g: Grid, pier: Set<number>, seed: number): void {
  if (pier.size === 0) return;
  const has = (x: number, y: number) => x >= 0 && y >= 0 && x < g.width && y < g.height && pier.has(y * g.width + x);
  const wet = (x: number, y: number) => kindAt(g, x, y) === 'water';
  for (const i of pier) {
    const x = i % g.width;
    const y = Math.floor(i / g.width);
    ctx.fillStyle = 'rgba(20,55,85,0.28)';
    ctx.fillRect(x - 0.5 + 0.04, y - 0.5 + 0.1, 1, 1);
  }
  for (const i of pier) {
    const x = i % g.width;
    const y = Math.floor(i / g.width);
    const along = has(x - 1, y) || has(x + 1, y) || !(has(x, y - 1) || has(x, y + 1)); // walking along x
    const boards = 4;
    for (let b = 0; b < boards; b++) {
      const tone = PLANK_TONES[Math.floor(hash2(x * 4 + b, y, seed + 5) * PLANK_TONES.length)];
      ctx.fillStyle = shade(tone, (hash2(y, x * 4 + b, seed + 6) - 0.5) * 0.1);
      if (along) ctx.fillRect(x - 0.5 + b / boards, y - 0.5, 1 / boards + 0.002, 1.002);
      else ctx.fillRect(x - 0.5, y - 0.5 + b / boards, 1.002, 1 / boards + 0.002);
    }
    // gaps between boards and nails
    ctx.fillStyle = 'rgba(70,45,20,0.5)';
    for (let b = 0; b < boards; b++) {
      if (along) ctx.fillRect(x - 0.5 + b / boards, y - 0.5, 0.025, 1);
      else ctx.fillRect(x - 0.5, y - 0.5 + b / boards, 1, 0.025);
    }
    ctx.fillStyle = 'rgba(60,40,20,0.55)';
    for (let b = 0; b < boards; b++) {
      for (const e of [-0.4, 0.4]) {
        const bx = along ? x - 0.5 + (b + 0.5) / boards : x + e;
        const by = along ? y + e : y - 0.5 + (b + 0.5) / boards;
        circle(ctx, bx, by, 0.018);
        ctx.fill();
      }
    }
    // edge beams where the pier meets open water
    ctx.fillStyle = '#7a5530';
    if (wet(x, y - 1)) ctx.fillRect(x - 0.5, y - 0.5, 1, 0.07);
    if (wet(x, y + 1)) ctx.fillRect(x - 0.5, y + 0.43, 1, 0.07);
    if (wet(x - 1, y)) ctx.fillRect(x - 0.5, y - 0.5, 0.07, 1);
    if (wet(x + 1, y)) ctx.fillRect(x + 0.43, y - 0.5, 0.07, 1);
  }
}

/** soft blobby water + sandy shore, done with a blur + alpha threshold */
function drawWater(ctx: Ctx, g: Grid, T: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (g.tiles[y * g.width + x] !== 'water') continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX === Infinity) return;
  const pad = 1;
  const ox = minX - pad;
  const oy = minY - pad;
  const tw = maxX - minX + 1 + 2 * pad;
  const th = maxY - minY + 1 + 2 * pad;
  // the mask is blurred anyway: a lower resolution keeps big lakes cheap
  const S = Math.min(T, 24);
  const cw = Math.ceil(tw * S);
  const ch = Math.ceil(th * S);
  const mask = document.createElement('canvas');
  mask.width = cw;
  mask.height = ch;
  const m = mask.getContext('2d', { willReadFrequently: true });
  if (!m) return;
  m.filter = `blur(${Math.max(1, Math.round(S * 0.28))}px)`;
  m.fillStyle = '#000';
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (g.tiles[y * g.width + x] !== 'water') continue;
      m.fillRect((x - ox) * S, (y - oy) * S, S + 1, S + 1);
    }
  }
  m.filter = 'none';
  const img = m.getImageData(0, 0, cw, ch);
  const d = img.data;
  const shore = [222, 205, 160];
  const foam = [210, 238, 246];
  const shallow = [128, 196, 226];
  const deep = [66, 140, 192];
  // colour per mask alpha, computed once
  const lut = new Uint8ClampedArray(256 * 4);
  for (let a = 0; a < 256; a++) {
    let c: number[];
    let alpha = 255;
    if (a < 70) {
      c = shore;
      alpha = 0;
    } else if (a < 118) {
      c = shore;
      alpha = Math.min(255, (a - 70) * 9);
    } else if (a < 132) c = foam;
    else {
      const t = Math.min(1, (a - 132) / 110);
      c = [shallow[0] + (deep[0] - shallow[0]) * t, shallow[1] + (deep[1] - shallow[1]) * t, shallow[2] + (deep[2] - shallow[2]) * t];
    }
    lut.set([c[0], c[1], c[2], alpha], a * 4);
  }
  for (let i = 0; i < d.length; i += 4) {
    const k = d[i + 3] * 4;
    d[i] = lut[k];
    d[i + 1] = lut[k + 1];
    d[i + 2] = lut[k + 2];
    d[i + 3] = lut[k + 3];
  }
  m.putImageData(img, 0, 0);
  ctx.drawImage(mask, ox - 0.5, oy - 0.5, cw / S, ch / S);
  // sparkles and lily pads
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (g.tiles[y * g.width + x] !== 'water') continue;
      const h = hash2(x, y, 77);
      if (h < 0.35) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 0.03;
        ctx.lineCap = 'round';
        ctx.beginPath();
        const sx = x - 0.25 + h;
        ctx.arc(sx, y, 0.14, Math.PI * 1.15, Math.PI * 1.65);
        ctx.stroke();
      } else if (h > 0.9) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, 0.16, 0.5, Math.PI * 2 - 0.1);
        ctx.closePath();
        ctx.fillStyle = '#5f9e4c';
        ctx.fill();
        if (h > 0.96) {
          circle(ctx, x + 0.04, y - 0.03, 0.05);
          ctx.fillStyle = '#f7b6cf';
          ctx.fill();
        }
      }
    }
  }
}

function drawWallFronts(ctx: Ctx, g: Grid): void {
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!isWallish(kindAt(g, x, y))) continue;
      const below = kindAt(g, x, y + 1);
      if (below === null || isWallish(below) || below === 'door') continue;
      const grad = ctx.createLinearGradient(0, y + 0.5, 0, y + 0.82);
      grad.addColorStop(0, shade(WALL_FRONT, -0.12));
      grad.addColorStop(1, WALL_FRONT);
      ctx.fillStyle = grad;
      ctx.fillRect(x - 0.5, y + 0.5, 1.002, 0.3);
      ctx.fillStyle = 'rgba(60,45,30,0.18)';
      ctx.fillRect(x - 0.5, y + 0.8, 1.002, 0.06);
    }
  }
}

function drawWallTops(ctx: Ctx, g: Grid): void {
  ctx.fillStyle = WALL_TOP;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (isWallish(kindAt(g, x, y))) ctx.fillRect(x - 0.5, y - 0.5, 1.002, 1.002);
    }
  }
  // subtle inner line to suggest thickness
  ctx.strokeStyle = 'rgba(160,140,115,0.35)';
  ctx.lineWidth = 0.025;
  ctx.beginPath();
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!isWallish(kindAt(g, x, y))) continue;
      if (isWallish(kindAt(g, x + 1, y))) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + 1, y);
      }
      if (isWallish(kindAt(g, x, y + 1))) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 1);
      }
    }
  }
  ctx.stroke();
  // dark outline on edges facing non-wall tiles
  ctx.strokeStyle = WALL_EDGE;
  ctx.lineWidth = 0.06;
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!isWallish(kindAt(g, x, y))) continue;
      const l = x - 0.5;
      const r = x + 0.5;
      const t = y - 0.5;
      const b = y + 0.5;
      if (!isWallish(kindAt(g, x, y - 1))) {
        ctx.moveTo(l, t);
        ctx.lineTo(r, t);
      }
      if (!isWallish(kindAt(g, x, y + 1))) {
        ctx.moveTo(l, b);
        ctx.lineTo(r, b);
      }
      if (!isWallish(kindAt(g, x - 1, y))) {
        ctx.moveTo(l, t);
        ctx.lineTo(l, b);
      }
      if (!isWallish(kindAt(g, x + 1, y))) {
        ctx.moveTo(r, t);
        ctx.lineTo(r, b);
      }
    }
  }
  ctx.stroke();
}

function drawDoors(ctx: Ctx, g: Grid): void {
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (kindAt(g, x, y) !== 'door') continue;
      const horizontalWall = isWallish(kindAt(g, x - 1, y)) || isWallish(kindAt(g, x + 1, y));
      ctx.save();
      ctx.translate(x, y);
      if (!horizontalWall) ctx.rotate(Math.PI / 2);
      // threshold
      rr(ctx, -0.5, -0.1, 1, 0.2, 0.02);
      ctx.fillStyle = '#a47449';
      ctx.fill();
      // frame posts
      for (const s of [-1, 1]) {
        rr(ctx, s * 0.5 - (s > 0 ? 0.14 : 0), -0.5, 0.14, 1, 0.03);
        ctx.fillStyle = WALL_TOP;
        ctx.fill();
        ctx.strokeStyle = WALL_EDGE;
        ctx.lineWidth = 0.05;
        ctx.stroke();
      }
      // open door leaf (hinged on the left post, swung inwards / downwards)
      rr(ctx, -0.36, 0.06, 0.1, 0.66, 0.03);
      ctx.fillStyle = '#b5865a';
      ctx.fill();
      ctx.strokeStyle = '#6e4a2e';
      ctx.lineWidth = 0.03;
      ctx.stroke();
      ctx.setLineDash([0.05, 0.05]);
      ctx.beginPath();
      ctx.arc(-0.36, 0.06, 0.66, 0, Math.PI / 2);
      ctx.strokeStyle = 'rgba(110,74,46,0.25)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

/** finds a spot for the room label near the room centre that isn't covered by objects */
function labelSpot(g: Grid, r: Room, occupied: Set<number>, widthTiles: number): { x: number; y: number } {
  const cx = r.rect.x + (r.rect.w - 1) / 2;
  const cy = r.rect.y + (r.rect.h - 1) / 2;
  const need = Math.min(r.rect.w, Math.ceil(widthTiles));
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
    for (let x0 = r.rect.x; x0 + need <= r.rect.x + r.rect.w; x0++) {
      let free = true;
      for (let x = x0; x < x0 + need && free; x++) {
        const k = kindAt(g, x, y);
        if (occupied.has(y * g.width + x) || k === 'wall' || k === 'water' || k === 'door') free = false;
      }
      if (!free) continue;
      const mx = x0 + (need - 1) / 2;
      const d = Math.abs(mx - cx) * 0.6 + Math.abs(y - cy);
      if (!best || d < best.d) best = { x: mx, y, d };
    }
  }
  return best ?? { x: cx, y: cy };
}

function drawRoomLabels(ctx: Ctx, world: World, T: number): void {
  const g = world.grid;
  const occupied = new Set<number>();
  for (const o of world.objects) {
    const def = world.objectDefs[o.type];
    const w = def?.size.w ?? 1;
    const h = def?.size.h ?? 1;
    for (let y = o.pos.y; y < o.pos.y + h; y++) for (let x = o.pos.x; x < o.pos.x + w; x++) occupied.add(y * g.width + x);
  }
  for (const r of g.rooms) {
    const ck = kindAt(g, Math.round(r.rect.x + (r.rect.w - 1) / 2), Math.round(r.rect.y + (r.rect.h - 1) / 2));
    const outdoor = ck === 'grass' || ck === 'path' || ck === 'water';
    const size = Math.round(T * (outdoor ? 0.5 : 0.42));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `700 ${size}px ${UI_FONT}`;
    try {
      ctx.letterSpacing = `${Math.round(size * 0.18)}px`;
    } catch {
      /* not supported */
    }
    const text = r.name.toUpperCase();
    const widthTiles = ctx.measureText(text).width / T + 0.6;
    const spot = labelSpot(g, r, occupied, widthTiles);
    ctx.translate((spot.x + 0.5) * T, (spot.y + 0.5) * T);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = outdoor ? 'rgba(40,80,30,0.25)' : 'rgba(90,60,30,0.24)';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

export function buildStaticLayer(world: World, prev?: StaticLayer): StaticLayer {
  const g = world.grid;
  const T = Math.max(16, Math.min(64, Math.floor(4096 / Math.max(g.width, g.height))));
  const canvas = prev && prev.T === T && prev.canvas.width === g.width * T ? prev.canvas : document.createElement('canvas');
  canvas.width = g.width * T;
  canvas.height = g.height * T;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas, T };
  ctx.setTransform(T, 0, 0, T, T / 2, T / 2);
  ctx.clearRect(-1, -1, g.width + 2, g.height + 2);

  drawGrass(ctx, g, world.seed | 0);
  const pier = pierTiles(g);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      let k = g.tiles[y * g.width + x];
      if (k === 'door') k = doorFloor(g, x, y);
      if (k === 'path' && pier.has(y * g.width + x)) continue;
      if (k === 'path') drawPath(ctx, x, y, world.seed | 0);
      else if (k === 'floor') drawFloor(ctx, g, x, y);
      else if (k === 'tile') drawTileFloor(ctx, g, x, y);
    }
  }
  // soft shadow along the outer house walls on grass
  ctx.fillStyle = 'rgba(40,60,30,0.12)';
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!isWallish(kindAt(g, x, y))) continue;
      const below = kindAt(g, x, y + 1);
      const right = kindAt(g, x + 1, y);
      if (below === 'grass' || below === 'path') ctx.fillRect(x - 0.5, y + 0.5, 1, 0.45);
      if (right === 'grass' || right === 'path') ctx.fillRect(x + 0.5, y - 0.3, 0.25, 1);
    }
  }
  drawWater(ctx, g, T);
  drawPier(ctx, g, pier, world.seed | 0);
  drawWallFronts(ctx, g);
  drawRoomLabels(ctx, world, T);

  const objs = [...world.objects].sort((a, b) => {
    const fa = isFlatObject(a.type) ? 0 : 1;
    const fb = isFlatObject(b.type) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const da = world.objectDefs[a.type];
    const db = world.objectDefs[b.type];
    return a.pos.y + (da?.size.h ?? 1) - (b.pos.y + (db?.size.h ?? 1));
  });
  // tree canopies overhang walls, so they go on top of the wall layer
  for (const o of objs) if (!isTallObject(o.type)) drawObject(ctx, world.objectDefs[baseTypeOf(o.type)], o, T);

  drawWallTops(ctx, g);
  drawDoors(ctx, g);
  for (const o of objs) if (isTallObject(o.type)) drawObject(ctx, world.objectDefs[baseTypeOf(o.type)], o, T);
  return { canvas, T };
}
