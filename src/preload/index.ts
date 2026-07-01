/**
 * Preload bridge (M4 slice 1 — stub).
 *
 * The single trusted seam between the isolated renderer and the main process.
 * With `contextIsolation` on, anything the renderer is allowed to call must be
 * exposed here via `contextBridge`; the renderer never gets `require`, Node, or
 * Electron directly.
 *
 * Slice 1 exposes only a version marker so the boot smoke test can confirm the
 * bridge is wired. The typed replay API (clock transitions + cursor-clipped
 * `getVisibleBars`) is added in M4 slice 2, shaped by `src/shared/ipc-contract`.
 */

import { contextBridge } from "electron";

/** Shape of the object exposed on `window.hindsight`. Grows in slice 2. */
export interface HindsightBridge {
  /** Marker proving the preload bridge is present in the renderer. */
  readonly ready: true;
}

const bridge: HindsightBridge = { ready: true };

contextBridge.exposeInMainWorld("hindsight", bridge);
