/**
 * Electron main-process entry (M4 slice 2).
 *
 * Boots the window and wires the replay IPC bridge: opens the DuckDB hot store,
 * builds a {@link createReplayBridge} over it with the real wall clock, and
 * registers the handlers the preload bridge invokes. The renderer drives replay
 * entirely through those handlers.
 *
 * ## Renderer isolation (deliberate)
 *
 * `contextIsolation: true` + `nodeIntegration: false` keep the renderer in its
 * own world with no Node or Electron globals; the only channel across is the
 * preload `contextBridge`. This is the boundary that makes "no peeking" hold
 * structurally — the renderer cannot reach DuckDB or the clock, so every
 * market-data read goes through main's cursor-clipped `getVisibleBars`.
 * `sandbox` is off because the project is ESM and Electron only supports an ESM
 * preload with the sandbox disabled; re-enabling it needs a CommonJS preload
 * build (a later hardening step).
 */

import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { createDuckDbBarStore, type DuckDbBarStore } from "./data/duckDbBarStore.js";
import { createReplayBridge, registerReplayIpc } from "./ipc/replayBridge.js";

/** The process-wide hot store, opened at startup and closed on quit. */
let store: DuckDbBarStore | null = null;

/** Open the store and register the replay IPC handlers over it. */
async function setupReplayIpc(): Promise<void> {
  const root = process.env["HINDSIGHT_DATA_ROOT"] ?? app.getPath("userData");
  store = await createDuckDbBarStore({ root });
  const bridge = createReplayBridge({ source: store, now: () => Date.now() });
  registerReplayIpc(ipcMain, bridge);
}

/** Create the single application window and load the renderer into it. */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.on("ready-to-show", () => window.show());

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}

void app.whenReady().then(async () => {
  await setupReplayIpc();
  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows close, except on macOS where apps stay resident.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Best-effort release of the DuckDB file lock on shutdown.
app.on("will-quit", () => {
  const closing = store;
  store = null;
  void closing?.close();
});
