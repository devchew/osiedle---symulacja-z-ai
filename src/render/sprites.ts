// Character sprites, drawn procedurally in world (tile) units.
// The figure is designed around its feet at (x, y + FEET) and scaled by
// AGENT_SCALE so characters stay readable at the fitted zoom.

import type { Agent } from '../types';
import { UI_FONT, EMOJI_FONT, circle, ellipse, hash2, rr, shade, withAlpha } from './colors';
import { fishingCastOf, jointViewOf } from '../agents/joint';
import type { Pet } from '../agents/pets';

type Ctx = CanvasRenderingContext2D;

export const AGENT_SCALE = 1.32;
/** offset of the feet below the tile centre (unscaled units) */
const FEET = 0.29;

const SKINS = ['#f6d5bd', '#eec3a1', '#dcaa84', '#b98260', '#8f5d3f', '#f3c9a8', '#6e4630'];
const HAIRS = ['#3a2a20', '#6b4630', '#c8954f', '#222326', '#9c4a2a', '#e2c47a', '#7b7f86', '#4d2f22', '#b9b4ad'];
const PANTS = ['#3d4a66', '#4b4f58', '#5a4636', '#2f5d62', '#47506b', '#6b4a5e'];
const HAIR_STYLES = 6;

export type PoseMode = 'stand' | 'walk' | 'sit' | 'pedal' | 'run' | 'bath' | 'shower' | 'sleep';

export interface AgentPose {
  /** interpolated position (tile units) */
  x: number;
  y: number;
  moving: boolean;
  /** walk cycle phase, radians */
  phase: number;
  sleeping: boolean;
  /** for sleeping agents: bed long axis is horizontal */
  bedHorizontal: boolean;
  /** blanket colour for sleeping agents */
  blanket: string;
  mode: PoseMode;
  /** facing while visually walking (overrides agent.facing) */
  facing?: -1 | 1;
}

export interface AgentLook {
  skin: string;
  hair: string;
  pants: string;
  /** 0..HAIR_STYLES-1 */
  style: number;
}

/** deterministic look derived from the agent id */
export function agentPalette(a: Agent): AgentLook {
  return {
    skin: SKINS[Math.floor(hash2(a.id, 1, 17) * SKINS.length)],
    hair: HAIRS[Math.floor(hash2(a.id, 2, 17) * HAIRS.length)],
    pants: PANTS[Math.floor(hash2(a.id, 3, 17) * PANTS.length)],
    style: Math.floor(hash2(a.id, 4, 17) * HAIR_STYLES),
  };
}

/** screen-space height of the drawn figure above its tile centre, in tiles (for icons / bubbles) */
export function headTop(mode: PoseMode): number {
  const base = mode === 'sit' || mode === 'pedal' ? 0.42 : mode === 'bath' ? 0.2 : mode === 'shower' ? 0.36 : 0.5;
  return FEET - (FEET + base) * AGENT_SCALE;
}

export function drawSelection(ctx: Ctx, p: AgentPose, now: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);
  const fy = p.y + FEET;
  ellipse(ctx, p.x, fy, 0.44 + pulse * 0.04, 0.19 + pulse * 0.02);
  ctx.fillStyle = 'rgba(255,214,90,0.3)';
  ctx.fill();
  ctx.lineWidth = 0.055;
  ctx.strokeStyle = '#ffd65a';
  ctx.stroke();
  ellipse(ctx, p.x, fy, 0.53 + pulse * 0.05, 0.23 + pulse * 0.03);
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = `rgba(255,255,255,${0.35 + pulse * 0.4})`;
  ctx.stroke();
}

