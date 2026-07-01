import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * M4 slice 1 boot smoke: the built Electron app launches, opens exactly one
 * window with the React root mounted, and exposes the preload bridge. This is
 * the end-to-end proof that main + preload + renderer are wired together — the
 * layers unit/component tests can't cover on their own.
 */
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // "." → Electron reads package.json "main" (out/main/index.mjs).
  app = await electron.launch({ args: ["."] });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
});

test("boots a single window with the React root and heading rendered", async () => {
  expect(app.windows().length).toBe(1);
  await expect(page.getByTestId("app-root")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hindsight" })).toBeVisible();
});

test("exposes the preload bridge on window.hindsight", async () => {
  const ready = await page.evaluate(
    () => (window as unknown as { hindsight?: { ready?: boolean } }).hindsight?.ready,
  );
  expect(ready).toBe(true);
});
