/**
 * Preload bridge (M4 slice 2).
 *
 * The single trusted seam between the isolated renderer and main. With
 * `contextIsolation` on, the renderer gets exactly what is exposed here and
 * nothing else — no `require`, no Node, no Electron, and no direct path to the
 * DuckDB store. Every method is a thin `ipcRenderer.invoke` of a channel from
 * the shared {@link REPLAY_CHANNELS}; the shapes come from the shared
 * {@link HindsightApi}, so preload and renderer agree by construction.
 *
 * That the renderer can only read bars through {@link ReplayBridgeApi.getVisibleBars}
 * — which main answers with a cursor-clipped read — is what makes "no peeking"
 * hold across the process boundary: there is no exposed channel that returns raw
 * store rows.
 */

import { contextBridge, ipcRenderer } from "electron";
import { REPLAY_CHANNELS } from "../shared/ipc-contract.js";
import type { HindsightApi, ReplayBridgeApi } from "../shared/ipc-contract.js";

const replay: ReplayBridgeApi = {
  createSession: (req) => ipcRenderer.invoke(REPLAY_CHANNELS.createSession, req),
  play: () => ipcRenderer.invoke(REPLAY_CHANNELS.play),
  pause: () => ipcRenderer.invoke(REPLAY_CHANNELS.pause),
  tick: () => ipcRenderer.invoke(REPLAY_CHANNELS.tick),
  setSpeed: (req) => ipcRenderer.invoke(REPLAY_CHANNELS.setSpeed, req),
  step: (req) => ipcRenderer.invoke(REPLAY_CHANNELS.step, req),
  scrubTo: (req) => ipcRenderer.invoke(REPLAY_CHANNELS.scrubTo, req),
  setTimeframe: (req) => ipcRenderer.invoke(REPLAY_CHANNELS.setTimeframe, req),
  getVisibleBars: () => ipcRenderer.invoke(REPLAY_CHANNELS.getVisibleBars),
};

const bridge: HindsightApi = { ready: true, replay };

contextBridge.exposeInMainWorld("hindsight", bridge);
