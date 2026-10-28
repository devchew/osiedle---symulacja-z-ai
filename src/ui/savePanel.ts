import './ui.css';
import { formatClock, timeFromTick } from '../core/time';
import type { World } from '../types';
import { el, isTypingTarget, setText } from './dom';
import { linkFor, readSaves, SAVE_VERSION, saveFromWorld, SLOT_COUNT, writeSave, type SaveData } from './saves';
import { toast } from './toast';

export interface SavePanelOptions {
  /** AI dialogues are on (replays may differ) */
  isAi(): boolean;
  isPaused(): boolean;
  onNewWorld(): void;
  /** called when the panel opens / closes (HUD button state, closing other panels) */
  onToggle?(open: boolean): void;
}

export interface SavePanel {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  /** writes the autosave (main calls it every game hour) */
  autosave(): void;
}

function describe(s: SaveData): string {
  const t = timeFromTick(s.tick);
  return `Dzień ${t.day}, ${formatClock(t)} · 👥 ${s.agentCount} · ziarno ${s.seed}`;
}

function savedWhen(s: SaveData): string {
  const d = new Date(s.savedAt);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return today ? `zapisano dziś ${hm}` : `zapisano ${d.toLocaleDateString('pl-PL')} ${hm}`;
}

/** copies text; falls back to a selected read-only field when the clipboard API is unavailable */
async function copyText(text: string, fallback: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    fallback.hidden = false;
    fallback.value = text;
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/** "Zapis gry" panel under the HUD: manual slots, autosave, share link, new world */
export function createSavePanel(world: World, opts: SavePanelOptions): SavePanel {
  const root = el('section', 'ui-panel ui-save');
  root.id = 'save-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Zapis gry');

  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Zamknij (Esc)';
  closeBtn.addEventListener('click', () => setOpen(false));
  const current = el('p', 'save-current');
  const list = el('ul', 'save-slots');

  const linkBtn = el('button', 'ui-btn save-link', ['🔗 Kopiuj link']);
  linkBtn.type = 'button';
  linkBtn.title = 'Link odtwarza ten świat w tej samej chwili (ziarno, mieszkańcy, czas)';
  const linkField = el('input', 'save-link-field');
  linkField.readOnly = true;
  linkField.hidden = true;
  linkField.setAttribute('aria-label', 'Link do tej chwili');
  linkBtn.addEventListener('click', async () => {
    const url = linkFor(saveFromWorld(world));
    const ok = await copyText(url, linkField);
    toast(ok ? 'Link skopiowany do schowka' : 'Skopiuj link z pola poniżej');
  });
  const newBtn = el('button', 'ui-btn save-new', ['✨ Nowy świat…']);
  newBtn.type = 'button';
  newBtn.title = 'Nowy świat (N)';
  newBtn.addEventListener('click', () => {
    setOpen(false);
    opts.onNewWorld();
  });

  const note = el('p', 'save-note', [
    'Zapis to ziarno świata i czas — wczytanie odtwarza symulację od początku. ',
    el('span', 'save-note-ai', ['Przy dialogach AI odtworzony przebieg może się różnić.']),
  ]);

  root.append(
    el('header', 'panel-header', [el('h2', 'panel-title', ['💾 Zapis gry']), closeBtn]),
    current,
    list,
    el('div', 'save-actions', [linkBtn, newBtn]),
    linkField,
    note,
  );
  document.body.append(root);

  let open = false;

  function load(s: SaveData): void {
    if (s.version !== SAVE_VERSION) toast('Zapis z innej wersji gry — stan może się różnić', 'warn');
    location.assign(linkFor(s, { paused: opts.isPaused() }));
  }

  function slotRow(label: string, s: SaveData | null, slot: number | 'auto'): HTMLElement {
    const meta = el('span', 'save-meta', [s ? describe(s) : 'pusty']);
    const when = el('span', 'save-when', [s ? savedWhen(s) : '']);
    if (s?.ai) {
      const badge = el('span', 'save-ai', ['AI']);
      badge.title = 'Zapisano przy dialogach AI — odtworzenie może się różnić';
      when.append(badge);
    }
    const info = el('div', 'save-info', [el('span', 'save-label', [label]), meta, when]);
    const buttons: HTMLElement[] = [];
    if (slot !== 'auto') {
      const saveBtn = el('button', 'ui-btn ui-btn--small save-btn-save', ['Zapisz']);
      saveBtn.type = 'button';
      saveBtn.title = s ? 'Nadpisz ten slot' : 'Zapisz w tym slocie';
      saveBtn.addEventListener('click', () => {
        const ok = writeSave(slot, saveFromWorld(world, opts.isAi()));
        toast(ok ? `Zapisano w slocie ${slot + 1}` : 'Nie udało się zapisać (pamięć przeglądarki niedostępna)', ok ? 'info' : 'warn');
        render();
      });
      buttons.push(saveBtn);
    }
    const loadBtn = el('button', 'ui-btn ui-btn--small ui-btn--primary save-btn-load', ['Wczytaj']);
    loadBtn.type = 'button';
    loadBtn.disabled = !s;
    if (s) loadBtn.addEventListener('click', () => load(s));
    buttons.push(loadBtn);
    const row = el('li', `save-slot${s ? '' : ' is-empty'}`, [info, el('div', 'save-btns', buttons)]);
    row.dataset.slot = String(slot);
    return row;
  }

  function render(): void {
    const store = readSaves();
    const t = timeFromTick(world.tick);
    setText(current, `Teraz: dzień ${t.day}, ${formatClock(t)} · 👥 ${world.agents.length} · ziarno ${world.seed}`);
    list.replaceChildren(
      ...Array.from({ length: SLOT_COUNT }, (_, i) => slotRow(`Slot ${i + 1}`, store.slots[i], i)),
      slotRow('Autozapis', store.auto, 'auto'),
    );
    note.classList.toggle('is-ai', opts.isAi());
  }

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    root.hidden = !o;
    linkField.hidden = true;
    if (o) render();
    opts.onToggle?.(o);
  }

  // Esc closes; Z toggles (capture: runs before the inspector's Esc)
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTypingTarget(e)) return;
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        setOpen(false);
      } else if (e.code === 'KeyZ' && !e.repeat) setOpen(!open);
    },
    true,
  );
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (open && !root.contains(t) && !t.closest?.('[data-panel="save"]')) setOpen(false);
  });

  return {
    get isOpen() {
      return open;
    },
    setOpen,
    autosave() {
      if (world.tick <= 0) return;
      writeSave('auto', saveFromWorld(world, opts.isAi()));
      if (open) render();
    },
  };
}
