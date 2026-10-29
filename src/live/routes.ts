import { DEFAULT_PLACE, PLACES, placeById, type PlaceId } from './protocol';

// Client routes (pure, no DOM):
//   /                      live view of the default place
//   /dom, /kamienica, …    live view of that place (PlaceDef.id = path)
//   /sandbox?from=<place>  time-controlled copy of a live world in this browser session
//   /lab?seed=…            developer/test route: the standalone simulation (not linked in the UI)
// The hash selects a resident: /kamienica#Ola or #3 (name or id).

export type Route =
  | { kind: 'live'; place: PlaceId }
  | { kind: 'sandbox'; place: PlaceId }
  | { kind: 'lab' };

/** route of a location (unknown paths fall back to the default place's live view) */
export function parseRoute(pathname: string, search = ''): Route {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  if (seg === 'lab') return { kind: 'lab' };
  if (seg === 'sandbox') {
    const from = new URLSearchParams(search).get('from');
    return { kind: 'sandbox', place: placeById(from)?.id ?? DEFAULT_PLACE };
  }
  return { kind: 'live', place: placeById(seg)?.id ?? DEFAULT_PLACE };
}

export function livePath(place: PlaceId): string {
  return `/${place}`;
}

export function sandboxPath(place: PlaceId): string {
  return `/sandbox?from=${encodeURIComponent(place)}`;
}

export const PLACE_IDS: readonly PlaceId[] = PLACES.map((p) => p.id);

/** lower-case, no Polish diacritics: "Łucja" → "lucja" */
export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .trim();
}

/** resident addressed by a URL hash (#Ola, #ola, #%C5%81ucja, #3); null when none matches */
export function agentFromHash<A extends { id: number; name: string }>(hash: string, agents: readonly A[]): A | null {
  let raw = hash.replace(/^#/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep it as typed */
  }
  raw = raw.trim();
  if (!raw) return null;
  const key = slug(raw);
  const byName = agents.find((a) => slug(a.name) === key);
  if (byName) return byName;
  if (/^\d+$/.test(raw)) return agents.find((a) => a.id === Number(raw)) ?? null;
  return null;
}

/** hash for a resident: the name (readable links like /kamienica#Ola) */
export function hashFor(agent: { name: string } | null): string {
  return agent ? `#${encodeURIComponent(agent.name)}` : '';
}
