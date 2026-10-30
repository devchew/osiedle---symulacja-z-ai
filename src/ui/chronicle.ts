import './ui.css';
import './chronicle.css';
import { formatClock, timeFromTick } from '../core/time';
import { LIVE_TIME_ZONE, type ChronicleDayView, type ChronicleItem, type ChronicleResponse, type PlaceId } from '../live/protocol';
import { CHRONICLE_LABELS, type ChronicleKind } from '../social/chronicle';
import { el, isTypingTarget, setText } from './dom';

// "📜 Kronika" panel (key K), live view only: the place's most important events of the last days
// (pairs, quarrels, finished projects, shared activities, breakdowns, weather) with a short
// summary per day. Read-only; the data comes from GET /api/live/:place/chronicle, kept on the
// server across restarts.

export interface ChroniclePanelOptions {
  /** loads the chronicle of a place (rejects on errors) */
  load(place: PlaceId): Promise<ChronicleResponse>;
  onToggle?(open: boolean): void;
  onSelectAgent?(id: number): void;
  /** does the resident have diary entries to link to? */
  hasDiary?(id: number): boolean;
  onOpenDiary?(id: number): void;
  /** reload period while the panel is open (default 5 min) */
  refreshMs?: number;
}

export interface ChroniclePanel {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  /** another place was selected */
  setPlace(place: PlaceId): void;
}

export const CHRONICLE_REFRESH_MS = 5 * 60_000;

const DAY_FORMAT = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

const warsawDate = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: LIVE_TIME_ZONE }).format(new Date(ms));

/** "Dziś", "Wczoraj" or "czwartek, 29 października" */
export function dayLabel(date: string, now: number = Date.now()): string {
  if (date === warsawDate(now)) return 'Dziś';
  if (date === warsawDate(now - 86_400_000)) return 'Wczoraj';
  const label = DAY_FORMAT.format(new Date(`${date}T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function itemTime(tick: number): string {
  return formatClock(timeFromTick(tick));
}

export function createChroniclePanel(initialPlace: PlaceId, opts: ChroniclePanelOptions): ChroniclePanel {
  let place = initialPlace;
  const root = el('section', 'ui-panel ui-chronicle');
  root.id = 'chronicle-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Kronika miejsca');

  const subtitle = el('span', 'panel-sub', ['ostatnie dni']);
  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Zamknij (Esc)';
  closeBtn.setAttribute('aria-label', 'Zamknij (Esc)');
  const body = el('div', 'chr-body');
  root.append(el('header', 'panel-header', [el('h2', 'panel-title', ['📜 Kronika']), subtitle, closeBtn]), body);
  document.body.append(root);

  let open = false;
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let shown: ChronicleResponse | null = null;

  function note(text: string): HTMLElement {
    const p = el('p', 'chr-note', [text]);
    p.setAttribute('role', 'status');
    return p;
  }

  function personButton(it: ChronicleItem): HTMLElement[] {
    const id = it.agentIds[0];
    if (id === undefined) return [];
    const out: HTMLElement[] = [];
    if (opts.onSelectAgent) {
      const b = el('button', 'chr-link', ['👤']);
      b.type = 'button';
      b.title = 'Pokaż na mapie';
      b.setAttribute('aria-label', 'Pokaż mieszkańca na mapie');
      b.addEventListener('click', () => opts.onSelectAgent!(id));
      out.push(b);
    }
    if (opts.onOpenDiary && opts.hasDiary?.(id)) {
      const b = el('button', 'chr-link', ['📔']);
      b.type = 'button';
      b.title = 'Pamiętnik';
      b.setAttribute('aria-label', 'Otwórz pamiętnik');
      b.addEventListener('click', () => opts.onOpenDiary!(id));
      out.push(b);
    }
    return out;
  }

  function itemRow(it: ChronicleItem): HTMLElement {
    return el('li', `chr-item chr-item--${it.kind}`, [
      el('span', 'chr-icon', [it.icon]),
      el('time', 'chr-time', [itemTime(it.tick)]),
      el('span', 'chr-text', [it.text]),
      el('span', 'chr-links', personButton(it)),
    ]);
  }

  function dayCard(d: ChronicleDayView): HTMLElement {
    const kinds = [...new Set(d.items.map((i) => i.kind))] as ChronicleKind[];
    const summary = el('p', 'chr-summary', [d.summary]);
    const head = el('h3', 'chr-day-title', [dayLabel(d.date), el('span', 'chr-day-date', [d.date])]);
    const parts: HTMLElement[] = [head, summary];
    if (d.summarySource === 'ai') summary.append(el('span', 'chr-ai', ['✨ podsumowanie AI']));
    const list = el('ol', 'chr-list', d.items.map(itemRow));
    list.setAttribute('aria-label', kinds.map((k) => CHRONICLE_LABELS[k]).join(', '));
    parts.push(list);
    if (d.total > d.items.length) parts.push(el('p', 'chr-more', [`+ ${d.total - d.items.length} mniej ważnych`]));
    return el('article', 'chr-day', parts);
  }

  function render(): void {
    if (!shown) return;
    if (shown.days.length === 0) {
      body.replaceChildren(note('Kronika jest jeszcze pusta — historia zapisuje się na bieżąco.'));
      setText(subtitle, 'ostatnie dni');
      return;
    }
    setText(subtitle, `${shown.days.length} ${shown.days.length === 1 ? 'dzień' : 'dni'}`);
    body.replaceChildren(...shown.days.map(dayCard));
  }

  async function refresh(): Promise<void> {
    const mine = ++seq;
    const target = place;
    try {
      const data = await opts.load(target);
      if (mine !== seq) return;
      shown = data;
      render();
    } catch {
      if (mine !== seq) return;
      // keep what is already shown; say so only when there is nothing
      if (!shown) body.replaceChildren(note('Nie udało się pobrać kroniki. Spróbuj za chwilę.'));
    }
  }

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    root.hidden = !o;
    if (timer) clearInterval(timer);
    timer = null;
    if (o) {
      if (!shown) body.replaceChildren(note('Wczytywanie kroniki…'));
      void refresh();
      timer = setInterval(() => void refresh(), opts.refreshMs ?? CHRONICLE_REFRESH_MS);
    } else seq++;
    opts.onToggle?.(o);
  }

  closeBtn.addEventListener('click', () => setOpen(false));
  // K toggles; Esc closes (capture: before the inspector's Esc)
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTypingTarget(e)) return;
      if (e.code === 'KeyK' && !e.repeat) {
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
    setPlace(p) {
      if (p === place) return;
      place = p;
      shown = null;
      seq++;
      if (open) {
        body.replaceChildren(note('Wczytywanie kroniki…'));
        void refresh();
      }
    },
  };
}
