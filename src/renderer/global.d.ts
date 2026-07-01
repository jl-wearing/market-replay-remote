import type { HindsightApi } from "@shared/ipc-contract.js";

/**
 * The preload bridge exposes {@link HindsightApi} on `window.hindsight`. This
 * ambient declaration is how the renderer sees it — the type lives in
 * `src/shared/ipc-contract` (the single source of truth) so preload and
 * renderer cannot drift.
 */
declare global {
  interface Window {
    hindsight: HindsightApi;
  }
}

export {};
