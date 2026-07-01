import type { ReactElement } from "react";
import type { CreateSessionRequest, ReplayBridgeApi } from "@shared/ipc-contract.js";
import { useReplaySession } from "./useReplaySession.js";

/**
 * A fixed demo session for the debug panel. Real instrument/date selection is a
 * later M4 slice; this exists only to exercise the IPC round-trip. EURUSD is in
 * the catalog, so `createSession` succeeds against a real (possibly empty) store.
 */
const DEMO_REQUEST: CreateSessionRequest = {
  symbol: "EURUSD",
  startMs: 0,
  endMs: 3_600_000,
  timeframeMs: 60_000,
};

/**
 * Minimal debug panel proving the renderer ↔ main replay round-trip end to end
 * (M4 slice 2). It loads a session, steps the cursor, and reads the visible-bar
 * count — all through {@link ReplayBridgeApi}, never touching the store. The
 * chart and real controls replace it in later M4 slices.
 */
export function ReplayDebugPanel({ api }: { api: ReplayBridgeApi }): ReactElement {
  const { snapshot, visibleBarCount, error, createSession, step, refreshBars } =
    useReplaySession(api);
  const noSession = snapshot === null;

  return (
    <section data-testid="replay-debug">
      <div>
        <button data-testid="btn-create" onClick={() => createSession(DEMO_REQUEST)}>
          Load session
        </button>
        <button data-testid="btn-step" disabled={noSession} onClick={() => step(60_000)}>
          Step +1m
        </button>
        <button data-testid="btn-refresh" disabled={noSession} onClick={() => refreshBars()}>
          Refresh bars
        </button>
      </div>

      {snapshot !== null && (
        <dl>
          <dt>cursor</dt>
          <dd data-testid="cursor">{snapshot.cursorMs}</dd>
          <dt>status</dt>
          <dd data-testid="status">{snapshot.status}</dd>
          <dt>timeframe</dt>
          <dd data-testid="timeframe">{snapshot.timeframeMs}</dd>
        </dl>
      )}

      {visibleBarCount !== null && <p data-testid="bar-count">{visibleBarCount}</p>}
      {error !== null && (
        <p role="alert" data-testid="error">
          {error}
        </p>
      )}
    </section>
  );
}
