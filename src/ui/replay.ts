import './ui.css';
import { formatClock, timeFromTick } from '../core/time';
import type { World } from '../types';
import { el, setText } from './dom';

// Rebuilds a saved state by replaying ticks headlessly. Runs in time-boxed
// chunks and yields to the browser between them, so the progress overlay
// animates and the page stays responsive.

export interface ReplayOptions {
  /** advances the world by one tick (main's tick function: world + UI samplers) */
  step(): void;
  /** where the overlay goes; no overlay if omitted */
  parent?: HTMLElement;
  /** ms of simulation per chunk */
  budgetMs?: number;
}

/** small overlay is only shown for replays that take a noticeable moment */
const OVERLAY_MIN_TICKS = 1500;

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function replayTo(world: World, target: number, opts: ReplayOptions): Promise<void> {
  const start = world.tick;
  const total = target - start;
  if (total <= 0) return;
  const budget = opts.budgetMs ?? 24;

  let overlay: HTMLElement | null = null;
  let fill: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let pct: HTMLElement | null = null;
  if (opts.parent && total >= OVERLAY_MIN_TICKS) {
    fill = el('div', 'replay-fill');
    label = el('span', 'replay-time');
    pct = el('span', 'replay-pct');
    const t = timeFromTick(target);
    overlay = el('div', 'ui-panel replay-overlay', [
      el('div', 'replay-title', ['⏳ Odtwarzanie symulacji…']),
      el('div', 'replay-sub', [`Cel: dzień ${t.day}, ${formatClock(t)}`]),
      el('div', 'replay-bar', [fill]),
      el('div', 'replay-meta', [label, pct]),
    ]);
    overlay.setAttribute('role', 'progressbar');
    overlay.setAttribute('aria-label', 'Odtwarzanie zapisu');
    overlay.setAttribute('aria-valuemin', '0');
    overlay.setAttribute('aria-valuemax', '100');
    opts.parent.append(overlay);
  }

  try {
    while (world.tick < target) {
      const t0 = performance.now();
      // check the clock every 50 ticks: a tick costs well under a millisecond
      do {
        for (let i = 0; i < 50 && world.tick < target; i++) opts.step();
      } while (world.tick < target && performance.now() - t0 < budget);
      if (overlay) {
        const p = Math.round(((world.tick - start) / total) * 100);
        fill!.style.width = `${p}%`;
        const t = timeFromTick(world.tick);
        setText(label!, `Dzień ${t.day}, ${formatClock(t)}`);
        setText(pct!, `${p}%`);
        overlay.setAttribute('aria-valuenow', String(p));
      }
      if (world.tick < target) await yieldToBrowser();
    }
  } finally {
    overlay?.remove();
  }
}
