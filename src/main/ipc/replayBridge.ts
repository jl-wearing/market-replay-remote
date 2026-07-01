/**
 * Replay IPC bridge — the main-side handler behind `window.hindsight.replay`
 * (M4 slice 2).
 *
 * Holds the single mutable {@link ReplaySession} for the process and answers
 * the renderer's typed commands: create/replace the session, drive the clock
 * (play / pause / tick / setSpeed / step / scrubTo), switch timeframe, and read
 * the cursor-clipped visible bars. It is the "thin adapter that reads the real
 * wall clock" the pure clock anticipated: `now` is injected (Date.now in
 * production, a fake in tests) and supplied to every wall-time transition, so
 * the renderer never controls replay time and the whole bridge stays testable
 * without Electron.
 *
 * ## Two layers of validation, neither reframed
 *
 * - **Wire shape** — each command validates its payload via the
 *   `src/shared/ipc-contract` validators, throwing {@link InvalidIpcPayloadError}
 *   for a malformed message before any kernel is touched.
 * - **Domain** — `toCatalogSymbol`, `createReplaySession`, and the clock own the
 *   value judgements (`UnknownInstrumentError`, `InvalidSessionInputError`,
 *   `InvalidClockInputError`); those propagate unchanged. Read failures from the
 *   store (`BarStoreError`) propagate unchanged too.
 *
 * The bridge owns exactly one error of its own — {@link ReplayBridgeError} with
 * code `"no-session"` — for a command issued before `createSession`.
 *
 * ## No peeking
 *
 * `getVisibleBars` delegates to `readVisibleBars`, which clips every read to the
 * cursor at the data layer. The bridge adds no read path that bypasses it, so a
 * renderer can never pull a bar past the cursor no matter what it invokes.
 */

import type { IpcMain } from "electron";
import type { Bar } from "../../shared/types.js";
import { toCatalogSymbol } from "../../shared/instruments.js";
import {
  createReplaySession,
  pause as sessionPause,
  play as sessionPlay,
  readVisibleBars,
  scrubTo as sessionScrubTo,
  setSpeed as sessionSetSpeed,
  setTimeframe as sessionSetTimeframe,
  step as sessionStep,
  tick as sessionTick,
  type ReplaySession,
} from "../replay/session.js";
import type { CursorBarSource } from "../replay/cursorBarReader.js";
import {
  REPLAY_CHANNELS,
  validateCreateSessionRequest,
  validateScrubToRequest,
  validateSetSpeedRequest,
  validateSetTimeframeRequest,
  validateStepRequest,
  type ReplayBridgeApi,
  type SessionSnapshot,
} from "../../shared/ipc-contract.js";

/**
 * Raised when a command that needs an active session is issued before
 * `createSession`. `code` is a single-value tag today (symmetry with the other
 * modules' discriminated errors, room to grow).
 */
export class ReplayBridgeError extends Error {
  /** Which precondition was violated. */
  readonly code: "no-session";

  constructor(message: string, code: "no-session") {
    super(message);
    this.name = "ReplayBridgeError";
    this.code = code;
  }
}

/**
 * The main-side command surface. Mirrors {@link ReplayBridgeApi} but the
 * command methods are synchronous (only `getVisibleBars` touches I/O) and take
 * the raw, unvalidated IPC payload (`unknown`) — the bridge validates it.
 */
export interface ReplayBridge {
  /** Create/replace the active session; returns its snapshot. */
  createSession(raw: unknown): SessionSnapshot;
  /** Start playback. */
  play(): SessionSnapshot;
  /** Pause playback. */
  pause(): SessionSnapshot;
  /** Advance the cursor to now (no-op while paused). */
  tick(): SessionSnapshot;
  /** Change replay speed. */
  setSpeed(raw: unknown): SessionSnapshot;
  /** Nudge the cursor by a delta and pause. */
  step(raw: unknown): SessionSnapshot;
  /** Jump the cursor to an absolute time and pause. */
  scrubTo(raw: unknown): SessionSnapshot;
  /** Switch the chart timeframe, preserving the cursor. */
  setTimeframe(raw: unknown): SessionSnapshot;
  /** Read the cursor-clipped visible bars folded to the timeframe. */
  getVisibleBars(): Promise<Bar[]>;
}

