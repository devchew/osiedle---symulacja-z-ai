import './ui.css';
import './live.css';
import type { PlaceDef, PlaceId, PlaceSummary } from '../live/protocol';
import { el, setText } from './dom';

// Live-view chrome: the place switcher (4 fixed places, the current highlight and temperature
// from /api/live/places), the "🔮 Co będzie dalej?" fork button, the connection banner, and the
// sandbox banner with "↩ Wróć na żywo".

const PLACE_ICON: Record<PlaceId, string> = { dom: '🏡', kamienica: '🏛️', jezioro: '🛶', akademik: '🎓' };

export function placeIcon(id: PlaceId): string {
  return PLACE_ICON[id] ?? '🏠';
}

export interface PlaceBar {
  setCurrent(id: PlaceId): void;
  setSummaries(list: readonly PlaceSummary[]): void;
}

export interface PlaceBarOptions {
  places: readonly PlaceDef[];
  current: PlaceId;
  /** href of a place (real links: middle-click / new tab work) */
  href(id: PlaceId): string;
  onSelect(id: PlaceId): void;
  /** "Co będzie dalej?" */
  forkHref(id: PlaceId): string;
  onFork(id: PlaceId): void;
}

/** "18°C" / "" */
function temp(t: number | null | undefined): string {
  return t == null ? '' : `${Math.round(t)}°C`;
}

const plainClick = (e: MouseEvent): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function createPlaceBar(opts: PlaceBarOptions): PlaceBar {
  const root = el('nav', 'ui-panel ui-places');
  root.id = 'places';
  root.setAttribute('aria-label', 'Miejsca');
  const title = el('h2', 'places-title', ['Osiedle na żywo']);
  const list = el('ul', 'places-list');
  let current = opts.current;

  const items = new Map<PlaceId, { a: HTMLAnchorElement; temp: HTMLElement; weather: HTMLElement; hl: HTMLElement; awake: HTMLElement }>();
  for (const p of opts.places) {
    const tempEl = el('span', 'place-temp');
    const weather = el('span', 'place-weather');
    const hl = el('span', 'place-hl');
    const awake = el('span', 'place-awake');
    const a = el('a', 'place-card', [
      el('span', 'place-icon', [placeIcon(p.id)]),
      el('span', 'place-body', [
        el('span', 'place-head', [el('span', 'place-name', [p.name]), weather, tempEl]),
        el('span', 'place-city', [p.city, awake]),
        hl,
      ]),
    ]);
    a.href = opts.href(p.id);
    a.dataset.place = p.id;
    a.title = `${p.name} — ${p.city}`;
    a.addEventListener('click', (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      if (p.id !== current) opts.onSelect(p.id);
    });
    items.set(p.id, { a, temp: tempEl, weather, hl, awake });
    list.append(el('li', '', [a]));
  }

  const fork = el('a', 'places-fork', [el('span', 'places-fork-icon', ['🔮']), el('span', 'places-fork-text', ['Co będzie dalej?'])]);
  fork.setAttribute('aria-label', 'Co będzie dalej? Przewiń czas na własnej kopii');
  fork.title = 'Skopiuj ten świat do swojej przeglądarki i przewiń czas do przodu — świat na żywo się nie zmieni';
  fork.addEventListener('click', (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    opts.onFork(current);
  });

  root.append(title, list, fork);
  document.body.append(root);

  function setCurrent(id: PlaceId): void {
    current = id;
    for (const [pid, it] of items) {
      const on = pid === id;
      it.a.classList.toggle('is-current', on);
      if (on) it.a.setAttribute('aria-current', 'page');
      else it.a.removeAttribute('aria-current');
    }
    fork.href = opts.forkHref(id);
    // phones: keep the current tab in view
    items.get(id)?.a.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  setCurrent(current);

  return {
    setCurrent,
    setSummaries(summaries) {
      for (const s of summaries) {
        const it = items.get(s.id);
        if (!it) continue;
        setText(it.temp, temp(s.temperature));
        setText(it.weather, s.weatherIcon ?? '');
        setText(it.hl, s.highlight ?? '');
        it.hl.hidden = !s.highlight;
        setText(it.awake, s.residents ? ` · nie śpi ${s.awake}/${s.residents}` : '');
        it.a.title = `${s.name} — ${s.city}${s.highlight ? `\n${s.highlight}` : ''}`;
      }
    },
  };
}

export type ConnState = 'connecting' | 'online' | 'offline';

export interface ConnBanner {
  set(state: ConnState, retryInMs?: number | null): void;
}

/** "Łączenie z osiedlem…" while there is no live connection (hidden when online) */
export function createConnBanner(): ConnBanner {
  const text = el('span', 'conn-text');
  const root = el('div', 'ui-panel ui-conn', [el('span', 'conn-spinner'), text]);
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;
  document.body.append(root);
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    set(state, retryInMs) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (state === 'online') {
        root.hidden = true;
        return;
      }
      const show = (): void => {
        root.hidden = false;
        root.dataset.state = state;
        setText(text, state === 'offline' && retryInMs ? `Łączenie z osiedlem… (ponowna próba za ${Math.max(1, Math.round(retryInMs / 1000))} s)` : 'Łączenie z osiedlem…');
      };
      // a quick reconnect does not flash the banner
      if (root.hidden) timer = setTimeout(show, state === 'connecting' ? 900 : 0);
      else show();
    },
  };
}

export interface SandboxBarOptions {
  placeName: string;
  /** "dzień 3, 14:05" — when the copy was taken */
  forkedAt: string;
  backHref: string;
  onBack(): void;
  /** take a fresh copy of the live world */
  onRefork(): void;
}

/** sandbox: clear banner that this is a private copy, with the way back */
export function createSandboxBar(opts: SandboxBarOptions): void {
  const back = el('a', 'sbx-back', ['↩ Wróć na żywo']);
  back.href = opts.backHref;
  back.addEventListener('click', (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    opts.onBack();
  });
  const refork = el('button', 'sbx-refork', ['⟳ Nowa kopia']);
  refork.type = 'button';
  refork.title = 'Zacznij od nowa od obecnego stanu świata na żywo';
  refork.addEventListener('click', () => opts.onRefork());
  const root = el('aside', 'ui-panel ui-sandbox', [
    el('div', 'sbx-head', [el('span', 'sbx-icon', ['🔮']), el('strong', 'sbx-title', ['Co będzie dalej?'])]),
    el('p', 'sbx-text', ['Symulacja w Twojej przeglądarce — świat na żywo toczy się dalej bez zmian.']),
    el('p', 'sbx-from', [`Kopia: ${opts.placeName}, ${opts.forkedAt}`]),
    el('div', 'sbx-actions', [back, refork]),
  ]);
  root.id = 'sandbox-bar';
  root.setAttribute('role', 'note');
  document.body.append(root);
}
