import { describe, expect, it } from "vitest";
import type { Tick } from "../types.js";
import { InvalidBi5Error, decodeBi5Records } from "./bi5.js";

/**
 * Encode a single bi5 record into 20 big-endian bytes, matching Dukascopy's
 * wire format. Used only to build fixture buffers for tests; the production
 * code only ever decodes.
 *
 * Layout (big-endian):
 *   u32 msFromHourStart
 *   u32 ask  * priceScale
 *   u32 bid  * priceScale
 *   f32 askVolume
 *   f32 bidVolume
 */
function encodeBi5Record(input: {
  msFromHourStart: number;
  bid: number;
  ask: number;
  volumeBid: number;
  volumeAsk: number;
  priceScale: number;
}): Uint8Array {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  view.setUint32(0, input.msFromHourStart, false);
  view.setUint32(4, Math.round(input.ask * input.priceScale), false);
  view.setUint32(8, Math.round(input.bid * input.priceScale), false);
  view.setFloat32(12, input.volumeAsk, false);
  view.setFloat32(16, input.volumeBid, false);
  return new Uint8Array(buf);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// An arbitrary, human-legible UTC hour: 2024-01-15 10:00:00 UTC.
const HOUR_START_MS = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const FOREX_SCALE = 1e5;
const JPY_SCALE = 1e3;

describe("decodeBi5Records — core behaviour", () => {
  it("empty buffer decodes to an empty array", () => {
    expect(
      decodeBi5Records(new Uint8Array(0), HOUR_START_MS, FOREX_SCALE),
    ).toEqual([]);
  });

  it("decodes a single EURUSD-like record into the correct Tick", () => {
    const record = encodeBi5Record({
      msFromHourStart: 1_234,
      bid: 1.08540,
      ask: 1.08545,
      volumeBid: 1.5,
      volumeAsk: 2.25,
      priceScale: FOREX_SCALE,
    });
    const [tick] = decodeBi5Records(record, HOUR_START_MS, FOREX_SCALE);

    expect(tick).toBeDefined();
    expect(tick!.timestampMs).toBe(HOUR_START_MS + 1_234);
    expect(tick!.bid).toBeCloseTo(1.0854, 6);
    expect(tick!.ask).toBeCloseTo(1.08545, 6);
    // Float32 round-trip preserves these exactly (1.5) or within tolerance (2.25).
    expect(tick!.volumeBid).toBeCloseTo(1.5, 6);
    expect(tick!.volumeAsk).toBeCloseTo(2.25, 6);
  });

  it("decodes a JPY-scaled record (priceScale 1e3) correctly", () => {
    const record = encodeBi5Record({
      msFromHourStart: 42,
      bid: 149.231,
      ask: 149.234,
      volumeBid: 0.25,
      volumeAsk: 0.5,
      priceScale: JPY_SCALE,
    });
    const [tick] = decodeBi5Records(record, HOUR_START_MS, JPY_SCALE);

    expect(tick!.timestampMs).toBe(HOUR_START_MS + 42);
    expect(tick!.bid).toBeCloseTo(149.231, 4);
    expect(tick!.ask).toBeCloseTo(149.234, 4);
    expect(tick!.volumeBid).toBeCloseTo(0.25, 6);
    expect(tick!.volumeAsk).toBeCloseTo(0.5, 6);
  });

  it("decodes multiple records in buffer order", () => {
    const bytes = concatBytes([
      encodeBi5Record({
        msFromHourStart: 0,
        bid: 1.0,
        ask: 1.0001,
        volumeBid: 1,
        volumeAsk: 1,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 500,
        bid: 1.0002,
        ask: 1.0003,
        volumeBid: 2,
        volumeAsk: 2,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 1500,
        bid: 1.0004,
        ask: 1.0005,
        volumeBid: 3,
        volumeAsk: 3,
        priceScale: FOREX_SCALE,
      }),
    ]);
    const ticks = decodeBi5Records(bytes, HOUR_START_MS, FOREX_SCALE);
    expect(ticks).toHaveLength(3);
    expect(ticks.map((t) => t.timestampMs - HOUR_START_MS)).toEqual([
      0, 500, 1500,
    ]);
  });
});

describe("decodeBi5Records — edge cases", () => {
  it("decodes a tick exactly at the hour start (msFromHourStart = 0)", () => {
    const record = encodeBi5Record({
      msFromHourStart: 0,
      bid: 1.0,
      ask: 1.0001,
      volumeBid: 1,
      volumeAsk: 1,
      priceScale: FOREX_SCALE,
    });
    const [tick] = decodeBi5Records(record, HOUR_START_MS, FOREX_SCALE);
    expect(tick!.timestampMs).toBe(HOUR_START_MS);
  });

  it("decodes a tick one millisecond before the next hour (msFromHourStart = 3_599_999)", () => {
    const record = encodeBi5Record({
      msFromHourStart: 3_599_999,
      bid: 1.0,
      ask: 1.0001,
      volumeBid: 1,
      volumeAsk: 1,
      priceScale: FOREX_SCALE,
    });
    const [tick] = decodeBi5Records(record, HOUR_START_MS, FOREX_SCALE);
    expect(tick!.timestampMs).toBe(HOUR_START_MS + 3_599_999);
  });

  it("accepts a hourStartMs at epoch 0 (sanity check for downstream timestamp math)", () => {
    const record = encodeBi5Record({
      msFromHourStart: 100,
      bid: 1.0,
      ask: 1.0001,
      volumeBid: 1,
      volumeAsk: 1,
      priceScale: FOREX_SCALE,
    });
    const [tick] = decodeBi5Records(record, 0, FOREX_SCALE);
    expect(tick!.timestampMs).toBe(100);
  });

  it("zero volumes decode to exactly 0", () => {
    const record = encodeBi5Record({
      msFromHourStart: 0,
      bid: 1.0,
      ask: 1.0001,
      volumeBid: 0,
      volumeAsk: 0,
      priceScale: FOREX_SCALE,
    });
    const [tick] = decodeBi5Records(record, HOUR_START_MS, FOREX_SCALE);
    expect(tick!.volumeBid).toBe(0);
    expect(tick!.volumeAsk).toBe(0);
  });
});

describe("decodeBi5Records — breaking tests (must throw)", () => {
  it("throws when buffer length is not a multiple of 20", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(21), HOUR_START_MS, FOREX_SCALE),
    ).toThrow(InvalidBi5Error);
  });

  it("throws when buffer length is 1 (smaller than a record)", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(1), HOUR_START_MS, FOREX_SCALE),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on NaN priceScale", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(0), HOUR_START_MS, Number.NaN),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on Infinity priceScale", () => {
    expect(() =>
      decodeBi5Records(
        new Uint8Array(0),
        HOUR_START_MS,
        Number.POSITIVE_INFINITY,
      ),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on zero priceScale", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(0), HOUR_START_MS, 0),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on negative priceScale", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(0), HOUR_START_MS, -1e5),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on NaN hourStartMs", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(0), Number.NaN, FOREX_SCALE),
    ).toThrow(InvalidBi5Error);
  });

  it("throws on Infinity hourStartMs", () => {
    expect(() =>
      decodeBi5Records(
        new Uint8Array(0),
        Number.POSITIVE_INFINITY,
        FOREX_SCALE,
      ),
    ).toThrow(InvalidBi5Error);
  });

  it("throws when a record's msFromHourStart is >= 3_600_000 (spans hours)", () => {
    const record = encodeBi5Record({
      msFromHourStart: 3_600_000,
      bid: 1.0,
      ask: 1.0001,
      volumeBid: 1,
      volumeAsk: 1,
      priceScale: FOREX_SCALE,
    });
    expect(() =>
      decodeBi5Records(record, HOUR_START_MS, FOREX_SCALE),
    ).toThrow(InvalidBi5Error);
  });

  it("throws when a later record in a multi-record buffer spans hours", () => {
    const bytes = concatBytes([
      encodeBi5Record({
        msFromHourStart: 0,
        bid: 1.0,
        ask: 1.0001,
        volumeBid: 1,
        volumeAsk: 1,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 4_000_000,
        bid: 1.0,
        ask: 1.0001,
        volumeBid: 1,
        volumeAsk: 1,
        priceScale: FOREX_SCALE,
      }),
    ]);
    expect(() => decodeBi5Records(bytes, HOUR_START_MS, FOREX_SCALE)).toThrow(
      InvalidBi5Error,
    );
  });

  it("InvalidBi5Error carries a descriptive message", () => {
    try {
      decodeBi5Records(new Uint8Array(21), HOUR_START_MS, FOREX_SCALE);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidBi5Error);
      expect((err as Error).message.toLowerCase()).toContain("20");
    }
  });
});

