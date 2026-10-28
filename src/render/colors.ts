// Small colour + drawing helpers shared by the render modules.

export type RGB = [number, number, number];

const cache = new Map<string, RGB>();
let probe: CanvasRenderingContext2D | null = null;

function parseHex(s: string): RGB | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** parses any CSS colour (hex fast path, otherwise via a 2D context) */
export function parseColor(c: string): RGB {
  const hit = cache.get(c);
  if (hit) return hit;
  let rgb = parseHex(c);
  if (!rgb) {
    if (!probe && typeof document !== 'undefined') probe = document.createElement('canvas').getContext('2d');
    rgb = [128, 128, 128];
    if (probe) {
      probe.fillStyle = '#808080';
      probe.fillStyle = c;
      const s = String(probe.fillStyle);
      const hex = parseHex(s);
      if (hex) rgb = hex;
      else {
        const nums = s.match(/[\d.]+/g);
        if (nums && nums.length >= 3) rgb = [Number(nums[0]), Number(nums[1]), Number(nums[2])];
      }
    }
  }
  cache.set(c, rgb);
  return rgb;
}

const toHex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

export function rgbStr(c: RGB): string {
  return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
}

/** amt > 0 lightens towards white, amt < 0 darkens towards black (|amt| <= 1) */
export function shade(c: string, amt: number): string {
  const [r, g, b] = parseColor(c);
  if (amt >= 0) return rgbStr([r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt]);
  const k = 1 + amt;
  return rgbStr([r * k, g * k, b * k]);
}

export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return rgbStr([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

export function withAlpha(c: string, a: number): string {
  const [r, g, b] = parseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** deterministic hash of integer coordinates to [0, 1) */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

export function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
}

export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
