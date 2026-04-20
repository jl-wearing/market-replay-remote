/**
 * Instrument metadata needed for sizing, fills, and display.
 *
 * The catalog covers all three pricing categories Hindsight will trade
 * (direct, inverse, cross — see `InstrumentCategory` below). Sizing and
 * pip-value math branch on the category, not on asset class, so adding
 * further instruments is data-only as long as their base/quote currencies
 * are understood.
 */

export type AssetClass =
  | "forex"
  | "metal"
  | "index"
  | "commodity"
  | "crypto"
  | "stock";

export type Currency = "USD" | "EUR" | "GBP" | "JPY" | "CHF" | "CAD" | "AUD" | "NZD" | "XAU" | "XAG" | "XPT" | "XPD";

export interface InstrumentSpec {
  /** Canonical symbol, e.g. "EURUSD", "XAUUSD", "SPX500". */
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  /**
   * Base currency / underlying.
   * For EUR/USD this is EUR; for XAU/USD this is XAU; for SPX500 CFD this is USD (treat the index as USD-denominated).
   */
  baseCurrency: Currency;
  /** Currency the price is quoted in. */
  quoteCurrency: Currency;
  /**
   * Units of the base asset per 1 standard lot.
   * Forex: 100_000. XAUUSD: 100 (oz). XAGUSD: 5_000 (oz). SPX500 CFD: 1 (per point).
   */
  contractSize: number;
  /**
   * Minimum price increment representing "1 pip" for sizing purposes.
   * EUR/USD: 0.0001. USD/JPY: 0.01. XAUUSD: 0.01 (1 cent). SPX500: 1 (1 index point).
   *
   * We use pip (not point) consistently; a "pip" here means the smallest unit
   * the user thinks in when setting stop losses for that instrument.
   */
  pipSize: number;
}

/**
 * Hindsight's instrument catalog.
 *
 * Grouped by pricing category (direct / inverse / cross) rather than asset
 * class, because pip-value and sizing math branch on the category.
 *
 * Note on `pipSize` vs tick-feed precision: `pipSize` here is the unit a
 * user enters stops in, not the smallest price increment Dukascopy publishes.
 * For most instruments the two coincide; for XAGUSD they deliberately do not
 * (see the comment on that entry). The tick-feed precision will be tracked
 * separately in the data layer once it lands (M2).
 */