describe("decodeBi5Records — invariants (property-style)", () => {
  it("ticks.length equals decompressed.length / 20 for valid buffers", () => {
    for (const n of [0, 1, 2, 5, 10, 37]) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(
          encodeBi5Record({
            msFromHourStart: i * 10,
            bid: 1.0 + i * 0.0001,
            ask: 1.0001 + i * 0.0001,
            volumeBid: 1,
            volumeAsk: 1,
            priceScale: FOREX_SCALE,
          }),
        );
      }
      const bytes = concatBytes(parts);
      const ticks = decodeBi5Records(bytes, HOUR_START_MS, FOREX_SCALE);
      expect(ticks.length).toBe(n);
      expect(bytes.length).toBe(n * 20);
    }
  });

  it("timestamps are non-decreasing for a chronologically-encoded buffer", () => {
    const offsets = [0, 1, 1, 2, 500, 500, 1000, 3_000_000, 3_599_999];
    const parts = offsets.map((off) =>
      encodeBi5Record({
        msFromHourStart: off,
        bid: 1.0,
        ask: 1.0001,
        volumeBid: 1,
        volumeAsk: 1,
        priceScale: FOREX_SCALE,
      }),
    );
    const ticks = decodeBi5Records(
      concatBytes(parts),
      HOUR_START_MS,
      FOREX_SCALE,
    );
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.timestampMs).toBeGreaterThanOrEqual(
        ticks[i - 1]!.timestampMs,
      );
    }
  });

  it("every tick's timestampMs is within [hourStartMs, hourStartMs + 3_600_000)", () => {
    const offsets = [0, 1, 1_000, 1_800_000, 3_599_999];
    const parts = offsets.map((off) =>
      encodeBi5Record({
        msFromHourStart: off,
        bid: 1.0,
        ask: 1.0001,
        volumeBid: 1,
        volumeAsk: 1,
        priceScale: FOREX_SCALE,
      }),
    );
    const ticks = decodeBi5Records(
      concatBytes(parts),
      HOUR_START_MS,
      FOREX_SCALE,
    );
    for (const t of ticks) {
      expect(t.timestampMs).toBeGreaterThanOrEqual(HOUR_START_MS);
      expect(t.timestampMs).toBeLessThan(HOUR_START_MS + 3_600_000);
    }
  });

  it("encode→decode round-trip across a grid of prices and scales preserves values", () => {
    const grid: Array<{
      bid: number;
      ask: number;
      volumeBid: number;
      volumeAsk: number;
      priceScale: number;
      tolerance: number;
    }> = [
      { bid: 1.08540, ask: 1.08545, volumeBid: 1.5, volumeAsk: 2.25, priceScale: FOREX_SCALE, tolerance: 1e-5 },
      { bid: 149.231, ask: 149.234, volumeBid: 0.25, volumeAsk: 0.5, priceScale: JPY_SCALE, tolerance: 1e-3 },
      { bid: 1950.25, ask: 1950.45, volumeBid: 0.01, volumeAsk: 0.02, priceScale: FOREX_SCALE, tolerance: 1e-2 },
      { bid: 0.65432, ask: 0.65437, volumeBid: 10, volumeAsk: 20, priceScale: FOREX_SCALE, tolerance: 1e-5 },
    ];

    for (const row of grid) {
      const record = encodeBi5Record({
        msFromHourStart: 123,
        bid: row.bid,
        ask: row.ask,
        volumeBid: row.volumeBid,
        volumeAsk: row.volumeAsk,
        priceScale: row.priceScale,
      });
      const [tick] = decodeBi5Records(record, HOUR_START_MS, row.priceScale);
      expect(tick!.bid).toBeCloseTo(row.bid, -Math.log10(row.tolerance));
      expect(tick!.ask).toBeCloseTo(row.ask, -Math.log10(row.tolerance));
      expect(tick!.volumeBid).toBeCloseTo(row.volumeBid, 5);
      expect(tick!.volumeAsk).toBeCloseTo(row.volumeAsk, 5);
    }
  });
});

// Tiny compile-time check that Tick from shared/types.ts is the return shape.
// (vitest type tests aren't set up yet; this is the cheapest safety net.)
function _assertReturnIsTickArray(bytes: Uint8Array): Tick[] {
  return decodeBi5Records(bytes, 0, FOREX_SCALE);
}
void _assertReturnIsTickArray;
