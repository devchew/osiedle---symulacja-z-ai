import './ui.css';
import { formatClock, timeFromTick } from '../core/time';
import type { SimEvent, SimEventKind, World } from '../types';
import { el, setText } from './dom';

export interface EventLogOptions {
  /** called when an event row is clicked; receives the first agent of the event */
  onSelectAgent?(id: number): void;
}

export interface EventLog {
  update(): void;
}

const MAX_ROWS = 40;
/** rows visible while the log is collapsed (compact mode) */
export const COMPACT_ROWS = 3;

export const EVENT_ICONS: Record<SimEventKind, string> = {
  conversation: '💬',
  use: '🔧',
  relationship: '💞',
  mood: '🎭',
  info: 'ℹ️',
};

export function formatEventTime(tick: number): string {
  const t = timeFromTick(tick);
  return `D${t.day} ${formatClock(t)}`;
}

/**
 * bottom-left list of the latest events, newest on top. Collapsed (default) it
 * shows only the last COMPACT_ROWS events so the map stays visible; expanded it
 * becomes a scrollable list.
 */
export function createEventLog(root: HTMLElement, world: World, opts: EventLogOptions = {}): EventLog {
  root.classList.add('ui-panel', 'ui-log');
  root.setAttribute('aria-label', 'Dziennik zdarzeń');
  root.replaceChildren();

  const count = el('span', 'log-count');
  const chevron = el('span', 'log-chevron', ['▾']);
  const hint = el('span', 'log-hint');
  const toggle = el('button', 'log-toggle', [el('span', 'log-title', ['📜 Wydarzenia']), count, hint, chevron]);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  const list = el('ol', 'log-list');
  list.setAttribute('aria-live', 'polite');
  const empty = el('p', 'insp-empty', ['Na razie spokojnie…']);
  root.append(toggle, list, empty);

  let collapsed = true;
  try {
    collapsed = localStorage.getItem('sim.log.collapsed') !== '0';
  } catch {
    /* storage unavailable */
  }
  const applyCollapsed = () => {
    root.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Pokaż więcej zdarzeń' : 'Zwiń dziennik';
    setText(hint, collapsed ? 'więcej' : 'zwiń');
    if (collapsed) list.scrollTop = 0;
  };
  applyCollapsed();
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    applyCollapsed();
    try {
      localStorage.setItem('sim.log.collapsed', collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  });

  let lastSeen: SimEvent | null = null;
  let unseen = 0;

  function row(ev: SimEvent): HTMLElement {
    const li = el('li', `log-row log-row--${ev.kind}`, [
      el('span', 'log-icon', [EVENT_ICONS[ev.kind] ?? '•']),
      el('time', 'log-time', [formatEventTime(ev.tick)]),
      el('span', 'log-text', [ev.text]),
    ]);
    if (opts.onSelectAgent && ev.agentIds.length > 0) {
      li.classList.add('is-clickable');
      li.addEventListener('click', () => opts.onSelectAgent!(ev.agentIds[0]));
    }
    return li;
  }

  function update(): void {
    const events = world.events;
    // events are appended (newest last) and trimmed from the front: new ones follow the last seen object
    const idx = lastSeen ? events.lastIndexOf(lastSeen) : -1;
    if (lastSeen && idx === -1) {
      // trimmed away or world reset: start over
      list.replaceChildren();
      lastSeen = null;
    }
    const fresh = events.slice(Math.max(idx + 1, events.length - MAX_ROWS));
    if (fresh.length > 0) {
      const frag = document.createDocumentFragment();
      for (let i = fresh.length - 1; i >= 0; i--) frag.append(row(fresh[i]));
      list.prepend(frag);
      while (list.childElementCount > MAX_ROWS) list.lastElementChild!.remove();
      lastSeen = events[events.length - 1];
      // events that don't fit in the compact view count as unseen
      if (collapsed) unseen += Math.max(0, fresh.length - COMPACT_ROWS);
    }
    if (!collapsed) unseen = 0;
    setText(count, collapsed && unseen > 0 ? `+${Math.min(unseen, 99)}` : '');
    empty.hidden = list.childElementCount > 0;
  }

  update();
  return { update };
}
