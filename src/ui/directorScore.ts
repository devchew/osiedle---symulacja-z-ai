import type { Vec2, World } from '../types';
import { jointLog, jointSessions, JOINT_LABEL } from '../agents/joint';
import { brokenObjects } from '../world/incidents';
import { projectsOf } from '../world/projects';

// Director mode, the pure part: which moments of a world are worth showing (scoring) and when the
// camera may move on (dwell time, cooldown, hysteresis). No DOM and no clock of its own: times are
// passed in (real milliseconds), so everything here is testable and deterministic.

export type MomentKind = 'argument' | 'conversation' | 'game' | 'relationship' | 'breakdown' | 'stage' | 'finished' | 'story';

export interface Moment {
  /** stable while the same thing is going on (used for cooldowns and for recognising the current one) */
  key: string;
  kind: MomentKind;
  score: number;
  /** Polish caption, no gendered forms */
  label: string;
  /** resident the camera follows (walking included); without one the camera glides to `pos` */
  agentId?: number;
  pos: Vec2;
}

/** world minutes: how long after it happened a one-off moment stays interesting */
export const RECENT_TICKS = { event: 10, breakdown: 20, stage: 20, finished: 40, game: 12 } as const;

/** moments scoring below this are not worth leaving the overview for */
export const MIN_SCORE = 3;

const CONVERSATION_BASE = 4;
const NEGATIVE_LINE = 2;
const MAX_NEGATIVE_LINES = 3;
const GAME_BASE = 3;
const GAME_FINISHED = 5;
const BREAKDOWN_BASE = 4;
const REPAIRING_BONUS = 2;
const STAGE_SCORE = 6;
const FINISHED_SCORE = 9;
const CREW_SCORE = 2.5;
const RELATIONSHIP_EVENT = 6;
const STORY_EVENT = 2;

const nameOf = (world: World, id: number): string => world.agents.find((a) => a.id === id)?.name ?? '?';
const joinNames = (world: World, ids: number[]): string => ids.map((id) => nameOf(world, id)).join(' i ');
const fresh = (world: World, tick: number, window: number): number => 1 - (world.tick - tick) / window;
const posOf = (world: World, id: number): Vec2 => world.agents.find((a) => a.id === id)?.pos ?? { x: 0, y: 0 };

/** everything worth a look right now, unsorted */
export function collectMoments(world: World): Moment[] {
  const out: Moment[] = [];

  for (const c of world.conversations) {
    const ids = [...c.participants];
    const negative = c.lines.filter((l) => l.tone === 'negative').length;
    const quarrel = negative >= 2;
    out.push({
      key: `c:${c.id}`,
      kind: quarrel ? 'argument' : 'conversation',
      score: CONVERSATION_BASE + NEGATIVE_LINE * Math.min(MAX_NEGATIVE_LINES, negative) + (c.lines.length >= 3 ? 1 : 0),
      label: `${quarrel ? 'Kłótnia' : 'Rozmowa'}: ${joinNames(world, ids)}`,
      agentId: ids[0],
      pos: posOf(world, ids[0]),
    });
  }

  for (const s of jointSessions(world)) {
    if (s.phase !== 'playing' || s.hereIds.length < 2) continue;
    out.push({
      key: `j:${s.hostId}:${s.startTick}`,
      kind: 'game',
      score: GAME_BASE + 0.5 * s.hereIds.length,
      label: `Wspólna gra (${s.game ?? JOINT_LABEL[s.kind]}): ${joinNames(world, s.hereIds)}`,
      agentId: s.hostId,
      pos: posOf(world, s.hostId),
    });
  }
  for (const r of jointLog(world).slice(-8)) {
    if (!r.happened || r.ids.length < 2 || world.tick - r.end > RECENT_TICKS.game) continue;
    out.push({
      key: `jl:${r.hostId}:${r.start}`,
      kind: 'game',
      score: GAME_FINISHED * Math.max(0.4, fresh(world, r.end, RECENT_TICKS.game)),
      label: `Koniec wspólnej gry (${r.game}): ${joinNames(world, r.ids)}`,
      agentId: r.hostId,
      pos: posOf(world, r.hostId),
    });
  }

  for (const e of world.events) {
    if (world.tick - e.tick > RECENT_TICKS.event || e.agentIds.length === 0 || e.text.startsWith('📰')) continue;
    const id = e.agentIds[0];
    if (e.kind === 'relationship') {
      out.push({ key: `e:${e.tick}:${e.text}`, kind: 'relationship', score: RELATIONSHIP_EVENT * fresh(world, e.tick, RECENT_TICKS.event) + 1, label: e.text, agentId: id, pos: posOf(world, id) });
    } else if (e.gossip) {
      out.push({
        key: `e:${e.tick}:${e.text}`,
        kind: 'story',
        score: (STORY_EVENT + 2 * Math.abs(e.gossip.valence)) * fresh(world, e.tick, RECENT_TICKS.event),
        label: e.text,
        agentId: id,
        pos: posOf(world, id),
      });
    }
  }

  for (const b of brokenObjects(world)) {
    if (world.tick - b.since > RECENT_TICKS.breakdown && b.repairerIds.length === 0) continue;
    const obj = world.objects.find((o) => o.uid === b.uid);
    if (!obj) continue;
    const repairer = b.repairerIds[0];
    out.push({
      key: `b:${b.uid}:${b.since}`,
      kind: 'breakdown',
      score: BREAKDOWN_BASE + (repairer !== undefined ? REPAIRING_BONUS : 0),
      label: `Awaria: ${b.name}${repairer !== undefined ? ` — naprawia ${nameOf(world, repairer)}` : ''}`,
      agentId: repairer,
      pos: { x: obj.pos.x, y: obj.pos.y },
    });
  }

  for (const p of projectsOf(world)) {
    const centre = { x: p.pos.x + (p.size.w - 1) / 2, y: p.pos.y + (p.size.h - 1) / 2 };
    const last = p.milestones[p.milestones.length - 1];
    if (p.status === 'done' && p.finishedTick !== null && world.tick - p.finishedTick <= RECENT_TICKS.finished) {
      out.push({ key: `p:${p.id}:done`, kind: 'finished', score: FINISHED_SCORE, label: `${p.icon} Gotowe: ${p.short}`, pos: centre });
    } else if (p.status === 'building') {
      if (last && p.stage > 0 && world.tick - last.tick <= RECENT_TICKS.stage) {
        out.push({ key: `p:${p.id}:s${p.stage}`, kind: 'stage', score: STAGE_SCORE, label: `${p.icon} ${p.short}: ${p.stageLabel}`, pos: centre });
      } else if (p.workerIds.length >= 2) {
        out.push({ key: `p:${p.id}:crew`, kind: 'stage', score: CREW_SCORE, label: `${p.icon} Budowa: ${p.short}`, pos: centre });
      }
    }
  }

  return out;
}

