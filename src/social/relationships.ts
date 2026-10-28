import type { Relationships } from '../types';

export const REL_MIN = -100;
export const REL_MAX = 100;

const clamp = (v: number): number => Math.max(REL_MIN, Math.min(REL_MAX, v));
const keyOf = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** symmetric sympathy store; a pair of the same agent is always 0 and never stored */
export function createRelationships(): Relationships {
  const values = new Map<string, number>();
  return {
    get(a, b) {
      if (a === b) return 0;
      return values.get(keyOf(a, b)) ?? 0;
    },
    adjust(a, b, delta) {
      if (a === b || !Number.isFinite(delta)) return this.get(a, b);
      const key = keyOf(a, b);
      const next = clamp((values.get(key) ?? 0) + delta);
      values.set(key, next);
      return next;
    },
    all() {
      const out: { a: number; b: number; value: number }[] = [];
      for (const [key, value] of values) {
        const [a, b] = key.split(':').map(Number);
        out.push({ a, b, value });
      }
      return out.sort((x, y) => x.a - y.a || x.b - y.b);
    },
  };
}

/** Polish label for a sympathy value (-100..100) */
export function relationshipLabel(v: number): string {
  if (v <= -60) return 'wrogowie';
  if (v <= -25) return 'nie przepadają za sobą';
  if (v < -5) return 'chłodna znajomość';
  if (v < 15) return 'znajomi';
  if (v < 40) return 'koledzy';
  if (v < 75) return 'przyjaciele';
  return 'najlepsi przyjaciele';
}