export function drawAgent(ctx: Ctx, a: Agent, p: AgentPose, now: number): void {
  if (p.sleeping || p.mode === 'sleep') return drawSleeping(ctx, a, p);
  // no game pad / rod / cards while still walking there
  const prop = p.moving ? null : propOf(a);
  // console players sit on poufs in front of the screen
  const pose: AgentPose = prop === 'pad' && p.mode === 'stand' ? { ...p, mode: 'sit', moving: false } : p;
  ctx.save();
  ctx.translate(p.x, p.y + FEET);
  ctx.scale(AGENT_SCALE, AGENT_SCALE);
  ctx.translate(0, -FEET);
  const look = agentPalette(a);
  if (p.mode === 'bath' || p.mode === 'shower') drawWashing(ctx, a, look, p.mode, now);
  else {
    if (prop === 'rod') drawRod(ctx, a, now);
    drawBody(ctx, a, look, pose, now);
    if (prop === 'pad') drawPad(ctx, a, now);
    else if (prop === 'cards') drawCards(ctx, a);
  }
  ctx.restore();
  const badge = jointViewOf(a)?.badge;
  if (badge) drawJointBadge(ctx, badge.text, badge.x, badge.y);
}

// ---------------------------------------------------------------- activity props

type Prop = 'pad' | 'cards' | 'rod' | null;

/** what the agent holds, from the activity (icon of the object in use) and the joint game */
function propOf(a: Agent): Prop {
  const act = a.action;
  if (act?.kind !== 'use' || act.phase !== 'using') return null;
  if (act.icon === '🕹️') return 'pad';
  if (act.icon === '🎣') return 'rod';
  if (act.icon === '🎲') return jointViewOf(a)?.game === 'chess' ? null : 'cards';
  return null;
}

/** a game pad held at the chest, thumbs wiggling */
function drawPad(ctx: Ctx, a: Agent, now: number): void {
  const wig = Math.sin(now * 0.02 + a.id * 2) * 0.012;
  const y = 0.13 + wig;
  rr(ctx, -0.15, y - 0.045, 0.3, 0.1, 0.045);
  ctx.fillStyle = '#2b2d3a';
  ctx.fill();
  ctx.lineWidth = 0.015;
  ctx.strokeStyle = '#15161d';
  ctx.stroke();
  circle(ctx, -0.075, y, 0.022);
  ctx.fillStyle = '#9aa3b5';
  ctx.fill();
  for (const [dx, c] of [[0.06, '#e85d5d'], [0.1, '#5dc1e8']] as const) {
    circle(ctx, dx, y - 0.005, 0.017);
    ctx.fillStyle = c;
    ctx.fill();
  }
}

/** a small fan of cards in front of the chest */
function drawCards(ctx: Ctx, a: Agent): void {
  const cx = a.facing * 0.06;
  const cy = 0.08;
  for (let i = -1; i <= 1; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(i * 0.32);
    rr(ctx, -0.04, -0.13, 0.08, 0.12, 0.015);
    ctx.fillStyle = '#fdfcf7';
    ctx.fill();
    ctx.lineWidth = 0.012;
    ctx.strokeStyle = '#8f8a80';
    ctx.stroke();
    circle(ctx, 0, -0.08, 0.016);
    ctx.fillStyle = i === 0 ? '#d23c3c' : '#2a2a2a';
    ctx.fill();
    ctx.restore();
  }
}

