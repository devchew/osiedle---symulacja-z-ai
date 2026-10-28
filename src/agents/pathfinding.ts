import type { Grid, Vec2 } from '../types';

export interface PathOptions {
  /** extra blocked tiles (e.g. other agents); never applied to the start tile */
  extraBlocked?: (x: number, y: number) => boolean;
  /** max expanded nodes before giving up (returns null) */
  maxNodes?: number;
}

const SQRT2 = Math.SQRT2;
const DIRS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** min-heap of node indices keyed by f (lazy deletion of stale entries) */
class Heap {
  private idx: number[] = [];
  private key: number[] = [];
  get size(): number { return this.idx.length; }
  push(i: number, k: number): void {
    this.idx.push(i); this.key.push(k);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      this.swap(c, p); c = p;
    }
  }
  pop(): number {
    const top = this.idx[0];
    const li = this.idx.pop()!, lk = this.key.pop()!;
    if (this.idx.length > 0) {
      this.idx[0] = li; this.key[0] = lk;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < this.idx.length && this.key[l] < this.key[m]) m = l;
        if (r < this.idx.length && this.key[r] < this.key[m]) m = r;
        if (m === p) break;
        this.swap(p, m); p = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
    [this.key[a], this.key[b]] = [this.key[b], this.key[a]];
  }
}

const inB = (g: Grid, x: number, y: number): boolean => x >= 0 && y >= 0 && x < g.width && y < g.height;

/** A* over tiles, 8-neighbourhood without corner cutting. Path excludes start, includes goal. */
export function findPath(grid: Grid, from: Vec2, to: Vec2, opts: PathOptions = {}): Vec2[] | null {
  const sx = Math.round(from.x), sy = Math.round(from.y);
  const gx = Math.round(to.x), gy = Math.round(to.y);
  if (!inB(grid, sx, sy) || !inB(grid, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];
  const W = grid.width;
  const start = sy * W + sx, goal = gy * W + gx;
  const extra = opts.extraBlocked;
  const maxNodes = opts.maxNodes ?? 5000;
  const blocked = (x: number, y: number): boolean => {
    if (!inB(grid, x, y)) return true;
    const i = y * W + x;
    if (i === start) return false;
    return grid.solid[i] || (extra !== undefined && extra(x, y));
  };
  if (blocked(gx, gy)) return null;

  const h = (x: number, y: number): number => {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };
  const n = W * grid.height;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap();
  g[start] = 0;
  heap.push(start, h(sx, sy));
  let expanded = 0;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    if (cur === goal) {
      const path: Vec2[] = [];
      for (let i = goal; i !== start; i = parent[i]) path.push({ x: i % W, y: Math.floor(i / W) });
      return path.reverse();
    }
    closed[cur] = 1;
    if (++expanded > maxNodes) return null;
    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (blocked(nx, ny)) continue;
      const diag = dx !== 0 && dy !== 0;
      if (diag && (blocked(cx + dx, cy) || blocked(cx, cy + dy))) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      const ng = g[cur] + (diag ? SQRT2 : 1);
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur;
        heap.push(ni, ng + h(nx, ny));
      }
    }
  }
  return null;
}

/** nearest in-bounds non-solid tile to p (BFS from the rounded, clamped position) */
export function nearestWalkable(grid: Grid, p: Vec2): Vec2 | null {
  const W = grid.width, H = grid.height;
  if (W <= 0 || H <= 0) return null;
  const x0 = Math.min(W - 1, Math.max(0, Math.round(p.x)));
  const y0 = Math.min(H - 1, Math.max(0, Math.round(p.y)));
  const seen = new Uint8Array(W * H);
  const queue = [y0 * W + x0];
  seen[queue[0]] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (!grid.solid[i]) return { x: i % W, y: Math.floor(i / W) };
    const x = i % W, y = Math.floor(i / W);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inB(grid, nx, ny)) continue;
      const ni = ny * W + nx;
      if (!seen[ni]) { seen[ni] = 1; queue.push(ni); }
    }
  }
  return null;
}