/**
 * Build a replay bridge over a bar {@link CursorBarSource} (the real
 * `DuckDbBarStore` in production) and an injected wall clock.
 *
 * @param deps.source The read port used by `getVisibleBars`.
 * @param deps.now    Wall-clock reader (ms); `Date.now` in production.
 */
export function createReplayBridge(deps: {
  source: CursorBarSource;
  now: () => number;
}): ReplayBridge {
  let session: ReplaySession | null = null;

  function requireSession(): ReplaySession {
    if (session === null) {
      throw new ReplayBridgeError(
        "no active replay session; call createSession first",
        "no-session",
      );
    }
    return session;
  }

  return {
    createSession(raw) {
      const req = validateCreateSessionRequest(raw);
      const symbol = toCatalogSymbol(req.symbol);
      const args: Parameters<typeof createReplaySession>[0] = {
        symbol,
        startMs: req.startMs,
        endMs: req.endMs,
        timeframeMs: req.timeframeMs,
        nowWallMs: deps.now(),
      };
      if (req.speed !== undefined) args.speed = req.speed;
      session = createReplaySession(args);
      return snapshot(session);
    },
    play() {
      session = sessionPlay(requireSession(), deps.now());
      return snapshot(session);
    },
    pause() {
      session = sessionPause(requireSession(), deps.now());
      return snapshot(session);
    },
    tick() {
      session = sessionTick(requireSession(), deps.now());
      return snapshot(session);
    },
    setSpeed(raw) {
      const { speed } = validateSetSpeedRequest(raw);
      session = sessionSetSpeed(requireSession(), speed, deps.now());
      return snapshot(session);
    },
    step(raw) {
      const { deltaMs } = validateStepRequest(raw);
      session = sessionStep(requireSession(), deltaMs);
      return snapshot(session);
    },
    scrubTo(raw) {
      const { targetMs } = validateScrubToRequest(raw);
      session = sessionScrubTo(requireSession(), targetMs);
      return snapshot(session);
    },
    setTimeframe(raw) {
      const { timeframeMs } = validateSetTimeframeRequest(raw);
      session = sessionSetTimeframe(requireSession(), timeframeMs);
      return snapshot(session);
    },
    async getVisibleBars() {
      return readVisibleBars(requireSession(), deps.source);
    },
  };
}

/**
 * Register the bridge's commands as `ipcMain.handle` handlers. Kept separate
 * from {@link createReplayBridge} so the bridge itself needs no Electron and is
 * unit-testable; this thin wiring is exercised by the Playwright E2E instead.
 */
export function registerReplayIpc(ipcMain: IpcMain, bridge: ReplayBridge): void {
  ipcMain.handle(REPLAY_CHANNELS.createSession, (_event, payload) =>
    bridge.createSession(payload),
  );
  ipcMain.handle(REPLAY_CHANNELS.play, () => bridge.play());
  ipcMain.handle(REPLAY_CHANNELS.pause, () => bridge.pause());
  ipcMain.handle(REPLAY_CHANNELS.tick, () => bridge.tick());
  ipcMain.handle(REPLAY_CHANNELS.setSpeed, (_event, payload) => bridge.setSpeed(payload));
  ipcMain.handle(REPLAY_CHANNELS.step, (_event, payload) => bridge.step(payload));
  ipcMain.handle(REPLAY_CHANNELS.scrubTo, (_event, payload) => bridge.scrubTo(payload));
  ipcMain.handle(REPLAY_CHANNELS.setTimeframe, (_event, payload) =>
    bridge.setTimeframe(payload),
  );
  ipcMain.handle(REPLAY_CHANNELS.getVisibleBars, () => bridge.getVisibleBars());
}

function snapshot(s: ReplaySession): SessionSnapshot {
  return {
    symbol: s.symbol,
    timeframeMs: s.timeframeMs,
    startMs: s.clock.startMs,
    endMs: s.clock.endMs,
    cursorMs: s.clock.cursorMs,
    speed: s.clock.speed,
    status: s.clock.status,
  };
}
