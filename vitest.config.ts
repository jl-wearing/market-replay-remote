import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

const sharedAlias = {
  "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
};

/**
 * Two Vitest projects:
 *
 * - **node** — the existing pure/`main` suite (`src/** /*.test.ts`), unchanged:
 *   Node environment, no DOM. All the M0–M3 tests keep running here.
 * - **browser** — renderer component/hook tests (`src/renderer/** /*.test.tsx`)
 *   in real Chromium via the Playwright provider, the base of the frontend test
 *   pyramid. Kept a separate project so the two never share an environment.
 *
 * The `.ts` vs `.tsx` split in the two `include` globs is what keeps them
 * disjoint — node never picks up a `.tsx`, browser only picks up `.tsx`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: "node",
          globals: true,
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          name: "browser",
          globals: true,
          include: ["src/renderer/**/*.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/types/**"],
    },
  },
});
