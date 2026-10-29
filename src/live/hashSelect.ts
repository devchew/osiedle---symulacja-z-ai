import type { World } from '../types';
import { agentFromHash, hashFor } from './routes';

// URL hash ↔ selected resident (#Ola). Selecting someone replaces the hash (no history entries);
// editing the hash or following a link selects them.

export interface HashSelection {
  /** call from the view's onSelect */
  onSelect(id: number | null): void;
  /** selects the resident named in the current hash (after the first frame / a place switch) */
  apply(): void;
}

export function bindHashSelection(getWorld: () => World | null, select: (id: number | null) => void): HashSelection {
  const apply = (): void => {
    const w = getWorld();
    if (!w) return;
    const a = agentFromHash(location.hash, w.agents);
    select(a ? a.id : null);
  };
  window.addEventListener('hashchange', apply);
  return {
    onSelect(id) {
      // also normalises "#ola" / "#3" to the resident's name and drops unknown names
      const w = getWorld();
      const a = id === null ? null : (w?.agents.find((x) => x.id === id) ?? null);
      const next = hashFor(a);
      if (next !== location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`);
    },
    apply,
  };
}
