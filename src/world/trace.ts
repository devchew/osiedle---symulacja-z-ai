import type { Agent, World } from '../types';
import { NEED_KEYS } from '../types';
import { timeFromTick, formatClock } from '../core/time';

// Activity trace: a detailed, timestamped record of every decision and action
// transition, for debugging behaviour ("why did she go to bed mid-chat?").
// Pure data, no DOM; read by the UI (download) and by analysis tools.

export type TraceKind =
  | 'decide' // picked an activity (with the top candidates)
  | 'start' // an action actually started (walking towards it)
  | 'arrive' // reached the object and started using it
  | 'end' // an action ended (with reason)
  | 'invite' // asked someone to talk
  | 'accept'
  | 'refuse'
  | 'interrupted' // someone else's invitation cut the current action
  | 'conv-start'
  | 'conv-end'; // with reason and line count

export interface TraceEntry {
  tick: number;
  agentId: number;
  kind: TraceKind;
  text: string;
  /** needs snapshot at that moment: h e f s y c (hunger energy fun social hygiene comfort) */
  needs: string;
}

const MAX_ENTRIES = 30000;
const traces = new WeakMap<World, TraceEntry[]>();

export function needsSnapshot(agent: Agent): string {
  return NEED_KEYS.map((k) => Math.round(agent.needs[k]).toString().padStart(3)).join(' ');
}

export function trace(world: World, agent: Agent, kind: TraceKind, text: string): void {
  let list = traces.get(world);
  if (!list) traces.set(world, (list = []));
  list.push({ tick: world.tick, agentId: agent.id, kind, text, needs: needsSnapshot(agent) });
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
}

export function traceOf(world: World): readonly TraceEntry[] {
  return traces.get(world) ?? [];
}

export function formatTraceEntry(world: World, e: TraceEntry): string {
  const t = timeFromTick(e.tick);
  const name = world.agents.find((a) => a.id === e.agentId)?.name ?? `#${e.agentId}`;
  return `D${t.day} ${formatClock(t)}  ${name.padEnd(7)} ${e.kind.padEnd(11)} [${e.needs}]  ${e.text}`;
}

/** plain-text dump, newest last; optionally only one agent */
export function formatTrace(world: World, agentId?: number): string {
  const header = `# trace seed=${world.seed} tick=${world.tick}  needs: głód energia zabawa towarzystwo higiena komfort`;
  const lines = traceOf(world)
    .filter((e) => agentId === undefined || e.agentId === agentId)
    .map((e) => formatTraceEntry(world, e));
  return [header, ...lines].join('\n');
}
