import type { ReactElement } from "react";

/**
 * Root application component (M4 slice 1 — placeholder).
 *
 * The chart, playback controls, and replay wiring arrive in later M4 slices;
 * for now this just proves the React tree renders inside the Electron window.
 * A stable `data-testid` gives the Playwright boot smoke test something concrete
 * to assert on.
 */
export function App(): ReactElement {
  return (
    <main data-testid="app-root">
      <h1>Hindsight</h1>
      <p>Replay engine ready — chart coming in a later M4 slice.</p>
    </main>
  );
}
