import { useCallback, useState } from "react";
import type {
  CreateSessionRequest,
  ReplayBridgeApi,
  SessionSnapshot,
} from "@shared/ipc-contract.js";

/** The renderer-side view of the replay session, plus any last error. */
export interface ReplaySessionState {
  /** Latest session snapshot, or `null` before a session is created. */
  snapshot: SessionSnapshot | null;
  /** Count from the last `getVisibleBars`, or `null` if never refreshed. */
  visibleBarCount: number | null;
  /** Message from the last failed command, or `null` when healthy. */
  error: string | null;
}

/** State + bound actions returned by {@link useReplaySession}. */
export interface UseReplaySession extends ReplaySessionState {
  createSession: (req: CreateSessionRequest) => void;
  play: () => void;
  step: (deltaMs: number) => void;
  refreshBars: () => void;
}

/**
 * Drive a replay session from the renderer over the injected {@link ReplayBridgeApi}
 * (the real `window.hindsight.replay`, or a fake in tests). Commands are
 * fire-and-forget from the caller's view; the resulting snapshot, bar count, and
 * any error are surfaced as state. A rejected command is caught and stored in
 * `error` rather than thrown, so one failed call degrades locally instead of
 * bubbling into a render crash.
 */
export function useReplaySession(api: ReplayBridgeApi): UseReplaySession {
  const [state, setState] = useState<ReplaySessionState>({
    snapshot: null,
    visibleBarCount: null,
    error: null,
  });

  const runCommand = useCallback(async (op: () => Promise<SessionSnapshot>) => {
    try {
      const snapshot = await op();
      setState((s) => ({ ...s, snapshot, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const createSession = useCallback(
    (req: CreateSessionRequest) => void runCommand(() => api.createSession(req)),
    [api, runCommand],
  );
  const play = useCallback(() => void runCommand(() => api.play()), [api, runCommand]);
  const step = useCallback(
    (deltaMs: number) => void runCommand(() => api.step({ deltaMs })),
    [api, runCommand],
  );
  const refreshBars = useCallback(() => {
    void (async () => {
      try {
        const bars = await api.getVisibleBars();
        setState((s) => ({ ...s, visibleBarCount: bars.length, error: null }));
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  }, [api]);

  return { ...state, createSession, play, step, refreshBars };
}
