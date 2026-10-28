import './ui.css';
import './houses.css';
import { el, storageGet, storageSet } from './dom';
import { newWorldLink, randomSeed } from './saves';
import { MAPS, getMap, type MapData } from '../world/maps';
import { OBJECT_DEFS, footprint } from '../world/objects';
import type { TileKind } from '../types';

export interface NewWorldDialog {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
}

export interface NewWorldOptions {
  /** current values, used as defaults */
  seed: number;
  agentCount: number;
  /** beds in the current house (the dialog counts beds per house itself; kept for callers) */
  maxAgents: number;
  /** current house id (default: ?map= of this page) */
  mapId?: string;
  /** current world runs in real-time mode (default: ?mode=real of this page) */
  realtime?: boolean;
  /** navigates to the new world (default: location.assign) */
  start?(url: string): void;
}

/** last choice in the dialog (localStorage, best effort) */
const STORAGE_KEY = 'sim.newworld.v1';
interface LastChoice {
  map?: string;
  agents?: number;
  realtime?: boolean;
}

function readLast(): LastChoice {
  try {
    const v = JSON.parse(storageGet(STORAGE_KEY) ?? 'null') as LastChoice | null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function bedsLabel(n: number): string {
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${n === 1 ? 'łóżko' : last >= 2 && last <= 4 && !teen ? 'łóżka' : 'łóżek'}`;
}

const TILE_COLORS: Record<TileKind, string> = {
  grass: '#7fae5f',
  path: '#d9c79e',
  floor: '#d6b07f',
  tile: '#ebe6dc',
  wall: '#3d3431',
  door: '#9a6a3a',
  water: '#4c8fc4',
};

/** small top-down schematic of a house: tiles plus coloured object footprints */
export function drawMapPreview(canvas: HTMLCanvasElement, map: MapData, cssWidth = 220): void {
  const g = map.grid;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const cell = cssWidth / g.width;
  canvas.style.aspectRatio = `${g.width} / ${g.height}`;
  canvas.width = Math.round(g.width * cell * dpr);
  canvas.height = Math.round(g.height * cell * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = canvas.width / g.width;
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++) {
      ctx.fillStyle = TILE_COLORS[g.tiles[y * g.width + x]];
      ctx.fillRect(x * s, y * s, s + 0.5, s + 0.5);
    }
  for (const o of map.objects) {
    const def = OBJECT_DEFS[o.type];
    if (!def || o.type === 'rug' || o.type === 'lamp') continue;
    const round = o.type === 'tree' || o.type === 'bush';
    ctx.fillStyle = o.type === 'tree' ? '#2f6b45' : o.type === 'fishing_spot' ? '#a68a64' : def.color;
    for (const p of footprint(o, def)) {
      if (round) {
        ctx.beginPath();
        ctx.arc((p.x + 0.5) * s, (p.y + 0.5) * s, s * (o.type === 'tree' ? 0.75 : 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(p.x * s + s * 0.1, p.y * s + s * 0.1, s * 0.8, s * 0.8);
    }
  }
}

/** modal "Nowy świat": house, seed (or random), number of residents, real-time mode */
export function createNewWorldDialog(opts: NewWorldOptions): NewWorldDialog {
  const params = new URLSearchParams(location.search);
  const currentMap = getMap(opts.mapId ?? params.get('map')).id;
  const currentRealtime = opts.realtime ?? params.get('mode') === 'real';
  // layouts are built once, for previews and bed counts
  const houses = MAPS.map((def) => {
    const data = def.create();
    return { def, data, beds: data.objects.filter((o) => o.type === 'bed').length };
  });

  const backdrop = el('div', 'ui-modal-backdrop');
  backdrop.hidden = true;
  const form = el('form', 'ui-panel ui-modal newworld newworld--houses');
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-labelledby', 'newworld-title');
  form.noValidate = true;

  const title = el('h2', 'panel-title', ['✨ Nowy świat']);
  title.id = 'newworld-title';
  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Anuluj (Esc)';

  // ------------------------------------------------------------ house picker
  let selected = currentMap;
  const houseLabel = el('span', 'ui-field-label', ['Dom']);
  houseLabel.id = 'newworld-houses-label';
  const picker = el('div', 'newworld-houses');
  picker.setAttribute('role', 'radiogroup');
  picker.setAttribute('aria-labelledby', houseLabel.id);
  const cards = houses.map(({ def, data, beds }) => {
    const card = el('button', 'newworld-house');
    card.type = 'button';
    card.dataset.map = def.id;
    card.setAttribute('role', 'radio');
    const preview = el('canvas', 'newworld-preview');
    preview.setAttribute('aria-hidden', 'true');
    drawMapPreview(preview, data);
    card.append(
      preview,
      el('span', 'newworld-house-name', [def.name]),
      el('span', 'newworld-house-desc', [def.description]),
      el('span', 'newworld-house-beds', [`🛏️ ${bedsLabel(beds)}`]),
    );
    card.addEventListener('click', () => select(def.id));
    return card;
  });
  picker.append(...cards);
  // arrow keys move between houses (radio group behaviour)
  picker.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = houses.findIndex((h) => h.def.id === selected);
    const next = houses[(i + step + houses.length) % houses.length].def.id;
    select(next);
    cards.find((c) => c.dataset.map === next)?.focus();
  });

  // ------------------------------------------------------------ seed
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

  // ------------------------------------------------------------ residents
  /** what the user asked for; shown clamped to the chosen house's beds */
  let wanted = opts.agentCount;
  const count = el('output', 'newworld-count');
  const range = el('input', 'newworld-range');
  range.type = 'range';
  range.min = '1';
  range.step = '1';
  range.id = 'newworld-agents';
  const rangeLabel = el('label', 'ui-field-label', ['Mieszkańcy']);
  rangeLabel.htmlFor = range.id;
  const people = el('div', 'newworld-people');
  const bedsHint = el('p', 'ui-field-hint');
  const bedsOf = (id: string): number => houses.find((h) => h.def.id === id)?.beds ?? opts.maxAgents;
  const syncCount = (): void => {
    const max = bedsOf(selected);
    const n = Number(range.value);
    count.textContent = String(n);
    people.replaceChildren(...Array.from({ length: max }, (_, i) => el('span', i < n ? 'is-on' : '', ['●'])));
    bedsHint.textContent = `Jedno łóżko na osobę — w tym domu najwyżej ${max}.`;
  };
  range.addEventListener('input', () => {
    wanted = Number(range.value);
    syncCount();
  });

  function select(id: string): void {
    selected = getMap(id).id;
    for (const c of cards) {
      const on = c.dataset.map === selected;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
      c.classList.toggle('is-selected', on);
    }
    const max = bedsOf(selected);
    range.max = String(max);
    range.value = String(Math.max(1, Math.min(max, wanted)));
    syncCount();
  }

  // ------------------------------------------------------------ real-time mode
  const realtimeBox = el('input', 'newworld-realtime');
  realtimeBox.type = 'checkbox';
  realtimeBox.id = 'newworld-realtime';
  const realtimeLabel = el('label', 'newworld-check', [realtimeBox, el('span', '', ['Tryb rzeczywisty (czas i pogoda na żywo)'])]);
  const realtimeHint = el('p', 'ui-field-hint', ['Zegar gry idzie jak Twój zegar, pogoda jest prawdziwa. Bez zapisów i powtórek.']);

  const cancelBtn = el('button', 'ui-btn', ['Anuluj']);
  cancelBtn.type = 'button';
  const startBtn = el('button', 'ui-btn ui-btn--primary newworld-start', ['Zacznij']);
  startBtn.type = 'submit';

  form.append(
    el('header', 'panel-header', [title, closeBtn]),
    el('div', 'newworld-body', [
      el('div', 'ui-field', [houseLabel, picker]),
      el('div', 'ui-field', [seedLabel, el('div', 'newworld-seed-row', [seedInput, diceBtn])]),
      el('p', 'ui-field-hint', ['To samo ziarno = ten sam świat i te same zdarzenia. Puste pole wylosuje nowe.']),
      el('div', 'ui-field', [el('div', 'newworld-count-row', [rangeLabel, count]), range, people]),
      bedsHint,
      el('div', 'ui-field', [realtimeLabel]),
      realtimeHint,
    ]),
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
      const last = readLast();
      seedInput.value = '';
      wanted = typeof last.agents === 'number' ? last.agents : opts.agentCount;
      realtimeBox.checked = typeof last.realtime === 'boolean' ? last.realtime : currentRealtime;
      select(MAPS.some((m) => m.id === last.map) ? last.map! : currentMap);
      // after the opening key (N) is done: focusing now would type "n" into the field
      setTimeout(() => open && seedInput.focus(), 0);
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
    const n = Math.max(1, Math.min(bedsOf(selected), Number(range.value)));
    const realtime = realtimeBox.checked;
    storageSet(STORAGE_KEY, JSON.stringify({ map: selected, agents: wanted, realtime } satisfies LastChoice));
    (opts.start ?? ((u: string) => location.assign(u)))(newWorldLink(seed, n, { map: selected, realtime }));
  });

  return {
    get isOpen() {
      return open;
    },
    setOpen,
  };
}
