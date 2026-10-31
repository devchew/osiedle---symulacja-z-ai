import type { World } from '../types';
import { timeFromTick } from '../core/time';
import { weatherOf } from '../world/incidents';
import { newEffects, soundMix } from '../audio/mix';
import { createSoundEngine, soundSupported, type SoundEngine } from '../audio/engine';
import type { HudButton } from './hud';
import { isTypingTarget, storageGet, storageSet } from './dom';

// Sound toggle (#13): off by default, remembered in localStorage, M key. The audio starts only after a
// user gesture (the click / key press); a remembered "on" waits for the first gesture on the page.
// The view feeds it the world at 5 Hz; the actual mapping lives in audio/mix.ts, the synthesis in audio/engine.ts.

const STORAGE_KEY = 'sim.sound';
const ID = 'sound';

export interface SoundUi {
  /** HUD button; null when the browser has no Web Audio */
  readonly button: HudButton | null;
  /** call once the HUD exists: syncs the button with the stored preference */
  attach(setActive: (id: string, active: boolean) => void): void;
  update(world: World): void;
  /** another scene (place): effects of the new world start fresh */
  reset(): void;
}

export function createSoundUi(): SoundUi {
  if (!soundSupported()) return { button: null, attach() {}, update() {}, reset() {} };

  const engine: SoundEngine = createSoundEngine();
  let enabled = storageGet(STORAGE_KEY) === '1';
  let seen: Map<number, number> | null = null;
  let setActive: ((id: string, active: boolean) => void) | null = null;

  const icon = (): HTMLElement | null => document.querySelector(`.hud-${ID}-btn`);
  const render = (): void => {
    setActive?.(ID, enabled);
    const btn = icon();
    if (btn) btn.textContent = enabled ? '🔊' : '🔇';
  };

  function set(on: boolean): void {
    enabled = on;
    storageSet(STORAGE_KEY, on ? '1' : '0');
    if (on) engine.start();
    else {
      engine.stop();
      seen = null;
    }
    render();
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || isTypingTarget(e)) return;
    set(!enabled);
  });

  // autoplay policy: a remembered "on" starts with the first gesture
  if (enabled) {
    const resume = (): void => {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      if (enabled) engine.start();
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  return {
    button: { id: ID, icon: '🔇', title: 'Dźwięk (M)', onClick: () => set(!enabled) },
    attach(fn) {
      setActive = fn;
      render();
    },
    update(world) {
      if (!enabled || !engine.running) return;
      const w = weatherOf(world);
      engine.setMix(soundMix({ daylight: timeFromTick(world.tick).daylight, weather: w.kind, intensity: w.intensity }));
      const found = newEffects(seen, world.agents, (uid) => world.objects.find((o) => o.uid === uid)?.type);
      seen = found.next;
      for (const fx of found.effects) engine.play(fx);
    },
    reset() {
      seen = null;
    },
  };
}
