// Character sprites, drawn procedurally in world (tile) units.
// The figure is designed around its feet at (x, y + FEET) and scaled by
// AGENT_SCALE so characters stay readable at the fitted zoom.

import type { Agent } from '../types';
import { circle, ellipse, hash2, rr, shade } from './colors';

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
  ctx.save();
  ctx.translate(p.x, p.y + FEET);
  ctx.scale(AGENT_SCALE, AGENT_SCALE);
  ctx.translate(0, -FEET);
  const look = agentPalette(a);
  if (p.mode === 'bath' || p.mode === 'shower') drawWashing(ctx, a, look, p.mode, now);
  else drawBody(ctx, a, look, p, now);
  ctx.restore();
}

function drawBody(ctx: Ctx, a: Agent, look: AgentLook, p: AgentPose, now: number): void {
  const f = a.facing;
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
