/**
 * Tick-to-1s-OHLCV-bar aggregator.
 *
 * Pure kernel that folds a chronologically-ordered `Tick[]` into a sparse
 * `Bar[]`, one bar per second that actually contains ticks. Empty seconds
 * emit no bar — the caller owns gap policy (charts may interpolate,
 * higher-TF aggregators may stretch, replay may simply step forward).
 *
 * Bid and ask are tracked independently per side (O/H/L/C), and volumes
 * are summed per side. This matches the paper broker's (M6) fill model
 * where buys hit ask and sells hit bid, and preserves the spread as
 * reconstructible at every timeframe.
 */

import type { Bar, Tick } from "../types.js";

const MS_PER_SECOND = 1_000;

/**
 * Thrown when the input tick stream breaks a precondition `ticksToSecondBars`
 * relies on: non-finite numeric fields, negative volumes, or timestamps
 * that regress. The error carries `tickIndex` — the 0-based index of the
 * first offending tick — so callers can locate the bad record.
 */
export class InvalidTickStreamError extends Error {
  /** Index of the offending tick in the input array. */
  readonly tickIndex: number;

  constructor(tickIndex: number, message: string) {
    super(`tick[${tickIndex}]: ${message}`);
    this.name = "InvalidTickStreamError";
    this.tickIndex = tickIndex;
  }
}

/**
 * Fold `ticks` (in non-decreasing `timestampMs` order) into a sparse array
 * of 1-second OHLCV bars.
 *
 * Each tick is assigned to the bar at `floor(tick.timestampMs / 1000) * 1000`.
 * The first tick in a bar sets `oBid` / `oAsk`; the last sets `cBid` / `cAsk`.
 * `hBid` / `lBid` / `hAsk` / `lAsk` track per-side extremes. `volumeBid` and
 * `volumeAsk` sum per side. `tickCount` reports the number of contributors.
 *
 * Returns an empty array for empty input. Bars are returned in ascending
 * `timestampMs` order; a second with no ticks produces no bar.
 *
 * Throws `InvalidTickStreamError` if any tick has non-finite `timestampMs`,
 * `bid`, `ask`, `volumeBid`, or `volumeAsk`; if any volume is negative; or
 * if a tick's `timestampMs` is strictly less than the previous tick's.
 * Spread inversions (`bid > ask`) are not rejected — that is a data-quality
 * concern, not a structural one.
 */
export function ticksToSecondBars(ticks: readonly Tick[]): Bar[] {
  const bars: Bar[] = [];
  let current: Bar | null = null;
  let lastTimestampMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    validateTick(t, i);

    if (t.timestampMs < lastTimestampMs) {
      throw new InvalidTickStreamError(
        i,
        `timestampMs=${t.timestampMs} is earlier than previous tick's ` +
          `timestampMs=${lastTimestampMs}`,
      );
    }
    lastTimestampMs = t.timestampMs;

    const bucket = Math.floor(t.timestampMs / MS_PER_SECOND) * MS_PER_SECOND;

    if (current === null || current.timestampMs !== bucket) {
      if (current !== null) bars.push(current);
      current = {
        timestampMs: bucket,
        oBid: t.bid,
        hBid: t.bid,
        lBid: t.bid,
        cBid: t.bid,
        oAsk: t.ask,
        hAsk: t.ask,
        lAsk: t.ask,
        cAsk: t.ask,
        volumeBid: t.volumeBid,
        volumeAsk: t.volumeAsk,
        tickCount: 1,
      };
    } else {
      if (t.bid > current.hBid) current.hBid = t.bid;
      if (t.bid < current.lBid) current.lBid = t.bid;
      if (t.ask > current.hAsk) current.hAsk = t.ask;
      if (t.ask < current.lAsk) current.lAsk = t.ask;
      current.cBid = t.bid;
      current.cAsk = t.ask;
      current.volumeBid += t.volumeBid;
      current.volumeAsk += t.volumeAsk;
      current.tickCount += 1;
    }
  }

  if (current !== null) bars.push(current);
  return bars;
}

function validateTick(t: Tick, index: number): void {
  if (!Number.isFinite(t.timestampMs)) {
    throw new InvalidTickStreamError(
      index,
      `timestampMs must be finite, got ${t.timestampMs}`,
    );
  }
  if (!Number.isFinite(t.bid)) {
    throw new InvalidTickStreamError(
      index,
      `bid must be finite, got ${t.bid}`,
    );
  }
  if (!Number.isFinite(t.ask)) {
    throw new InvalidTickStreamError(
      index,
      `ask must be finite, got ${t.ask}`,
    );
  }
  if (!Number.isFinite(t.volumeBid)) {
    throw new InvalidTickStreamError(
      index,
      `volumeBid must be finite, got ${t.volumeBid}`,
    );
  }
  if (!Number.isFinite(t.volumeAsk)) {
    throw new InvalidTickStreamError(
      index,
      `volumeAsk must be finite, got ${t.volumeAsk}`,
    );
  }
  if (t.volumeBid < 0) {
    throw new InvalidTickStreamError(
      index,
      `volumeBid must be >= 0, got ${t.volumeBid}`,
    );
  }
  if (t.volumeAsk < 0) {
    throw new InvalidTickStreamError(
      index,
      `volumeAsk must be >= 0, got ${t.volumeAsk}`,
    );
  }
}
