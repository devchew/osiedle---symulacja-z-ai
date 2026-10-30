import { parseRoute } from './live/routes';

// Entry: picks the mode from the URL (see live/routes.ts).
//   /, /dom, /kamienica, /jezioro, /akademik → live view of a server world (live/liveApp.ts)
//   /lab?seed=…                              → standalone simulation for development and tests (ui/lab.ts)
// Each mode is loaded on demand, so the live view does not ship the lab's dialogs.

const route = parseRoute(location.pathname);

async function main(): Promise<void> {
  if (route.kind === 'lab') {
    const { startLab } = await import('./ui/lab');
    await startLab();
  } else {
    const { startLive } = await import('./live/liveApp');
    startLive(route.place);
  }
}

void main();
