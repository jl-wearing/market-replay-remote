import { describe, expect, it } from "vitest";
import { INSTRUMENTS } from "../instruments.js";
import {
  UnmappedSymbolError,
  catalogToDukascopy,
} from "./symbolMap.js";

describe("catalogToDukascopy — core behaviour", () => {
  it("maps EURUSD to 'eurusd'", () => {
    expect(catalogToDukascopy("EURUSD")).toBe("eurusd");
  });

  it("maps GER40 (DAX) to 'deuidxeur' (non-obvious)", () => {
    expect(catalogToDukascopy("GER40")).toBe("deuidxeur");
  });

  it("maps SPX500 to 'usa500idxusd' (non-obvious)", () => {
    expect(catalogToDukascopy("SPX500")).toBe("usa500idxusd");
  });

  it("maps NAS100 to 'usatechidxusd' (non-obvious)", () => {
    expect(catalogToDukascopy("NAS100")).toBe("usatechidxusd");
  });

  it("maps US30 to 'usa30idxusd' (non-obvious)", () => {
    expect(catalogToDukascopy("US30")).toBe("usa30idxusd");
  });

  it("maps metals (XAUUSD, XAGUSD) to their Dukascopy spot symbols", () => {
    expect(catalogToDukascopy("XAUUSD")).toBe("xauusd");
    expect(catalogToDukascopy("XAGUSD")).toBe("xagusd");
  });

  it("maps inverse pairs (USDJPY, USDCHF, USDCAD) to their lowercased forms", () => {
    expect(catalogToDukascopy("USDJPY")).toBe("usdjpy");
    expect(catalogToDukascopy("USDCHF")).toBe("usdchf");
    expect(catalogToDukascopy("USDCAD")).toBe("usdcad");
  });

  it("maps cross FX pairs (EURJPY, EURGBP, EURCHF, GBPJPY, AUDJPY) to lowercased forms", () => {
    expect(catalogToDukascopy("EURJPY")).toBe("eurjpy");
    expect(catalogToDukascopy("EURGBP")).toBe("eurgbp");
    expect(catalogToDukascopy("EURCHF")).toBe("eurchf");
    expect(catalogToDukascopy("GBPJPY")).toBe("gbpjpy");
    expect(catalogToDukascopy("AUDJPY")).toBe("audjpy");
  });
});

describe("catalogToDukascopy — edge cases", () => {
  it("is deterministic: repeated calls for the same input return the same value", () => {
    const a = catalogToDukascopy("EURUSD");
    const b = catalogToDukascopy("EURUSD");
    expect(a).toBe(b);
  });

  it("distinct catalog symbols map to distinct Dukascopy symbols (no collisions across a spot check)", () => {
    const spot = [
      "EURUSD",
      "USDJPY",
      "EURJPY",
      "GER40",
      "SPX500",
      "NAS100",
      "US30",
      "XAUUSD",
      "XAGUSD",
    ];
    const mapped = new Set(spot.map(catalogToDukascopy));
    expect(mapped.size).toBe(spot.length);
  });

  it("returned DukascopySymbol is a plain string at runtime (brand is phantom)", () => {
    const dukaEurusd = catalogToDukascopy("EURUSD");
    expect(typeof dukaEurusd).toBe("string");
    expect(`${dukaEurusd}`).toBe("eurusd");
  });
});

describe("catalogToDukascopy — breaking tests (must throw)", () => {
  it("throws UnmappedSymbolError on empty string", () => {
    expect(() => catalogToDukascopy("")).toThrow(UnmappedSymbolError);
  });

  it("throws UnmappedSymbolError on unknown catalog symbol", () => {
    expect(() => catalogToDukascopy("FOOBAR")).toThrow(UnmappedSymbolError);
  });

  it("throws UnmappedSymbolError on lowercase catalog symbol (catalog is uppercase)", () => {
    expect(() => catalogToDukascopy("eurusd")).toThrow(UnmappedSymbolError);
  });

  it("throws UnmappedSymbolError on mixed-case catalog symbol", () => {
    expect(() => catalogToDukascopy("EurUsd")).toThrow(UnmappedSymbolError);
  });

  it("UnmappedSymbolError carries the offending symbol verbatim", () => {
    try {
      catalogToDukascopy("WHATEVER");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnmappedSymbolError);
      expect((err as UnmappedSymbolError).symbol).toBe("WHATEVER");
    }
  });

  it("throws UnmappedSymbolError on non-string input at runtime", () => {
    // Simulates a JS caller handing the function a non-string. The branded
    // TS return type is irrelevant here — we care that bad runtime input
    // fails loudly rather than silently producing a broken DukascopySymbol.
    expect(() =>
      catalogToDukascopy(null as unknown as string),
    ).toThrow(UnmappedSymbolError);
    expect(() =>
      catalogToDukascopy(undefined as unknown as string),
    ).toThrow(UnmappedSymbolError);
    expect(() =>
      catalogToDukascopy(123 as unknown as string),
    ).toThrow(UnmappedSymbolError);
  });
});

describe("catalogToDukascopy — invariants", () => {
  it("catalog coverage: every key in INSTRUMENTS has a Dukascopy mapping", () => {
    const catalogSymbols = Object.keys(INSTRUMENTS);
    expect(catalogSymbols.length).toBeGreaterThan(0);
    for (const symbol of catalogSymbols) {
      expect(() => catalogToDukascopy(symbol)).not.toThrow();
      expect(typeof catalogToDukascopy(symbol)).toBe("string");
      expect(catalogToDukascopy(symbol).length).toBeGreaterThan(0);
    }
  });

  it("reverse injectivity: no two distinct catalog symbols map to the same Dukascopy symbol", () => {
    const catalogSymbols = Object.keys(INSTRUMENTS);
    const seen = new Map<string, string>(); // dukaSym -> catalog sym
    for (const symbol of catalogSymbols) {
      const duka = catalogToDukascopy(symbol);
      const prior = seen.get(duka);
      if (prior !== undefined) {
        throw new Error(
          `collision: both ${prior} and ${symbol} map to Dukascopy '${duka}'`,
        );
      }
      seen.set(duka, symbol);
    }
    expect(seen.size).toBe(catalogSymbols.length);
  });

  it("all Dukascopy mappings are lowercase ASCII (Dukascopy symbol convention)", () => {
    for (const symbol of Object.keys(INSTRUMENTS)) {
      const duka = catalogToDukascopy(symbol);
      expect(duka).toMatch(/^[a-z0-9]+$/);
    }
  });
});
