import type { EffectId, SoundMix } from './mix';

// Web Audio engine: procedural ambience (filtered noise for rain and wind, synthesised bird chirps and
// crickets) plus a few quiet action effects. No audio files. The first start() must run inside a user
// gesture (autoplay policy); the context is suspended while the tab is hidden.

const MASTER = 0.5;
const RAIN_MAX = 0.1;
const WIND_MAX = 0.06;
const BIRD_PEAK = 0.04;
const CRICKET_PEAK = 0.018;
const EFFECT_PEAK = 0.05;
const TICK_MS = 400;
const MIN_EFFECT_GAP_S = 0.7;
const FADE_S = 1.5;

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | undefined {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function soundSupported(): boolean {
  return typeof window !== 'undefined' && !!audioCtor();
}

export interface SoundEngine {
  /** creates / resumes the context; call from a user gesture */
  start(): void;
  /** silences everything (the context is suspended) */
  stop(): void;
  setMix(mix: SoundMix): void;
  play(effect: EffectId): void;
  readonly running: boolean;
}

export function createSoundEngine(): SoundEngine {
  let ctx: AudioContext | null = null;
  let wanted = false;
  let mix: SoundMix = { birds: 0, crickets: 0, wind: 0, rain: 0 };
  let rainGain: GainNode;
  let windGain: GainNode;
  let master: GainNode;
  let noise: AudioBuffer;
  let lastEffectAt = -Infinity;

  function noiseSource(c: AudioContext): AudioBufferSourceNode {
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    return src;
  }

  function build(c: AudioContext): void {
    noise = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    master = c.createGain();
    master.gain.value = MASTER;
    master.connect(c.destination);

    rainGain = c.createGain();
    rainGain.gain.value = 0;
    const rainHp = c.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 900;
    const rainLp = c.createBiquadFilter();
    rainLp.type = 'lowpass';
    rainLp.frequency.value = 7000;
    const rainSrc = noiseSource(c);
    rainSrc.connect(rainHp).connect(rainLp).connect(rainGain).connect(master);

    windGain = c.createGain();
    windGain.gain.value = 0;
    const windLp = c.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 450;
    const gust = c.createOscillator();
    gust.frequency.value = 0.12;
    const gustDepth = c.createGain();
    gustDepth.gain.value = 200;
    gust.connect(gustDepth).connect(windLp.frequency);
    const windSrc = noiseSource(c);
    windSrc.connect(windLp).connect(windGain).connect(master);
    for (const node of [rainSrc, windSrc, gust]) node.start();

    window.setInterval(tick, TICK_MS);
    applyMix();
  }

  function applyMix(): void {
    if (!ctx) return;
    const t = ctx.currentTime;
    rainGain.gain.setTargetAtTime(mix.rain * RAIN_MAX, t, FADE_S);
    windGain.gain.setTargetAtTime(mix.wind * WIND_MAX, t, FADE_S);
  }

  function blip(freq: number, at: number, dur: number, peak: number, type: OscillatorType = 'sine', glide = 0): void {
    const c = ctx!;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (glide) osc.frequency.exponentialRampToValueAtTime(freq * glide, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function tick(): void {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (Math.random() < 0.4 * mix.birds) {
      const base = 2400 + Math.random() * 1800;
      let at = now + 0.02;
      for (let i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) {
        blip(base * (1 + i * 0.12), at, 0.09, BIRD_PEAK * mix.birds, 'sine', Math.random() < 0.5 ? 1.35 : 0.75);
        at += 0.12 + Math.random() * 0.08;
      }
    }
    if (Math.random() < 0.7 * mix.crickets) {
      const base = 4200 + Math.random() * 300;
      for (let i = 0; i < 4; i++) blip(base, now + 0.02 + i * 0.07, 0.035, CRICKET_PEAK * mix.crickets, 'triangle');
    }
  }

  function noiseBurst(at: number, dur: number, peak: number, filter: BiquadFilterType, from: number, to: number): void {
    const c = ctx!;
    const src = noiseSource(c);
    const f = c.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(from, at);
    f.frequency.linearRampToValueAtTime(to, at + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.15);
    g.gain.setValueAtTime(peak, at + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(master);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  function play(effect: EffectId): void {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - lastEffectAt < MIN_EFFECT_GAP_S) return;
    lastEffectAt = now;
    switch (effect) {
      case 'water':
        noiseBurst(now, 2.2, EFFECT_PEAK, 'bandpass', 2600, 3200);
        break;
      case 'flush':
        noiseBurst(now, 2.4, EFFECT_PEAK, 'lowpass', 1800, 300);
        break;
      case 'sizzle':
        noiseBurst(now, 2, EFFECT_PEAK * 0.7, 'highpass', 5000, 6500);
        break;
      case 'piano': {
        const scale = [261.63, 293.66, 329.63, 392, 440];
        let at = now;
        for (let i = 0; i < 3; i++) {
          blip(scale[Math.floor(Math.random() * scale.length)], at, 1.1, EFFECT_PEAK, 'triangle');
          at += 0.35 + Math.random() * 0.25;
        }
        break;
      }
    }
  }

  const onVisibility = (): void => {
    if (document.hidden) void ctx?.suspend();
    else if (wanted) api.start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const api: SoundEngine = {
    start() {
      wanted = true;
      if (document.hidden) return;
      if (!ctx) {
        const Ctor = audioCtor();
        if (!Ctor) return;
        ctx = new Ctor();
        build(ctx);
      }
      void ctx.resume();
    },
    stop() {
      wanted = false;
      if (ctx) void ctx.suspend();
    },
    setMix(next) {
      mix = next;
      applyMix();
    },
    play,
    get running() {
      return !!ctx && ctx.state === 'running';
    },
  };
  return api;
}
