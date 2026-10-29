import './ui.css';
import { NEED_ICONS, NEED_KEYS, NEED_LABELS } from '../types';
import type { Action, Agent, NeedKey, Traits, World } from '../types';
import { relationshipLabel } from '../social/relationships';
import { goalOf } from '../agents/goals';
import { agentMemories, type MemoryView } from '../social/memory';
import type { RelationOfFn } from './extras';
import { entriesLabel } from './diary';
import { el, moodEmoji, setBar, setText, storageGet, storageSet } from './dom';

export interface InspectorOptions {
  /** relationship kind (couple, rivals…), when the simulation provides it */
  relationOf?: RelationOfFn;
  onClose(): void;
  onFollow?(id: number): void;
  /** residents' diaries: entry point "📔 Pamiętnik" */
  diary?: InspectorDiary;
}

export interface InspectorDiary {
  count(id: number): number;
  unread(id: number): boolean;
  open(id: number): void;
}

export interface Inspector {
  show(id: number | null): void;
  update(): void;
  /** currently shown agent id */
  readonly current: number | null;
}

const MAX_RELATIONS = 5;
const MAX_MEMORIES = 5;
const MEM_COLLAPSED_KEY = 'sim.insp.memCollapsed';

/** icon for how nice / embarrassing a remembered story is */
export function valenceIcon(v: number): string {
  if (v >= 0.5) return '💖';
  if (v >= 0.15) return '🙂';
  if (v <= -0.5) return '😬';
  if (v <= -0.15) return '🙁';
  return '😐';
}

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

