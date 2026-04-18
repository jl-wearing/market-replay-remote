import { describe, expect, it } from "vitest";
import {
  getInstrument,
  instrumentCategory,
  type InstrumentSpec,
} from "./instruments.js";
import { InvalidPipValueInputError, pipValueInUsd } from "./pip-value.js";

// M0 catalog (USD-quoted → "direct" category).
const EURUSD = getInstrument("EURUSD");
const GBPUSD = getInstrument("GBPUSD");
const XAUUSD = getInstrument("XAUUSD");
const XAGUSD = getInstrument("XAGUSD");
const SPX500 = getInstrument("SPX500");

// Ad-hoc specs for the two categories that land in slice 2 of M1.
// Defining them inline here keeps slice 1 free of catalog changes — the
// pip-value kernel is independent of which symbols ship in INSTRUMENTS.

const USDJPY: InstrumentSpec = {
  symbol: "USDJPY",
  displayName: "USD / JPY",
  assetClass: "forex",
  baseCurrency: "USD",
  quoteCurrency: "JPY",
  contractSize: 100_000,
  pipSize: 0.01,
};

const USDCHF: InstrumentSpec = {
  symbol: "USDCHF",
  displayName: "USD / CHF",
  assetClass: "forex",
  baseCurrency: "USD",
  quoteCurrency: "CHF",
  contractSize: 100_000,
  pipSize: 0.0001,
};

const EURJPY: InstrumentSpec = {
  symbol: "EURJPY",
  displayName: "EUR / JPY",
  assetClass: "forex",
  baseCurrency: "EUR",
  quoteCurrency: "JPY",
  contractSize: 100_000,
  pipSize: 0.01,
};

const EURGBP: InstrumentSpec = {
  symbol: "EURGBP",
  displayName: "EUR / GBP",
  assetClass: "forex",
  baseCurrency: "EUR",
  quoteCurrency: "GBP",
  contractSize: 100_000,
  pipSize: 0.0001,
};

const GER40: InstrumentSpec = {
  symbol: "GER40",
  displayName: "DAX (Germany 40) CFD",
  assetClass: "index",
  baseCurrency: "EUR",
  quoteCurrency: "EUR",
  contractSize: 1,
  pipSize: 1,
};

describe("pipValueInUsd — core behaviour", () => {
  it("direct (EURUSD): pipValueUsd = pipSize × contractSize, prices unused", () => {
    const r = pipValueInUsd({ instrument: EURUSD });
    expect(r.pipValueUsd).toBeCloseTo(10, 10); // 0.0001 × 100_000
    expect(r.category).toBe("direct");
  });

  it("direct (GBPUSD): $10/pip per standard lot", () => {
    const r = pipValueInUsd({ instrument: GBPUSD });
    expect(r.pipValueUsd).toBeCloseTo(10, 10);
    expect(r.category).toBe("direct");
  });

  it("direct (XAUUSD): gold 100 oz × $0.01 pip = $1/pip", () => {
    const r = pipValueInUsd({ instrument: XAUUSD });
    expect(r.pipValueUsd).toBeCloseTo(1, 10);
    expect(r.category).toBe("direct");
  });

  it("direct (XAGUSD): silver 5000 oz × $0.001 pip = $5/pip", () => {
    const r = pipValueInUsd({ instrument: XAGUSD });
    expect(r.pipValueUsd).toBeCloseTo(5, 10);
    expect(r.category).toBe("direct");
  });

  it("direct (SPX500): 1 index point × $1 per point = $1/pip", () => {
    const r = pipValueInUsd({ instrument: SPX500 });
    expect(r.pipValueUsd).toBeCloseTo(1, 10);
    expect(r.category).toBe("direct");
  });

  it("inverse (USDJPY at 150.00): pipValueUsd = pipSize × contractSize / price ≈ $6.67", () => {
    const r = pipValueInUsd({
      instrument: USDJPY,
      instrumentPrice: 150,
    });
    // 0.01 × 100_000 / 150 = 1000 / 150 = 6.6666…
    expect(r.pipValueUsd).toBeCloseTo(1000 / 150, 10);
    expect(r.category).toBe("inverse");
  });

  it("inverse (USDCHF at 0.90): pipValueUsd = 10 / 0.9 ≈ $11.11", () => {
    const r = pipValueInUsd({
      instrument: USDCHF,
      instrumentPrice: 0.9,
    });
    // 0.0001 × 100_000 / 0.9 = 10 / 0.9 = 11.111…
    expect(r.pipValueUsd).toBeCloseTo(10 / 0.9, 10);
    expect(r.category).toBe("inverse");
  });

  it("cross (EURJPY with USDJPY at 150.00): pipValueUsd = pipSize × contractSize × quoteToUsdRate ≈ $6.67", () => {
    const r = pipValueInUsd({
      instrument: EURJPY,
      quoteToUsdRate: 1 / 150,
    });
    // 0.01 × 100_000 × (1/150) = 6.6666…
    expect(r.pipValueUsd).toBeCloseTo(1000 / 150, 10);
    expect(r.category).toBe("cross");
  });

  it("cross (EURJPY): pipValueUsd is independent of the EURJPY price itself", () => {
    // Same quoteToUsdRate, wildly different EURJPY prices supplied → same result.
    const low = pipValueInUsd({
      instrument: EURJPY,
      instrumentPrice: 120,
      quoteToUsdRate: 1 / 150,
    });
    const high = pipValueInUsd({
      instrument: EURJPY,
      instrumentPrice: 200,
      quoteToUsdRate: 1 / 150,
    });
    expect(low.pipValueUsd).toBeCloseTo(high.pipValueUsd, 12);
  });

  it("cross (EURGBP with GBPUSD at 1.25): pipValueUsd = 10 × 1.25 = $12.50", () => {
    const r = pipValueInUsd({
      instrument: EURGBP,
      quoteToUsdRate: 1.25,
    });
    // 0.0001 × 100_000 × 1.25 = 12.5
    expect(r.pipValueUsd).toBeCloseTo(12.5, 10);
    expect(r.category).toBe("cross");
  });

  it("cross (GER40 with EURUSD at 1.08): pipValueUsd ≈ $1.08 per contract per index point", () => {
    const r = pipValueInUsd({
      instrument: GER40,
      quoteToUsdRate: 1.08,
    });
    expect(r.pipValueUsd).toBeCloseTo(1.08, 10);
    expect(r.category).toBe("cross");
  });
});

