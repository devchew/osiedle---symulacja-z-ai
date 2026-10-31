import './director.css';
import type { View } from './view';
import { el, isTypingTarget, setText, storageGet, storageSet } from './dom';
import { collectMoments, createDirector, directorConfig, type Director, type Moment } from './directorScore';

// Director mode (live view): the camera moves on its own to the most interesting moment of the
// place (see directorScore.ts). Off by default, toggled from the HUD or with R; the choice is
// remembered. Moves are smooth (instant with prefers-reduced-motion, which also halves the cuts).
// Touching the camera yourself (drag, wheel, pan / zoom keys, picking a resident) pauses the mode
// for a while, then it carries on.

const STORAGE_KEY = 'sim.director';
const TICK_MS = 1000;
const ZOOM_PEOPLE = 46;
const ZOOM_SITE = 34;
const CAMERA_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Equal', 'Minus', 'BracketLeft', 'BracketRight']);

export interface DirectorMode {
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  toggle(): void;
  /** another place is shown: forget the current moment */
  reset(): void;
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createDirectorMode(opts: { view(): View | null; onChange?(on: boolean): void }): DirectorMode {
  let enabled = false;
  let director: Director = createDirector(directorConfig(reducedMotion()));
  let timer: number | undefined;
  /** agent the director asked the renderer to follow (any other value means the viewer took over) */
  let following: number | null = null;

  const caption = el('div', 'director-caption');
  caption.hidden = true;
  caption.setAttribute('aria-hidden', 'true');
  document.body.append(caption);

  function interrupt(): void {
    if (!enabled) return;
    director.interrupt(performance.now());
    following = null;
    refreshCaption();
  }

  const canvas = document.getElementById('world');
  canvas?.addEventListener('pointerdown', interrupt);
  canvas?.addEventListener('wheel', interrupt, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || e.repeat) return;
    if (e.code === 'KeyR') toggle();
    else if (CAMERA_KEYS.has(e.code)) interrupt();
  });

  function refreshCaption(): void {
    const now = performance.now();
    caption.hidden = !enabled;
    if (!enabled) return;
    const paused = director.paused(now);
    caption.classList.toggle('is-paused', paused);
    setText(caption, paused ? '🎬 Wstrzymano — kamera wróci po chwili bez ruchu' : director.current ? `🎬 ${director.current.label}` : '🎬 Tryb reżysera: brak ciekawych wydarzeń');
  }

  function show(m: Moment, view: View): void {
    if (m.agentId !== undefined) {
      view.renderer.follow(m.agentId);
      following = m.agentId;
    } else {
      view.renderer.focusOn(m.pos);
      following = null;
    }
    view.renderer.zoomTo(m.agentId !== undefined ? ZOOM_PEOPLE : ZOOM_SITE);
  }

  function step(): void {
    const view = opts.view();
    if (!enabled || !view) return;
    // the viewer started following someone else (inspector button, resident list) or stopped following
    if (following !== null && view.renderer.following !== following) interrupt();
    const m = director.step(collectMoments(view.world), performance.now());
    if (m) show(m, view);
    refreshCaption();
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    storageSet(STORAGE_KEY, on ? '1' : '0');
    opts.view()?.hud.setActive('director', on);
    if (on) {
      director = createDirector(directorConfig(reducedMotion()));
      timer = window.setInterval(step, TICK_MS);
      step();
    } else {
      window.clearInterval(timer);
      if (following !== null) opts.view()?.renderer.follow(null);
      following = null;
    }
    refreshCaption();
    opts.onChange?.(on);
  }

  function toggle(): void {
    setEnabled(!enabled);
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled,
    toggle,
    reset() {
      director.reset();
      following = null;
      refreshCaption();
    },
  };
}

/** the remembered choice (off unless the viewer turned it on before) */
export function directorPreference(): boolean {
  return storageGet(STORAGE_KEY) === '1';
}
