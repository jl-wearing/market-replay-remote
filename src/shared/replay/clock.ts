/**
 * Replay clock — pure state machine (M3 slice 1).
 *
 * Owns the single replay `cursorMs` and the play / pause / speed / step /
 * scrub transitions every later M3 slice advances. It is **pure and
 * timer-free**: instead of reading the wall clock itself, every transition
 * that depends on elapsed real time takes a `nowWallMs` argument. The thin
 * adapter that drives playback (a `setInterval` / `requestAnimationFrame`
 * in `main/` or `renderer/`, a later slice) is the only place that reads a
 * real clock; this module stays deterministic and unit-testable in
 * milliseconds, per the `src/shared/` purity rule.
 *
 * ## Time model
 *
 * While playing, the cursor is a linear function of wall time:
 *
 *   cursorMs = anchorCursorMs + (nowWallMs - anchorWallMs) * speed
 *
 * clamped to the session bounds `[startMs, endMs]`. The anchor is the
 * (wall, cursor) pair captured the last time playback (re)started — on
 * `play`, `setSpeed`, `step`, `scrubTo`, and on the auto-pause that fires
 * when the cursor reaches `endMs`. `tick` recomputes the cursor against
 * the live anchor without moving it, so repeated ticks accumulate exactly
 * (no per-tick re-anchor drift). `speed` is a unitless multiplier (`2` =
 * two replay-seconds per wall-second); fractional speeds (slow-motion) are
 * allowed, so `cursorMs` may be fractional between the integer bounds — the
 * slice-3 cursor reader floors it to an integer bar timestamp.
 *
 * ## Bounds policy (deliberate asymmetry)
 *
 * `step` is a *relative* nudge and **clamps** to `[startMs, endMs]` —
 * overshooting the end of the session by stepping is expected, not a bug.
 * `scrubTo` is an *absolute* target and **throws** when out of range — a
 * UI scrub bar maps a pixel to an in-range time by construction, so an
 * out-of-range absolute target is a caller error worth surfacing.
 */

/** Whether the clock is advancing (`"playing"`) or frozen (`"paused"`). */
export type ClockStatus = "paused" | "playing";

/**
 * Discriminating tag on {@link InvalidClockInputError}:
 *
 * - `"range"` — `startMs` / `endMs` non-finite, non-integer, negative, or
 *   `startMs >= endMs`.
 * - `"speed"` — `speed` not finite or `<= 0`.
 * - `"wall"` — a `nowWallMs` reading is non-finite, or moved backward while
 *   the clock was playing (the wall clock must be monotonic).
 * - `"scrub"` — a `scrubTo` target is non-finite, non-integer, or outside
 *   `[startMs, endMs]`.
 * - `"step"` — a `step` delta is non-finite or non-integer.
 */
export type ClockErrorCode = "range" | "speed" | "wall" | "scrub" | "step";

/**
 * Raised on any illegal clock input. Carries a {@link ClockErrorCode}
 * `code` so callers (and breaking tests) can route on the specific failure
 * without re-parsing the message.
 */
export class InvalidClockInputError extends Error {
  /** Which class of input was rejected. */
  readonly code: ClockErrorCode;

  constructor(message: string, code: ClockErrorCode) {
    super(message);
    this.name = "InvalidClockInputError";
    this.code = code;
  }
}

/**
 * Immutable replay-clock state. Every transition returns a fresh value;
 * the input is never mutated.
 */
export interface ReplayClock {
  /** Session lower bound, inclusive (UTC epoch ms; integer >= 0). */
  readonly startMs: number;
  /** Session upper bound, inclusive (UTC epoch ms; integer > startMs). */
  readonly endMs: number;
  /**
   * Current replay cursor (UTC epoch ms), always within
   * `[startMs, endMs]`. May be fractional while playing at a fractional
   * speed.
   */
  readonly cursorMs: number;
  /** Replay speed multiplier (> 0). */
  readonly speed: number;
  /** Whether the clock is advancing. */
  readonly status: ClockStatus;
  /** Wall-clock ms captured at the last (re)anchor. */
  readonly anchorWallMs: number;
  /** Cursor ms captured at the last (re)anchor. */
  readonly anchorCursorMs: number;
}