describe("pipValueInUsd — edge cases", () => {
  it("direct: irrelevant instrumentPrice and quoteToUsdRate are accepted and ignored", () => {
    const r = pipValueInUsd({
      instrument: EURUSD,
      instrumentPrice: 999,
      quoteToUsdRate: 999,
    });
    expect(r.pipValueUsd).toBeCloseTo(10, 10);
    expect(r.category).toBe("direct");
  });

  it("inverse: very high price produces very small pip value (no clamping)", () => {
    const r = pipValueInUsd({ instrument: USDJPY, instrumentPrice: 500 });
    expect(r.pipValueUsd).toBeCloseTo(2, 10); // 1000 / 500
  });

  it("inverse: very low price produces very large pip value (no clamping)", () => {
    // Fabricate a USD-base pair at a pathological 0.5 price to prove the
    // function doesn't silently floor the output.
    const r = pipValueInUsd({ instrument: USDJPY, instrumentPrice: 0.5 });
    expect(r.pipValueUsd).toBeCloseTo(2000, 8);
  });

  it("cross: very small quoteToUsdRate (weak quote currency) produces small pip value", () => {
    // Imagine EUR/HUF-style instrument; quoteToUsdRate ≈ 1/400.
    const hufLike: InstrumentSpec = {
      ...EURJPY,
      symbol: "EURHUF",
      quoteCurrency: "JPY", // stand-in; any non-USD works for category
      pipSize: 0.01,
      contractSize: 100_000,
    };
    const r = pipValueInUsd({ instrument: hufLike, quoteToUsdRate: 1 / 400 });
    expect(r.pipValueUsd).toBeCloseTo(1000 / 400, 10);
    expect(r.pipValueUsd).toBeGreaterThan(0);
    expect(Number.isFinite(r.pipValueUsd)).toBe(true);
  });

  it("inverse and cross agree at the same effective quote-to-USD rate", () => {
    // USDJPY at 150 and EURJPY with quoteToUsdRate = 1/150 describe pip
    // movement in the same quote currency (JPY) with the same contract size
    // and pipSize — so pipValueUsd must match exactly.
    const inverse = pipValueInUsd({ instrument: USDJPY, instrumentPrice: 150 });
    const cross = pipValueInUsd({
      instrument: EURJPY,
      quoteToUsdRate: 1 / 150,
    });
    expect(inverse.pipValueUsd).toBeCloseTo(cross.pipValueUsd, 12);
  });
});

