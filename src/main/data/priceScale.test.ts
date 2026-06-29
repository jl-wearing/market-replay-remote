import { describe, expect, it } from "vitest";
import { catalogToDukascopy } from "../../shared/dukascopy/symbolMap.js";
import { INSTRUMENTS } from "../../shared/instruments.js";
import {
  UnsupportedDukascopySymbolError,
  dukascopyPriceScale,
} from "./priceScale.js";

describe("dukascopyPriceScale — core behaviour (per-instrument pin)", () => {
  // Each row pins the wire-scale that `decodeBi5Records` must be given for
  // the instrument. Values were verified against
  // `instrumentMetaData[sym].decimalFactor` in dukascopy-node@1.46.4. If the
  // library ships a data-shape change (rename, restructure, value drift),
  // this table breaks and we notice immediately rather than silently
  // mis-scaling decoded prices by 100x.
  const PINS: ReadonlyArray<readonly [string, number]> = [
    // ── direct (FX, USD-quoted) ─────────────────────────── 1e5 ──
    ["EURUSD", 100_000],
    ["GBPUSD", 100_000],
    ["AUDUSD", 100_000],
    ["NZDUSD", 100_000],

    // ── direct (metals, USD-quoted) ─────────────────────── 1e3 ──
    // Note these differ from EURUSD's 1e5 — XAUUSD and XAGUSD use a
    // 3-decimal wire scale despite being USD-quoted. This is exactly
    // why the orchestrator can't assume "USD-quote ⇒ 1e5".
    ["XAUUSD", 1_000],
    ["XAGUSD", 1_000],

    // ── direct (USD indices) ────────────────────────────── 1e3 ──
    ["SPX500", 1_000],
    ["NAS100", 1_000],
    ["US30", 1_000],

    // ── inverse (USD-base, JPY-quoted) ──────────────────── 1e3 ──
    ["USDJPY", 1_000],

    // ── inverse (USD-base, non-JPY) ─────────────────────── 1e5 ──
    ["USDCHF", 100_000],
    ["USDCAD", 100_000],

    // ── cross (JPY-quoted) ──────────────────────────────── 1e3 ──
    ["EURJPY", 1_000],
    ["GBPJPY", 1_000],
    ["AUDJPY", 1_000],

    // ── cross (non-JPY FX) ──────────────────────────────── 1e5 ──
    ["EURGBP", 100_000],
    ["EURCHF", 100_000],

    // ── cross (EUR-quoted index) ────────────────────────── 1e3 ──
    ["GER40", 1_000],
  ];

  for (const [catalogSymbol, expectedScale] of PINS) {
    it(`${catalogSymbol} has wire scale ${expectedScale}`, () => {
      const sym = catalogToDukascopy(catalogSymbol);
      expect(dukascopyPriceScale(sym)).toBe(expectedScale);
    });
  }

  it("returns the same value across repeated calls (deterministic, stateless)", () => {
    const sym = catalogToDukascopy("EURUSD");
    expect(dukascopyPriceScale(sym)).toBe(dukascopyPriceScale(sym));
  });
});

