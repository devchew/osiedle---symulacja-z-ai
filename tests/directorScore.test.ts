import { describe, expect, it } from 'vitest';
import type { Conversation, DialogueLine, SimEvent, Tone, World } from '../src/types';
import { createWorld, tickWorld } from '../src/world/world';
import { collectMoments, createDirector, directorConfig, DIRECTOR_DEFAULTS, MIN_SCORE, type Moment } from '../src/ui/directorScore';

// Director mode, the DOM-free part: scoring of what happens in a world and the pacing rules
// (dwell time, cooldown, hysteresis, pause after the viewer touches the camera).

const line = (tone: Tone): DialogueLine => ({ speakerId: 1, text: '…', tone });
const conv = (id: number, tones: Tone[]): Conversation => ({
  id,
  participants: [1, 2],
  topic: 'pogoda',
  lines: tones.map(line),
  nextLineIn: 3,
  pending: false,
  maxLines: 6,
  startedAt: 0,
});

function fakeWorld(parts: { conversations?: Conversation[]; events?: SimEvent[]; tick?: number }): World {
  return {
    tick: parts.tick ?? 100,
    agents: [
      { id: 1, name: 'Ola', pos: { x: 3, y: 4 } },
      { id: 2, name: 'Kuba', pos: { x: 4, y: 4 } },
    ],
    conversations: parts.conversations ?? [],
    events: parts.events ?? [],
    objects: [],
  } as unknown as World;
}

const moment = (key: string, score: number): Moment => ({ key, kind: 'conversation', score, label: key, pos: { x: 0, y: 0 } });
const s = 1000;

describe('collectMoments', () => {
  it('scores an argument above a friendly chat', () => {
    const [chat] = collectMoments(fakeWorld({ conversations: [conv(1, ['positive', 'neutral'])] }));
    const [fight] = collectMoments(fakeWorld({ conversations: [conv(2, ['negative', 'negative', 'neutral'])] }));
    expect(chat.kind).toBe('conversation');
    expect(fight.kind).toBe('argument');
    expect(fight.label).toBe('Kłótnia: Ola i Kuba');
    expect(fight.score).toBeGreaterThan(chat.score);
    expect(fight.agentId).toBe(1);
  });

  it('counts recent relationship events with fresh ones higher, and skips old, anonymous and TV news', () => {
    const ev = (tick: number, kind: SimEvent['kind'], text: string, agentIds = [1, 2]): SimEvent => ({ tick, kind, text, agentIds });
    const moments = collectMoments(
      fakeWorld({
        tick: 100,
        events: [
          ev(99, 'relationship', 'Ola ↔ Kuba: kłótnia o wynik gry 💢'),
          ev(92, 'relationship', 'Ola i Kuba się zaprzyjaźniają'),
          ev(60, 'relationship', 'dawno temu'),
          ev(99, 'relationship', 'bez osób', []),
          ev(99, 'info', '📰 wiadomości'),
        ],
      }),
    );
    expect(moments.map((m) => m.label)).toEqual(['Ola ↔ Kuba: kłótnia o wynik gry 💢', 'Ola i Kuba się zaprzyjaźniają']);
    expect(moments[0].score).toBeGreaterThan(moments[1].score);
  });

  it('runs on a real world: unique keys, finite scores, at least one moment over a day', () => {
    const world = createWorld(5, { mapId: 'dom', agentCount: 4 });
    let seen = 0;
    for (let i = 0; i < 24 * 60; i++) {
      tickWorld(world);
      if (i % 10) continue;
      const moments = collectMoments(world);
      expect(new Set(moments.map((m) => m.key)).size).toBe(moments.length);
      for (const m of moments) {
        expect(Number.isFinite(m.score)).toBe(true);
        expect(Number.isFinite(m.pos.x) && Number.isFinite(m.pos.y)).toBe(true);
      }
      seen += moments.filter((m) => m.score >= MIN_SCORE).length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('createDirector', () => {
  const cfg = DIRECTOR_DEFAULTS;

  it('goes to the best moment and ignores the dull ones', () => {
    const d = createDirector();
    expect(d.step([moment('dull', MIN_SCORE - 1)], 0)).toBeNull();
    expect(d.step([moment('a', 5), moment('b', 8), moment('dull', 2)], s)?.key).toBe('b');
  });

  it('stays at least the minimum dwell, even for a much better moment', () => {
    const d = createDirector();
    d.step([moment('a', 4)], 0);
    expect(d.step([moment('a', 4), moment('big', 20)], cfg.minDwellMs - 1)).toBeNull();
    expect(d.step([moment('a', 4), moment('big', 20)], cfg.minDwellMs)?.key).toBe('big');
  });

  it('keeps a good moment unless another one is clearly better (hysteresis)', () => {
    const d = createDirector();
    d.step([moment('a', 6)], 0);
    expect(d.step([moment('a', 6), moment('b', 7)], cfg.minDwellMs)).toBeNull();
    expect(d.step([moment('a', 6), moment('b', 9)], cfg.minDwellMs + s)?.key).toBe('b');
  });

  it('moves on when the moment is over, and after the maximum dwell', () => {
    const d = createDirector();
    d.step([moment('a', 6)], 0);
    expect(d.step([moment('b', 4)], cfg.minDwellMs)?.key).toBe('b');
    expect(d.step([moment('b', 5), moment('c', 4)], cfg.minDwellMs * 2 - 1)).toBeNull();
    expect(d.step([moment('b', 5), moment('c', 4)], cfg.minDwellMs + cfg.maxDwellMs)?.key).toBe('c');
  });

  it('does not return to a moment it just left until the cooldown passes', () => {
    const d = createDirector();
    d.step([moment('a', 5)], 0);
    d.step([moment('a', 5), moment('b', 9)], cfg.minDwellMs);
    const t = 2 * cfg.minDwellMs;
    expect(d.step([moment('a', 12), moment('b', 3)], t)).toBeNull();
    expect(d.step([moment('a', 12), moment('b', 3)], cfg.minDwellMs + cfg.cooldownMs + 1)?.key).toBe('a');
  });

  it('is paused by the viewer, then starts afresh without the moment they left', () => {
    const d = createDirector();
    d.step([moment('a', 5)], 0);
    d.interrupt(5 * s);
    expect(d.paused(6 * s)).toBe(true);
    expect(d.step([moment('b', 9)], 6 * s)).toBeNull();
    expect(d.paused(5 * s + cfg.pauseMs)).toBe(false);
    expect(d.step([moment('a', 9), moment('b', 5)], 5 * s + cfg.pauseMs)?.key).toBe('b');
  });

  it('reset forgets the current moment and the pause', () => {
    const d = createDirector();
    d.step([moment('a', 5)], 0);
    d.interrupt(s);
    d.reset();
    expect(d.current).toBeNull();
    expect(d.step([moment('a', 5)], 2 * s)?.key).toBe('a');
  });

  it('cuts less often with reduced motion', () => {
    expect(directorConfig(true).minDwellMs).toBeGreaterThan(directorConfig(false).minDwellMs);
  });
});
