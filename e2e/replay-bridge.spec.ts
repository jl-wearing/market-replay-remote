import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * M4 slice 2 end-to-end: drive a replay session from the renderer, through the
 * preload bridge and real `ipcMain` handlers, over a real (empty) DuckDB store
 * in a throwaway data root. Proves the whole IPC round-trip — including that
 * DuckDB loads inside Electron main — that unit/integration tests can't.
 */
let app: ElectronApplication;
let page: Page;
let dataRoot: string;

test.beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-e2e-"));
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, HINDSIGHT_DATA_ROOT: dataRoot },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test("round-trips a replay session through real IPC", async () => {
  await page.getByTestId("btn-create").click();
  await expect(page.getByTestId("cursor")).toHaveText("0");
  await expect(page.getByTestId("status")).toHaveText("paused");
  await expect(page.getByTestId("timeframe")).toHaveText("60000");

  await page.getByTestId("btn-step").click();
  await expect(page.getByTestId("cursor")).toHaveText("60000");

  // Empty store → no visible bars, but the read round-trips cleanly.
  await page.getByTestId("btn-refresh").click();
  await expect(page.getByTestId("bar-count")).toHaveText("0");
});
