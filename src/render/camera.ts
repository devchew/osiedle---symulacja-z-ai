// 2D camera: centre in tile units + zoom in CSS pixels per tile.
// Zoom can be animated: zoomAt() sets a target that update(dt) eases towards,
// keeping the world point under the anchor fixed on screen.

import type { RectArea, Vec2 } from '../types';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

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
  private targetZoom: number | null = null;
  private anchor: Vec2 = { x: 0, y: 0 };

  setMap(w: number, h: number): void {
    this.mapW = w;
    this.mapH = h;
  }

  /**
   * Fits `area` (tile rect; default = whole map) into the viewport minus the
   * given insets (CSS px), centring it in the remaining space.
   */
  fit(insets: Insets, area?: RectArea): void {
    const a = area ?? { x: 0, y: 0, w: this.mapW, h: this.mapH };
    const availW = Math.max(40, this.viewW - insets.left - insets.right);
    const availH = Math.max(40, this.viewH - insets.top - insets.bottom);
    const z = Math.max(4, Math.min(availW / a.w, availH / a.h));
    this.updateLimits();
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    this.targetZoom = null;
    // centre of the area lands on the centre of the free rect
    const freeCx = insets.left + availW / 2;
    const freeCy = insets.top + availH / 2;
    const areaCx = a.x - 0.5 + a.w / 2;
    const areaCy = a.y - 0.5 + a.h / 2;
    this.cx = areaCx - (freeCx - this.viewW / 2) / this.zoom;
    this.cy = areaCy - (freeCy - this.viewH / 2) / this.zoom;
    this.clamp();
  }

  /** keeps the zoom range sensible after a resize without re-fitting */
  updateLimits(margin = 24): void {
    const z = Math.min((this.viewW - margin * 2) / this.mapW, (this.viewH - margin * 2) / this.mapH);
    this.minZoom = Math.max(4, z * 0.7);
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

  /** immediate zoom around a screen point (pinch) */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.targetZoom = null;
    this.setZoomKeeping(sx, sy, this.zoom * factor);
  }

  /** animated zoom around a screen point (wheel); successive calls accumulate */
  zoomSmooth(sx: number, sy: number, factor: number): void {
    const base = this.targetZoom ?? this.zoom;
    this.targetZoom = Math.max(this.minZoom, Math.min(this.maxZoom, base * factor));
    this.anchor = { x: sx, y: sy };
  }

  /** advances the zoom animation (instant when `instant`); returns true while animating */
  update(dt: number, instant = false): boolean {
    if (this.targetZoom === null) return false;
    const k = instant ? 1 : 1 - Math.exp(-dt * 14);
    const next = this.zoom + (this.targetZoom - this.zoom) * k;
    if (Math.abs(next - this.targetZoom) < 0.01) {
      this.setZoomKeeping(this.anchor.x, this.anchor.y, this.targetZoom);
      this.targetZoom = null;
      return false;
    }
    this.setZoomKeeping(this.anchor.x, this.anchor.y, next);
    return true;
  }

  private setZoomKeeping(sx: number, sy: number, zoom: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
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
