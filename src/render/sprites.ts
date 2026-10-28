// Character sprites, drawn procedurally in world (tile) units.

import type { Agent } from '../types';
import { circle, ellipse, hash2, rr, shade } from './colors';

type Ctx = CanvasRenderingContext2D;

const SKINS = ['#f6d5bd', '#eec3a1', '#dcaa84', '#b98260', '#8f5d3f', '#f3c9a8'];
const HAIRS = ['#3a2a20', '#6b4630', '#c8954f', '#222326', '#9c4a2a', '#e2c47a', '#7b7f86', '#4d2f22'];
const PANTS = ['#3d4a66', '#4b4f58', '#5a4636', '#2f5d62', '#47506b'];

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
}

export function agentPalette(a: Agent): { skin: string; hair: string; pants: string } {
  return {
    skin: SKINS[Math.floor(hash2(a.id, 1, 17) * SKINS.length)],
    hair: HAIRS[Math.floor(hash2(a.id, 2, 17) * HAIRS.length)],
    pants: PANTS[Math.floor(hash2(a.id, 3, 17) * PANTS.length)],
  };
}

export function drawSelection(ctx: Ctx, p: AgentPose, now: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);
  ellipse(ctx, p.x, p.y + 0.28, 0.4 + pulse * 0.04, 0.17 + pulse * 0.02);
  ctx.fillStyle = 'rgba(255,214,90,0.28)';
  ctx.fill();
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = '#ffd65a';
  ctx.stroke();
  ellipse(ctx, p.x, p.y + 0.28, 0.48 + pulse * 0.05, 0.21 + pulse * 0.03);
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = `rgba(255,255,255,${0.35 + pulse * 0.4})`;
  ctx.stroke();
}

export function drawAgent(ctx: Ctx, a: Agent, p: AgentPose, now: number): void {
  if (p.sleeping) return drawSleeping(ctx, a, p);
  const pal = agentPalette(a);
  const f = a.facing;
  const swing = p.moving ? Math.sin(p.phase) : 0;
  const bob = p.moving ? -Math.abs(Math.cos(p.phase)) * 0.05 : Math.sin(now * 0.0025 + a.id) * 0.008;
  const x = p.x;
  const y = p.y;

  // shadow
  ellipse(ctx, x, y + 0.29, 0.25 - (p.moving ? Math.abs(swing) * 0.02 : 0), 0.085);
  ctx.fillStyle = 'rgba(30,25,20,0.25)';
  ctx.fill();

  // legs
  const legY = y + 0.13 + bob * 0.3;
  for (const s of [-1, 1]) {
    const lift = p.moving ? Math.max(0, s * swing) * 0.07 : 0;
    rr(ctx, x + s * 0.075 - 0.045, legY, 0.09, 0.15 - lift, 0.04);
    ctx.fillStyle = pal.pants;
    ctx.fill();
    ellipse(ctx, x + s * 0.075 + f * 0.015, legY + 0.15 - lift, 0.055, 0.03);
    ctx.fillStyle = '#2b2b30';
    ctx.fill();
  }

  // arms (behind/next to the body)
  for (const s of [-1, 1]) {
    const armSwing = p.moving ? -s * swing * 0.05 : 0;
    ellipse(ctx, x + s * 0.19, y + 0.03 + bob + armSwing, 0.055, 0.1);
    ctx.fillStyle = shade(a.color, -0.12);
    ctx.fill();
    circle(ctx, x + s * 0.2, y + 0.12 + bob + armSwing, 0.04);
    ctx.fillStyle = pal.skin;
    ctx.fill();
  }

  // torso
  rr(ctx, x - 0.17, y - 0.12 + bob, 0.34, 0.3, 0.13);
  ctx.fillStyle = a.color;
  ctx.fill();
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = shade(a.color, -0.35);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  rr(ctx, x - 0.12, y - 0.09 + bob, 0.12, 0.08, 0.04);
  ctx.fill();

  // head
  const hy = y - 0.3 + bob;
  circle(ctx, x, hy, 0.175);
  ctx.fillStyle = pal.skin;
  ctx.fill();
  ctx.lineWidth = 0.022;
  ctx.strokeStyle = shade(pal.skin, -0.3);
  ctx.stroke();
  // hair cap
  ctx.save();
  circle(ctx, x, hy, 0.18);
  ctx.clip();
  ellipse(ctx, x - f * 0.04, hy - 0.1, 0.22, 0.13);
  ctx.fillStyle = pal.hair;
  ctx.fill();
  ellipse(ctx, x - f * 0.14, hy - 0.02, 0.07, 0.12);
  ctx.fill();
  ctx.restore();
  // eyes
  ctx.fillStyle = '#2a2420';
  for (const s of [-1, 1]) {
    circle(ctx, x + f * 0.05 + s * 0.055, hy + 0.025, 0.022);
    ctx.fill();
  }
  // cheeks
  ctx.fillStyle = 'rgba(240,120,110,0.28)';
  for (const s of [-1, 1]) {
    circle(ctx, x + f * 0.05 + s * 0.09, hy + 0.075, 0.03);
    ctx.fill();
  }
}

function drawSleeping(ctx: Ctx, a: Agent, p: AgentPose): void {
  const pal = agentPalette(a);
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.bedHorizontal) ctx.rotate(-Math.PI / 2);
  // head on the pillow (towards -y)
  const hy = -0.36;
  circle(ctx, 0, hy, 0.16);
  ctx.fillStyle = pal.skin;
  ctx.fill();
  ctx.lineWidth = 0.02;
  ctx.strokeStyle = shade(pal.skin, -0.3);
  ctx.stroke();
  ctx.save();
  circle(ctx, 0, hy, 0.165);
  ctx.clip();
  ellipse(ctx, 0, hy - 0.11, 0.2, 0.1);
  ctx.fillStyle = pal.hair;
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
  // body under the blanket
  rr(ctx, -0.3, -0.2, 0.6, 0.7, 0.16);
  ctx.fillStyle = p.blanket;
  ctx.fill();
  ctx.strokeStyle = shade(p.blanket, -0.3);
  ctx.lineWidth = 0.02;
  ctx.stroke();
  rr(ctx, -0.3, -0.2, 0.6, 0.13, 0.06);
  ctx.fillStyle = shade(p.blanket, 0.35);
  ctx.fill();
  ellipse(ctx, 0, 0.12, 0.16, 0.22);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  ctx.restore();
}
