import { describe, expect, it } from "vitest";
import {
  INSTRUMENTS,
  UnknownInstrumentError,
  getInstrument,
  instrumentCategory,
  type InstrumentSpec,
} from "./instruments.js";

const DIRECT_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "AUDUSD",
  "NZDUSD",
  "XAUUSD",
  "XAGUSD",
  "SPX500",
  "NAS100",
  "US30",
] as const;

const INVERSE_SYMBOLS = ["USDJPY", "USDCHF", "USDCAD"] as const;

const CROSS_SYMBOLS = [
  "EURJPY",
  "GBPJPY",
  "AUDJPY",
  "EURGBP",
  "EURCHF",
  "GER40",
] as const;

describe("instruments catalog — core behaviour", () => {
  it("getInstrument returns the matching spec for known symbols (direct)", () => {
    for (const symbol of DIRECT_SYMBOLS) {
      const spec = getInstrument(symbol);
      expect(spec.symbol).toBe(symbol);
    }
  });

  it("getInstrument returns the matching spec for known symbols (inverse)", () => {
    for (const symbol of INVERSE_SYMBOLS) {
      const spec = getInstrument(symbol);
      expect(spec.symbol).toBe(symbol);
    }
  });

  it("getInstrument returns the matching spec for known symbols (cross)", () => {
    for (const symbol of CROSS_SYMBOLS) {
      const spec = getInstrument(symbol);
      expect(spec.symbol).toBe(symbol);
    }
  });

  it("USDJPY has the expected contract (100k, pip 0.01, base USD, quote JPY)", () => {
    const spec = getInstrument("USDJPY");
    expect(spec.contractSize).toBe(100_000);
    expect(spec.pipSize).toBe(0.01);
    expect(spec.baseCurrency).toBe("USD");
    expect(spec.quoteCurrency).toBe("JPY");
  });

  it("USDCHF has pip 0.0001 (non-JPY quote)", () => {
    const spec = getInstrument("USDCHF");
    expect(spec.pipSize).toBe(0.0001);
    expect(spec.contractSize).toBe(100_000);
  });

  it("EURJPY has pip 0.01 (JPY-quoted cross)", () => {
    const spec = getInstrument("EURJPY");
    expect(spec.pipSize).toBe(0.01);
    expect(spec.contractSize).toBe(100_000);
    expect(spec.baseCurrency).toBe("EUR");
    expect(spec.quoteCurrency).toBe("JPY");
  });

  it("EURGBP has pip 0.0001 (non-JPY cross)", () => {
    const spec = getInstrument("EURGBP");
    expect(spec.pipSize).toBe(0.0001);
    expect(spec.contractSize).toBe(100_000);
    expect(spec.baseCurrency).toBe("EUR");
    expect(spec.quoteCurrency).toBe("GBP");
  });

  it("GER40 is an EUR-denominated index CFD with pip=1, contract=1", () => {
    const spec = getInstrument("GER40");
    expect(spec.assetClass).toBe("index");
    expect(spec.baseCurrency).toBe("EUR");
    expect(spec.quoteCurrency).toBe("EUR");
    expect(spec.pipSize).toBe(1);
    expect(spec.contractSize).toBe(1);
  });

  it("XAUUSD stays at 100 oz contract, $0.01 pip (gold sizing convention)", () => {
    const spec = getInstrument("XAUUSD");
    expect(spec.contractSize).toBe(100);
    expect(spec.pipSize).toBe(0.01);
  });

  it("XAGUSD stays at 5000 oz contract, $0.001 pip (silver sizing convention)", () => {
    // Note: Dukascopy's tick feed quotes XAGUSD to 4 decimals (0.0001),
    // but pipSize here is the unit a user enters stops in. That's 0.001
    // by the MT4 convention, which gives $5/pip at 1 standard lot.
    const spec = getInstrument("XAGUSD");
    expect(spec.contractSize).toBe(5_000);
    expect(spec.pipSize).toBe(0.001);
  });
});

describe("instrumentCategory — core behaviour", () => {
  it("classifies every direct symbol as 'direct'", () => {
    for (const symbol of DIRECT_SYMBOLS) {
      expect(instrumentCategory(getInstrument(symbol))).toBe("direct");
    }
  });

  it("classifies every inverse symbol as 'inverse'", () => {
    for (const symbol of INVERSE_SYMBOLS) {
      expect(instrumentCategory(getInstrument(symbol))).toBe("inverse");
    }
  });

  it("classifies every cross symbol as 'cross'", () => {
    for (const symbol of CROSS_SYMBOLS) {
      expect(instrumentCategory(getInstrument(symbol))).toBe("cross");
    }
  });

  it("categorises a hand-constructed spec with quote=USD as 'direct'", () => {
    const fake: InstrumentSpec = {
      symbol: "FAKEUSD",
      displayName: "Fake / USD",
      assetClass: "forex",
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      contractSize: 100_000,
      pipSize: 0.0001,
    };
    expect(instrumentCategory(fake)).toBe("direct");
  });

  it("categorises a hand-constructed spec with base=USD, quote!=USD as 'inverse'", () => {
    const fake: InstrumentSpec = {
      symbol: "USDXYZ",
      displayName: "USD / XYZ",
      assetClass: "forex",
      baseCurrency: "USD",
      quoteCurrency: "JPY",
      contractSize: 100_000,
      pipSize: 0.01,
    };
    expect(instrumentCategory(fake)).toBe("inverse");
  });

  it("categorises a hand-constructed spec with neither USD as 'cross'", () => {
    const fake: InstrumentSpec = {
      symbol: "EURJPY-LIKE",
      displayName: "EUR / JPY",
      assetClass: "forex",
      baseCurrency: "EUR",
      quoteCurrency: "JPY",
      contractSize: 100_000,
      pipSize: 0.01,
    };
    expect(instrumentCategory(fake)).toBe("cross");
  });
});

