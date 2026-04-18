import { describe, expect, it } from "vitest";
import {
  InvalidStoragePathError,
  barParquetPath,
  tickHourPath,
  tickPathForTimestamp,
} from "./paths.js";

const ROOT = "/data";

describe("tickHourPath / tickPathForTimestamp / barParquetPath — core behaviour", () => {
  it("tickHourPath builds the expected nested path for a simple EURUSD hour", () => {
    const p = tickHourPath({
      root: ROOT,
      symbol: "EURUSD",
      year: 2024,
      month: 1,
      day: 15,
      hour: 10,
    });
    expect(p).toBe("/data/ticks/EURUSD/2024/01/15/10h_ticks.bi5");
  });

  it("tickHourPath zero-pads month, day, and hour", () => {
    const p = tickHourPath({
      root: ROOT,
      symbol: "USDJPY",
      year: 2003,
      month: 5,
      day: 7,
      hour: 3,
    });
    expect(p).toBe("/data/ticks/USDJPY/2003/05/07/03h_ticks.bi5");
  });

  it("tickHourPath zero-pads hour 0 and hour 23", () => {
    expect(
      tickHourPath({
        root: ROOT,
        symbol: "EURUSD",
        year: 2024,
        month: 6,
        day: 1,
        hour: 0,
      }),
    ).toBe("/data/ticks/EURUSD/2024/06/01/00h_ticks.bi5");

    expect(
      tickHourPath({
        root: ROOT,
        symbol: "EURUSD",
        year: 2024,
        month: 6,
        day: 1,
        hour: 23,
      }),
    ).toBe("/data/ticks/EURUSD/2024/06/01/23h_ticks.bi5");
  });

  it("tickPathForTimestamp matches tickHourPath for the equivalent UTC components", () => {
    // 2024-01-15 10:30:45.123 UTC
    const ts = Date.UTC(2024, 0, 15, 10, 30, 45, 123);
    expect(
      tickPathForTimestamp({ root: ROOT, symbol: "EURUSD", timestampMs: ts }),
    ).toBe(
      tickHourPath({
        root: ROOT,
        symbol: "EURUSD",
        year: 2024,
        month: 1,
        day: 15,
        hour: 10,
      }),
    );
  });

  it("barParquetPath combines symbol and year under bars/1s/", () => {
    expect(barParquetPath({ root: ROOT, symbol: "EURUSD", year: 2024 })).toBe(
      "/data/bars/1s/EURUSD_2024.parquet",
    );
    expect(barParquetPath({ root: ROOT, symbol: "GER40", year: 2024 })).toBe(
      "/data/bars/1s/GER40_2024.parquet",
    );
  });
});

describe("tickHourPath / tickPathForTimestamp / barParquetPath — edge cases", () => {
  it("trims a single trailing slash on root", () => {
    expect(
      tickHourPath({
        root: "/data/",
        symbol: "EURUSD",
        year: 2024,
        month: 1,
        day: 15,
        hour: 10,
      }),
    ).toBe("/data/ticks/EURUSD/2024/01/15/10h_ticks.bi5");
  });

  it("accepts a Windows-style absolute root verbatim (caller owns OS conversion)", () => {
    expect(
      tickHourPath({
        root: "C:/Users/me/Hindsight/data",
        symbol: "EURUSD",
        year: 2024,
        month: 1,
        day: 15,
        hour: 10,
      }),
    ).toBe("C:/Users/me/Hindsight/data/ticks/EURUSD/2024/01/15/10h_ticks.bi5");
  });

  it("timestamp at exact hour boundary resolves to that hour", () => {
    const ts = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
    expect(
      tickPathForTimestamp({ root: ROOT, symbol: "EURUSD", timestampMs: ts }),
    ).toBe("/data/ticks/EURUSD/2024/01/15/10h_ticks.bi5");
  });

  it("timestamp at the last millisecond of an hour resolves to that same hour", () => {
    const ts = Date.UTC(2024, 0, 15, 10, 59, 59, 999);
    expect(
      tickPathForTimestamp({ root: ROOT, symbol: "EURUSD", timestampMs: ts }),
    ).toBe("/data/ticks/EURUSD/2024/01/15/10h_ticks.bi5");
  });

  it("timestamp one ms past the end of an hour resolves to the next hour", () => {
    const tsEnd = Date.UTC(2024, 0, 15, 10, 59, 59, 999);
    const tsNext = tsEnd + 1; // = 2024-01-15T11:00:00.000Z
    expect(
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: tsNext,
      }),
    ).toBe("/data/ticks/EURUSD/2024/01/15/11h_ticks.bi5");
  });

  it("year-boundary timestamps resolve to the correct year folder", () => {
    const lastHour2024 = Date.UTC(2024, 11, 31, 23, 30, 0);
    const firstHour2025 = Date.UTC(2025, 0, 1, 0, 0, 0);
    expect(
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: lastHour2024,
      }),
    ).toBe("/data/ticks/EURUSD/2024/12/31/23h_ticks.bi5");
    expect(
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: firstHour2025,
      }),
    ).toBe("/data/ticks/EURUSD/2025/01/01/00h_ticks.bi5");
  });

  it("handles February 29 on a leap year", () => {
    const ts = Date.UTC(2024, 1, 29, 12, 0, 0);
    expect(
      tickPathForTimestamp({ root: ROOT, symbol: "EURUSD", timestampMs: ts }),
    ).toBe("/data/ticks/EURUSD/2024/02/29/12h_ticks.bi5");
  });
});

