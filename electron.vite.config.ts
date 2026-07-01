import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite build for the three Electron targets.
 *
 * - `main` / `preload` — bundled for the Node side; `externalizeDepsPlugin`
 *   keeps `node_modules` (electron, `@duckdb/node-api`'s native binding, …)
 *   external so native modules load from disk instead of being bundled.
 * - `renderer` — the React app, rooted at `src/renderer`, with the same
 *   `@shared` alias the Node side and Vitest use so pure `src/shared` code is
 *   importable from the UI.
 *
 * The project is ESM (`"type": "module"`), so all three emit `.mjs`. That is
 * why the window runs `sandbox: false` (see `src/main/index.ts`): Electron only
 * supports an **ESM** preload when the sandbox is off. `contextIsolation` stays
 * on — that is the boundary that keeps the renderer off Node and off the store.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      },
    },
    plugins: [react()],
  },
});
