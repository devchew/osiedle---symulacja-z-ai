export interface Loop {
  readonly paused: boolean;
  readonly speed: number;
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  start(): void;
  stop(): void;
  /**
   * an external tick driver (real-time mode): called every frame instead of the
   * accumulator; it steps the simulation itself and returns the render alpha
   */
  setDriver(driver: ((now: number) => number) | null): void;
}

export interface LoopOptions {
  /** simulation ticks per real second at speed 1 */
  ticksPerSecond: number;
  tick(): void;
  /** alpha in [0, 1): progress between the last tick and the next one */
  render(alpha: number): void;
}

/** fixed-timestep loop: the simulation advances in whole ticks, rendering interpolates between them */
export function createLoop(opts: LoopOptions): Loop {
  let paused = false;
  let speed = 1;
  let acc = 0;
  let last = 0;
  let raf = 0;
  let driver: ((now: number) => number) | null = null;
  const MAX_TICKS_PER_FRAME = 64;

  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (driver) {
      opts.render(driver(now));
      raf = requestAnimationFrame(frame);
      return;
    }
    if (!paused) {
      acc += dt * opts.ticksPerSecond * speed;
      let n = 0;
      while (acc >= 1 && n < MAX_TICKS_PER_FRAME) {
        opts.tick();
        acc -= 1;
        n++;
      }
      if (n === MAX_TICKS_PER_FRAME) acc = 0;
    }
    opts.render(paused ? 1 : acc);
    raf = requestAnimationFrame(frame);
  };

  return {
    get paused() {
      return paused;
    },
    get speed() {
      return speed;
    },
    setPaused(p) {
      paused = p;
    },
    setSpeed(s) {
      speed = s;
    },
    setDriver(d) {
      driver = d;
    },
    start() {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}