export interface DirectorConfig {
  /** the camera stays on a moment at least this long (ms) */
  minDwellMs: number;
  /** after this long, a different moment may take over even if the current one is still going (ms) */
  maxDwellMs: number;
  /** a moment the camera has left is not shown again for this long (ms) */
  cooldownMs: number;
  /** a better moment interrupts the current one only when it scores this many times more */
  switchRatio: number;
  /** after the viewer moves the camera by hand the director stays quiet this long (ms) */
  pauseMs: number;
}

export const DIRECTOR_DEFAULTS: DirectorConfig = { minDwellMs: 14_000, maxDwellMs: 60_000, cooldownMs: 120_000, switchRatio: 1.5, pauseMs: 30_000 };

/** reduced motion: fewer cuts, so the view changes less often */
export function directorConfig(reducedMotion: boolean): DirectorConfig {
  return reducedMotion ? { ...DIRECTOR_DEFAULTS, minDwellMs: DIRECTOR_DEFAULTS.minDwellMs * 2, maxDwellMs: DIRECTOR_DEFAULTS.maxDwellMs * 2 } : DIRECTOR_DEFAULTS;
}

export interface Director {
  /** the moment to move the camera to, or null to stay where it is */
  step(moments: readonly Moment[], now: number): Moment | null;
  /** the viewer took the camera: no moves for `pauseMs` */
  interrupt(now: number): void;
  paused(now: number): boolean;
  readonly current: Moment | null;
  /** forgets the current moment and cooldowns (another place is shown) */
  reset(): void;
}

export function createDirector(cfg: DirectorConfig = DIRECTOR_DEFAULTS): Director {
  let current: Moment | null = null;
  let since = 0;
  let pausedUntil = -Infinity;
  const cooldown = new Map<string, number>();

  const byScore = (a: Moment, b: Moment): number => b.score - a.score || (a.key < b.key ? -1 : 1);

  function switchTo(m: Moment, now: number): Moment {
    if (current) cooldown.set(current.key, now + cfg.cooldownMs);
    current = m;
    since = now;
    return m;
  }

  return {
    step(moments, now) {
      if (now < pausedUntil) return null;
      for (const [k, until] of cooldown) if (until <= now) cooldown.delete(k);
      const candidates = moments.filter((m) => m.score >= MIN_SCORE && m.key !== current?.key && !cooldown.has(m.key)).sort(byScore);
      const best = candidates[0];
      if (!current) return best ? switchTo(best, now) : null;
      if (now - since < cfg.minDwellMs || !best) return null;
      const live = moments.find((m) => m.key === current!.key);
      if (!live || now - since >= cfg.maxDwellMs || best.score >= live.score * cfg.switchRatio) return switchTo(best, now);
      return null;
    },
    interrupt(now) {
      pausedUntil = now + cfg.pauseMs;
      // the viewer left it: after the pause the director starts afresh instead of "returning" to it
      if (current) cooldown.set(current.key, pausedUntil + cfg.cooldownMs);
      current = null;
    },
    paused: (now) => now < pausedUntil,
    get current() {
      return current;
    },
    reset() {
      current = null;
      pausedUntil = -Infinity;
      cooldown.clear();
    },
  };
}
