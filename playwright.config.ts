import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Electron end-to-end suite (top of the test
 * pyramid). Specs live in `e2e/` and drive the **built** app via
 * `_electron.launch` — so `npm run build` must run first (the app entry is
 * `package.json` "main" → `out/main/index.mjs`).
 *
 * Serial, single worker: one Electron instance at a time, no shared-window
 * races.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
});