describe("tickHourPath / tickPathForTimestamp / barParquetPath — breaking tests", () => {
  const baseHour = {
    root: ROOT,
    symbol: "EURUSD",
    year: 2024,
    month: 1,
    day: 15,
    hour: 10,
  } as const;

  it("throws on empty root", () => {
    expect(() => tickHourPath({ ...baseHour, root: "" })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on empty symbol", () => {
    expect(() => tickHourPath({ ...baseHour, symbol: "" })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on symbol containing path-traversal characters", () => {
    expect(() => tickHourPath({ ...baseHour, symbol: ".." })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, symbol: "EUR/USD" })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, symbol: "EUR\\USD" })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, symbol: "EUR USD" })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on lowercase symbol (catalog always uses uppercase)", () => {
    expect(() => tickHourPath({ ...baseHour, symbol: "eurusd" })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on month out of range (0, 13)", () => {
    expect(() => tickHourPath({ ...baseHour, month: 0 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, month: 13 })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on day out of range (0, 32)", () => {
    expect(() => tickHourPath({ ...baseHour, day: 0 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, day: 32 })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on hour out of range (-1, 24)", () => {
    expect(() => tickHourPath({ ...baseHour, hour: -1 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, hour: 24 })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on year < 1970 (sanity floor for Dukascopy data)", () => {
    expect(() => tickHourPath({ ...baseHour, year: 1969 })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on non-integer year / month / day / hour", () => {
    expect(() => tickHourPath({ ...baseHour, year: 2024.5 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, month: 1.5 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, day: 15.5 })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, hour: 10.5 })).toThrow(
      InvalidStoragePathError,
    );
  });

  it("throws on NaN / Infinity in any numeric hour field", () => {
    expect(() => tickHourPath({ ...baseHour, year: Number.NaN })).toThrow(
      InvalidStoragePathError,
    );
    expect(() => tickHourPath({ ...baseHour, month: Number.NaN })).toThrow(
      InvalidStoragePathError,
    );
    expect(() =>
      tickHourPath({ ...baseHour, day: Number.POSITIVE_INFINITY }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      tickHourPath({ ...baseHour, hour: Number.NEGATIVE_INFINITY }),
    ).toThrow(InvalidStoragePathError);
  });

  it("tickPathForTimestamp throws on NaN / Infinity / non-integer timestampMs", () => {
    expect(() =>
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: Number.NaN,
      }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: 1.5,
      }),
    ).toThrow(InvalidStoragePathError);
  });

  it("barParquetPath throws on invalid year and invalid symbol", () => {
    expect(() =>
      barParquetPath({ root: ROOT, symbol: "EURUSD", year: 1969 }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      barParquetPath({ root: ROOT, symbol: "EURUSD", year: Number.NaN }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      barParquetPath({ root: ROOT, symbol: "eurusd", year: 2024 }),
    ).toThrow(InvalidStoragePathError);
    expect(() =>
      barParquetPath({ root: "", symbol: "EURUSD", year: 2024 }),
    ).toThrow(InvalidStoragePathError);
  });
});

describe("tickHourPath / tickPathForTimestamp / barParquetPath — invariants", () => {
  it("tickPathForTimestamp equals tickHourPath(UTC components) over a grid of timestamps", () => {
    const samples: number[] = [
      Date.UTC(1970, 0, 1, 0, 0, 0, 1),
      Date.UTC(2003, 4, 5, 3, 0, 0, 0),
      Date.UTC(2024, 0, 15, 10, 30, 45, 123),
      Date.UTC(2024, 1, 29, 0, 0, 0, 0),
      Date.UTC(2024, 11, 31, 23, 59, 59, 999),
      Date.UTC(2025, 0, 1, 0, 0, 0, 0),
    ];
    for (const ts of samples) {
      const d = new Date(ts);
      const fromTs = tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: ts,
      });
      const fromHour = tickHourPath({
        root: ROOT,
        symbol: "EURUSD",
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
      });
      expect(fromTs).toBe(fromHour);
    }
  });

  it("every timestamp within the same UTC hour resolves to the same path", () => {
    const hourStart = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
    const within = [
      hourStart,
      hourStart + 1,
      hourStart + 30_000,
      hourStart + 1_800_000,
      hourStart + 3_599_999,
    ];
    const paths = new Set(
      within.map((ts) =>
        tickPathForTimestamp({ root: ROOT, symbol: "EURUSD", timestampMs: ts }),
      ),
    );
    expect(paths.size).toBe(1);
  });

  it("adjacent timestamps across an hour boundary resolve to different paths", () => {
    const hourEnd = Date.UTC(2024, 0, 15, 10, 59, 59, 999);
    const nextHour = hourEnd + 1;
    expect(
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: hourEnd,
      }),
    ).not.toBe(
      tickPathForTimestamp({
        root: ROOT,
        symbol: "EURUSD",
        timestampMs: nextHour,
      }),
    );
  });

  it("barParquetPath is distinct per (symbol, year)", () => {
    const paths = new Set<string>();
    for (const symbol of ["EURUSD", "GBPUSD", "XAUUSD", "GER40"]) {
      for (const year of [2022, 2023, 2024]) {
        paths.add(barParquetPath({ root: ROOT, symbol, year }));
      }
    }
    expect(paths.size).toBe(4 * 3);
  });
});
