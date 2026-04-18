import { describe, expect, it } from "vitest";
import { getInstrument } from "./instruments.js";
import { InvalidPipValueInputError } from "./pip-value.js";
import { InvalidSizingInputError, positionSize } from "./sizing.js";

const EURUSD = getInstrument("EURUSD");
const GBPUSD = getInstrument("GBPUSD");
const XAUUSD = getInstrument("XAUUSD");
const SPX500 = getInstrument("SPX500");
const XAGUSD = getInstrument("XAGUSD");
const USDJPY = getInstrument("USDJPY");
const USDCHF = getInstrument("USDCHF");
const EURJPY = getInstrument("EURJPY");
const EURGBP = getInstrument("EURGBP");
const GER40 = getInstrument("GER40");

describe("positionSize — core math (direct instruments)", () => {
  it("EUR/USD: $10,000 × 1% with 50 pip SL → 0.20 lots risking $100", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 50,
      instrument: EURUSD,
    });

    expect(result.lots).toBeCloseTo(0.2, 10);
    expect(result.units).toBeCloseTo(20_000, 6);
    expect(result.pipValueUsd).toBeCloseTo(2, 6);
    expect(result.intendedRiskUsd).toBeCloseTo(100, 6);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
    expect(result.category).toBe("direct");
  });

  it("GBP/USD: $5,000 × 2% with 20 pip SL → 0.50 lots risking $100", () => {
    const result = positionSize({
      accountBalanceUsd: 5_000,
      riskPercent: 2,
      stopLossPips: 20,
      instrument: GBPUSD,
    });

    expect(result.lots).toBeCloseTo(0.5, 10);
    expect(result.units).toBeCloseTo(50_000, 6);
    expect(result.pipValueUsd).toBeCloseTo(5, 6);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
  });

  it("XAU/USD: $10,000 × 1% with 300 pip SL rounds 0.333… down to 0.33 lots", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 300,
      instrument: XAUUSD,
    });

    expect(result.lots).toBeCloseTo(0.33, 10);
    expect(result.units).toBeCloseTo(33, 6);
    expect(result.pipValueUsd).toBeCloseTo(0.33, 6);
    expect(result.intendedRiskUsd).toBeCloseTo(100, 6);
    expect(result.riskAmountUsd).toBeCloseTo(99, 6);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(result.intendedRiskUsd);
  });

  it("SPX500: $10,000 × 1% with 10 point SL → 10.0 lots", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 10,
      instrument: SPX500,
      maxLots: 100,
    });

    expect(result.lots).toBeCloseTo(10, 10);
    expect(result.pipValueUsd).toBeCloseTo(10, 6);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
  });

  it("XAG/USD: $10,000 × 1% with 200 pip SL → correct pip value for 5000 oz contract", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 200,
      instrument: XAGUSD,
    });
    expect(result.pipValueUsd).toBeCloseTo(0.001 * 5_000 * result.lots, 8);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(100);
  });
});

describe("positionSize — core math (inverse and cross instruments)", () => {
  it("USDJPY at 150.00: $10,000 × 1% with 30 pip SL → 0.50 lots risking $100", () => {
    // pipValueUsdPerLot = 0.01 × 100_000 / 150 = 6.6666…
    // idealLots = 100 / (30 × 6.6666…) = 0.5000
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 30,
      instrument: USDJPY,
      instrumentPrice: 150,
    });

    expect(result.lots).toBeCloseTo(0.5, 10);
    expect(result.units).toBeCloseTo(50_000, 6);
    expect(result.pipValueUsd).toBeCloseTo((1000 / 150) * 0.5, 8);
    expect(result.intendedRiskUsd).toBeCloseTo(100, 6);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
    expect(result.category).toBe("inverse");
  });

  it("USDCHF at 0.90: $10,000 × 1% with 10 pip SL → ideal 0.90 lots", () => {
    // pipValueUsdPerLot = 10 / 0.9 ≈ 11.111
    // idealLots = 100 / (10 × 11.111) = 0.9
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 10,
      instrument: USDCHF,
      instrumentPrice: 0.9,
    });

    expect(result.lots).toBeCloseTo(0.9, 10);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(100 + 1e-9);
    expect(result.category).toBe("inverse");
  });

  it("EURJPY with USDJPY at 150.00: same $ risk and lots as the matching USDJPY case", () => {
    // By design of pipValueInUsd, the EURJPY price itself doesn't enter;
    // only quoteToUsdRate = 1 / USDJPY matters. So this must produce the
    // same lots/risk as the USDJPY inverse test above.
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 30,
      instrument: EURJPY,
      quoteToUsdRate: 1 / 150,
    });

    expect(result.lots).toBeCloseTo(0.5, 10);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
    expect(result.category).toBe("cross");
  });

  it("EURJPY: lots are independent of the EURJPY price the caller supplies", () => {
    const low = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 30,
      instrument: EURJPY,
      instrumentPrice: 120,
      quoteToUsdRate: 1 / 150,
    });
    const high = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 30,
      instrument: EURJPY,
      instrumentPrice: 200,
      quoteToUsdRate: 1 / 150,
    });
    expect(low.lots).toBeCloseTo(high.lots, 12);
    expect(low.riskAmountUsd).toBeCloseTo(high.riskAmountUsd, 10);
  });

  it("EURGBP with GBPUSD at 1.25: $10,000 × 1% with 25 pip SL → 0.32 lots", () => {
    // pipValueUsdPerLot = 0.0001 × 100_000 × 1.25 = 12.5
    // idealLots = 100 / (25 × 12.5) = 0.32 exactly
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 25,
      instrument: EURGBP,
      quoteToUsdRate: 1.25,
    });

    expect(result.lots).toBeCloseTo(0.32, 10);
    expect(result.riskAmountUsd).toBeCloseTo(100, 6);
    expect(result.category).toBe("cross");
  });

  it("GER40 with EURUSD at 1.08: $10,000 × 1% with 10 point SL → 9.25 lots (rounds down)", () => {
    // pipValueUsdPerLot = 1 × 1 × 1.08 = 1.08
    // idealLots = 100 / (10 × 1.08) ≈ 9.2592…, rounds down to 9.25 at step 0.01
    // riskAmount = 9.25 × 10 × 1.08 = 99.9
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 10,
      instrument: GER40,
      quoteToUsdRate: 1.08,
      maxLots: 100,
    });

    expect(result.lots).toBeCloseTo(9.25, 10);
    expect(result.riskAmountUsd).toBeCloseTo(99.9, 6);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(result.intendedRiskUsd + 1e-9);
    expect(result.category).toBe("cross");
  });
});