/** a fishing rod held out over the water (see joint.noteFishingCast), line and a bobbing float */
function drawRod(ctx: Ctx, a: Agent, now: number): void {
  const f = a.facing;
  const dir = fishingCastOf(a) ?? { x: f, y: 0 };
  const hx = f * 0.16;
  const hy = 0.12;
  // slanted to the facing side when casting straight up / down the screen
  const side = f * 0.35 * (1 - Math.abs(dir.x));
  const tipX = hx + dir.x * 0.75 + side;
  const tipY = hy + dir.y * 0.75 - 0.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.quadraticCurveTo(hx + dir.x * 0.3, hy + dir.y * 0.3 - 0.4, tipX, tipY);
  ctx.strokeStyle = '#6b4a2e';
  ctx.lineWidth = 0.03;
  ctx.stroke();
  const bob = Math.sin(now * 0.004 + a.id * 1.7) * 0.025;
  const fx = hx + dir.x * 1.2 + side * 1.2;
  const fy = hy + dir.y * 1.2 + 0.08 + bob;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(fx, fy);
  ctx.strokeStyle = 'rgba(240,240,240,0.75)';
  ctx.lineWidth = 0.008;
  ctx.stroke();
  ellipse(ctx, fx, fy + 0.03, 0.07, 0.025);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();
  circle(ctx, fx, fy, 0.035);
  ctx.fillStyle = '#e8453c';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(fx, fy, 0.035, 0, Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/** score pill above a group playing together ("🎮 2:1", "🎣 3 ryby"); drawn in world units at a fixed screen size */
export function drawJointBadge(ctx: Ctx, text: string, x: number, y: number): void {
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b) || 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 / k, 1 / k);
  // ~12 css px tall whatever the zoom (k includes the device pixel ratio)
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const size = Math.round(12.5 * Math.min(3, dpr));
  ctx.font = `700 ${size}px ${UI_FONT}, ${EMOJI_FONT}`;
  const w = ctx.measureText(text).width + size * 1.1;
  const h = size * 1.65;
  ctx.shadowColor = 'rgba(20,20,40,0.35)';
  ctx.shadowBlur = size * 0.4;
  ctx.shadowOffsetY = size * 0.08;
  rr(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = 'rgba(255,250,236,0.96)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1, size * 0.1);
  ctx.strokeStyle = '#e0a526';
  ctx.stroke();
  ctx.fillStyle = '#3a2a10';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, size * 0.06);
  ctx.restore();
}

function drawBody(ctx: Ctx, a: Agent, look: AgentLook, p: AgentPose, now: number): void {
  const f = p.facing ?? a.facing;
  const sit = p.mode === 'sit' || p.mode === 'pedal';
  const walking = p.moving || p.mode === 'run';
  const phase = p.mode === 'run' ? now * 0.016 + a.id : p.phase;
  const swing = walking ? Math.sin(phase) : 0;
  // idle breathing: tiny chest rise + head bob
  const breath = Math.sin(now * 0.0024 + a.id * 1.3);
  const bob = walking ? -Math.abs(Math.cos(phase)) * 0.05 : breath * 0.01;
  const drop = sit ? 0.1 : 0;
  const y = drop;

  // shadow
  ellipse(ctx, 0, FEET, sit ? 0.22 : 0.24 - Math.abs(swing) * 0.02, 0.08);
  ctx.fillStyle = 'rgba(30,25,20,0.26)';
  ctx.fill();

  if (sit) {
    // thighs pointing at the viewer + feet
    const pedal = p.mode === 'pedal' ? now * 0.012 + a.id : 0;
    for (const s of [-1, 1]) {
      const lift = p.mode === 'pedal' ? (Math.sin(pedal + (s > 0 ? Math.PI : 0)) + 1) * 0.03 : 0;
      rr(ctx, s * 0.085 - 0.055, 0.1 + y - 0.02, 0.11, 0.12 - lift, 0.05);
      ctx.fillStyle = look.pants;
      ctx.fill();
      ellipse(ctx, s * 0.085, 0.22 + y - lift - 0.02, 0.055, 0.032);
      ctx.fillStyle = '#2b2b30';
      ctx.fill();
    }
  } else {
    const legY = 0.13 + bob * 0.3;
    for (const s of [-1, 1]) {
      const lift = walking ? Math.max(0, s * swing) * 0.07 : 0;
      rr(ctx, s * 0.075 - 0.045, legY, 0.09, 0.15 - lift, 0.04);
      ctx.fillStyle = look.pants;
      ctx.fill();
      ellipse(ctx, s * 0.075 + f * 0.015, legY + 0.15 - lift, 0.055, 0.03);
      ctx.fillStyle = '#2b2b30';
      ctx.fill();
    }
  }

  // long hair / ponytail sits behind the body
  const hy = -0.3 + bob + y;
  drawHair(ctx, look, f, hy, 'back');

  // arms
  for (const s of [-1, 1]) {
    const armSwing = walking ? -s * swing * 0.05 : 0;
    const ay = sit ? 0.05 + y : 0.03 + bob + armSwing + y;
    ellipse(ctx, s * 0.19, ay, 0.055, sit ? 0.085 : 0.1);
    ctx.fillStyle = shade(a.color, -0.12);
    ctx.fill();
    circle(ctx, s * (sit ? 0.16 : 0.2), ay + (sit ? 0.08 : 0.09), 0.04);
    ctx.fillStyle = look.skin;
    ctx.fill();
  }

  // torso (breathing stretches it a hair)
  const th = 0.3 + (walking ? 0 : breath * 0.008);
  rr(ctx, -0.17, -0.12 + bob + y - (th - 0.3), 0.34, th, 0.13);
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = shade(a.color, -0.38);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  rr(ctx, -0.12, -0.09 + bob + y, 0.12, 0.08, 0.04);
  ctx.fill();

  drawHead(ctx, look, f, hy, false);
}

