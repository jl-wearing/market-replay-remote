/**
 * Replay session orchestrator — M3 slice 5 (the last M3 slice).
 *
 * Composes the three M3 primitives into the single handle the replay UI drives:
 *
 *  - the pure {@link ReplayClock} (slice 1) — owns the cursor plus the
 *    play / pause / speed / step / scrub state;
 *  - {@link readBarsUpToCursor} (slice 3) — the data-layer "no peeking"
 *    cursor-clipped read;
 *  - {@link resampleBars} (slice 4) — folds the visible 1 s bars into the
 *    chart's timeframe.
 *
 * A {@link ReplaySession} is an immutable value `{ symbol, timeframeMs, clock }`
 * — every transition returns a fresh session and never mutates its input, the
 * same discipline as the clock it wraps. The data source is deliberately NOT
 * part of the session: it is injected into {@link readVisibleBars} at read time,
 * so the session state stays a pure, serialisable value and the whole state
 * machine is unit-testable with no I/O (the clock is pure; only the read does
 * I/O, exactly as in `cursorBarReader`).
 *
 * ## Timeframe switch preserves the cursor (the slice's headline contract)
 *
 * {@link setTimeframe} changes only `timeframeMs`; it leaves the `clock`
 * untouched (same reference). Switching M1 → M5 mid-replay re-folds the visible
 * bars at the new period on the next {@link readVisibleBars}, but the cursor —
 * and the entire play/pause/anchor state — does not jump.
 *
 * ## No peeking, end to end
 *
 * {@link readVisibleBars} reads the whole session span clipped to the cursor:
 * the clip (via the slice-3 reader) trims everything past `cursorMs` before the
 * store is touched, and the fold only ever sees bars at or before the cursor.
 * Because the read window starts at `startMs` and the clock guarantees
 * `cursorMs >= startMs`, the session can never even *form* a future-only
 * request — the {@link NoPeekingViolationError} refusal is structurally
 * unreachable from here, and every folded bar's timestamp is `<= cursorMs`.
 *
 * ## Simplicity over caching (deliberate)
 *
 * Each call re-reads `[startMs, cursor]` and re-folds the whole window. That is
 * intentionally the simple, obviously-correct shape; an append-only forward
 * replay-window cache with incremental resampling is a later, profile-driven
 * slice, not this one.
 *
 * ## Error ownership
 *
 * The session owns exactly one validation of its own — `timeframeMs` — and
 * surfaces it eagerly (at create / {@link setTimeframe}) as
 * {@link InvalidSessionInputError}, so a bad timeframe fails at the call site
 * rather than latently at the next read. This mirrors {@link createClock}
 * validating its bounds eagerly: a `createReplaySession` that rejected bad
 * bounds but silently accepted a bad timeframe (or vice-versa) would be a
 * surprising asymmetry. Everything else propagates unchanged — bounds / speed /
 * wall errors as {@link InvalidClockInputError} from the clock transitions, and
 * read failures (`BarStoreError`, and in principle `InvalidClipInputError` /
 * `InvalidResampleInputError`) from {@link readVisibleBars} — so the layer that
 * actually failed is never hidden (same stance as `cursorBarReader`).
 */

import type { Bar } from "../../shared/types.js";
import type { CatalogSymbol } from "../../shared/instruments.js";
import type { ReplayClock } from "../../shared/replay/clock.js";
import {
  createClock,
  pause as clockPause,
  play as clockPlay,
  scrubTo as clockScrubTo,
  setSpeed as clockSetSpeed,
  step as clockStep,
  tick as clockTick,
} from "../../shared/replay/clock.js";
import { resampleBars } from "../../shared/bars/resample.js";
import { readBarsUpToCursor, type CursorBarSource } from "./cursorBarReader.js";

const MS_PER_SECOND = 1_000;

/**
 * Discriminating tag on {@link InvalidSessionInputError}. Currently a single
 * value — the only input the session validates on its own behalf is the
 * timeframe — kept as a tagged union for symmetry with the clock / clip /
 * resample errors and to leave room for a future session-owned parameter.
 *
 * - `"timeframe"` — `timeframeMs` non-finite, non-integer, `<= 0`, or not a
 *   whole number of seconds (multiple of 1000 ms).
 */
