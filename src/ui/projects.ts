import './ui.css';
import './projects.css';
import { formatClock, timeFromTick } from '../core/time';
import type { World } from '../types';
import { nextProposal, projectsOf, type ProjectView } from '../world/projects';
import { el, isTypingTarget, setText } from './dom';

// "🔨 Projekty" panel (key B): the building project under way (stage, progress, days, who works
// and how much, milestones) and the finished ones. Read-only view of world/projects.

export interface ProjectsPanelOptions {
  onToggle?(open: boolean): void;
  onSelectAgent?(id: number): void;
}

export interface ProjectsPanel {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  /** re-renders when something changed; call a few times per second */
  update(): void;
  /** shows another world (live view) */
  setWorld(world: World): void;
}

/** "45 min", "3 h", "3 h 20 min" */
export function formatMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** "1 dzień", "2 dni", "5 dni" */
export function daysLabel(n: number): string {
  return `${n} ${n === 1 ? 'dzień' : 'dni'}`;
}

/** "dzień 3, 14:20" */
function when(tick: number): string {
  const t = timeFromTick(tick);
  return `dzień ${t.day}, ${formatClock(t)}`;
}

function button(className: string, children: (Node | string)[], title?: string): HTMLButtonElement {
  const b = el('button', className, children);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  return b;
}

