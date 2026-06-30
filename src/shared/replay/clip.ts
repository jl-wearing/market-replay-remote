/**
 * Replay range clip — the pure "no peeking" kernel (M3 slice 2).
 *
 * Translates a requested half-open bar range `[fromMs, toMs)` and the replay
 * {@link ReplayClock} `cursorMs` into a clipped half-open range that never
 * exposes a bar whose timestamp lies past the cursor. This is the data-layer
 * enforcement of Hindsight's "no peeking" non-negotiable: the replay must
 * never reveal a bar the trader could not have seen at the cursor. The
 * slice-3 cursor reader (`main/replay/cursorBarReader`) hands the clipped
 * range straight to `DuckDbBarStore.readBarsInRange`, so the clip lives here,
 * one layer above the store, where it stays pure and exhaustively testable.
 *
 * ## Cursor semantics
 *
 * Visible data is `timestamp <= cursorMs` (the cursor is *inclusive*). The
 * store query is *half-open* and bar timestamps are integers, while the clock
 * cursor may be fractional (fractional/slow-motion speed). The smallest
 * half-open upper bound that admits every integer `t <= cursorMs` and excludes
 * the next bar is therefore `floor(cursorMs) + 1`. The clipped upper bound is
 * `min(requestedToMs, floor(cursorMs) + 1)` — the future tail is trimmed; an
 * already-in-the-past request is returned untouched. This is the single place
 * the fractional cursor is floored.
 *
 * ## Bounds policy (deliberate asymmetry)
 *
 * Clipping the *upper* bound is normal: a chart asks for a window wider than
 * the cursor and we silently trim the part that hasn't happened yet. A *lower*
 * bound past the cursor (`fromMs > cursorMs`) is different — the entire
 * requested window lies in the future, which a correct caller never asks for
 * (the visible window is `[someStart, cursor]` by construction). That is a
 * caller logic bug worth surfacing loudly, so it throws
 * {@link NoPeekingViolationError} rather than returning an empty range. (This
 * mirrors the clock's `step`-clamps / `scrubTo`-throws asymmetry.)
 */

/**
 * Discriminating tag on {@link InvalidClipInputError}:
 *
 * - `"range"` — `fromMs` / `toMs` non-finite, non-integer, negative, or
 *   `fromMs >= toMs` (the requested range must be a non-empty half-open
 *   interval, consistent with `readBarsInRange`).
 * - `"cursor"` — `cursorMs` non-finite or negative. A *fractional* cursor is
 *   legal (it is floored), so non-integer is **not** rejected here.
 */
export type ClipErrorCode = "range" | "cursor";

/**
 * Raised on any malformed clip input (bad bounds or bad cursor). Carries a
 * {@link ClipErrorCode} `code` so callers and breaking tests can route on the
 * specific failure without re-parsing the message. Distinct from
 * {@link NoPeekingViolationError}, which is a refusal, not a malformed input.
 */
export class InvalidClipInputError extends Error {
  /** Which class of input was rejected. */
  readonly code: ClipErrorCode;

  constructor(message: string, code: ClipErrorCode) {
    super(message);
    this.name = "InvalidClipInputError";
    this.code = code;
  }
}

/**
 * Raised when a clip request would read entirely past the replay cursor
 * (`fromMs > cursorMs`) — an attempt to peek into the future. Its own class
 * (rather than a {@link ClipErrorCode}) so the "no peeking" non-negotiable is
 * its own breaking-test category here and in every later slice that re-asserts
 * it. Carries the offending `fromMs` and `cursorMs` for diagnostics.
 */
export class NoPeekingViolationError extends Error {
  /** The requested lower bound that sat past the cursor. */
  readonly fromMs: number;
  /** The replay cursor the request tried to read beyond. */
  readonly cursorMs: number;

  constructor(message: string, args: { fromMs: number; cursorMs: number }) {
    super(message);
    this.name = "NoPeekingViolationError";
    this.fromMs = args.fromMs;
    this.cursorMs = args.cursorMs;
  }
}

/** A half-open `[fromMs, toMs)` bar range, clipped to the replay cursor. */
export interface ClippedRange {
  /** Lower bound, inclusive (UTC epoch ms). Equal to the requested `fromMs`. */
  readonly fromMs: number;
  /**
   * Upper bound, exclusive (UTC epoch ms). `min(requestedToMs,
   * floor(cursorMs) + 1)`, always `> fromMs`.
   */
  readonly toMs: number;
}

/**
 * Clip a requested half-open bar range to the replay cursor so that no bar
 * past the cursor can be read.
 *
 * @param args.fromMs   Requested lower bound, inclusive (integer >= 0 ms).
 * @param args.toMs     Requested upper bound, exclusive (integer > fromMs).
 * @param args.cursorMs Replay cursor (>= 0 ms; may be fractional).
 * @returns The clipped range `{ fromMs, toMs: min(toMs, floor(cursorMs)+1) }`,
 *   guaranteed non-empty (`fromMs < toMs`) and safe to pass to
 *   `readBarsInRange`.
 * @throws {InvalidClipInputError} `code: "range"` on bad bounds,
 *   `code: "cursor"` on a bad cursor.
 * @throws {NoPeekingViolationError} when `fromMs > cursorMs` (the whole
 *   request is in the future).
 */
export function clipRangeToCursor(args: {
  fromMs: number;
  toMs: number;
  cursorMs: number;
}): ClippedRange {
  const { fromMs, toMs, cursorMs } = args;
  assertRangeBound(fromMs, "fromMs");
  assertRangeBound(toMs, "toMs");
  if (fromMs >= toMs) {
    throw new InvalidClipInputError(
      `fromMs (${fromMs}) must be strictly less than toMs (${toMs})`,
      "range",
    );
  }
  if (!Number.isFinite(cursorMs) || cursorMs < 0) {
    throw new InvalidClipInputError(
      `cursorMs must be a finite number >= 0, got ${cursorMs}`,
      "cursor",
    );
  }

  if (fromMs > cursorMs) {
    throw new NoPeekingViolationError(
      `clip request fromMs (${fromMs}) is past the cursor (${cursorMs}) — refusing to read future bars`,
      { fromMs, cursorMs },
    );
  }

  // Inclusive cursor -> exclusive half-open upper bound. `fromMs <= cursorMs`
  // (checked above) and `fromMs` is an integer, so `floor(cursorMs) + 1 >
  // fromMs`; with `toMs > fromMs` too, the min is always `> fromMs`.
  const cursorUpper = Math.floor(cursorMs) + 1;
  return { fromMs, toMs: Math.min(toMs, cursorUpper) };
}

function assertRangeBound(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new InvalidClipInputError(
      `${name} must be a finite integer >= 0, got ${value}`,
      "range",
    );
  }
}
