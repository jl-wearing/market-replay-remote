import { describe, expect, it } from "vitest";
import { INSTRUMENTS, getInstrument } from "./instruments.js";
import {
  InvalidSizingInputError,
  UnsupportedQuoteCurrencyError,
  positionSize,
} from "./sizing.js";

const EURUSD = getInstrument("EURUSD");
const GBPUSD = getInstrument("GBPUSD");
const XAUUSD = getInstrument("XAUUSD");
const SPX500 = getInstrument("SPX500");
const XAGUSD = getInstrument("XAGUSD");

describe("positionSize — core math (USD account, USD-quoted instruments)", () => {
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

  it("throws UnsupportedQuoteCurrencyError for non-USD-quoted instruments (v1 scope)", () => {
    const fakeUsdJpy = {
      ...EURUSD,
      symbol: "USDJPY",
      quoteCurrency: "JPY" as const,
      pipSize: 0.01,
    };
    expect(() =>
      positionSize({
        accountBalanceUsd: 10_000,
        riskPercent: 1,
        stopLossPips: 50,
        instrument: fakeUsdJpy,
      }),
    ).toThrow(UnsupportedQuoteCurrencyError);
  });
});

describe("positionSize — invariants (property-style)", () => {
  it("actual risk never exceeds intended risk across a grid of inputs", () => {
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
          }
        }
      }
    }
  });

  it("the v1 catalog contains only USD-quoted instruments", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      expect(spec.quoteCurrency).toBe("USD");
    }
  });
});
