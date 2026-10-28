// 2D camera: centre in tile units + zoom in CSS pixels per tile.

import type { Vec2 } from '../types';

export class Camera {
  cx = 0;
  cy = 0;
  /** CSS pixels per tile */
  zoom = 32;
  viewW = 1;
  viewH = 1;
  minZoom = 6;
  maxZoom = 160;
  mapW = 1;
  mapH = 1;

  setMap(w: number, h: number): void {
    this.mapW = w;
    this.mapH = h;
  }

  /** fit the whole map into the viewport with a margin (CSS px) */
  fit(margin = 32): void {
    const zx = (this.viewW - margin * 2) / this.mapW;
    const zy = (this.viewH - margin * 2) / this.mapH;
    const z = Math.max(4, Math.min(zx, zy));
    this.minZoom = Math.max(4, z * 0.6);
    this.zoom = z;
    this.cx = (this.mapW - 1) / 2;
    this.cy = (this.mapH - 1) / 2;
  }

  /** keeps the zoom range sensible after a resize without re-fitting */
  updateLimits(margin = 32): void {
    const z = Math.min((this.viewW - margin * 2) / this.mapW, (this.viewH - margin * 2) / this.mapH);
    this.minZoom = Math.max(4, z * 0.6);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
  }

  toScreen(wx: number, wy: number): Vec2 {
    return { x: (wx - this.cx) * this.zoom + this.viewW / 2, y: (wy - this.cy) * this.zoom + this.viewH / 2 };
  }

  toWorld(sx: number, sy: number): Vec2 {
    return { x: (sx - this.viewW / 2) / this.zoom + this.cx, y: (sy - this.viewH / 2) / this.zoom + this.cy };
  }

  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.zoom;
    this.cy -= dy / this.zoom;
    this.clamp();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.clamp();
  }

  clamp(): void {
    this.cx = Math.max(-0.5, Math.min(this.mapW - 0.5, this.cx));
    this.cy = Math.max(-0.5, Math.min(this.mapH - 0.5, this.cy));
  }
}