function drawHead(ctx: Ctx, look: AgentLook, f: number, hy: number, closedEyes: boolean): void {
  circle(ctx, 0, hy, 0.175);
  ctx.fillStyle = look.skin;
  ctx.fill();
  ctx.lineWidth = 0.022;
  ctx.strokeStyle = shade(look.skin, -0.32);
  ctx.stroke();
  drawHair(ctx, look, f, hy, 'front');
  // eyes
  if (closedEyes) {
    ctx.strokeStyle = '#3a302a';
    ctx.lineWidth = 0.018;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(f * 0.05 + s * 0.055, hy + 0.02, 0.028, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#2a2420';
    for (const s of [-1, 1]) {
      circle(ctx, f * 0.05 + s * 0.055, hy + 0.03, 0.024);
      ctx.fill();
    }
  }
  // cheeks
  ctx.fillStyle = 'rgba(240,120,110,0.3)';
  for (const s of [-1, 1]) {
    circle(ctx, f * 0.05 + s * 0.09, hy + 0.08, 0.03);
    ctx.fill();
  }
}

function drawHair(ctx: Ctx, look: AgentLook, f: number, hy: number, layer: 'back' | 'front'): void {
  const c = look.hair;
  ctx.fillStyle = c;
  if (layer === 'back') {
    if (look.style === 1) {
      // long hair falling to the shoulders
      rr(ctx, -0.2, hy - 0.08, 0.4, 0.33, 0.14);
      ctx.fill();
    } else if (look.style === 4) {
      // ponytail on the back side
      ellipse(ctx, -f * 0.19, hy + 0.07, 0.07, 0.12);
      ctx.fill();
    }
    return;
  }
  ctx.save();
  circle(ctx, 0, hy, 0.185);
  ctx.clip();
  switch (look.style) {
    case 5: // buzz cut
      ellipse(ctx, -f * 0.02, hy - 0.12, 0.2, 0.09);
      ctx.fill();
      break;
    case 3: // curly
      ellipse(ctx, 0, hy - 0.12, 0.22, 0.11);
      ctx.fill();
      break;
    default: // short cap with a side fringe
      ellipse(ctx, -f * 0.04, hy - 0.1, 0.22, 0.13);
      ctx.fill();
      ellipse(ctx, -f * 0.14, hy - 0.02, 0.07, 0.12);
      ctx.fill();
  }
  ctx.restore();
  if (look.style === 3) {
    for (let i = 0; i < 7; i++) {
      const ang = Math.PI * (1.05 + (i / 6) * 0.9);
      circle(ctx, Math.cos(ang) * 0.16, hy + Math.sin(ang) * 0.15, 0.06);
      ctx.fill();
    }
  } else if (look.style === 2) {
    circle(ctx, 0, hy - 0.2, 0.075);
    ctx.fill();
  }
  // sheen
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ellipse(ctx, f * 0.05, hy - 0.15, 0.07, 0.03);
  ctx.fill();
}

/** in the shower / bathtub only the head (and a bit of shoulders) shows, with steam */
function drawWashing(ctx: Ctx, a: Agent, look: AgentLook, mode: 'bath' | 'shower', now: number): void {
  const t = now / 1000;
  const hy = mode === 'bath' ? -0.02 : -0.18;
  if (mode === 'bath') {
    // shoulders under foamy water
    ellipse(ctx, 0, hy + 0.17, 0.22, 0.08);
    ctx.fillStyle = look.skin;
    ctx.fill();
    for (let i = 0; i < 5; i++) {
      circle(ctx, -0.2 + i * 0.1, hy + 0.2 + Math.sin(t * 2 + i) * 0.01, 0.06);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
    }
  } else {
    ellipse(ctx, 0, hy + 0.2, 0.2, 0.1);
    ctx.fillStyle = look.skin;
    ctx.fill();
    // falling water
    ctx.strokeStyle = 'rgba(140,200,240,0.75)';
    ctx.lineWidth = 0.018;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const x = -0.2 + i * 0.065;
      const k = (t * 1.6 + hash2(i, a.id) ) % 1;
      const y0 = hy - 0.3 + k * 0.55;
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + 0.07);
    }
    ctx.stroke();
  }
  drawHead(ctx, look, a.facing, hy, true);
  // steam puffs
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.35 + i / 3 + a.id * 0.17) % 1;
    const r = 0.06 + k * 0.1;
    circle(ctx, Math.sin(k * 5 + i * 2) * 0.12 + (i - 1) * 0.1, hy - 0.2 - k * 0.45, r);
    ctx.fillStyle = `rgba(255,255,255,${(0.55 * Math.sin(Math.PI * k)).toFixed(3)})`;
    ctx.fill();
  }
}

