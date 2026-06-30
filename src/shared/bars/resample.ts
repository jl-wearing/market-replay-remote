/**
 * Higher-timeframe bar resampler (M3 slice 4).
 *
 * Pure kernel that folds a chronologically-ordered, 1-second `Bar[]` into a
 * sparse `Bar[]` at a coarser timeframe (M1 / M5 / M15 / H1 / D1 / …). This is
 * the "higher-timeframe aggregation rides on top of the 1 s hot store" piece
 * the DuckDB store's ADR anticipated: the replay engine reads 1 s bars up to
 * the cursor (`main/replay/cursorBarReader`) and folds them to the chart's
 * timeframe here, with no I/O and no peeking concern of its own.
 *
 * Mechanically it mirrors `ticksToSecondBars`: each source bar is assigned to
 * the bucket at `floor(timestampMs / periodMs) * periodMs` (UTC-epoch-aligned,
 * so standard FX timeframes land on natural session boundaries), and bars in
 * the same bucket merge — **open** from the first member, **close** from the
 * last, **high/low** as per-side extremes, **volumes** and **tickCount** as
 * sums. A bucket with no source bars produces no output bar (same sparse
 * policy as the 1 s aggregator: the caller owns gap policy).
 *
 * `periodMs` must be a positive integer multiple of 1000 ms — the second grid
 * the whole system runs on. That rejects sub-second or misaligned periods,
 * which cannot be a meaningful coarsening of 1 s bars.
 */

import type { Bar } from "../types.js";

const MS_PER_SECOND = 1_000;

/** The eight per-side OHLC price fields validated on every input bar. */
const PRICE_FIELDS = [
  "oBid", "hBid", "lBid", "cBid",
  "oAsk", "hAsk", "lAsk", "cAsk",
] as const;

/**
 * Discriminating tag on {@link InvalidResampleInputError}:
 *
 * - `"period"` — `periodMs` non-finite, non-integer, `<= 0`, or not a whole
 *   number of seconds (multiple of 1000 ms).
 * - `"bars"` — a member bar broke a precondition: a non-finite price, a
 *   non-finite or negative volume, a `tickCount` that is not an integer `>= 1`,
 *   a non-integer or negative `timestampMs`, or a `timestampMs` that does not
 *   strictly exceed the previous bar's. `barIndex` locates the offender.
 */
export type ResampleErrorCode = "period" | "bars";

/**
 * Thrown when `resampleBars` is given a bad period or a bad input bar stream.
 * Carries a {@link ResampleErrorCode} `code`, and — for `code: "bars"` — the
 * 0-based `barIndex` of the first offending bar, so callers can locate it.
 */
export class InvalidResampleInputError extends Error {
  /** Which class of input was rejected. */
  readonly code: ResampleErrorCode;
  /** Index of the offending bar, when `code` is `"bars"`. */
  readonly barIndex?: number;

  constructor(message: string, args: { code: ResampleErrorCode; barIndex?: number }) {
    super(message);
    this.name = "InvalidResampleInputError";
    this.code = args.code;
    if (args.barIndex !== undefined) this.barIndex = args.barIndex;
  }
}

/**
 * Fold `bars` (1-second OHLCV bars, strictly ascending by `timestampMs`) into
 * a sparse array of bars at the `periodMs` timeframe.
 *
 * @param bars     Source bars, strictly ascending by `timestampMs`.
 * @param periodMs Target bucket width in ms; a positive integer multiple of
 *   1000 (e.g. `60_000` for M1, `300_000` for M5, `3_600_000` for H1).
 * @returns Bars at the coarser timeframe, ascending; `[]` for empty input. A
 *   bucket containing no source bars is omitted.
 * @throws {InvalidResampleInputError} `code: "period"` on a bad `periodMs`;
 *   `code: "bars"` (with `barIndex`) on a malformed or out-of-order source bar.
 */
export function resampleBars(bars: readonly Bar[], periodMs: number): Bar[] {
  assertPeriod(periodMs);

  const out: Bar[] = [];
  let current: Bar | null = null;
  let lastTimestampMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    validateBar(b, i);
    if (b.timestampMs <= lastTimestampMs) {
      throw new InvalidResampleInputError(
        `bar[${i}].timestampMs=${b.timestampMs} must be strictly greater than the previous bar's ${lastTimestampMs}`,
        { code: "bars", barIndex: i },
      );
    }
    lastTimestampMs = b.timestampMs;

    const bucket = Math.floor(b.timestampMs / periodMs) * periodMs;

    if (current === null || current.timestampMs !== bucket) {
      if (current !== null) out.push(current);
      current = {
        timestampMs: bucket,
        oBid: b.oBid, hBid: b.hBid, lBid: b.lBid, cBid: b.cBid,
        oAsk: b.oAsk, hAsk: b.hAsk, lAsk: b.lAsk, cAsk: b.cAsk,
        volumeBid: b.volumeBid, volumeAsk: b.volumeAsk,
        tickCount: b.tickCount,
      };
    } else {
      if (b.hBid > current.hBid) current.hBid = b.hBid;
      if (b.lBid < current.lBid) current.lBid = b.lBid;
      if (b.hAsk > current.hAsk) current.hAsk = b.hAsk;
      if (b.lAsk < current.lAsk) current.lAsk = b.lAsk;
      current.cBid = b.cBid;
      current.cAsk = b.cAsk;
      current.volumeBid += b.volumeBid;
      current.volumeAsk += b.volumeAsk;
      current.tickCount += b.tickCount;
    }
  }

  if (current !== null) out.push(current);
  return out;
}

function assertPeriod(periodMs: number): void {
  if (!Number.isFinite(periodMs) || !Number.isInteger(periodMs) || periodMs <= 0) {
    throw new InvalidResampleInputError(
      `periodMs must be a finite positive integer, got ${periodMs}`,
      { code: "period" },
    );
  }
  if (periodMs % MS_PER_SECOND !== 0) {
    throw new InvalidResampleInputError(
      `periodMs must be a whole number of seconds (multiple of ${MS_PER_SECOND}), got ${periodMs}`,
      { code: "period" },
    );
  }
}

function validateBar(b: Bar, index: number): void {
  if (!Number.isFinite(b.timestampMs) || !Number.isInteger(b.timestampMs) || b.timestampMs < 0) {
    throw new InvalidResampleInputError(
      `bar[${index}].timestampMs must be a finite integer >= 0, got ${b.timestampMs}`,
      { code: "bars", barIndex: index },
    );
  }
  for (const field of PRICE_FIELDS) {
    if (!Number.isFinite(b[field])) {
      throw new InvalidResampleInputError(
        `bar[${index}].${field} must be finite, got ${b[field]}`,
        { code: "bars", barIndex: index },
      );
    }
  }
  if (!Number.isFinite(b.volumeBid) || b.volumeBid < 0) {
    throw new InvalidResampleInputError(
      `bar[${index}].volumeBid must be finite and >= 0, got ${b.volumeBid}`,
      { code: "bars", barIndex: index },
    );
  }
  if (!Number.isFinite(b.volumeAsk) || b.volumeAsk < 0) {
    throw new InvalidResampleInputError(
      `bar[${index}].volumeAsk must be finite and >= 0, got ${b.volumeAsk}`,
      { code: "bars", barIndex: index },
    );
  }
  if (!Number.isInteger(b.tickCount) || b.tickCount < 1) {
    throw new InvalidResampleInputError(
      `bar[${index}].tickCount must be an integer >= 1, got ${b.tickCount}`,
      { code: "bars", barIndex: index },
    );
  }
}