export const INSTRUMENTS: Readonly<Record<string, InstrumentSpec>> = Object.freeze({
  // ── direct (quote = USD) ───────────────────────────────────────────────
  EURUSD: {
    symbol: "EURUSD",
    displayName: "EUR / USD",
    assetClass: "forex",
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  GBPUSD: {
    symbol: "GBPUSD",
    displayName: "GBP / USD",
    assetClass: "forex",
    baseCurrency: "GBP",
    quoteCurrency: "USD",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  AUDUSD: {
    symbol: "AUDUSD",
    displayName: "AUD / USD",
    assetClass: "forex",
    baseCurrency: "AUD",
    quoteCurrency: "USD",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  NZDUSD: {
    symbol: "NZDUSD",
    displayName: "NZD / USD",
    assetClass: "forex",
    baseCurrency: "NZD",
    quoteCurrency: "USD",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  XAUUSD: {
    symbol: "XAUUSD",
    displayName: "Gold / USD",
    assetClass: "metal",
    baseCurrency: "XAU",
    quoteCurrency: "USD",
    contractSize: 100,
    pipSize: 0.01,
  },
  XAGUSD: {
    // Dukascopy quotes XAGUSD to 4 decimals on the tick feed (tick step
    // 0.0001), but the user-facing pip for stop-loss entry is 0.001 per
    // MT4 convention, giving $5/pip at 1 standard lot (0.001 × 5000 oz).
    // `pipSize` here is the pip unit; tick-feed precision belongs to the
    // data layer (M2) and does not change sizing math.
    symbol: "XAGUSD",
    displayName: "Silver / USD",
    assetClass: "metal",
    baseCurrency: "XAG",
    quoteCurrency: "USD",
    contractSize: 5_000,
    pipSize: 0.001,
  },
  SPX500: {
    symbol: "SPX500",
    displayName: "S&P 500 CFD",
    assetClass: "index",
    baseCurrency: "USD",
    quoteCurrency: "USD",
    contractSize: 1,
    pipSize: 1,
  },
  NAS100: {
    symbol: "NAS100",
    displayName: "Nasdaq 100 CFD",
    assetClass: "index",
    baseCurrency: "USD",
    quoteCurrency: "USD",
    contractSize: 1,
    pipSize: 1,
  },
  US30: {
    symbol: "US30",
    displayName: "Dow Jones 30 CFD",
    assetClass: "index",
    baseCurrency: "USD",
    quoteCurrency: "USD",
    contractSize: 1,
    pipSize: 1,
  },

  // ── inverse (base = USD, quote ≠ USD) ──────────────────────────────────
  USDJPY: {
    symbol: "USDJPY",
    displayName: "USD / JPY",
    assetClass: "forex",
    baseCurrency: "USD",
    quoteCurrency: "JPY",
    contractSize: 100_000,
    pipSize: 0.01,
  },
  USDCHF: {
    symbol: "USDCHF",
    displayName: "USD / CHF",
    assetClass: "forex",
    baseCurrency: "USD",
    quoteCurrency: "CHF",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  USDCAD: {
    symbol: "USDCAD",
    displayName: "USD / CAD",
    assetClass: "forex",
    baseCurrency: "USD",
    quoteCurrency: "CAD",
    contractSize: 100_000,
    pipSize: 0.0001,
  },

  // ── cross (neither base nor quote is USD) ──────────────────────────────
  EURJPY: {
    symbol: "EURJPY",
    displayName: "EUR / JPY",
    assetClass: "forex",
    baseCurrency: "EUR",
    quoteCurrency: "JPY",
    contractSize: 100_000,
    pipSize: 0.01,
  },
  GBPJPY: {
    symbol: "GBPJPY",
    displayName: "GBP / JPY",
    assetClass: "forex",
    baseCurrency: "GBP",
    quoteCurrency: "JPY",
    contractSize: 100_000,
    pipSize: 0.01,
  },
  AUDJPY: {
    symbol: "AUDJPY",
    displayName: "AUD / JPY",
    assetClass: "forex",
    baseCurrency: "AUD",
    quoteCurrency: "JPY",
    contractSize: 100_000,
    pipSize: 0.01,
  },
  EURGBP: {
    symbol: "EURGBP",
    displayName: "EUR / GBP",
    assetClass: "forex",
    baseCurrency: "EUR",
    quoteCurrency: "GBP",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  EURCHF: {
    symbol: "EURCHF",
    displayName: "EUR / CHF",
    assetClass: "forex",
    baseCurrency: "EUR",
    quoteCurrency: "CHF",
    contractSize: 100_000,
    pipSize: 0.0001,
  },
  GER40: {
    // DAX index CFD. Dukascopy symbol DEU.IDX/EUR; we store the
    // user-friendly GER40 name here and map Dukascopy symbols at M2.
    // Quote currency is EUR, so USD pip value needs an EURUSD conversion
    // supplied by the caller (category: cross).
    symbol: "GER40",
    displayName: "DAX (Germany 40) CFD",
    assetClass: "index",
    baseCurrency: "EUR",
    quoteCurrency: "EUR",
    contractSize: 1,
    pipSize: 1,
  },
});

/**
 * Look up an `InstrumentSpec` by its catalog symbol (e.g. `"EURUSD"`).
 *
 * Strict: throws `UnknownInstrumentError` for any string not present as a
 * key in `INSTRUMENTS`. Does not normalise case or trim whitespace —
 * surfacing bad call sites is worth more than the convenience of coercion.
 */
export function getInstrument(symbol: string): InstrumentSpec {
  const instrument = INSTRUMENTS[symbol];
  if (!instrument) {
    throw new UnknownInstrumentError(symbol);
  }
  return instrument;
}

/**
 * Thrown when a catalog-symbol lookup fails: unknown symbol, wrong case,
 * whitespace-padded input, empty string, or a non-string runtime value.
 * Carries the offending value as `symbol` (coerced to string) so callers
 * can surface a useful error message.
 */
export class UnknownInstrumentError extends Error {
  readonly symbol: string;
  constructor(symbol: string) {
    super(`Unknown instrument: "${symbol}"`);
    this.name = "UnknownInstrumentError";
    this.symbol = symbol;
  }
}

/**
 * Nominal type for a catalog-validated instrument symbol (e.g. `"EURUSD"`,
 * `"XAUUSD"`, `"GER40"`). The brand is a compile-time phantom field with
 * zero runtime cost; the only constructor is `toCatalogSymbol`. Functions
 * that take a `CatalogSymbol` are compile-time guaranteed to receive a
 * string that passed catalog-membership validation, which lets them skip
 * the check and makes it impossible to pass a raw `"ZZZBOGUS"` literal
 * by mistake.
 *
 * Mirrors the `DukascopySymbol` brand in `shared/dukascopy/symbolMap.ts`.
 * Used by the ingest orchestrator and the DuckDB bar store.
 */
export type CatalogSymbol = string & { readonly __brand: "CatalogSymbol" };

/**
 * Validate that `symbol` is a known catalog key and return it branded as
 * `CatalogSymbol`. Throws `UnknownInstrumentError` on anything that is
 * not a current `INSTRUMENTS` key — including empty strings, non-string
 * runtime values, wrong-case variants, and whitespace-padded inputs.
 *
 * At runtime the returned value is identical to the input string; the
 * brand is a compile-time phantom. Downstream APIs (`ingestSymbol`,
 * `DuckDbBarStore`) accept only `CatalogSymbol` so the compiler blocks
 * un-validated raw strings at their call sites.
 */
export function toCatalogSymbol(symbol: string): CatalogSymbol {
  if (typeof symbol !== "string" || !(symbol in INSTRUMENTS)) {
    throw new UnknownInstrumentError(String(symbol));
  }
  return symbol as CatalogSymbol;
}

/**
 * Pricing category used for pip-value and sizing math. Determined entirely
 * by an instrument's base and quote currencies:
 *
 * - `direct`  — quote currency is USD (EURUSD, XAUUSD, SPX500, …). The USD
 *   pip value is constant; no market price needed.
 * - `inverse` — base currency is USD and quote currency is not (USDJPY,
 *   USDCHF, USDCAD). USD pip value depends on the instrument's own price.
 * - `cross`   — neither base nor quote is USD (EURJPY, EURGBP, GER40, …).
 *   USD pip value depends on a separate quote-currency → USD conversion
 *   rate; the instrument's own price does not enter the pip-value formula.
 */
export type InstrumentCategory = "direct" | "inverse" | "cross";

export function instrumentCategory(spec: InstrumentSpec): InstrumentCategory {
  if (spec.quoteCurrency === "USD") return "direct";
  if (spec.baseCurrency === "USD") return "inverse";
  return "cross";
}
