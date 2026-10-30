import './a11y.css';
import type { World } from '../types';
import { el, isTypingTarget, setText } from './dom';
import { actionInfo } from './inspector';
import { isGuest } from '../agents/role';

// Accessibility layer shared by every mode: a keyboard- and screen-reader-friendly list of the
// residents and what they are doing (the canvas itself cannot be read), a calm live digest,
// keyboard selection ([ / ]), focus handling for panels and Polish labels for icon-only buttons.
// Self-contained: the view only feeds it the world, the selection and the clock.

const LIST_REFRESH_MS = 3000;
const DIGEST_MS = 60_000;
const PANEL_SELECTOR = 'section.ui-panel[aria-label], aside.ui-panel[aria-label]';

export interface A11yOptions {
  world: World;
  /** selects a resident and brings them into view (like a click + follow) */
  onPick(id: number): void;
  /** clock text of the world, e.g. "12:05" */
  clock(): string;
}

export interface A11y {
  update(): void;
  setWorld(world: World, sameScene: boolean): void;
  setSelected(id: number | null): void;
  /** previous / next resident relative to the selection */
  cycle(dir: 1 | -1): void;
}

function describe(world: World, a: World['agents'][number]): string {
  const info = actionInfo(a.action, world);
  return `${a.name}${isGuest(a) ? ' (gość)' : ''} — ${info.text}${info.state ? ` (${info.state})` : ''}`;
}

export function createA11y(opts: A11yOptions): A11y {
  let world = opts.world;
  let selected: number | null = null;

  const skip = el('a', 'a11y-skip', ['Przejdź do listy mieszkańców']);
  skip.href = '#a11y-residents';

  const region = el('section', 'a11y-residents');
  region.id = 'a11y-residents';
  region.tabIndex = -1;
  region.setAttribute('aria-label', 'Mieszkańcy osiedla');
  const intro = el('p', 'a11y-intro', ['Mieszkańcy (i goście) oraz ich bieżące zajęcia. Enter pokazuje postać na mapie. Klawisze [ i ] przełączają postacie.']);
  const list = el('ul', 'a11y-list');
  region.append(intro, list);

  const digest = el('p', 'a11y-sr-only');
  digest.id = 'a11y-digest';
  digest.setAttribute('role', 'status');
  digest.setAttribute('aria-live', 'polite');
  digest.setAttribute('aria-atomic', 'true');

  document.body.prepend(skip);
  document.body.append(region, digest);
  skip.addEventListener('click', (e) => {
    e.preventDefault(); // a hash change would be read as a resident link
    (list.querySelector<HTMLElement>('button') ?? region).focus();
  });

  const canvas = document.getElementById('world');
  canvas?.setAttribute('role', 'img');
  canvas?.setAttribute('aria-label', 'Mapa osiedla widziana z góry. Opis tego, co robią mieszkańcy, jest na liście mieszkańców.');
  const hud = document.getElementById('hud');
  hud?.setAttribute('role', 'group');
  hud?.setAttribute('aria-label', 'Zegar i narzędzia');

  const rows = new Map<number, { li: HTMLElement; btn: HTMLButtonElement }>();
  let lastList = -Infinity;
  let lastDigest = -Infinity;
  let digestText = '';

  function syncRoster(): void {
    const ids = world.agents.map((a) => a.id);
    if (ids.length === rows.size && ids.every((id) => rows.has(id))) return;
    const focusedId = [...rows].find(([, r]) => r.btn === document.activeElement)?.[0];
    rows.clear();
    list.replaceChildren();
    for (const a of world.agents) {
      const btn = el('button', 'a11y-resident');
      btn.type = 'button';
      btn.addEventListener('click', () => opts.onPick(a.id));
      const li = el('li', '', [btn]);
      rows.set(a.id, { li, btn });
      list.append(li);
    }
    if (focusedId !== undefined) rows.get(focusedId)?.btn.focus();
  }

  function refreshList(): void {
    syncRoster();
    for (const a of world.agents) {
      const r = rows.get(a.id);
      if (!r) continue;
      setText(r.btn, describe(world, a));
      r.btn.setAttribute('aria-pressed', String(a.id === selected));
    }
  }

  // one calm announcement a minute (the live world itself moves once a minute), only when it changed
  function refreshDigest(): void {
    const text = `Godzina ${opts.clock()}. ${world.agents.map((a) => describe(world, a)).join('. ')}.`;
    if (text !== digestText) {
      digestText = text;
      digest.textContent = text;
    }
  }

  // "Pauza (spacja)" etc.: icon buttons known only by a title get the same text as an accessible name
  function labelButtons(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.ui-panel button[title]')) {
      if (b.hasAttribute('aria-label') && !b.dataset.a11yAuto) continue;
      b.dataset.a11yAuto = '1';
      if (b.getAttribute('aria-label') !== b.title) b.setAttribute('aria-label', b.title);
    }
  }

  // panels: focus moves in when one opens from the keyboard and returns to where it came from
  let keyboard = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') keyboard = true;
  });
  window.addEventListener('pointerdown', () => (keyboard = false));
  const openers = new Map<Element, HTMLElement | null>();
  new MutationObserver((records) => {
    for (const rec of records) {
      const p = rec.target as HTMLElement;
      if (!p.matches?.(PANEL_SELECTOR)) continue;
      if (!p.hidden) {
        if (!keyboard || openers.has(p)) continue;
        const active = document.activeElement as HTMLElement | null;
        openers.set(p, active && active !== document.body ? active : null);
        if (!p.hasAttribute('tabindex')) p.tabIndex = -1;
        p.focus({ preventScroll: true });
      } else if (openers.has(p)) {
        const back = openers.get(p);
        openers.delete(p);
        const active = document.activeElement;
        if (back?.isConnected && (!active || active === document.body || p.contains(active))) back.focus({ preventScroll: true });
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

  function cycle(dir: 1 | -1): void {
    const n = world.agents.length;
    if (!n) return;
    const i = world.agents.findIndex((a) => a.id === selected);
    const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    opts.onPick(world.agents[next].id);
  }
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || e.repeat) return;
    if (e.key === ']') cycle(1);
    else if (e.key === '[') cycle(-1);
  });

  function update(): void {
    const now = performance.now();
    if (now - lastList >= LIST_REFRESH_MS) {
      lastList = now;
      refreshList();
    }
    if (now - lastDigest >= DIGEST_MS) {
      lastDigest = now;
      refreshDigest();
    }
    labelButtons();
  }
  update();

  return {
    update,
    setWorld(w, sameScene) {
      world = w;
      if (sameScene) return;
      lastList = -Infinity;
      lastDigest = -Infinity;
      update();
    },
    setSelected(id) {
      selected = id;
      for (const [rid, r] of rows) r.btn.setAttribute('aria-pressed', String(rid === id));
    },
    cycle,
  };
}
