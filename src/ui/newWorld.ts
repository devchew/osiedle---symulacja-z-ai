import './ui.css';
import { el } from './dom';
import { newWorldLink, randomSeed } from './saves';

export interface NewWorldDialog {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
}

export interface NewWorldOptions {
  /** current values, used as defaults */
  seed: number;
  agentCount: number;
  /** one bed per resident */
  maxAgents: number;
  /** navigates to the new world (default: location.assign) */
  start?(url: string): void;
}

/** modal "Nowy świat": seed (or random) and number of residents */
export function createNewWorldDialog(opts: NewWorldOptions): NewWorldDialog {
  const backdrop = el('div', 'ui-modal-backdrop');
  backdrop.hidden = true;
  const form = el('form', 'ui-panel ui-modal newworld');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-labelledby', 'newworld-title');
  form.noValidate = true;

  const title = el('h2', 'panel-title', ['✨ Nowy świat']);
  title.id = 'newworld-title';
  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Anuluj (Esc)';

  const seedInput = el('input', 'ui-input newworld-seed');
  seedInput.type = 'text';
  seedInput.inputMode = 'numeric';
  seedInput.autocomplete = 'off';
  seedInput.id = 'newworld-seed';
  seedInput.placeholder = `losowe (teraz: ${opts.seed})`;
  const diceBtn = el('button', 'ui-btn newworld-dice', ['🎲']);
  diceBtn.type = 'button';
  diceBtn.title = 'Losuj ziarno';
  diceBtn.addEventListener('click', () => {
    seedInput.value = String(randomSeed());
    seedInput.focus();
  });
  const seedLabel = el('label', 'ui-field-label', ['Ziarno świata']);
  seedLabel.htmlFor = seedInput.id;

  const count = el('output', 'newworld-count');
  const range = el('input', 'newworld-range');
  range.type = 'range';
  range.min = '1';
  range.max = String(opts.maxAgents);
  range.step = '1';
  range.id = 'newworld-agents';
  const rangeLabel = el('label', 'ui-field-label', ['Mieszkańcy']);
  rangeLabel.htmlFor = range.id;
  const people = el('div', 'newworld-people');
  const syncCount = (): void => {
    const n = Number(range.value);
    count.textContent = String(n);
    people.replaceChildren(
      ...Array.from({ length: opts.maxAgents }, (_, i) => el('span', i < n ? 'is-on' : '', ['●'])),
    );
  };
  range.addEventListener('input', syncCount);

  const cancelBtn = el('button', 'ui-btn', ['Anuluj']);
  cancelBtn.type = 'button';
  const startBtn = el('button', 'ui-btn ui-btn--primary newworld-start', ['Zacznij']);
  startBtn.type = 'submit';

  form.append(
    el('header', 'panel-header', [title, closeBtn]),
    el('div', 'ui-field', [seedLabel, el('div', 'newworld-seed-row', [seedInput, diceBtn])]),
    el('p', 'ui-field-hint', ['To samo ziarno = ten sam świat i te same zdarzenia. Puste pole wylosuje nowe.']),
    el('div', 'ui-field', [
      el('div', 'newworld-count-row', [rangeLabel, count]),
      range,
      people,
    ]),
    el('p', 'ui-field-hint', [`Jedno łóżko na osobę — najwyżej ${opts.maxAgents}.`]),
    el('div', 'ui-modal-actions', [cancelBtn, startBtn]),
  );
  backdrop.append(form);
  document.body.append(backdrop);

  let open = false;
  let returnFocus: Element | null = null;

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    backdrop.hidden = !o;
    if (o) {
      document.body.dataset.modal = 'open';
      returnFocus = document.activeElement;
      seedInput.value = '';
      range.value = String(Math.min(opts.maxAgents, opts.agentCount));
      syncCount();
      seedInput.focus();
    } else {
      delete document.body.dataset.modal;
      (returnFocus as HTMLElement | null)?.focus?.();
    }
  }

  closeBtn.addEventListener('click', () => setOpen(false));
  cancelBtn.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) setOpen(false);
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = seedInput.value.replace(/\D/g, '');
    const seed = Math.min(999_999_999, Number(raw)) || randomSeed();
    const n = Math.max(1, Math.min(opts.maxAgents, Number(range.value)));
    (opts.start ?? ((u: string) => location.assign(u)))(newWorldLink(seed, n));
  });

  return {
    get isOpen() {
      return open;
    },
    setOpen,
  };
}