describe("instruments catalog — edge cases", () => {
  it("all forex pairs have contractSize 100_000", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      if (spec.assetClass === "forex") {
        expect(spec.contractSize).toBe(100_000);
      }
    }
  });

  it("all JPY-quoted pairs (forex or crosses) have pipSize 0.01", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      if (spec.quoteCurrency === "JPY") {
        expect(spec.pipSize).toBe(0.01);
      }
    }
  });

  it("all non-JPY forex pairs have pipSize 0.0001", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      if (spec.assetClass === "forex" && spec.quoteCurrency !== "JPY") {
        expect(spec.pipSize).toBe(0.0001);
      }
    }
  });

  it("all indices have pipSize 1 and contractSize 1", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      if (spec.assetClass === "index") {
        expect(spec.pipSize).toBe(1);
        expect(spec.contractSize).toBe(1);
      }
    }
  });

  it("catalog is frozen at the top level (immutable)", () => {
    expect(Object.isFrozen(INSTRUMENTS)).toBe(true);
  });
});

describe("instruments catalog — breaking tests (must throw / must not happen)", () => {
  it("getInstrument throws UnknownInstrumentError for an unknown symbol", () => {
    expect(() => getInstrument("NOPE")).toThrow(UnknownInstrumentError);
  });

  it("getInstrument throws for empty string", () => {
    expect(() => getInstrument("")).toThrow(UnknownInstrumentError);
  });

  it("getInstrument is case-sensitive (wrong case throws)", () => {
    expect(() => getInstrument("eurusd")).toThrow(UnknownInstrumentError);
  });

  it("UnknownInstrumentError carries the offending symbol", () => {
    try {
      getInstrument("WAT");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownInstrumentError);
      expect((err as UnknownInstrumentError).symbol).toBe("WAT");
    }
  });
});

describe("instruments catalog — invariants (property-style)", () => {
  it("every catalog entry classifies to exactly one category", () => {
    const categories = new Set(["direct", "inverse", "cross"]);
    for (const spec of Object.values(INSTRUMENTS)) {
      expect(categories.has(instrumentCategory(spec))).toBe(true);
    }
  });

  it("'direct' iff quoteCurrency === 'USD'", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      const isDirect = instrumentCategory(spec) === "direct";
      expect(isDirect).toBe(spec.quoteCurrency === "USD");
    }
  });

  it("'inverse' iff baseCurrency === 'USD' and quoteCurrency !== 'USD'", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      const isInverse = instrumentCategory(spec) === "inverse";
      const matches =
        spec.baseCurrency === "USD" && spec.quoteCurrency !== "USD";
      expect(isInverse).toBe(matches);
    }
  });

  it("'cross' iff neither base nor quote is USD", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      const isCross = instrumentCategory(spec) === "cross";
      const matches =
        spec.baseCurrency !== "USD" && spec.quoteCurrency !== "USD";
      expect(isCross).toBe(matches);
    }
  });

  it("catalog contains at least one instrument of each category", () => {
    const seen = new Set<string>();
    for (const spec of Object.values(INSTRUMENTS)) {
      seen.add(instrumentCategory(spec));
    }
    expect(seen.has("direct")).toBe(true);
    expect(seen.has("inverse")).toBe(true);
    expect(seen.has("cross")).toBe(true);
  });

  it("every spec has finite, positive pipSize and contractSize", () => {
    for (const spec of Object.values(INSTRUMENTS)) {
      expect(Number.isFinite(spec.pipSize)).toBe(true);
      expect(spec.pipSize).toBeGreaterThan(0);
      expect(Number.isFinite(spec.contractSize)).toBe(true);
      expect(spec.contractSize).toBeGreaterThan(0);
    }
  });

  it("every spec.symbol matches its key in INSTRUMENTS and is uppercase", () => {
    for (const [key, spec] of Object.entries(INSTRUMENTS)) {
      expect(spec.symbol).toBe(key);
      expect(key).toBe(key.toUpperCase());
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