function drawSleeping(ctx: Ctx, a: Agent, p: AgentPose): void {
  const look = agentPalette(a);
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.bedHorizontal) ctx.rotate(-Math.PI / 2);
  // head on the pillow (towards -y)
  const hy = -0.36;
  if (look.style === 1) {
    ellipse(ctx, 0, hy - 0.04, 0.21, 0.17);
    ctx.fillStyle = look.hair;
    ctx.fill();
  }
  circle(ctx, 0, hy, 0.16);
  ctx.fillStyle = look.skin;
  ctx.fill();
  ctx.lineWidth = 0.02;
  ctx.strokeStyle = shade(look.skin, -0.3);
  ctx.stroke();
  ctx.save();
  circle(ctx, 0, hy, 0.165);
  ctx.clip();
  ellipse(ctx, 0, hy - 0.11, 0.2, 0.1);
  ctx.fillStyle = look.hair;
  ctx.fill();
  ctx.restore();
  // closed eyes
  ctx.strokeStyle = '#3a302a';
  ctx.lineWidth = 0.018;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(s * 0.055, hy + 0.02, 0.03, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
  // body under the blanket, gently breathing
  const breath = Math.sin(performance.now() * 0.0016 + a.id) * 0.012;
  rr(ctx, -0.3 - breath, -0.2, 0.6 + breath * 2, 0.7, 0.16);
  ctx.fillStyle = p.blanket;
  ctx.fill();
  ctx.strokeStyle = shade(p.blanket, -0.3);
  ctx.lineWidth = 0.02;
  ctx.stroke();
  rr(ctx, -0.3 - breath, -0.2, 0.6 + breath * 2, 0.13, 0.06);
  ctx.fillStyle = shade(p.blanket, 0.35);
  ctx.fill();
  ellipse(ctx, 0, 0.12, 0.16, 0.22);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- pets (#9)

export interface PetPose {
  x: number;
  y: number;
  moving: boolean;
  /** walk cycle phase, radians */
  phase: number;
  facing: -1 | 1;
}

/** pet feet below the tile centre (side view) */
const PET_FEET = 0.24;
/** like AGENT_SCALE: a little larger than life so the pet reads next to the residents */
const PET_SCALE = 1.3;
const CAT_COATS = ['#e8913a', '#6f6f78', '#2c2c32', '#f1ede4', '#a8794f', '#b9a58c'];
const DOG_COATS = ['#c99a5c', '#6b4a2e', '#2d2723', '#ece2cf', '#d9b27a', '#a0522d'];

function nameHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** fixed coat colour per species and name */
export function petCoat(pet: Pet): string {
  const coats = pet.species === 'cat' ? CAT_COATS : DOG_COATS;
  return coats[Math.floor(hash2(nameHash(pet.name), pet.species === 'cat' ? 7 : 9, 23) * coats.length)];
}

/** screen-space top of the drawn pet above its tile centre, in tiles (for the name label) */
export function petTop(pet: Pet): number {
  return PET_FEET - (pet.activity === 'sleep' ? 0.3 : pet.species === 'cat' ? 0.44 : 0.42) * PET_SCALE;
}

export function drawPetSelection(ctx: Ctx, p: PetPose, now: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);
  ellipse(ctx, p.x, p.y + PET_FEET, 0.38 + pulse * 0.03, 0.15 + pulse * 0.015);
  ctx.fillStyle = 'rgba(255,214,90,0.3)';
  ctx.fill();
  ctx.lineWidth = 0.045;
  ctx.strokeStyle = '#ffd65a';
  ctx.stroke();
}

/** a cat (~0.45 tile, upright tail, pointy ears) or a dog (~0.55 tile, floppy ears), side view */
export function drawPet(ctx: Ctx, pet: Pet, p: PetPose, now: number): void {
  const coat = petCoat(pet);
  ctx.save();
  ctx.translate(p.x, p.y + PET_FEET);
  ctx.scale(PET_SCALE, PET_SCALE);
  if (pet.activity === 'sleep' && !p.moving) drawPetCurled(ctx, pet, coat, now);
  else drawPetStanding(ctx, pet, coat, p, now);
  ctx.restore();
}

function petEye(ctx: Ctx, x: number, y: number, r: number, closed: boolean): void {
  if (closed) {
    ctx.beginPath();
    ctx.arc(x, y - r * 0.4, r * 1.3, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.strokeStyle = '#2a2420';
    ctx.lineWidth = 0.012;
    ctx.stroke();
    return;
  }
  circle(ctx, x, y, r);
  ctx.fillStyle = '#1e1a18';
  ctx.fill();
  circle(ctx, x + r * 0.3, y - r * 0.35, r * 0.35);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawPetStanding(ctx: Ctx, pet: Pet, coat: string, p: PetPose, now: number): void {
  const cat = pet.species === 'cat';
  const f = p.facing;
  const dark = shade(coat, -0.35);
  const belly = shade(coat, 0.3);
  const swing = p.moving ? Math.sin(p.phase) : 0;
  const t = now / 1000 + pet.id;
  // playing: little hops; eating: head down at the bowl
  const hop = pet.activity === 'play' && !p.moving ? -Math.abs(Math.sin(t * 6)) * 0.05 : 0;
  const bob = p.moving ? -Math.abs(Math.cos(p.phase)) * 0.02 : 0;
  const eating = pet.activity === 'eat' && !p.moving;
  const len = cat ? 0.17 : 0.2;
  const legH = cat ? 0.1 : 0.12;
  const bodyY = -legH - (cat ? 0.06 : 0.07) + bob;

  ellipse(ctx, 0, 0, len + 0.03, 0.05);
  ctx.fillStyle = 'rgba(30,25,20,0.24)';
  ctx.fill();
  ctx.translate(0, hop);

  // tail (behind the body)
  const tailX = -f * len * 0.9;
  const tailY = bodyY - 0.02;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  if (cat) {
    const sway = Math.sin(t * 1.6) * 0.05 + swing * 0.03;
    ctx.bezierCurveTo(tailX - f * 0.12, tailY - 0.02, tailX - f * 0.08 + sway, tailY - 0.2, tailX - f * 0.02 + sway, tailY - 0.24);
  } else {
    // wagging, faster when happy or busy with someone
    const wag = Math.sin(t * (pet.mood > 60 || pet.withId !== null ? 14 : 4)) * 0.05;
    ctx.quadraticCurveTo(tailX - f * 0.1, tailY - 0.04, tailX - f * 0.12 + wag, tailY - 0.14);
  }
  ctx.strokeStyle = dark;
  ctx.lineWidth = cat ? 0.05 : 0.055;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = coat;
  ctx.lineWidth = cat ? 0.03 : 0.035;
  ctx.stroke();

  // legs: far pair darker, near pair in front; diagonal pairs swing together
  for (const [k, far] of [[0, true], [1, true], [0, false], [1, false]] as const) {
    const lx = (k === 0 ? -1 : 1) * len * 0.62 + (far ? f * 0.025 : -f * 0.01);
    const s = (k === 0) === far ? swing : -swing;
    const lift = Math.max(0, s) * 0.03;
    ctx.save();
    ctx.translate(lx, bodyY + 0.03);
    ctx.rotate(s * 0.35);
    rr(ctx, -0.022, 0, 0.044, -bodyY - 0.03 - lift, 0.02);
    ctx.fillStyle = far ? dark : coat;
    ctx.fill();
    ctx.restore();
  }

  // body
  ellipse(ctx, 0, bodyY, len, cat ? 0.075 : 0.09);
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.lineWidth = 0.018;
  ctx.strokeStyle = dark;
  ctx.stroke();
  ellipse(ctx, f * 0.02, bodyY + 0.035, len * 0.6, 0.03);
  ctx.fillStyle = withAlpha(belly, 0.7);
  ctx.fill();
  if (cat && (coat === '#e8913a' || coat === '#a8794f' || coat === '#6f6f78')) {
    // tabby stripes
    ctx.strokeStyle = withAlpha(dark, 0.55);
    ctx.lineWidth = 0.016;
    for (const dx of [-0.07, 0, 0.07]) {
      ctx.beginPath();
      ctx.moveTo(dx - 0.015, bodyY - 0.07);
      ctx.lineTo(dx + 0.01, bodyY - 0.02);
      ctx.stroke();
    }
  }

  // head
  const hr = cat ? 0.085 : 0.095;
  const hx = f * (len + (cat ? 0.02 : 0.04));
  const hy = eating ? bodyY + 0.06 : bodyY - (cat ? 0.09 : 0.08) + (p.moving ? 0 : Math.sin(t * 1.3) * 0.006);
  if (cat) {
    // pointy ears
    for (const s of [-1, 1]) {
      const ex = hx + s * 0.045 + f * 0.005;
      ctx.beginPath();
      ctx.moveTo(ex - 0.035, hy - 0.05);
      ctx.lineTo(ex + s * 0.01, hy - 0.13);
      ctx.lineTo(ex + 0.035, hy - 0.05);
      ctx.closePath();
      ctx.fillStyle = coat;
      ctx.fill();
      ctx.lineWidth = 0.014;
      ctx.strokeStyle = dark;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex - 0.016, hy - 0.06);
      ctx.lineTo(ex + s * 0.008, hy - 0.105);
      ctx.lineTo(ex + 0.016, hy - 0.06);
      ctx.closePath();
      ctx.fillStyle = '#f2a7a7';
      ctx.fill();
    }
  }
  circle(ctx, hx, hy, hr);
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.lineWidth = 0.018;
  ctx.strokeStyle = dark;
  ctx.stroke();
  if (!cat) {
    // snout + nose
    ellipse(ctx, hx + f * 0.075, hy + 0.025, 0.05, 0.038);
    ctx.fillStyle = belly;
    ctx.fill();
    circle(ctx, hx + f * 0.118, hy + 0.012, 0.018);
    ctx.fillStyle = '#231d1a';
    ctx.fill();
    // floppy ear hanging at the back of the head
    ellipse(ctx, hx - f * 0.035, hy + 0.02, 0.035, 0.07);
    ctx.fillStyle = dark;
    ctx.fill();
  } else {
    circle(ctx, hx + f * 0.06, hy + 0.025, 0.012);
    ctx.fillStyle = '#e88a8a';
    ctx.fill();
    // whiskers
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 0.007;
    for (const dy of [0.015, 0.04]) {
      ctx.beginPath();
      ctx.moveTo(hx + f * 0.05, hy + 0.03);
      ctx.lineTo(hx + f * 0.14, hy + dy);
      ctx.stroke();
    }
  }
  petEye(ctx, hx + f * (cat ? 0.035 : 0.04), hy - 0.015, 0.016, eating);
}

/** asleep on the cushion: curled up, tail around the nose, breathing */
function drawPetCurled(ctx: Ctx, pet: Pet, coat: string, now: number): void {
  const cat = pet.species === 'cat';
  const dark = shade(coat, -0.35);
  const breath = Math.sin(now * 0.0018 + pet.id) * 0.008;
  const rx = (cat ? 0.17 : 0.2) + breath;
  const ry = (cat ? 0.11 : 0.12) + breath;
  const cy = -ry;
  ellipse(ctx, 0, 0, rx + 0.02, 0.05);
  ctx.fillStyle = 'rgba(30,25,20,0.2)';
  ctx.fill();
  ellipse(ctx, 0, cy, rx, ry);
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.lineWidth = 0.018;
  ctx.strokeStyle = dark;
  ctx.stroke();
  // fold of the back
  ctx.beginPath();
  ctx.arc(0.02, cy + 0.02, rx * 0.6, 1.1 * Math.PI, 1.75 * Math.PI);
  ctx.strokeStyle = withAlpha(dark, 0.6);
  ctx.lineWidth = 0.014;
  ctx.stroke();
  // head tucked in on the left, tail wrapped along the front
  const hx = -rx * 0.45;
  const hy = cy + 0.02;
  if (cat)
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hx + s * 0.04 - 0.025, hy - 0.04);
      ctx.lineTo(hx + s * 0.05, hy - 0.11);
      ctx.lineTo(hx + s * 0.04 + 0.025, hy - 0.04);
      ctx.closePath();
      ctx.fillStyle = coat;
      ctx.fill();
      ctx.lineWidth = 0.012;
      ctx.strokeStyle = dark;
      ctx.stroke();
    }
  circle(ctx, hx, hy, cat ? 0.075 : 0.085);
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.lineWidth = 0.016;
  ctx.strokeStyle = dark;
  ctx.stroke();
  if (!cat) {
    ellipse(ctx, hx + 0.06, hy + 0.01, 0.03, 0.06);
    ctx.fillStyle = dark;
    ctx.fill();
  }
  for (const s of [-1, 1]) petEye(ctx, hx + s * 0.03, hy + 0.005, 0.012, true);
  ctx.beginPath();
  ctx.moveTo(rx * 0.85, cy + 0.04);
  ctx.quadraticCurveTo(rx * 0.6, cy + ry + 0.02, hx + 0.03, cy + ry * 0.8);
  ctx.strokeStyle = dark;
  ctx.lineWidth = cat ? 0.05 : 0.045;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.strokeStyle = coat;
  ctx.lineWidth = cat ? 0.03 : 0.028;
  ctx.stroke();
}