/**
 * Create a paused clock positioned at `startMs`.
 *
 * @param args.startMs Session lower bound, inclusive (integer >= 0 ms).
 * @param args.endMs   Session upper bound, inclusive (integer > startMs).
 * @param args.speed   Replay speed multiplier (> 0). Defaults to `1`.
 * @param args.nowWallMs Initial wall reading for the anchor. Defaults to
 *   `0`; irrelevant until the clock is played.
 * @throws {InvalidClockInputError} `code: "range"` on bad bounds,
 *   `code: "speed"` on bad speed, `code: "wall"` on a non-finite reading.
 */
export function createClock(args: {
  startMs: number;
  endMs: number;
  speed?: number;
  nowWallMs?: number;
}): ReplayClock {
  const { startMs, endMs } = args;
  assertBound(startMs, "startMs");
  assertBound(endMs, "endMs");
  if (startMs >= endMs) {
    throw new InvalidClockInputError(
      `startMs (${startMs}) must be strictly less than endMs (${endMs})`,
      "range",
    );
  }
  const speed = args.speed ?? 1;
  assertSpeed(speed);
  const nowWallMs = args.nowWallMs ?? 0;
  assertWall(nowWallMs);

  return {
    startMs,
    endMs,
    cursorMs: startMs,
    speed,
    status: "paused",
    anchorWallMs: nowWallMs,
    anchorCursorMs: startMs,
  };
}

/**
 * Start (or restart) playback. Anchors at `(nowWallMs, currentCursor)` so
 * playback resumes from where the cursor sits. Idempotent in effect when
 * already playing (settles to `nowWallMs`, then re-anchors).
 *
 * @throws {InvalidClockInputError} `code: "wall"` on a non-finite reading,
 *   or wall time before the current anchor while already playing.
 */
export function play(clock: ReplayClock, nowWallMs: number): ReplayClock {
  assertWall(nowWallMs);
  const cursorMs = projectedCursor(clock, nowWallMs);
  return {
    ...clock,
    cursorMs,
    status: "playing",
    anchorWallMs: nowWallMs,
    anchorCursorMs: cursorMs,
  };
}

/**
 * Freeze the cursor at its current projected position. No-op when already
 * paused.
 *
 * @throws {InvalidClockInputError} `code: "wall"` as for {@link play}.
 */
export function pause(clock: ReplayClock, nowWallMs: number): ReplayClock {
  assertWall(nowWallMs);
  if (clock.status === "paused") return clock;
  const cursorMs = projectedCursor(clock, nowWallMs);
  return {
    ...clock,
    cursorMs,
    status: "paused",
    anchorWallMs: nowWallMs,
    anchorCursorMs: cursorMs,
  };
}

/**
 * Change the replay speed. While playing, the cursor first settles at the
 * old speed up to `nowWallMs`, then the new speed takes effect from there
 * (no time jump). While paused, only the speed changes.
 *
 * @throws {InvalidClockInputError} `code: "speed"` on a bad speed,
 *   `code: "wall"` on a bad reading.
 */
export function setSpeed(
  clock: ReplayClock,
  speed: number,
  nowWallMs: number,
): ReplayClock {
  assertSpeed(speed);
  assertWall(nowWallMs);
  if (clock.status === "paused") {
    return { ...clock, speed };
  }
  const cursorMs = projectedCursor(clock, nowWallMs);
  return {
    ...clock,
    speed,
    cursorMs,
    anchorWallMs: nowWallMs,
    anchorCursorMs: cursorMs,
  };
}