export function createProjectsPanel(initialWorld: World, opts: ProjectsPanelOptions = {}): ProjectsPanel {
  let world = initialWorld;
  const root = el('section', 'ui-panel ui-projects');
  root.id = 'projects-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Projekty budowlane');

  const subtitle = el('span', 'panel-sub');
  const closeBtn = button('ui-icon-btn', ['✕'], 'Zamknij (Esc)');
  const body = el('div', 'proj-body');
  root.append(el('header', 'panel-header', [el('h2', 'panel-title', ['🔨 Projekty']), subtitle, closeBtn]), body);
  document.body.append(root);

  let open = false;
  let lastKey = '';

  const agentName = (id: number): string => world.agents.find((a) => a.id === id)?.name ?? '?';
  const agentColor = (id: number): string => world.agents.find((a) => a.id === id)?.color ?? '#888';

  function person(id: number, extra?: string): HTMLElement {
    const b = button('proj-person', [el('span', 'insp-dot insp-dot--small', []), agentName(id), ...(extra ? [el('span', 'proj-person-extra', [extra])] : [])]);
    (b.firstChild as HTMLElement).style.background = agentColor(id);
    b.addEventListener('click', () => opts.onSelectAgent?.(id));
    return b;
  }

  function stageChips(p: ProjectView): HTMLElement {
    return el(
      'ol',
      'proj-stages',
      p.stages.map((st, i) => {
        const state = i < p.stage ? 'done' : i === p.stage ? 'current' : 'todo';
        const li = el('li', `proj-stage proj-stage--${state}`, [state === 'done' ? `✓ ${st.label}` : st.label]);
        if (state === 'current') li.setAttribute('aria-current', 'step');
        return li;
      }),
    );
  }

  function progressBar(p: ProjectView): HTMLElement {
    const fill = el('div', 'proj-bar-fill');
    fill.style.width = `${(p.progress * 100).toFixed(1)}%`;
    const ticks = p.stages.slice(0, -1).map((st) => {
      const t = el('span', 'proj-bar-tick');
      t.style.left = `${st.until * 100}%`;
      return t;
    });
    const bar = el('div', 'proj-bar', [fill, ...ticks]);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.floor(p.progress * 100)));
    return bar;
  }

  function contributors(p: ProjectView): HTMLElement {
    if (!p.contributors.length) return el('p', 'proj-empty', ['Nikt jeszcze nie chwycił za łopatę.']);
    const max = Math.max(...p.contributors.map((c) => c.minutes));
    return el(
      'ul',
      'proj-crew',
      p.contributors.map((c) => {
        const fill = el('span', 'proj-crew-fill');
        fill.style.width = `${(c.minutes / max) * 100}%`;
        fill.style.background = agentColor(c.id);
        const now = p.workerIds.includes(c.id);
        return el('li', 'proj-crew-row', [
          person(c.id, now ? '🔨 teraz' : undefined),
          el('span', 'proj-crew-track', [fill]),
          el('span', 'proj-crew-min', [formatMinutes(c.minutes)]),
        ]);
      }),
    );
  }

  function milestones(p: ProjectView): HTMLElement {
    const list = [...p.milestones].reverse().slice(0, 8);
    return el(
      'ul',
      'proj-log',
      list.map((m) => el('li', '', [el('span', 'proj-log-when', [when(m.tick)]), el('span', 'proj-log-text', [m.text])])),
    );
  }

  function activeCard(p: ProjectView): HTMLElement {
    const now = world.tick;
    const day = Math.floor((now - p.startTick) / (24 * 60)) + 1;
    const est = Math.round(p.estimatedDays);
    const pct = Math.floor(p.progress * 100);
    const stagePct = Math.floor(p.stageProgress * 100);
    const facts = el('dl', 'proj-facts', [
      el('dt', '', ['Etap']),
      el('dd', '', [`${p.stageLabel} (${stagePct}%)`]),
      el('dt', '', ['Czas']),
      el('dd', '', [`dzień ${day} z ok. ${est} (plan: ${p.plannedDays})`]),
      el('dt', '', ['Pomysł']),
      el('dd', '', [person(p.proposerId)]),
      el('dt', '', ['Teraz']),
      el('dd', '', p.workerIds.length ? p.workerIds.map((id) => person(id)) : [el('span', 'proj-muted', [workHint()])]),
      ...(p.helperIds.length ? [el('dt', '', ['Dziś pomaga']), el('dd', '', p.helperIds.map((id) => person(id)))] : []),
    ]);
    return el('article', 'proj-card proj-card--active', [
      el('div', 'proj-card-head', [
        el('span', 'proj-icon', [p.icon]),
        el('div', 'proj-card-title', [el('h3', 'proj-name', [p.name]), el('span', 'proj-sub', [`w budowie od: ${when(p.startTick)}`])]),
        el('span', 'proj-pct', [`${pct}%`]),
      ]),
      progressBar(p),
      stageChips(p),
      facts,
      el('h4', 'proj-h', ['Ekipa — przepracowany czas']),
      contributors(p),
      el('h4', 'proj-h', ['Kamienie milowe']),
      milestones(p),
    ]);
  }

  function workHint(): string {
    const t = timeFromTick(world.tick);
    if (t.hour < 8 || t.hour >= 19) return 'praca trwa od 8:00 do 19:00';
    return 'nikt w tej chwili — może po przerwie';
  }

  function doneCard(p: ProjectView): HTMLElement {
    const days = p.finishedTick !== null ? Math.max(1, Math.round((p.finishedTick - p.startTick) / (24 * 60))) : 0;
    const crew = p.contributors.filter((c) => c.minutes >= 30);
    const total = p.contributors.reduce((s, c) => s + c.minutes, 0);
    return el('article', 'proj-card proj-card--done', [
      el('div', 'proj-card-head', [
        el('span', 'proj-icon', [p.icon]),
        el('div', 'proj-card-title', [
          el('h3', 'proj-name', [p.name]),
          el('span', 'proj-sub', [`gotowe: ${when(p.finishedTick ?? p.startTick)} · ${daysLabel(days)} budowy · ${formatMinutes(total)} pracy`]),
        ]),
        el('span', 'proj-pct proj-pct--done', ['✓']),
      ]),
      el('div', 'proj-people', (crew.length ? crew : p.contributors.slice(0, 1)).map((c) => person(c.id, formatMinutes(c.minutes)))),
    ]);
  }

  function emptyState(): HTMLElement {
    const next = nextProposal(world);
    const t = timeFromTick(world.tick);
    const hint = next ? (timeFromTick(next.tick).day <= t.day ? 'Ktoś chyba ma pomysł — może jeszcze dziś…' : 'Może jutro ktoś wpadnie na pomysł?') : '';
    return el('div', 'proj-empty-state', [
      el('p', 'proj-empty-icon', ['🏗️']),
      el('p', '', ['Na razie nikt nie zaproponował wspólnej budowy.']),
      ...(hint ? [el('p', 'proj-muted', [hint])] : []),
    ]);
  }

  function render(): void {
    const projects = projectsOf(world);
    const active = projects.filter((p) => p.status === 'building');
    const done = projects.filter((p) => p.status === 'done').reverse();
    setText(subtitle, active.length ? `${active.length} w budowie · ${done.length} gotowe` : done.length ? `${done.length} gotowe` : 'brak projektów');
    const parts: HTMLElement[] = [];
    if (!projects.length) parts.push(emptyState());
    for (const p of active) parts.push(activeCard(p));
    if (done.length) parts.push(el('h4', 'proj-h proj-h--section', ['Ukończone']), ...done.map(doneCard));
    body.replaceChildren(...parts);
  }

  function update(): void {
    if (!open) return;
    // re-render only when something visible changed (progress in whole percent, workers, minutes)
    const t = timeFromTick(world.tick);
    const key = projectsOf(world)
      .map((p) => `${p.id}:${p.stage}:${Math.floor(p.progress * 1000)}:${p.workerIds.join(',')}:${p.helperIds.join(',')}:${p.contributors.map((c) => c.minutes).join(',')}:${p.milestones.length}`)
      .join('|') + `|${t.day}|${t.hour >= 8 && t.hour < 19}`;
    if (key === lastKey) return;
    lastKey = key;
    render();
  }

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    root.hidden = !o;
    lastKey = '';
    if (o) update();
    opts.onToggle?.(o);
  }

  closeBtn.addEventListener('click', () => setOpen(false));
  // B toggles; Esc closes (capture: before the inspector's Esc)
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'KeyB' && !e.repeat) {
        setOpen(!open);
        return;
      }
      if (open && e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    },
    { capture: true },
  );

  return {
    get isOpen() {
      return open;
    },
    setOpen,
    update,
    setWorld(w) {
      world = w;
      lastKey = '';
      update();
    },
  };
}