describe("dukascopyPriceScale — edge cases", () => {
  it("returns a positive finite integer for every catalog instrument", () => {
    const allCatalog = [
      "EURUSD", "GBPUSD", "AUDUSD", "NZDUSD",
      "XAUUSD", "XAGUSD",
      "SPX500", "NAS100", "US30",
      "USDJPY", "USDCHF", "USDCAD",
      "EURJPY", "GBPJPY", "AUDJPY",
      "EURGBP", "EURCHF", "GER40",
    ];
    for (const c of allCatalog) {
      const v = dukascopyPriceScale(catalogToDukascopy(c));
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("only ever returns 1e3 or 1e5 for the current catalog (sanity guard against silent drift)", () => {
    const allCatalog = [
      "EURUSD", "GBPUSD", "AUDUSD", "NZDUSD",
      "XAUUSD", "XAGUSD",
      "SPX500", "NAS100", "US30",
      "USDJPY", "USDCHF", "USDCAD",
      "EURJPY", "GBPJPY", "AUDJPY",
      "EURGBP", "EURCHF", "GER40",
    ];
    const allowed = new Set([1_000, 100_000]);
    for (const c of allCatalog) {
      expect(allowed.has(dukascopyPriceScale(catalogToDukascopy(c)))).toBe(true);
    }
  });
});

describe("dukascopyPriceScale — breaking tests (must throw)", () => {
  it("throws UnsupportedDukascopySymbolError for a Dukascopy identifier the library doesn't know", () => {
    // The branded `DukascopySymbol` type prevents handing in a raw string
    // at compile time, but defensively at runtime the function still
    // refuses values the library doesn't recognise.
    expect(() =>
      dukascopyPriceScale("not-a-real-symbol" as never),
    ).toThrow(UnsupportedDukascopySymbolError);
  });

  it("throws UnsupportedDukascopySymbolError for the empty string at runtime", () => {
    expect(() =>
      dukascopyPriceScale("" as never),
    ).toThrow(UnsupportedDukascopySymbolError);
  });

  it("throws UnsupportedDukascopySymbolError for upper-cased Dukascopy identifier (Dukascopy uses lowercase)", () => {
    expect(() =>
      dukascopyPriceScale("EURUSD" as never),
    ).toThrow(UnsupportedDukascopySymbolError);
  });

  it("UnsupportedDukascopySymbolError carries the offending symbol", () => {
    try {
      dukascopyPriceScale("xxx-bogus" as never);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedDukascopySymbolError);
      expect((err as UnsupportedDukascopySymbolError).symbol).toBe("xxx-bogus");
    }
  });
});

describe("dukascopyPriceScale — pip vs wire-scale relationship (reconciled narrative)", () => {
  // Executable pin for the corrected pip≠wire story documented in the
  // `instruments.ts` header and this module's header. The bi5 wire step is
  // `1 / decimalFactor`; a pip is `pipSize`. For the current catalog every
  // pip is a whole number of wire steps, Dukascopy quotes at least as fine
  // as a pip, and XAGUSD is the UNIQUE instrument where pip == wire step.
  // This stops the long-standing (and backwards) "XAGUSD is the one that
  // diverges" myth from creeping back in: it is the one that *coincides*.
  const catalog = Object.values(INSTRUMENTS);

  /** `pipSize` expressed in whole bi5 wire steps: pipSize / (1 / decimalFactor). */
  function wireStepsPerPip(symbol: string): number {
    const decimalFactor = dukascopyPriceScale(catalogToDukascopy(symbol));
    return spec(symbol).pipSize * decimalFactor;
  }

  function spec(symbol: string) {
    const s = INSTRUMENTS[symbol];
    if (s === undefined) throw new Error(`no catalog entry for ${symbol}`);
    return s;
  }

  it("every instrument's pip is a positive whole number of bi5 wire steps", () => {
    for (const s of catalog) {
      const steps = wireStepsPerPip(s.symbol);
      // Float-tolerant integer check (0.0001 * 100000 = 10.000…02 etc.).
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      expect(Math.round(steps)).toBeGreaterThanOrEqual(1);
    }
  });

  it("XAGUSD is the ONLY instrument whose pip equals its wire step (1 step per pip)", () => {
    const coincident = catalog
      .filter((s) => Math.round(wireStepsPerPip(s.symbol)) === 1)
      .map((s) => s.symbol);
    expect(coincident).toEqual(["XAGUSD"]);
  });

  it("every non-XAGUSD instrument is quoted strictly finer than its pip (>1 step per pip)", () => {
    for (const s of catalog) {
      if (s.symbol === "XAGUSD") continue;
      expect(Math.round(wireStepsPerPip(s.symbol))).toBeGreaterThan(1);
    }
  });
});

describe("dukascopyPriceScale — invariants (property-style)", () => {
  it("for every JPY-quoted catalog instrument the scale is 1e3 (never 1e5)", () => {
    const jpyQuoted = ["USDJPY", "EURJPY", "GBPJPY", "AUDJPY"];
    for (const c of jpyQuoted) {
      expect(dukascopyPriceScale(catalogToDukascopy(c))).toBe(1_000);
    }
  });

  it("for every non-JPY FX catalog instrument the scale is 1e5", () => {
    const nonJpyFx = [
      "EURUSD", "GBPUSD", "AUDUSD", "NZDUSD",
      "USDCHF", "USDCAD",
      "EURGBP", "EURCHF",
    ];
    for (const c of nonJpyFx) {
      expect(dukascopyPriceScale(catalogToDukascopy(c))).toBe(100_000);
    }
  });
});
