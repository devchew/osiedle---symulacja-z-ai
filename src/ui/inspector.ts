import './ui.css';
import { NEED_ICONS, NEED_KEYS, NEED_LABELS } from '../types';
import type { Action, Agent, NeedKey, Traits, World } from '../types';
import { relationshipLabel } from '../social/relationships';
import { el, moodEmoji, setBar, setText } from './dom';

export interface InspectorOptions {
  onClose(): void;
  onFollow?(id: number): void;
}

export interface Inspector {
  show(id: number | null): void;
  update(): void;
  /** currently shown agent id */
  readonly current: number | null;
}

const MAX_RELATIONS = 5;

/** gender-neutral descriptive words for a personality */
export function personalityWords(t: Traits): { word: string; hint: string }[] {
  const out: { word: string; hint: string }[] = [];
  const add = (v: number, hi: string, lo: string, hint: string) => {
    if (v >= 0.35) out.push({ word: hi, hint });
    else if (v <= -0.35) out.push({ word: lo, hint });
  };
  add(t.sociability, 'dusza towarzystwa', 'domator', 'towarzyskość');
  add(t.activity, 'wulkan energii', 'śpioch', 'aktywność');
  add(t.neatness, 'pedant', 'bałaganiarz', 'porządek');
  add(t.cheerfulness, 'optymista', 'maruda', 'pogoda ducha');
  if (out.length === 0) out.push({ word: 'złoty środek', hint: 'zrównoważony charakter' });
  return out;
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function actionText(a: Action | null, world: World): string {
  if (!a) return '💭 Zastanawia się, co robić';
  let text = `${a.icon} ${a.label}`;
  if (a.kind === 'talk') {
    const partner = world.agents.find((x) => x.id === a.partnerId);
    if (partner && !a.label.includes(partner.name)) text += ` · ${partner.name}`;
  }
  return text;
}

interface BarRow {
  row: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
}

function barRow(label: string, icon: string): BarRow {
  const fill = el('div', 'bar-fill');
  const value = el('span', 'bar-value');
  const row = el('div', 'bar-row', [
    el('span', 'bar-label', [el('span', 'bar-icon', [icon]), label]),
    el('div', 'bar', [fill]),
    value,
  ]);
  return { row, fill, value };
}

/** right-side panel (bottom sheet on narrow screens) with details of one agent */
export function createInspector(root: HTMLElement, world: World, opts: InspectorOptions): Inspector {
  root.classList.add('ui-panel', 'ui-inspector');
  root.hidden = true;
  root.setAttribute('aria-label', 'Szczegóły postaci');
  root.replaceChildren();

  // header
  const dot = el('span', 'insp-dot');
  const name = el('h2', 'insp-name');
  const followBtn = el('button', 'ui-icon-btn', ['🎯']);
  followBtn.type = 'button';
  followBtn.title = 'Śledź kamerą';
  followBtn.hidden = !opts.onFollow;
  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Zamknij (Esc)';
  const header = el('header', 'insp-header', [dot, name, el('div', 'insp-actions', [followBtn, closeBtn])]);

  const traits = el('div', 'insp-traits');
  const action = el('div', 'insp-action');

  const moodRow = barRow('Nastrój', '🙂');
  moodRow.row.classList.add('bar-row--mood');
  const needRows = new Map<NeedKey, BarRow>();
  const needsBox = el('div', 'insp-needs');
  for (const k of NEED_KEYS) {
    const r = barRow(NEED_LABELS[k], NEED_ICONS[k]);
    needRows.set(k, r);
    needsBox.append(r.row);
  }

  const relList = el('ul', 'insp-rels');
  const relEmpty = el('p', 'insp-empty', ['Jeszcze nikogo nie zna bliżej.']);

  const statConv = el('dd');
  const statObj = el('dd');
  const statIdle = el('dd');
  const stats = el('dl', 'insp-stats', [
    el('dt', '', ['Rozmowy']), statConv,
    el('dt', '', ['Użyte przedmioty']), statObj,
    el('dt', '', ['Bezczynność']), statIdle,
  ]);

  const section = (title: string, ...body: Node[]) => el('section', 'insp-section', [el('h3', '', [title]), ...body]);
  root.append(
    header,
    traits,
    action,
    el('div', 'insp-mood', [moodRow.row]),
    section('Potrzeby', needsBox),
    section('Relacje', relList, relEmpty),
    section('Statystyki', stats),
  );

  let current: number | null = null;
  let traitsKey = '';
  let relKey = '';
  const relRows = new Map<number, BarRow & { label: HTMLElement }>();

  const close = () => {
    show(null);
    opts.onClose();
  };
  closeBtn.addEventListener('click', close);
  followBtn.addEventListener('click', () => {
    if (current !== null) opts.onFollow?.(current);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current !== null) close();
  });

  function find(): Agent | undefined {
    return current === null ? undefined : world.agents.find((a) => a.id === current);
  }

  function renderTraits(a: Agent): void {
    const key = `${a.id}|${a.traits.sociability}|${a.traits.activity}|${a.traits.neatness}|${a.traits.cheerfulness}`;
    if (key === traitsKey) return;
    traitsKey = key;
    traits.replaceChildren(
      ...personalityWords(a.traits).map(({ word, hint }) => {
        const chip = el('span', 'chip', [word]);
        chip.title = hint;
        return chip;
      }),
    );
  }

  function renderRelations(a: Agent): void {
    const rels = world.relationships
      .all()
      .filter((r) => r.a === a.id || r.b === a.id)
      .map((r) => ({ other: r.a === a.id ? r.b : r.a, value: r.value }))
      .filter((r) => world.agents.some((x) => x.id === r.other))
      .sort((x, y) => y.value - x.value || x.other - y.other)
      .slice(0, MAX_RELATIONS);

    const key = `${a.id}|${rels.map((r) => r.other).join(',')}`;
    if (key !== relKey) {
      relKey = key;
      relRows.clear();
      relList.replaceChildren();
      for (const r of rels) {
        const other = world.agents.find((x) => x.id === r.other)!;
        const fill = el('div', 'bar-fill');
        const value = el('span', 'bar-value');
        const label = el('span', 'rel-label');
        const nameBtn = el('button', 'rel-name', [el('span', 'insp-dot insp-dot--small'), other.name]);
        nameBtn.type = 'button';
        nameBtn.title = `Pokaż: ${other.name}`;
        (nameBtn.firstChild as HTMLElement).style.background = other.color;
        nameBtn.addEventListener('click', () => show(other.id));
        const row = el('li', 'rel-row', [
          el('div', 'rel-top', [nameBtn, label]),
          el('div', 'rel-bar-wrap', [el('div', 'bar bar--rel', [el('span', 'bar-mid'), fill]), value]),
        ]);
        relRows.set(r.other, { row, fill, value, label });
        relList.append(row);
      }
    }
    relEmpty.hidden = rels.length > 0;
    for (const r of rels) {
      const row = relRows.get(r.other);
      if (!row) continue;
      // bar grows from the centre: right for sympathy, left for antipathy
      const pct = Math.min(50, Math.abs(r.value) / 2);
      const left = r.value >= 0 ? 50 : 50 - pct;
      const style = `${left}%`;
      if (row.fill.style.left !== style) row.fill.style.left = style;
      setBar(row.fill, pct, r.value >= 0 ? 'var(--ui-good)' : 'var(--ui-bad)');
      setText(row.value, `${r.value > 0 ? '+' : ''}${Math.round(r.value)}`);
      setText(row.label, relationshipLabel(r.value));
    }
  }

  function update(): void {
    if (current === null) return;
    const a = find();
    if (!a) {
      close();
      return;
    }
    if (dot.style.background !== a.color) dot.style.background = a.color;
    setText(name, a.name);
    renderTraits(a);
    setText(action, actionText(a.action, world));

    setText(moodRow.row.querySelector('.bar-icon')!, moodEmoji(a.mood));
    setBar(moodRow.fill, a.mood);
    setText(moodRow.value, String(Math.round(a.mood)));
    for (const k of NEED_KEYS) {
      const r = needRows.get(k)!;
      setBar(r.fill, a.needs[k]);
      setText(r.value, String(Math.round(a.needs[k])));
      r.row.classList.toggle('is-low', a.needs[k] < 20);
    }

    renderRelations(a);
    setText(statConv, String(a.stats.conversations));
    setText(statObj, String(a.stats.objectsUsed));
    setText(statIdle, formatMinutes(a.stats.ticksIdle));
  }

  function show(id: number | null): void {
    current = id;
    if (id === null || !find()) {
      current = null;
      root.hidden = true;
      return;
    }
    traitsKey = '';
    relKey = '';
    root.hidden = false;
    update();
  }

  return {
    show,
    update,
    get current() {
      return current;
    },
  };
}