describe("positionSize — rounding and lot limits", () => {
  it("rounds DOWN to the nearest lotStep (never exceeds intended risk)", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 37,
      instrument: EURUSD,
      lotStep: 0.01,
    });
    expect(result.lots).toBeCloseTo(0.27, 10);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(100);
  });

  it("respects a coarser lotStep (e.g. 0.10 mini-lot increments)", () => {
    const result = positionSize({
      accountBalanceUsd: 10_000,
      riskPercent: 1,
      stopLossPips: 37,
      instrument: EURUSD,
      lotStep: 0.1,
    });
    expect(result.lots).toBeCloseTo(0.2, 10);
    expect(result.riskAmountUsd).toBeLessThanOrEqual(100);
  });

  it("returns zero lots when ideal size is below minLots", () => {
    const result = positionSize({
      accountBalanceUsd: 1_000,
      riskPercent: 0.1,
      stopLossPips: 500,
      instrument: EURUSD,
      minLots: 0.01,
    });
    expect(result.lots).toBe(0);
    expect(result.units).toBe(0);
    expect(result.pipValueUsd).toBe(0);
    expect(result.riskAmountUsd).toBe(0);
  });

  it("caps at maxLots when ideal size exceeds it", () => {
    const result = positionSize({
      accountBalanceUsd: 1_000_000,
      riskPercent: 5,
      stopLossPips: 10,
      instrument: EURUSD,
      maxLots: 50,
    });
    expect(result.lots).toBe(50);
  });
});

describe("positionSize — breaking tests (must throw)", () => {
  it("throws on zero balance", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 0,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on negative balance", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: -10,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on zero risk percent", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 0,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on negative risk percent", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: -1,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws when risk percent exceeds 100%", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 150,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on zero stop loss", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 0,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on negative stop loss", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: -10,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on NaN inputs", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: Number.NaN,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on Infinity inputs", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: Number.POSITIVE_INFINITY,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on non-positive lotStep", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
        lotStep: 0,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws on negative minLots", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
        minLots: -0.01,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws when maxLots < minLots", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURUSD,
        minLots: 1,
        maxLots: 0.5,
      }),
    ).toThrow(InvalidSizingInputError);
  });

  it("throws InvalidPipValueInputError on inverse instrument without instrumentPrice", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: USDJPY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on cross instrument without quoteToUsdRate", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURJPY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on NaN instrumentPrice (inverse)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: USDJPY,
        instrumentPrice: Number.NaN,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on Infinity instrumentPrice (inverse)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: USDJPY,
        instrumentPrice: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on zero instrumentPrice (inverse)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: USDJPY,
        instrumentPrice: 0,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on negative instrumentPrice (inverse)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: USDJPY,
        instrumentPrice: -150,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on NaN quoteToUsdRate (cross)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURJPY,
        quoteToUsdRate: Number.NaN,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on Infinity quoteToUsdRate (cross)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURJPY,
        quoteToUsdRate: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on zero quoteToUsdRate (cross)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURJPY,
        quoteToUsdRate: 0,
      }),
    ).toThrow(InvalidPipValueInputError);
  });

  it("throws InvalidPipValueInputError on negative quoteToUsdRate (cross)", () => {
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: EURJPY,
        quoteToUsdRate: -0.00667,
      }),
    ).toThrow(InvalidPipValueInputError);
  });
});

