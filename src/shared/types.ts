/**
 * Cross-cutting primitive types shared between `main/` and `renderer/`.
 *
 * Keep this file small. Types that are only meaningful inside one module
 * belong next to that module (e.g. `PositionSizeResult` in `sizing.ts`);
 * this file is for primitives that flow *across* module boundaries.
 */

/**
 * A single trade tick as published by the data feed (Dukascopy for now).
 *
 * Prices are in the instrument's quote currency in natural units
 * (e.g. 1.0854 for EURUSD, 149.23 for USDJPY). Volumes are in the feed's
 * native volume units — for Dukascopy that's millions of units of the
 * base asset, preserved separately per side rather than summed.
 *
 * Bid and ask are kept separate end-to-end: the paper broker (M6) fills
 * buys at the ask and sells at the bid, and the 1 s OHLCV bar format
 * stores bid and ask columns side-by-side so spread-as-slippage stays
 * reconstructible at any timeframe.
 */
export interface Tick {
  /** Absolute epoch milliseconds (UTC). */
  timestampMs: number;
  /** Bid price, in the instrument's quote currency (natural units). */
  bid: number;
  /** Ask price, in the instrument's quote currency (natural units). */
  ask: number;
  /** Bid-side volume as published by the feed (Dukascopy: millions of base). */
  volumeBid: number;
  /** Ask-side volume as published by the feed (Dukascopy: millions of base). */
  volumeAsk: number;
}

/**
 * OHLCV bar at a single timeframe, with bid and ask tracked independently.
 *
 * Each side carries its own open/high/low/close so that the paper broker
 * (M6) can fill buys at the ask and sells at the bid without having to
 * re-synthesise a side from a mid price. Volumes are kept per-side for the
 * same "don't discard reconstructible info" reason.
 *
 * Bars form a sparse series: a second with zero ticks produces no bar.
 * Downstream code (chart, replay) is responsible for its own gap policy.
 */
export interface Bar {
  /**
   * Absolute epoch milliseconds at the top of the bar's bucket. For a 1 s
   * bar produced by `ticksToSecondBars`, this is a multiple of 1000.
   */
  timestampMs: number;
  /** Open bid — first tick's bid in the bar's bucket. */
  oBid: number;
  /** High bid — max tick bid in the bar's bucket. */
  hBid: number;
  /** Low bid — min tick bid in the bar's bucket. */
  lBid: number;
  /** Close bid — last tick's bid in the bar's bucket. */
  cBid: number;
  /** Open ask — first tick's ask in the bar's bucket. */
  oAsk: number;
  /** High ask — max tick ask in the bar's bucket. */
  hAsk: number;
  /** Low ask — min tick ask in the bar's bucket. */
  lAsk: number;
  /** Close ask — last tick's ask in the bar's bucket. */
  cAsk: number;
  /** Sum of bid-side tick volumes in the bar's bucket. >= 0. */
  volumeBid: number;
  /** Sum of ask-side tick volumes in the bar's bucket. >= 0. */
  volumeAsk: number;
  /** Number of ticks that contributed to this bar. >= 1 for emitted bars. */
  tickCount: number;
}