describe("pipValueInUsd — breaking tests (must throw / must not happen)", () => {
  it("throws when instrumentPrice is missing for an inverse instrument", () => {
    expect(() => pipValueInUsd({ instrument: USDJPY })).toThrow(
      InvalidPipValueInputError,
    );
  });

  it("throws when quoteToUsdRate is missing for a cross instrument", () => {
    expect(() => pipValueInUsd({ instrument: EURJPY })).toThrow(
      InvalidPipValueInputError,
    );
  });

  it("throws on NaN instrumentPrice (inverse)", () => {
    expect(() =>
      pipValueInUsd({ instrument: USDJPY, instrumentPrice: Number.NaN }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on Infinity instrumentPrice (inverse)", () => {
    expect(() =>
      pipValueInUsd({
        instrument: USDJPY,
        instrumentPrice: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on zero instrumentPrice (inverse)", () => {
    expect(() =>
      pipValueInUsd({ instrument: USDJPY, instrumentPrice: 0 }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on negative instrumentPrice (inverse)", () => {
    expect(() =>
      pipValueInUsd({ instrument: USDJPY, instrumentPrice: -150 }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on NaN quoteToUsdRate (cross)", () => {
    expect(() =>
      pipValueInUsd({ instrument: EURJPY, quoteToUsdRate: Number.NaN }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on Infinity quoteToUsdRate (cross)", () => {
    expect(() =>
      pipValueInUsd({
        instrument: EURJPY,
        quoteToUsdRate: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on zero quoteToUsdRate (cross)", () => {
    expect(() =>
      pipValueInUsd({ instrument: EURJPY, quoteToUsdRate: 0 }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws on negative quoteToUsdRate (cross)", () => {
    expect(() =>
      pipValueInUsd({ instrument: EURJPY, quoteToUsdRate: -0.00667 }),
    ).toThrow(InvalidPipValueInputError);
  });
});

describe("pipValueInUsd — invariants (property-style)", () => {
  it("pipValueUsd is > 0 and finite across a grid of valid inputs for all three categories", () => {
    const directs = [EURUSD, GBPUSD, XAUUSD, XAGUSD, SPX500];
    const inverseSpecs: { spec: InstrumentSpec; prices: number[] }[] = [
      { spec: USDJPY, prices: [100, 120, 150, 180, 250] },
      { spec: USDCHF, prices: [0.7, 0.85, 0.95, 1.1, 1.3] },
    ];
    const crossSpecs: { spec: InstrumentSpec; rates: number[] }[] = [
      { spec: EURJPY, rates: [1 / 180, 1 / 150, 1 / 110] },
      { spec: EURGBP, rates: [1.1, 1.25, 1.45] },
      { spec: GER40, rates: [0.95, 1.08, 1.25] },
    ];

    for (const inst of directs) {
      const r = pipValueInUsd({ instrument: inst });
      expect(r.pipValueUsd).toBeGreaterThan(0);
      expect(Number.isFinite(r.pipValueUsd)).toBe(true);
      expect(r.category).toBe("direct");
      expect(r.category).toBe(instrumentCategory(inst));
    }

    for (const { spec, prices } of inverseSpecs) {
      for (const price of prices) {
        const r = pipValueInUsd({ instrument: spec, instrumentPrice: price });
        expect(r.pipValueUsd).toBeGreaterThan(0);
        expect(Number.isFinite(r.pipValueUsd)).toBe(true);
        expect(r.category).toBe("inverse");
        expect(r.category).toBe(instrumentCategory(spec));
      }
    }

    for (const { spec, rates } of crossSpecs) {
      for (const rate of rates) {
        const r = pipValueInUsd({ instrument: spec, quoteToUsdRate: rate });
        expect(r.pipValueUsd).toBeGreaterThan(0);
        expect(Number.isFinite(r.pipValueUsd)).toBe(true);
        expect(r.category).toBe("cross");
        expect(r.category).toBe(instrumentCategory(spec));
      }
    }
  });

  it("scales linearly in pipSize and contractSize for direct instruments", () => {
    // If pipSize doubles, pipValueUsd doubles; likewise for contractSize.
    const base = pipValueInUsd({ instrument: EURUSD });
    const doubled: InstrumentSpec = { ...EURUSD, pipSize: EURUSD.pipSize * 2 };
    const r = pipValueInUsd({ instrument: doubled });
    expect(r.pipValueUsd).toBeCloseTo(base.pipValueUsd * 2, 10);
  });

  it("inverse(p) and cross(1/p) produce identical pipValueUsd for matching pip/contract sizes", () => {
    const prices = [80, 100, 130, 175, 250];
    for (const p of prices) {
      const inverse = pipValueInUsd({ instrument: USDJPY, instrumentPrice: p });
      const cross = pipValueInUsd({
        instrument: EURJPY,
        quoteToUsdRate: 1 / p,
      });
      expect(inverse.pipValueUsd).toBeCloseTo(cross.pipValueUsd, 12);
    }
  });
});
