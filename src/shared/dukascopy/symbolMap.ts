/**
 * Catalog → Dukascopy symbol map (pure).
 *
 * The only place in Hindsight that knows how the catalog's user-facing
 * symbols (EURUSD, GER40, XAUUSD, ...) correspond to Dukascopy's
 * instrument identifiers (eurusd, deuidxeur, xauusd, ...). Everything
 * above this module thinks in catalog symbols; the Dukascopy fetcher
 * (slice 4b) consumes the branded `DukascopySymbol` type so that
 * translation has to go through this module — you cannot hand the
 * fetcher a raw string without the compiler objecting.
 *
 * Mappings were verified against the generated instrument enum shipped
 * with `dukascopy-node` (the upstream source of truth for Dukascopy's
 * URL-scheme identifiers).
 */

import { INSTRUMENTS } from "../instruments.js";

/**
 * Nominal type for a Dukascopy instrument identifier. Carries no extra
 * runtime information beyond the underlying string — the brand is a
 * compile-time-only phantom field — but its only constructor is
 * `catalogToDukascopy`, so a value of this type is a compile-time
 * proof that it came out of the catalog→Dukascopy map.
 */
export type DukascopySymbol = string & { readonly __brand: "DukascopySymbol" };

/**
 * Thrown when `catalogToDukascopy` is called with something that is not a
 * known catalog symbol: the empty string, a non-string runtime value, a
 * wrong-case symbol (catalog is uppercase), or simply a symbol with no
 * Dukascopy counterpart. Carries the offending value as `symbol` (coerced
 * to string) so callers can surface a useful error message.
 */
export class UnmappedSymbolError extends Error {
  readonly symbol: string;
  constructor(symbol: string) {
    super(`No Dukascopy mapping for catalog symbol: ${JSON.stringify(symbol)}`);
    this.name = "UnmappedSymbolError";
    this.symbol = symbol;
  }
}

/**
 * Catalog-symbol (key in `INSTRUMENTS`) → Dukascopy-symbol map.
 *
 * Guarantees asserted at test time:
 *
 * - Forward coverage: every key of `INSTRUMENTS` appears here.
 * - Reverse injectivity: no two catalog keys map to the same value.
 * - All values are lowercase ASCII `[a-z0-9]+` per Dukascopy's convention.
 */
const CATALOG_TO_DUKASCOPY: Readonly<Record<string, string>> = Object.freeze({
  // ── direct (quote = USD) ───────────────────────────────────────────────
  EURUSD: "eurusd",
  GBPUSD: "gbpusd",
  AUDUSD: "audusd",
  NZDUSD: "nzdusd",
  XAUUSD: "xauusd",
  XAGUSD: "xagusd",
  // US indices are *usa{n}idxusd* on Dukascopy's side, where n is the
  // number of constituents: 500 for the S&P, "tech" for the Nasdaq 100,
  // 30 for the Dow. The catalog uses the more recognisable trading names.
  SPX500: "usa500idxusd",
  NAS100: "usatechidxusd",
  US30: "usa30idxusd",

  // ── inverse (base = USD, quote ≠ USD) ──────────────────────────────────
  USDJPY: "usdjpy",
  USDCHF: "usdchf",
  USDCAD: "usdcad",

  // ── cross (neither base nor quote is USD) ──────────────────────────────
  EURJPY: "eurjpy",
  GBPJPY: "gbpjpy",
  AUDJPY: "audjpy",
  EURGBP: "eurgbp",
  EURCHF: "eurchf",
  // DAX is Dukascopy's DEU.IDX/EUR → `deuidxeur` in URL form.
  GER40: "deuidxeur",
});

/**
 * Translate a Hindsight catalog symbol (e.g. `"EURUSD"`, `"GER40"`) into
 * the corresponding Dukascopy identifier (e.g. `"eurusd"`, `"deuidxeur"`).
 *
 * Matching is strict: the input must be a non-empty string that is exactly
 * a key of the catalog. Empty strings, non-string runtime values, and
 * wrong-case variants all throw `UnmappedSymbolError` rather than being
 * silently normalised — a wrong case is almost always a bug at the call
 * site, and surfacing it is worth more than the mild convenience of
 * uppercasing.
 *
 * The returned value is branded `DukascopySymbol` so the 4b fetcher's
 * typed input refuses hand-crafted strings at compile time.
 */
export function catalogToDukascopy(symbol: string): DukascopySymbol {
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new UnmappedSymbolError(String(symbol));
  }
  const mapped = CATALOG_TO_DUKASCOPY[symbol];
  if (mapped === undefined) {
    throw new UnmappedSymbolError(symbol);
  }
  // The catalog key-space is the domain of `CATALOG_TO_DUKASCOPY`; the
  // forward-coverage invariant test pins that relationship, so reaching
  // here means `symbol` is also a valid `INSTRUMENTS` key. We assert
  // that defensively for the next reader: if a future refactor ever
  // breaks the two-way coherence, the error fires before anything
  // downstream can act on a phantom mapping.
  if (INSTRUMENTS[symbol] === undefined) {
    throw new UnmappedSymbolError(symbol);
  }
  return mapped as DukascopySymbol;
}
