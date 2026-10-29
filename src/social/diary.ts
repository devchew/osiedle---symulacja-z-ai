import type { World } from '../types';

// Residents' diaries: every evening each resident writes a first-person entry about their day,
// built from what really happened (trace, events, memories, goals, relationships, TV news).
// Diaries never influence the simulation. Wave 8 stub — see plan/TASKS.md.

export interface DiaryEntry {
  agentId: number;
  /** game day the entry is about (1-based) */
  day: number;
  /** tick when it was written */
  tick: number;
  /** Polish, first person, a few short paragraphs separated by "\n\n" */
  text: string;
  /** writer's mood (0..100) at writing time */
  mood: number;
  /** short emoji tags of the day's highlights, e.g. ["🎣", "💬", "🌧️"] */
  tags: string[];
  /** 'ai' once an AI rewrite has replaced the procedural text */
  source: 'procedural' | 'ai';
}

/** called once per tick (after agents act): writes entries when residents turn in for the night */
export function tickDiary(_world: World): void {}

/** all entries of one resident, oldest first */
export function diaryOf(_world: World, _agentId: number): readonly DiaryEntry[] {
  return [];
}

/** subscribe to new/updated entries (UI refresh); returns unsubscribe */
export function onDiaryChange(_world: World, _fn: (entry: DiaryEntry) => void): () => void {
  return () => {};
}

/** plain-text export of one resident's diary (or everyone's) */
export function formatDiary(_world: World, _agentId?: number): string {
  return '';
}
