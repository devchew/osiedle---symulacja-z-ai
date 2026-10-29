import './ui.css';
import './diary.css';
import { formatClock, timeFromTick } from '../core/time';
import type { Agent, World } from '../types';
import { diaryOf, formatDiary, onDiaryChange, type DiaryEntry } from '../social/diary';
import { el, isTypingTarget, moodEmoji, setText } from './dom';
import { toast } from './toast';

// Residents' diaries (read-only view): an overview of everyone's latest entry ("Pamiętniki", key P)
// and one resident's notebook with a list of days, prev/next navigation and a .txt export.
// Entries come from social/diary.ts; read state is kept in memory only.

/** where entries come from (the simulation's diary by default) */
export interface DiarySource {
  entriesOf(world: World, agentId: number): readonly DiaryEntry[];
  onChange(world: World, fn: (entry: DiaryEntry) => void): () => void;
  format(world: World, agentId?: number): string;
}

const SIM_SOURCE: DiarySource = { entriesOf: diaryOf, onChange: onDiaryChange, format: formatDiary };

export interface DiaryPanelOptions {
  source?: DiarySource;
  onToggle?(open: boolean): void;
  /** called when the number of residents with unread entries changes */
  onUnreadChange?(count: number): void;
  /** "📔 Ola pisze pamiętnik" toasts (default on) */
  notify?: boolean;
}

export interface DiaryPanel {
  readonly isOpen: boolean;
  /** resident whose diary is shown, null for the overview */
  readonly agentId: number | null;
  setOpen(open: boolean): void;
  openOverview(): void;
  openFor(agentId: number): void;
  entryCount(agentId: number): number;
  hasUnread(agentId: number): boolean;
  /** re-renders when something changed; call a few times per second */
  update(): void;
  /**
   * shows another world. `sameScene` (next live frame of the same place): read marks and known
   * entries are kept, new entries get the usual toast; otherwise everything starts over.
   */
  setWorld(world: World, sameScene: boolean): void;
}

const TOAST_GAP_MS = 20_000;
const TOAST_GATHER_MS = 1_500;
const SNIPPET = 140;

const PHASE_WORD = { morning: 'rano', day: 'w dzień', evening: 'wieczorem', night: 'nocą' } as const;

/** "wieczorem, 21:40" — when the entry was written */
export function writtenAt(tick: number): string {
  const t = timeFromTick(tick);
  return `${PHASE_WORD[t.phase]}, ${formatClock(t)}`;
}

/** first paragraph(s) shortened to about `max` characters, on a word boundary */
export function snippet(text: string, max = SNIPPET): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** "1 wpis", "3 wpisy", "5 wpisów" */
export function entriesLabel(n: number): string {
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
  return `${n} ${n === 1 ? 'wpis' : few ? 'wpisy' : 'wpisów'}`;
}

