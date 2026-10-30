import { parseRoute } from './live/routes';

// Entry: the live view of a server world (live/liveApp.ts). The path picks the place
// (/, /dom, /kamienica, /jezioro, /akademik; see live/routes.ts).

const route = parseRoute(location.pathname);

void import('./live/liveApp').then(({ startLive }) => startLive(route.place));
