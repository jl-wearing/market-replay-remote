/**
 * Instrument metadata needed for sizing, fills, and display.
 *
 * v1 only exercises USD-quoted instruments. Non-USD quotes are modelled here
 * so the catalog can grow, but the sizing module rejects them until M1.
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
 * v1 catalog: USD-quoted only. More instruments join at M1 once sizing
 * supports non-USD quotes and cross-rate conversion.
 */
export const INSTRUMENTS: Readonly<Record<string, InstrumentSpec>> = Object.freeze({
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
});

export function getInstrument(symbol: string): InstrumentSpec {
  const instrument = INSTRUMENTS[symbol];
  if (!instrument) {
    throw new UnknownInstrumentError(symbol);
  }
  return instrument;
}

export class UnknownInstrumentError extends Error {
  readonly symbol: string;
  constructor(symbol: string) {
    super(`Unknown instrument: "${symbol}"`);
    this.name = "UnknownInstrumentError";
    this.symbol = symbol;
  }
}