/** toast text for residents who just wrote an entry (gender-neutral) */
export function writingToastText(names: string[]): string {
  if (names.length === 1) return `📔 ${names[0]} pisze pamiętnik`;
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} i jeszcze ${rest}` : `${shown.slice(0, -1).join(', ')} i ${shown[shown.length - 1]}`;
  return `📔 Pamiętniki piszą: ${list}`;
}

export function diaryFileName(world: World, agent?: Agent): string {
  const slug = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ł/g, 'l')
      .replace(/Ł/g, 'L')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  const who = agent ? slug(agent.name) || `postac-${agent.id}` : 'wszyscy';
  return `pamietnik-${who}-seed${world.seed}-dzien${timeFromTick(world.tick).day}.txt`;
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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

/** "📔 Pamiętniki" panel: everyone's latest entries, or one resident's notebook */
export function createDiaryPanel(initialWorld: World, opts: DiaryPanelOptions = {}): DiaryPanel {
  let world = initialWorld;
  const src = opts.source ?? SIM_SOURCE;
  const root = el('section', 'ui-panel ui-diary');
  root.id = 'diary-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Pamiętniki');

  // header: back to the overview, title, export, close
  const backBtn = button('ui-icon-btn diary-back', ['‹'], 'Wszystkie pamiętniki');
  const titleDot = el('span', 'insp-dot diary-title-dot');
  const titleText = el('span', 'diary-title-text');
  const title = el('h2', 'panel-title diary-title', [titleDot, titleText]);
  const subtitle = el('span', 'panel-sub diary-sub');
  const downloadBtn = button('ui-btn ui-btn--small diary-download', ['⬇ .txt'], 'Pobierz pamiętnik (.txt)');
  const closeBtn = button('ui-icon-btn diary-close', ['✕'], 'Zamknij (Esc)');
  const header = el('header', 'panel-header diary-header', [backBtn, title, subtitle, downloadBtn, closeBtn]);

  // overview: one card per resident
  const overview = el('ul', 'diary-overview');
  const overviewHint = el('p', 'diary-hint', [
    'Każdy mieszkaniec wieczorem, przed snem, zapisuje kilka zdań o swoim dniu. Kliknij, by przeczytać.',
  ]);
  const overviewBox = el('div', 'diary-overview-box', [overviewHint, overview]);

  // one resident: days list + notebook page
  const days = el('ol', 'diary-days');
  days.setAttribute('aria-label', 'Dni');
  const pageDay = el('h3', 'diary-page-day');
  const pageWhen = el('span', 'diary-page-when');
  const pageMood = el('span', 'diary-page-mood');
  const aiBadge = el('span', 'diary-ai', ['✨ AI']);
  aiBadge.title = 'Wpis przepisany przez AI';
  const pageTags = el('div', 'diary-page-tags');
  const pageText = el('div', 'diary-text');
  const page = el('article', 'diary-page', [
    el('header', 'diary-page-head', [pageDay, el('span', 'diary-page-meta', [pageWhen, pageMood, aiBadge])]),
    pageTags,
    pageText,
  ]);
  page.tabIndex = -1;
  const emptyBox = el('p', 'diary-empty');
  const prevBtn = button('ui-btn ui-btn--small diary-prev', ['‹ Poprzedni dzień'], 'Poprzedni dzień (←)');
  const nextBtn = button('ui-btn ui-btn--small diary-next', ['Następny dzień ›'], 'Następny dzień (→)');
  const pos = el('span', 'diary-pos');
  const nav = el('nav', 'diary-nav', [prevBtn, pos, nextBtn]);
  const sheet = el('div', 'diary-sheet', [page, emptyBox, nav]);
  const book = el('div', 'diary-book', [days, sheet]);

  root.append(header, overviewBox, book);
  document.body.append(root);

  let open = false;
  let agentId: number | null = null;
  /** index into the resident's entries (oldest first) */
  let index = -1;
  let dirty = true;
  /** per resident: key of the latest entry already seen */
  const readKey = new Map<number, string>();
  let unreadCount = -1;

  const agentOf = (id: number) => world.agents.find((a) => a.id === id);
  const entries = (id: number) => src.entriesOf(world, id);
  const latestKey = (list: readonly DiaryEntry[]) => (list.length ? `${list.length}|${list[list.length - 1].tick}` : '');
  const unread = (id: number) => {
    const k = latestKey(entries(id));
    return k !== '' && readKey.get(id) !== k;
  };

  // --- notifications: gather residents writing at about the same time into one toast
  const known = new Set<string>();
  for (const a of world.agents) for (const e of entries(a.id)) known.add(`${e.agentId}:${e.day}`);
  let pending: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastToast = -Infinity;
  const flush = () => {
    flushTimer = null;
    if (!pending.length) return;
    const wait = lastToast + TOAST_GAP_MS - performance.now();
    if (wait > 0) {
      flushTimer = setTimeout(flush, wait);
      return;
    }
    toast(writingToastText(pending));
    pending = [];
    lastToast = performance.now();
  };
  const onEntry = (e: DiaryEntry): void => {
    dirty = true;
    const k = `${e.agentId}:${e.day}`;
    if (known.has(k)) return; // an AI rewrite of an existing entry
    known.add(k);
    const who = agentOf(e.agentId);
    if (opts.notify === false || !who || (open && agentId === e.agentId)) return;
    if (!pending.includes(who.name)) pending.push(who.name);
    if (!flushTimer) flushTimer = setTimeout(flush, TOAST_GATHER_MS);
  };
  let unsubscribe = src.onChange(world, onEntry);

  // entries that arrive with a whole new state (live frames) fire no change event: compare a
  // cheap fingerprint of everyone's latest entry instead
  const fingerprint = (): string =>
    world.agents
      .map((a) => {
        const l = entries(a.id);
        const last = l[l.length - 1];
        return last ? `${a.id}:${l.length}:${last.tick}:${last.source}:${last.text.length}` : `${a.id}:0`;
      })
      .join('|');
  let lastPrint = fingerprint();
  function checkExternal(): void {
    const p = fingerprint();
    if (p === lastPrint) return;
    lastPrint = p;
    dirty = true;
    for (const a of world.agents) for (const e of entries(a.id)) if (!known.has(`${e.agentId}:${e.day}`)) onEntry(e);
  }

  // --- rendering
  function renderOverview(): void {
    titleDot.hidden = true;
    backBtn.hidden = true;
    setText(titleText, '📔 Pamiętniki');
    const rows = world.agents
      .map((a) => ({ a, list: entries(a.id) }))
      .sort((x, y) => (y.list.at(-1)?.tick ?? -1) - (x.list.at(-1)?.tick ?? -1) || x.a.id - y.a.id);
    const total = rows.reduce((s, r) => s + r.list.length, 0);
    setText(subtitle, total ? entriesLabel(total) : 'na razie bez wpisów');
    downloadBtn.disabled = total === 0;
    downloadBtn.title = 'Pobierz wszystkie pamiętniki (.txt)';
    overview.replaceChildren(
      ...rows.map(({ a, list }) => {
        const last = list.at(-1);
        const dot = el('span', 'insp-dot');
        dot.style.background = a.color;
        const head = el('span', 'diary-ov-head', [dot, el('span', 'diary-ov-name', [a.name])]);
        if (last) {
          head.append(
            el('span', 'diary-ov-day', [`Dzień ${last.day}`]),
            el('span', 'diary-ov-mood', [moodEmoji(last.mood)]),
            ...(last.source === 'ai' ? [el('span', 'diary-ai diary-ai--small', ['✨ AI'])] : []),
          );
        }
        if (unread(a.id)) {
          const d = el('span', 'diary-unread');
          d.title = 'Nowy wpis';
          head.append(d);
        }
        const body = last
          ? [
              el('span', 'diary-ov-tags', [last.tags.join(' ')]),
              el('span', 'diary-ov-snippet', [snippet(last.text)]),
            ]
          : [el('span', 'diary-ov-snippet diary-ov-snippet--empty', ['Jeszcze nic nie napisano.'])];
        const b = button('diary-ov-item', [head, ...body]);
        b.dataset.agent = String(a.id);
        b.title = last ? `Czytaj pamiętnik: ${a.name}` : `${a.name}: pamiętnik jeszcze pusty`;
        b.addEventListener('click', () => openFor(a.id));
        return el('li', '', [b]);
      }),
    );
  }

  function renderAgent(a: Agent): void {
    const list = entries(a.id);
    backBtn.hidden = false;
    titleDot.hidden = false;
    titleDot.style.background = a.color;
    setText(titleText, `Pamiętnik: ${a.name}`);
    downloadBtn.title = 'Pobierz pamiętnik (.txt)';
    downloadBtn.disabled = list.length === 0;
    if (index < 0 || index >= list.length) index = list.length - 1;
    setText(subtitle, list.length ? `${list.length} ${list.length === 1 ? 'dzień' : 'dni'}` : '');
    if (list.length) readKey.set(a.id, latestKey(list));

    const empty = list.length === 0;
    book.classList.toggle('is-empty', empty);
    days.hidden = empty;
    page.hidden = empty;
    nav.hidden = empty;
    emptyBox.hidden = !empty;
    if (empty) {
      setText(emptyBox, `Pamiętnik jest jeszcze pusty — pierwszy wpis pojawi się wieczorem, gdy ${a.name} pójdzie spać.`);
      return;
    }

    // days, newest first
    days.replaceChildren(
      ...list
        .map((e, i) => {
          const b = button('diary-day', [
            el('span', 'diary-day-n', [`Dzień ${e.day}`]),
            el('span', 'diary-day-mood', [moodEmoji(e.mood)]),
            el('span', 'diary-day-tags', [e.tags.join(' ')]),
          ]);
          b.classList.toggle('is-active', i === index);
          b.setAttribute('aria-current', i === index ? 'page' : 'false');
          b.addEventListener('click', () => go(i));
          return el('li', '', [b]);
        })
        .reverse(),
    );

    const e = list[index];
    page.dataset.day = String(e.day);
    setText(pageDay, `Dzień ${e.day}`);
    setText(pageWhen, writtenAt(e.tick));
    pageWhen.title = 'Kiedy powstał wpis';
    setText(pageMood, moodEmoji(e.mood));
    pageMood.title = `Nastrój: ${Math.round(e.mood)}`;
    aiBadge.hidden = e.source !== 'ai';
    pageTags.hidden = e.tags.length === 0;
    pageTags.replaceChildren(...e.tags.map((t) => el('span', 'diary-tag', [t])));
    pageText.replaceChildren(...paragraphs(e.text).map((p) => el('p', '', [p])));
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= list.length - 1;
    setText(pos, `${index + 1} / ${list.length}`);
    // keep the chosen day visible in the (horizontally scrolling, on phones) list
    days.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function render(): void {
    dirty = false;
    const a = agentId === null ? undefined : agentOf(agentId);
    if (agentId !== null && !a) agentId = null;
    root.classList.toggle('is-overview', !a);
    overviewBox.hidden = !!a;
    book.hidden = !a;
    if (a) renderAgent(a);
    else renderOverview();
  }

  function go(i: number): void {
    if (agentId === null) return;
    const n = entries(agentId).length;
    if (i < 0 || i >= n || i === index) return;
    index = i;
    render();
    sheet.scrollTop = 0;
    page.scrollTop = 0;
  }

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    root.hidden = !o;
    if (o) render();
    opts.onToggle?.(o);
    reportUnread();
  }

  function openFor(id: number): void {
    agentId = id;
    index = -1;
    if (open) render();
    else setOpen(true);
    reportUnread();
    page.focus({ preventScroll: true });
  }

  function openOverview(): void {
    agentId = null;
    if (open) render();
    else setOpen(true);
  }

  function reportUnread(): void {
    const n = world.agents.filter((a) => unread(a.id)).length;
    if (n !== unreadCount) {
      unreadCount = n;
      opts.onUnreadChange?.(n);
    }
  }

  backBtn.addEventListener('click', openOverview);
  closeBtn.addEventListener('click', () => setOpen(false));
  prevBtn.addEventListener('click', () => go(index - 1));
  nextBtn.addEventListener('click', () => go(index + 1));
  downloadBtn.addEventListener('click', () => {
    const a = agentId === null ? undefined : agentOf(agentId);
    download(diaryFileName(world, a), src.format(world, a?.id));
  });

  // P toggles the overview; while open: Esc closes, ←/→ change the day, ↑/↓ scroll the page.
  // Capture phase: runs before the inspector's Esc and the camera's arrow-key panning.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'KeyP' && !e.repeat) {
        if (open && agentId === null) setOpen(false);
        else openOverview();
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        e.preventDefault();
        if (agentId !== null) go(index + (e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.stopPropagation();
        e.preventDefault();
        const box = agentId === null ? overviewBox : window.matchMedia('(max-width: 720px)').matches ? sheet : page;
        box.scrollBy({ top: e.key === 'ArrowUp' ? -48 : 48 });
      }
    },
    true,
  );

  return {
    get isOpen() {
      return open;
    },
    get agentId() {
      return agentId;
    },
    setOpen,
    openOverview,
    openFor,
    entryCount: (id) => entries(id).length,
    hasUnread: unread,
    setWorld(w, sameScene) {
      if (w === world) return;
      unsubscribe();
      world = w;
      unsubscribe = src.onChange(world, onEntry);
      dirty = true;
      if (!sameScene) {
        // another place: its past entries are not news
        known.clear();
        readKey.clear();
        pending = [];
        agentId = null;
        index = -1;
        for (const a of world.agents) for (const e of entries(a.id)) known.add(`${e.agentId}:${e.day}`);
        lastPrint = fingerprint();
      } else checkExternal();
      if (open) render();
      reportUnread();
    },
    update() {
      checkExternal();
      if (dirty && open) render();
      if (dirty && !open) dirty = false;
      reportUnread();
    },
  };
}