/** "what is the agent doing now": icon, label and a short state hint */
export function actionInfo(a: Action | null, world: World): { icon: string; text: string; state: string } {
  if (!a) return { icon: '💭', text: 'Zastanawia się, co robić', state: '' };
  let text = a.label;
  let state = '';
  if (a.kind === 'talk') {
    const partner = world.agents.find((x) => x.id === a.partnerId);
    if (partner && !a.label.includes(partner.name)) text += ` · ${partner.name}`;
    state = a.phase === 'approaching' ? 'podchodzi' : 'rozmawia';
  } else if (a.kind === 'use') state = a.phase === 'walking' ? 'w drodze' : 'w trakcie';
  else if (a.kind === 'wander') state = 'spacer';
  return { icon: a.icon || '•', text, state };
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
  const nowIcon = el('span', 'insp-now-icon');
  const nowText = el('span', 'insp-now-text');
  const nowState = el('span', 'insp-now-state');
  const action = el('div', 'insp-now', [
    nowIcon,
    el('div', 'insp-now-body', [el('span', 'insp-now-label', ['Co teraz robi']), nowText]),
    nowState,
  ]);
  action.setAttribute('aria-live', 'polite');

  // goal of the day: same layout as "Co teraz robi", warmer tint
  const goalIcon = el('span', 'insp-now-icon');
  // own class: e2e tests address the activity row by .insp-now-text
  const goalText = el('span', 'insp-goal-text');
  Object.assign(goalText.style, { fontWeight: '650', fontSize: '13.5px', lineHeight: '1.25', overflowWrap: 'anywhere' });
  const goalState = el('span', 'insp-now-state');
  const goal = el('div', 'insp-now insp-goal', [
    goalIcon,
    el('div', 'insp-now-body', [el('span', 'insp-now-label', ['Cel dnia']), goalText]),
    goalState,
  ]);
  goal.style.marginTop = '8px';
  goal.style.background = 'linear-gradient(135deg, rgba(255, 196, 92, 0.16), rgba(255, 196, 92, 0.05))';
  goal.style.borderColor = 'rgba(255, 196, 92, 0.22)';
  goalIcon.style.width = goalIcon.style.height = '30px';
  goalIcon.style.fontSize = '17px';

  // diary entry point (opens the diary panel for this resident)
  const diaryCount = el('span', 'insp-diary-count');
  const diaryBtn = el('button', 'insp-diary-btn', [el('span', '', ['📔']), el('span', 'insp-diary-label', ['Pamiętnik']), diaryCount]);
  diaryBtn.type = 'button';
  diaryBtn.hidden = !opts.diary;
  diaryBtn.addEventListener('click', () => {
    if (current !== null) opts.diary?.open(current);
  });

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

  // memories: top few, collapsible (state remembered)
  const memList = el('ul', 'insp-mems');
  const memEmpty = el('p', 'insp-empty', ['Na razie bez wspomnień.']);
  const memCount = el('span', 'insp-sec-count');
  const memToggle = el('button', 'insp-sec-toggle', [el('span', '', ['Wspomnienia']), memCount, el('span', 'insp-sec-chevron', ['▾'])]);
  memToggle.type = 'button';
  const memBody = el('div', 'insp-sec-body', [memList, memEmpty]);
  memBody.id = 'insp-mem-body';
  memToggle.setAttribute('aria-controls', memBody.id);
  const memSection = el('section', 'insp-section insp-memories', [el('h3', '', [memToggle]), memBody]);
  const setMemCollapsed = (c: boolean): void => {
    memSection.classList.toggle('is-collapsed', c);
    memBody.hidden = c;
    memToggle.setAttribute('aria-expanded', String(!c));
    memToggle.title = c ? 'Rozwiń wspomnienia' : 'Zwiń wspomnienia';
  };
  setMemCollapsed(storageGet(MEM_COLLAPSED_KEY) === '1');
  memToggle.addEventListener('click', () => {
    const c = !memSection.classList.contains('is-collapsed');
    setMemCollapsed(c);
    storageSet(MEM_COLLAPSED_KEY, c ? '1' : '0');
  });

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
    goal,
    diaryBtn,
    el('div', 'insp-mood', [moodRow.row]),
    section('Potrzeby', needsBox),
    section('Relacje', relList, relEmpty),
    memSection,
    section('Statystyki', stats),
  );

  let current: number | null = null;
  let traitsKey = '';
  let relKey = '';
  let memKey = '';
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
      const kind = opts.relationOf?.(world, a.id, r.other);
      setText(row.label, kind ? `${kind.icon ? `${kind.icon} ` : ''}${kind.label}` : relationshipLabel(r.value));
      row.label.title = kind?.detail ?? '';
    }
  }

  function renderMemories(a: Agent): void {
    const all = agentMemories(world, a.id);
    const mems = all.slice(0, MAX_MEMORIES);
    setText(memCount, all.length ? String(all.length) : '');
    // strength shown in steps of 10% to keep DOM churn low
    const key = `${a.id}|${mems.map((m) => `${m.gossip.text}:${m.source}:${Math.round(m.strength * 10)}`).join('|')}`;
    memEmpty.hidden = mems.length > 0;
    if (key === memKey) return;
    memKey = key;
    memList.replaceChildren(...mems.map((m) => memoryRow(m)));
  }

  function memoryRow(m: MemoryView): HTMLElement {
    const icon = el('span', 'mem-icon', [valenceIcon(m.gossip.valence)]);
    icon.title = m.gossip.valence >= 0.15 ? 'miłe' : m.gossip.valence <= -0.15 ? 'przykre' : 'obojętne';
    const from = m.source === 'heard' && m.fromId !== undefined ? world.agents.find((x) => x.id === m.fromId) : undefined;
    const tag = el('span', `mem-tag mem-tag--${m.source}`, [m.source === 'lived' ? 'przeżyte' : from ? `od: ${from.name}` : 'zasłyszane']);
    tag.title = m.source === 'lived' ? 'Przeżyte lub widziane na własne oczy' : 'Zasłyszane w rozmowie';
    const strength = el('span', 'mem-strength');
    strength.style.setProperty('--s', String(Math.max(0, Math.min(1, m.strength))));
    strength.title = `Siła wspomnienia: ${Math.round(m.strength * 100)}%`;
    const row = el('li', 'mem-row', [icon, el('span', 'mem-text', [m.gossip.text]), el('span', 'mem-meta', [tag, strength])]);
    row.style.opacity = String(0.55 + 0.45 * Math.min(1, m.strength));
    return row;
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
    const info = actionInfo(a.action, world);
    if (nowIcon.textContent !== info.icon) {
      setText(nowIcon, info.icon);
      // restart the little pop animation when the activity changes
      nowIcon.classList.remove('is-pop');
      void nowIcon.offsetWidth;
      nowIcon.classList.add('is-pop');
    }
    setText(nowText, info.text);
    setText(nowState, info.state);
    nowState.hidden = !info.state;
    action.dataset.state = a.action?.kind === 'use' && a.action.phase === 'using' ? 'busy' : 'moving';

    const g = goalOf(a, world);
    goal.hidden = !g;
    if (g) {
      setText(goalIcon, g.icon);
      setText(goalText, g.label);
      setText(goalState, g.progressText);
      goalState.hidden = !g.progressText;
      goalState.title = g.done ? 'Wykonany' : g.expired ? 'Nie udało się dziś' : 'Postęp';
      const look = g.done ? 'done' : g.expired ? 'expired' : 'active';
      if (goal.dataset.state !== look) {
        goal.dataset.state = look;
        goalState.style.background = g.done ? 'rgba(120, 200, 120, 0.3)' : '';
        goalState.style.color = g.done ? 'var(--ui-good)' : '';
        goalText.style.opacity = g.expired ? '0.6' : '';
      }
    }

    if (opts.diary) {
      const n = opts.diary.count(a.id);
      setText(diaryCount, n ? entriesLabel(n) : 'pusty');
      const unread = opts.diary.unread(a.id);
      diaryBtn.classList.toggle('has-badge', unread);
      diaryBtn.title = unread ? `Nowy wpis w pamiętniku: ${a.name}` : `Czytaj pamiętnik: ${a.name}`;
    }

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
    renderMemories(a);
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
    memKey = '';
    root.hidden = false;
    // a freshly shown agent gets its bars instantly; later updates glide
    root.classList.add('no-anim');
    update();
    void root.offsetWidth;
    requestAnimationFrame(() => root.classList.remove('no-anim'));
  }

  return {
    show,
    update,
    get current() {
      return current;
    },
  };
}
