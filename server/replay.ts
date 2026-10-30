import { join } from 'node:path';
import type { PlaceId } from '../src/live/protocol';
import type { ReplayRecorder } from '../src/live/replayRecorder';

// Persistence of the 24 h replay recording (src/live/replayRecorder.ts): DATA_DIR/<place>.replay.json,
// written atomically right before the world snapshot (so it is never behind the snapshot; after a
// crash it may be ahead and is rewound to the restored world's tick).

export function replayPath(dataDir: string, place: PlaceId): string {
  return join(dataDir, `${place}.replay.json`);
}

export function encodeReplay(rec: ReplayRecorder, savedAt: number): string {
  return JSON.stringify(rec.data(savedAt));
}

/** loads a saved recording into `rec`; throws on anything unusable (the caller starts a new recording) */
export function decodeReplay(text: string, rec: ReplayRecorder): void {
  rec.restore(JSON.parse(text));
}
