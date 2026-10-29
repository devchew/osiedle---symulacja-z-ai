// first: the simulation's modules have import cycles (world/objects ↔ world/projects ↔ incidents,
// maps); evaluating them from world/world.ts, as the tests and the server do, keeps their
// top-level state identical — another entry order changed the simulation (seed 1 diverged).
import './world/world';
import { parseRoute } from './live/routes';

// Entry: picks the mode from the URL (see live/routes.ts).
//   /, /dom, /kamienica, /jezioro, /akademik → live view of a server world (live/liveApp.ts)
//   /sandbox?from=<place>                    → "Co będzie dalej?" copy in this tab (live/sandboxApp.ts)
//   /lab?seed=…                              → standalone simulation for development and tests (ui/lab.ts)
// Each mode is loaded on demand, so the live view does not ship the lab's dialogs.

const route = parseRoute(location.pathname, location.search);

async function main(): Promise<void> {
  if (route.kind === 'lab') {
    const { startLab } = await import('./ui/lab');
    await startLab();
  } else if (route.kind === 'sandbox') {
    const { startSandbox } = await import('./live/sandboxApp');
    await startSandbox(route.place);
  } else {
    const { startLive } = await import('./live/liveApp');
    startLive(route.place);
  }
}

void main();