export type SessionErrorCode = "timeframe";

/**
 * Raised on a malformed session input the session validates itself (today:
 * only the timeframe). Carries a {@link SessionErrorCode} `code` so callers and
 * breaking tests can route on the specific failure without re-parsing the
 * message. Bounds / speed / wall failures are not this class — they surface as
 * {@link InvalidClockInputError} straight from the clock.
 */
export class InvalidSessionInputError extends Error {
  /** Which class of input was rejected. */
  readonly code: SessionErrorCode;

  constructor(message: string, code: SessionErrorCode) {
    super(message);
    this.name = "InvalidSessionInputError";
    this.code = code;
  }
}

/**
 * Immutable replay-session state. Every transition returns a fresh value; the
 * input is never mutated. The `clock` carries the cursor and play state; the
 * session adds the instrument and the chart timeframe the visible bars fold to.
 */
export interface ReplaySession {
  /** Catalog-validated instrument the session replays. */
  readonly symbol: CatalogSymbol;
  /**
   * Chart timeframe the visible 1 s bars fold to, in ms. A positive integer
   * multiple of 1000 (e.g. `60_000` for M1, `300_000` for M5).
   */
  readonly timeframeMs: number;
  /** The replay clock: session bounds, cursor, speed, and play status. */
  readonly clock: ReplayClock;
}

/**
 * Create a paused replay session positioned at `startMs`.
 *
 * Validates `timeframeMs` first (this module's own contract), then delegates
 * bounds / speed / wall validation to {@link createClock}.
 *
 * @param args.symbol     Catalog-validated instrument symbol.
 * @param args.startMs    Session lower bound, inclusive (integer >= 0 ms).
 * @param args.endMs      Session upper bound, inclusive (integer > startMs).
 * @param args.timeframeMs Chart timeframe; positive integer multiple of 1000.
 * @param args.speed      Replay speed multiplier (> 0). Defaults to `1`.
 * @param args.nowWallMs  Initial wall reading for the clock anchor. Defaults
 *   to `0`; irrelevant until the session is played.
 * @throws {InvalidSessionInputError} `code: "timeframe"` on a bad timeframe.
 * @throws {InvalidClockInputError} on bad bounds / speed / wall (from
 *   {@link createClock}).
 */
export function createReplaySession(args: {
  symbol: CatalogSymbol;
  startMs: number;
  endMs: number;
  timeframeMs: number;
  speed?: number;
  nowWallMs?: number;
}): ReplaySession {
  assertTimeframe(args.timeframeMs);
  // Build the clock args without forwarding `undefined` (exactOptionalPropertyTypes).
  const clockArgs: Parameters<typeof createClock>[0] = {
    startMs: args.startMs,
    endMs: args.endMs,
  };
  if (args.speed !== undefined) clockArgs.speed = args.speed;
  if (args.nowWallMs !== undefined) clockArgs.nowWallMs = args.nowWallMs;
  return {
    symbol: args.symbol,
    timeframeMs: args.timeframeMs,
    clock: createClock(clockArgs),
  };
}

/**
 * Start (or restart) playback. Delegates to {@link play} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "wall"` on a bad reading.
 */
export function play(session: ReplaySession, nowWallMs: number): ReplaySession {
  return { ...session, clock: clockPlay(session.clock, nowWallMs) };
}

/**
 * Freeze the cursor at its current projected position. Delegates to
 * {@link pause} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "wall"` on a bad reading.
 */
export function pause(session: ReplaySession, nowWallMs: number): ReplaySession {
  return { ...session, clock: clockPause(session.clock, nowWallMs) };
}

/**
 * Change the replay speed. Delegates to {@link setSpeed} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "speed"` on a bad speed,
 *   `code: "wall"` on a bad reading.
 */
export function setSpeed(
  session: ReplaySession,
  speed: number,
  nowWallMs: number,
): ReplaySession {
  return { ...session, clock: clockSetSpeed(session.clock, speed, nowWallMs) };
}

/**
 * Advance the cursor to `nowWallMs` (no-op while paused; auto-pauses at the
 * session end). Delegates to {@link tick} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "wall"` on a bad / backward reading.
 */
