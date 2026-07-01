import type { ReactElement } from "react";
import { ReplayDebugPanel } from "./ReplayDebugPanel.js";

/**
 * Root application component (M4 slice 2).
 *
 * Renders the replay debug panel wired to the real preload bridge
 * (`window.hindsight.replay`). The chart and real controls replace the panel in
 * later M4 slices; the `data-testid`s give the E2E suite concrete anchors.
 */
export function App(): ReactElement {
  return (
    <main data-testid="app-root">
      <h1>Hindsight</h1>
      <ReplayDebugPanel api={window.hindsight.replay} />
    </main>
  );
}