/**
 * Recompute the cursor against the live anchor. While paused this is a
 * no-op. While playing, advances to `nowWallMs`; if the cursor reaches
 * `endMs` the clock auto-pauses there.
 *
 * @throws {InvalidClockInputError} `code: "wall"` as for {@link play}.
 */
export function tick(clock: ReplayClock, nowWallMs: number): ReplayClock {
  assertWall(nowWallMs);
  if (clock.status === "paused") return clock;
  if (nowWallMs < clock.anchorWallMs) {
    throw new InvalidClockInputError(
      `nowWallMs (${nowWallMs}) moved backward before the anchor (${clock.anchorWallMs})`,
      "wall",
    );
  }
  const raw = clock.anchorCursorMs + (nowWallMs - clock.anchorWallMs) * clock.speed;
  if (raw >= clock.endMs) {
    return {
      ...clock,
      cursorMs: clock.endMs,
      status: "paused",
      anchorWallMs: nowWallMs,
      anchorCursorMs: clock.endMs,
    };
  }
  return { ...clock, cursorMs: raw };
}

/**
 * Move the cursor by `deltaMs` (positive = forward) and pause. The result
 * is clamped to `[startMs, endMs]`; overshooting the bounds is allowed.
 *
 * @throws {InvalidClockInputError} `code: "step"` on a non-finite or
 *   non-integer delta.
 */
export function step(clock: ReplayClock, deltaMs: number): ReplayClock {
  if (!Number.isFinite(deltaMs) || !Number.isInteger(deltaMs)) {
    throw new InvalidClockInputError(
      `deltaMs must be a finite integer, got ${deltaMs}`,
      "step",
    );
  }
  const cursorMs = clamp(clock.cursorMs + deltaMs, clock.startMs, clock.endMs);
  return {
    ...clock,
    cursorMs,
    status: "paused",
    anchorCursorMs: cursorMs,
  };
}

/**
 * Jump the cursor to an absolute `targetMs` and pause.
 *
 * @throws {InvalidClockInputError} `code: "scrub"` if `targetMs` is
 *   non-finite, non-integer, or outside `[startMs, endMs]`.
 */
export function scrubTo(clock: ReplayClock, targetMs: number): ReplayClock {
  if (!Number.isFinite(targetMs) || !Number.isInteger(targetMs)) {
    throw new InvalidClockInputError(
      `scrub target must be a finite integer, got ${targetMs}`,
      "scrub",
    );
  }
  if (targetMs < clock.startMs || targetMs > clock.endMs) {
    throw new InvalidClockInputError(
      `scrub target ${targetMs} is outside [${clock.startMs}, ${clock.endMs}]`,
      "scrub",
    );
  }
  return {
    ...clock,
    cursorMs: targetMs,
    status: "paused",
    anchorCursorMs: targetMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * The cursor a playing clock would show at `nowWallMs`, clamped to bounds.
 * For a paused clock the cursor does not move, so its current value is
 * returned. Rejects wall time before the anchor while playing.
 */
function projectedCursor(clock: ReplayClock, nowWallMs: number): number {
  if (clock.status === "paused") return clock.cursorMs;
  if (nowWallMs < clock.anchorWallMs) {
    throw new InvalidClockInputError(
      `nowWallMs (${nowWallMs}) moved backward before the anchor (${clock.anchorWallMs})`,
      "wall",
    );
  }
  const raw = clock.anchorCursorMs + (nowWallMs - clock.anchorWallMs) * clock.speed;
  return clamp(raw, clock.startMs, clock.endMs);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function assertBound(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new InvalidClockInputError(
      `${name} must be a finite integer >= 0, got ${value}`,
      "range",
    );
  }
}

function assertSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new InvalidClockInputError(
      `speed must be a finite number > 0, got ${speed}`,
      "speed",
    );
  }
}

function assertWall(nowWallMs: number): void {
  if (!Number.isFinite(nowWallMs)) {
    throw new InvalidClockInputError(
      `nowWallMs must be finite, got ${nowWallMs}`,
      "wall",
    );
  }
}
