/**
 * Electron main-process entry (M4 slice 1).
 *
 * The smallest shell that boots: create one `BrowserWindow`, load the renderer
 * (the electron-vite dev server in `npm run dev`, the built `index.html`
 * otherwise), and follow the standard app lifecycle. No feature wiring yet —
 * the typed IPC replay bridge lands in M4 slice 2.
 *
 * ## Renderer isolation (deliberate)
 *
 * `contextIsolation: true` + `nodeIntegration: false` keep the renderer in its
 * own world with no Node or Electron globals; the only channel across is the
 * preload `contextBridge`. This is the boundary that later lets "no peeking"
 * hold structurally — the renderer physically cannot reach DuckDB or the clock,
 * so every market-data read must go through main's cursor-clipped path.
 * `sandbox` is off because the project is ESM and Electron only supports an ESM
 * preload with the sandbox disabled; turning it back on would need a CommonJS
 * preload build (a later hardening step).
 */

import { join } from "node:path";
import { app, BrowserWindow } from "electron";

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

void app.whenReady().then(() => {
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
