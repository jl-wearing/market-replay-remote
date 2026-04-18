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
