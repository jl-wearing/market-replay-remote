/**
 * Per-instrument bi5 wire-scale lookup, sourced from `dukascopy-node`.
 *
 * `decodeBi5Records` (`src/shared/dukascopy/bi5.ts`) needs the integer
 * divisor Dukascopy used to encode the prices in the bi5 records (1e5 for
 * most FX, 1e3 for JPY-quoted pairs, metals, and indices). The catalog's
 * `pipSize` is the *user-facing* pip and explicitly differs from the wire
 * scale (XAGUSD is the canonical case), so it is not a substitute.
 *
 * Rather than maintain a parallel table that would drift, this module
 * reads the value straight out of `dukascopy-node`'s
 * `instrumentMetaData[symbol].decimalFactor`. The companion test pins the
 * value per catalog instrument so any upstream data-shape change (rename,
 * restructure, value drift) breaks loudly here rather than silently
 * mis-scaling decoded prices.
 *
 * Lives in `src/main/data/` (alongside `dukascopyClient.ts`) because
 * `src/shared/` is forbidden from importing third-party libraries; the
 * pure decoder in `shared/dukascopy/bi5.ts` keeps taking the scale as a
 * parameter, and this adapter is the producer.
 */

import {
  type InstrumentType,
  instrumentMetaData,
} from "dukascopy-node";

import type { DukascopySymbol } from "../../shared/dukascopy/symbolMap.js";

/**
 * Thrown when a `DukascopySymbol` value is presented at runtime that
 * `dukascopy-node`'s `instrumentMetaData` does not recognise. Should be
 * unreachable from typed code (the brand's only constructor is
 * `catalogToDukascopy`, which only emits values present in the catalog),
 * but kept as a defensive runtime check so the failure mode is explicit
 * rather than `Cannot read properties of undefined`.
 */
export class UnsupportedDukascopySymbolError extends Error {
  /** The offending symbol, coerced to string for logs. */
  readonly symbol: string;
  constructor(symbol: string) {
    super(
      `dukascopy-node has no instrumentMetaData entry for symbol: ${JSON.stringify(symbol)}`,
    );
    this.name = "UnsupportedDukascopySymbolError";
    this.symbol = symbol;
  }
}

/**
 * Return the bi5 wire-scale (decimal factor) for a Dukascopy instrument.
 *
 * The returned value is the integer divisor that turns the bi5 record's
 * `u32` price field into a natural-units price (e.g. 110_000 → 1.10000
 * for EURUSD, where the scale is 100_000). Pass it as the `priceScale`
 * argument to `decodeBi5Records`.
 *
 * Throws `UnsupportedDukascopySymbolError` if the symbol is absent from
 * `dukascopy-node`'s `instrumentMetaData`. The branded `DukascopySymbol`
 * type prevents this at compile time for any value emitted by
 * `catalogToDukascopy`; the runtime check guards against `as` casts and
 * library data-shape regressions.
 */
export function dukascopyPriceScale(symbol: DukascopySymbol): number {
  // The brand `DukascopySymbol` widens cleanly to `InstrumentType` for
  // every value our catalog produces; the runtime check below is the
  // safety net for everything else.
  const meta = instrumentMetaData[symbol as InstrumentType];
  if (meta === undefined || typeof meta.decimalFactor !== "number") {
    throw new UnsupportedDukascopySymbolError(String(symbol));
  }
  return meta.decimalFactor;
}