describe("positionSize — invariants (property-style)", () => {
  it("actual risk never exceeds intended risk — direct instruments", () => {
    const balances = [1_000, 5_000, 10_000, 25_000, 100_000];
    const risks = [0.25, 0.5, 1, 2, 5];
    const stops = [5, 12, 37, 50, 83, 150, 300];
    const instruments = [EURUSD, GBPUSD, XAUUSD, XAGUSD, SPX500];

    for (const bal of balances) {
      for (const risk of risks) {
        for (const sl of stops) {
          for (const inst of instruments) {
            const r = positionSize({
              accountBalanceUsd: bal,
              riskPercent: risk,
              stopLossPips: sl,
              instrument: inst,
              maxLots: 1_000,
            });
            expect(r.riskAmountUsd).toBeLessThanOrEqual(r.intendedRiskUsd + 1e-9);
            expect(r.lots).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(r.lots)).toBe(true);
            expect(Number.isFinite(r.riskAmountUsd)).toBe(true);
            expect(r.category).toBe("direct");
          }
        }
      }
    }
  });

  it("actual risk never exceeds intended risk — inverse instruments over a price grid", () => {
    const balances = [5_000, 10_000, 50_000];
    const risks = [0.5, 1, 2];
    const stops = [10, 30, 75, 150];
    const cases: { spec: typeof USDJPY; prices: number[] }[] = [
      { spec: USDJPY, prices: [100, 130, 150, 180, 250] },
      { spec: USDCHF, prices: [0.7, 0.85, 0.95, 1.1, 1.3] },
    ];

    for (const bal of balances) {
      for (const risk of risks) {
        for (const sl of stops) {
          for (const { spec, prices } of cases) {
            for (const price of prices) {
              const r = positionSize({
                accountBalanceUsd: bal,
                riskPercent: risk,
                stopLossPips: sl,
                instrument: spec,
                instrumentPrice: price,
                maxLots: 1_000,
              });
              expect(r.riskAmountUsd).toBeLessThanOrEqual(r.intendedRiskUsd + 1e-9);
              expect(r.lots).toBeGreaterThanOrEqual(0);
              expect(Number.isFinite(r.lots)).toBe(true);
              expect(Number.isFinite(r.riskAmountUsd)).toBe(true);
              expect(r.category).toBe("inverse");
            }
          }
        }
      }
    }
  });

  it("actual risk never exceeds intended risk — cross instruments over a rate grid", () => {
    const balances = [5_000, 10_000, 50_000];
    const risks = [0.5, 1, 2];
    const stops = [10, 30, 75, 150];
    const cases: { spec: typeof EURJPY; rates: number[] }[] = [
      { spec: EURJPY, rates: [1 / 180, 1 / 150, 1 / 110] },
      { spec: EURGBP, rates: [1.1, 1.25, 1.45] },
      { spec: GER40, rates: [0.95, 1.08, 1.25] },
    ];

    for (const bal of balances) {
      for (const risk of risks) {
        for (const sl of stops) {
          for (const { spec, rates } of cases) {
            for (const rate of rates) {
              const r = positionSize({
                accountBalanceUsd: bal,
                riskPercent: risk,
                stopLossPips: sl,
                instrument: spec,
                quoteToUsdRate: rate,
                maxLots: 1_000,
              });
              expect(r.riskAmountUsd).toBeLessThanOrEqual(r.intendedRiskUsd + 1e-9);
              expect(r.lots).toBeGreaterThanOrEqual(0);
              expect(Number.isFinite(r.lots)).toBe(true);
              expect(Number.isFinite(r.riskAmountUsd)).toBe(true);
              expect(r.category).toBe("cross");
            }
          }
        }
      }
    }
  });

  it("inverse(p) and matching cross(1/p) produce the same lots and risk", () => {
    // USDJPY at price p yields the same pipValueUsdPerLot as EURJPY with
    // quoteToUsdRate = 1/p, because both pairs share pipSize × contractSize
    // and the pip move is in JPY. Sizing — which only depends on that pip
    // value — must agree bit-for-bit.
    const prices = [90, 120, 150, 200];
    for (const p of prices) {
      const inv = positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 30,
        instrument: USDJPY,
        instrumentPrice: p,
        maxLots: 1_000,
      });
      const crs = positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 30,
        instrument: EURJPY,
        quoteToUsdRate: 1 / p,
        maxLots: 1_000,
      });
      expect(inv.lots).toBeCloseTo(crs.lots, 12);
      expect(inv.riskAmountUsd).toBeCloseTo(crs.riskAmountUsd, 10);
    }
  });
});
