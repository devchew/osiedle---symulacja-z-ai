import type { Json } from '../core/state';
import { registerWorldState } from '../core/state';
import { loadActionsState, saveActionsState, type ActionsSnapshot } from './actions';

// Registers the module state of src/agents/actions.ts (conversation id counter, minutes at the
// current object, chat extensions) with the world snapshot registry (core/state.ts). Kept apart
// so actions.ts stays free of registry code.

registerWorldState('actions', {
  save: (world) => {
    const s = saveActionsState(world);
    const empty = !s.conversationId && !Object.keys(s.usedFor).length && !Object.keys(s.chatExtension).length;
    return empty ? null : (JSON.parse(JSON.stringify(s)) as Json);
  },
  load: (world, data) => loadActionsState(world, data as unknown as ActionsSnapshot),
  clear: (world) => loadActionsState(world, null),
});