export function tick(session: ReplaySession, nowWallMs: number): ReplaySession {
  return { ...session, clock: clockTick(session.clock, nowWallMs) };
}

/**
 * Nudge the cursor by `deltaMs` and pause (clamped to the bounds). Delegates to
 * {@link step} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "step"` on a non-finite/non-integer
 *   delta.
 */
export function step(session: ReplaySession, deltaMs: number): ReplaySession {
  return { ...session, clock: clockStep(session.clock, deltaMs) };
}

/**
 * Jump the cursor to an absolute `targetMs` and pause. Delegates to
 * {@link scrubTo} on the clock.
 *
 * @throws {InvalidClockInputError} `code: "scrub"` if out of range / malformed.
 */
export function scrubTo(session: ReplaySession, targetMs: number): ReplaySession {
  return { ...session, clock: clockScrubTo(session.clock, targetMs) };
}

/**
 * Switch the chart timeframe, preserving the cursor and the entire clock.
 *
 * This is the slice's headline behaviour: the returned session shares the same
 * `clock` reference, so the cursor, play status, speed, and anchors do not
 * move — only the period the next {@link readVisibleBars} folds to changes.
 *
 * @throws {InvalidSessionInputError} `code: "timeframe"` on a bad timeframe.
 */
export function setTimeframe(
  session: ReplaySession,
  timeframeMs: number,
): ReplaySession {
  assertTimeframe(timeframeMs);
  return { ...session, timeframeMs };
}

/**
 * Read the bars the trader can legitimately see at the current cursor, folded
 * to the session's timeframe.
 *
 * Reads the whole session span `[startMs, endMs]` clipped to the cursor via
 * {@link readBarsUpToCursor} (so no bar past `cursorMs` is ever returned), then
 * folds the resulting 1 s bars with {@link resampleBars}. Returns `[]` when
 * nothing is visible yet.
 *
 * @param session The session whose cursor + timeframe drive the read.
 * @param source  The bar store read port (real `DuckDbBarStore` or a fake).
 * @returns The visible bars folded to `session.timeframeMs`, ascending.
 * @throws Whatever `source.readBarsInRange` throws (e.g. `BarStoreError`),
 *   unchanged. (`InvalidClipInputError` / `NoPeekingViolationError` from the
 *   reader and `InvalidResampleInputError` from the fold are structurally
 *   unreachable here given a session built through {@link createReplaySession}.)
 */
export async function readVisibleBars(
  session: ReplaySession,
  source: CursorBarSource,
): Promise<Bar[]> {
  const { clock, symbol, timeframeMs } = session;
  const bars1s = await readBarsUpToCursor(source, {
    symbol,
    fromMs: clock.startMs,
    // Half-open upper bound `endMs + 1` so a bar sitting exactly on the
    // inclusive session end is reachable once the cursor reaches it. The clip
    // caps this at `floor(cursorMs) + 1`, and `cursorMs <= endMs`, so nothing
    // past the cursor — hence nothing past `endMs` — is ever read.
    toMs: clock.endMs + 1,
    cursorMs: clock.cursorMs,
  });
  return resampleBars(bars1s, timeframeMs);
}

/**
 * Reject a timeframe that is not a positive whole number of seconds. The rule
 * is identical to `resampleBars`' `periodMs` check (which re-validates at fold
 * time as defence in depth); validating here lets a bad timeframe fail at the
 * `createReplaySession` / `setTimeframe` call site instead of at the next read.
 */
function assertTimeframe(timeframeMs: number): void {
  if (
    !Number.isFinite(timeframeMs) ||
    !Number.isInteger(timeframeMs) ||
    timeframeMs <= 0
  ) {
    throw new InvalidSessionInputError(
      `timeframeMs must be a finite positive integer, got ${timeframeMs}`,
      "timeframe",
    );
  }
  if (timeframeMs % MS_PER_SECOND !== 0) {
    throw new InvalidSessionInputError(
      `timeframeMs must be a whole number of seconds (multiple of ${MS_PER_SECOND}), got ${timeframeMs}`,
      "timeframe",
    );
  }
}
