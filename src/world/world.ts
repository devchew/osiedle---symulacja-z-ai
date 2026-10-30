import type { Agent, DialogueProvider, NeedKey, World } from '../types';
import { NEED_ICONS } from '../types';
import { createRng } from '../core/rng';
import { registerWorldBase } from '../core/state';
import { timeOf } from '../core/calendar';
import { getMap, setMapId } from './maps';
import { tickNews } from './news';
import { WORLD_OBJECT_DEFS } from './objects';
import { pushEvent } from './events';
import { createAgents } from '../agents/agent';
import { computeMood, decayNeeds } from '../agents/needs';
import { ambientChats, endAction, isAgentSleeping, tickConversations, updateAgent } from '../agents/actions';
import { mostUrgentNeed } from '../agents/brain';
import { assignBeds } from '../agents/home';
import { narrateState } from '../agents/narration';
import { createRelationships } from '../social/relationships';
import { createProceduralProvider } from '../social/dialogueProvider';
import { updateMemories } from '../social/memory';
import { tickDiary } from '../social/diary';
import { initIncidents, tickIncidents } from './incidents';
import { initProjects, tickProjects } from './projects';
import { updateRelations } from '../social/relationships';
import { tickGatherings } from '../agents/groups';
import { ensurePets, tickPets } from '../agents/pets';
// side effects: register the module state of actions.ts / movement.ts with the snapshot registry
import '../agents/actionsState';
import '../agents/movementState';

// what core/state.restoreWorld needs to rebuild a World (it must not import simulation modules)
registerWorldBase({ objectDefs: WORLD_OBJECT_DEFS, createDialogue: createProceduralProvider, createRelationships });

export { restoreWorld, snapshotWorld } from '../core/state';

export interface WorldOptions {
  agentCount?: number;
  dialogue?: DialogueProvider;
  /** house layout id from src/world/maps (default 'dom') */
  mapId?: string;
}

export function createWorld(seed = 1, opts: WorldOptions = {}): World {
  const rng = createRng(seed);
  const mapDef = getMap(opts.mapId);
  const map = mapDef.create();
  const agents = createAgents(opts.agentCount ?? 6, map.spawnPoints, rng);
  const relationships = createRelationships();
  // housemates already know each other a bit
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) relationships.adjust(agents[i].id, agents[j].id, rng.int(-10, 25));

  const world: World = {
    seed,
    rng,
    tick: 0,
    grid: map.grid,
    objectDefs: WORLD_OBJECT_DEFS,
    objects: map.objects,
    agents,
    relationships,
    conversations: [],
    events: [],
    dialogue: opts.dialogue ?? createProceduralProvider(),
  };
  setMapId(world, mapDef.id);
  assignBeds(world);
  initIncidents(world);
  initProjects(world);
  ensurePets(world, map);
  pushEvent(world, 'info', `Nowy dzień na osiedlu. Mieszkańcy: ${agents.map((a) => a.name).join(', ')}`, []);
  return world;
}

const COMPLAINTS: Record<NeedKey, string[]> = {
  hunger: ['Burczy mi w brzuchu…', 'Coś by się zjadło'],
  energy: ['Padam z nóg…', 'Oczy same się zamykają'],
  fun: ['Nudy…', 'Przydałaby się jakaś rozrywka'],
  social: ['Z kim by tu pogadać?', 'Trochę samotnie…'],
  hygiene: ['Przydałby się prysznic', 'Hmm, czuć mnie…'],
  comfort: ['Wszystko mnie boli', 'Muszę odsapnąć'],
};

function thinkAloud(world: World, agent: Agent): void {
  if (agent.bubble || agent.action?.kind === 'talk') return;
  const need = mostUrgentNeed(agent);
  if (agent.needs[need] > 22 || !world.rng.chance(0.01)) return;
  agent.bubble = { kind: 'thought', text: `${NEED_ICONS[need]} ${world.rng.pick(COMPLAINTS[need])}`, ttl: 30 };
}

export function tickWorld(world: World): void {
  world.tick++;
  const time = timeOf(world);

  for (const agent of world.agents) {
    agent.prevPos = { x: agent.pos.x, y: agent.pos.y };
    decayNeeds(agent, { sleeping: isAgentSleeping(world, agent), hour: time.hour });
    if (agent.bubble && --agent.bubble.ttl <= 0) agent.bubble = null;
  }
  for (const agent of world.agents) updateAgent(world, agent, time);
  tickPets(world);
  tickIncidents(world, endAction);
  tickProjects(world);
  tickNews(world);
  updateMemories(world);
  tickConversations(world, time);
  // relationship status and gatherings are updated right before ambient chats pick pairs
  updateRelations(world);
  tickGatherings(world);
  ambientChats(world);
  for (const agent of world.agents) {
    agent.mood = computeMood(agent.needs, agent.traits);
    thinkAloud(world, agent);
    narrateState(world, agent, isAgentSleeping(world, agent));
  }
  tickDiary(world);
}
