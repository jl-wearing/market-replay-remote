/**
 * Integration test: bi5 bytes → ticks → 1 s OHLCV bars.
 *
 * Co-located with `aggregate.ts` because that is the composition's terminal
 * step. Both halves of the pipeline (`decodeBi5Records` and
 * `ticksToSecondBars`) are pure, so this test runs entirely offline and
 * deterministically — no network, no fs, no Electron.
 *
 * What this catches that the per-module unit tests cannot:
 * - The two modules agree on the `Tick` shape (field names, units,
 *   bid-vs-ask convention).
 * - The intra-hour ms offset semantics from bi5 line up with the
 *   millisecond-bucketing in aggregate (boundaries land in the right
 *   second).
 * - Each module owns its own error class and neither silently translates
 *   the other's failure mode (e.g. a bi5 parse error must surface as
 *   `InvalidBi5Error`, not get reframed by the aggregator).
 * - Cross-module data-quality semantics: bi5 deliberately accepts
 *   non-monotonic records and inverted spreads (parser concerns only);
 *   the aggregator owns the "must not regress in time" contract; both
 *   leave inverted spreads untouched. This file pins all three.
 *
 * The bi5 encoder helper duplicates the one in `bi5.test.ts` on purpose
 * so each test file reads stand-alone. The byte layout is documented in
 * `bi5.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  InvalidBi5Error,
  decodeBi5Records,
} from "../dukascopy/bi5.js";
import { InvalidTickStreamError, ticksToSecondBars } from "./aggregate.js";

/**
 * Encode a single bi5 record to its 20-byte big-endian wire form. Layout:
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

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// 2024-01-15 10:00:00 UTC. A whole UTC hour, mid-London-session, settled
// long ago — same anchor the per-module tests use.
const HOUR_MS = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const FOREX_SCALE = 1e5;
const ONE_HOUR_MS = 3_600_000;

describe("bi5 → ticksToSecondBars composition — core behaviour", () => {
  it("decodes 4 records spanning 2 seconds and aggregates into 2 bars with hand-computed OHLCV per side", () => {
    // All volumes chosen to be exactly representable in float32 (1.5,
    // 1.25, 0.5, 1.0, 2.0, 0.75) so volume sums compare with `.toBe`.
    const bytes = concatBytes([
      encodeBi5Record({
        msFromHourStart: 500,
        bid: 1.1,
        ask: 1.10003,
        volumeBid: 1.5,
        volumeAsk: 1.25,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 750,
        bid: 1.10005,
        ask: 1.10008,
        volumeBid: 0.5,
        volumeAsk: 1.0,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 1_100,
        bid: 1.10004,
        ask: 1.10006,
        volumeBid: 2.0,
        volumeAsk: 0.75,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 1_900,
        bid: 1.09998,
        ask: 1.10001,
        volumeBid: 1.0,
        volumeAsk: 0.5,
        priceScale: FOREX_SCALE,
      }),
    ]);

    const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
    const bars = ticksToSecondBars(ticks);

    expect(ticks).toHaveLength(4);
    expect(bars).toHaveLength(2);

    const [bar0, bar1] = bars;
    expect(bar0).toBeDefined();
    expect(bar1).toBeDefined();

    expect(bar0!.timestampMs).toBe(HOUR_MS);
    expect(bar0!.oBid).toBeCloseTo(1.1, 6);
    expect(bar0!.hBid).toBeCloseTo(1.10005, 6);
    expect(bar0!.lBid).toBeCloseTo(1.1, 6);
    expect(bar0!.cBid).toBeCloseTo(1.10005, 6);
    expect(bar0!.oAsk).toBeCloseTo(1.10003, 6);
    expect(bar0!.hAsk).toBeCloseTo(1.10008, 6);
    expect(bar0!.lAsk).toBeCloseTo(1.10003, 6);
    expect(bar0!.cAsk).toBeCloseTo(1.10008, 6);
    expect(bar0!.volumeBid).toBe(2.0);
    expect(bar0!.volumeAsk).toBe(2.25);
    expect(bar0!.tickCount).toBe(2);

    expect(bar1!.timestampMs).toBe(HOUR_MS + 1_000);
    expect(bar1!.oBid).toBeCloseTo(1.10004, 6);
    expect(bar1!.hBid).toBeCloseTo(1.10004, 6);
    expect(bar1!.lBid).toBeCloseTo(1.09998, 6);
    expect(bar1!.cBid).toBeCloseTo(1.09998, 6);
    expect(bar1!.oAsk).toBeCloseTo(1.10006, 6);
    expect(bar1!.hAsk).toBeCloseTo(1.10006, 6);
    expect(bar1!.lAsk).toBeCloseTo(1.10001, 6);
    expect(bar1!.cAsk).toBeCloseTo(1.10001, 6);
    expect(bar1!.volumeBid).toBe(3.0);
    expect(bar1!.volumeAsk).toBe(1.25);
    expect(bar1!.tickCount).toBe(2);
  });
});

describe("bi5 → ticksToSecondBars composition — edge cases", () => {
  it("empty bi5 buffer → empty ticks → empty bars (no throws at either layer)", () => {
    const ticks = decodeBi5Records(new Uint8Array(0), HOUR_MS, FOREX_SCALE);
    const bars = ticksToSecondBars(ticks);
    expect(ticks).toEqual([]);
    expect(bars).toEqual([]);
  });

  it("a single record decodes to one tick that aggregates to one bar with O=H=L=C and tickCount=1", () => {
    const bytes = encodeBi5Record({
      msFromHourStart: 250,
      bid: 1.1,
      ask: 1.10003,
      volumeBid: 1.5,
      volumeAsk: 0.5,
      priceScale: FOREX_SCALE,
    });
    const bars = ticksToSecondBars(
      decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE),
    );

    expect(bars).toHaveLength(1);
    const [b] = bars;
    expect(b!.timestampMs).toBe(HOUR_MS);
    expect(b!.oBid).toBe(b!.cBid);
    expect(b!.oBid).toBe(b!.hBid);
    expect(b!.oBid).toBe(b!.lBid);
    expect(b!.oAsk).toBe(b!.cAsk);
    expect(b!.oAsk).toBe(b!.hAsk);
    expect(b!.oAsk).toBe(b!.lAsk);
    expect(b!.volumeBid).toBe(1.5);
    expect(b!.volumeAsk).toBe(0.5);
    expect(b!.tickCount).toBe(1);
  });

  it("ms offsets 999 and 1000 land in adjacent bars (the 1000-ms tick goes into the +1000 bucket, not the +0 bucket)", () => {
    const bytes = concatBytes([
      encodeBi5Record({
        msFromHourStart: 999,
        bid: 1.1,
        ask: 1.10003,
        volumeBid: 1.0,
        volumeAsk: 1.0,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 1_000,
        bid: 1.10005,
        ask: 1.10008,
        volumeBid: 1.0,
        volumeAsk: 1.0,
        priceScale: FOREX_SCALE,
      }),
    ]);
    const bars = ticksToSecondBars(
      decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE),
    );

    expect(bars).toHaveLength(2);
    expect(bars[0]!.timestampMs).toBe(HOUR_MS);
    expect(bars[0]!.tickCount).toBe(1);
    expect(bars[1]!.timestampMs).toBe(HOUR_MS + 1_000);
    expect(bars[1]!.tickCount).toBe(1);
  });

  it("a tick at the last legal ms (3_599_999) produces a bar at HOUR_MS + 3_599_000", () => {
    const bytes = encodeBi5Record({
      msFromHourStart: 3_599_999,
      bid: 1.1,
      ask: 1.10003,
      volumeBid: 1.0,
      volumeAsk: 1.0,
      priceScale: FOREX_SCALE,
    });
    const bars = ticksToSecondBars(
      decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE),
    );

    expect(bars).toHaveLength(1);
    expect(bars[0]!.timestampMs).toBe(HOUR_MS + 3_599_000);
  });

  it("inverted spread (bid > ask) round-trips through both layers untouched (data-quality, not structural)", () => {
    const bytes = encodeBi5Record({
      msFromHourStart: 100,
      bid: 1.10010,
      ask: 1.10005,
      volumeBid: 1.0,
      volumeAsk: 1.0,
      priceScale: FOREX_SCALE,
    });
    const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
    const bars = ticksToSecondBars(ticks);

    expect(ticks[0]!.bid).toBeGreaterThan(ticks[0]!.ask);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.oBid).toBeGreaterThan(bars[0]!.oAsk);
  });
});

describe("bi5 → ticksToSecondBars composition — breaking tests (must throw)", () => {
  it("bi5-layer parse error surfaces as InvalidBi5Error; the aggregator never runs", () => {
    expect(() =>
      decodeBi5Records(new Uint8Array(21), HOUR_MS, FOREX_SCALE),
    ).toThrow(InvalidBi5Error);
  });

  it("non-monotonic ms offsets are accepted by bi5 (parser concern only) but rejected by aggregate as InvalidTickStreamError", () => {
    // bi5 deliberately does not enforce chronological ordering — that is
    // the aggregator's contract. This pins the cross-layer split.
    const bytes = concatBytes([
      encodeBi5Record({
        msFromHourStart: 500,
        bid: 1.1,
        ask: 1.10003,
        volumeBid: 1.0,
        volumeAsk: 1.0,
        priceScale: FOREX_SCALE,
      }),
      encodeBi5Record({
        msFromHourStart: 200,
        bid: 1.10005,
        ask: 1.10008,
        volumeBid: 1.0,
        volumeAsk: 1.0,
        priceScale: FOREX_SCALE,
      }),
    ]);

    const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
    expect(ticks).toHaveLength(2);
    expect(ticks[1]!.timestampMs).toBeLessThan(ticks[0]!.timestampMs);

    expect(() => ticksToSecondBars(ticks)).toThrow(InvalidTickStreamError);
  });

  it("a record whose ms offset spans hours throws InvalidBi5Error from the decoder, not InvalidTickStreamError from the aggregator", () => {
    const bytes = encodeBi5Record({
      msFromHourStart: 3_600_000,
      bid: 1.1,
      ask: 1.10003,
      volumeBid: 1.0,
      volumeAsk: 1.0,
      priceScale: FOREX_SCALE,
    });

    let caught: unknown = null;
    try {
      const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
      ticksToSecondBars(ticks);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidBi5Error);
    expect(caught).not.toBeInstanceOf(InvalidTickStreamError);
  });
});

describe("bi5 → ticksToSecondBars composition — invariants (property-style)", () => {
  it("for a grid of valid buffers: every bar timestampMs is in [HOUR_MS, HOUR_MS + 3_599_000] and a multiple of 1000, and Σ tickCount == record count", () => {
    const offsetGrids: number[][] = [
      [0],
      [0, 1, 999, 1_000, 1_001],
      [10, 10, 10, 10],
      [100, 5_200, 5_800, 12_000, 12_500, 12_999],
      [0, 1_800_000, 3_599_999],
    ];

    for (const offsets of offsetGrids) {
      const parts = offsets.map((off, i) =>
        encodeBi5Record({
          msFromHourStart: off,
          bid: 1.1 + i * 0.0001,
          ask: 1.10003 + i * 0.0001,
          volumeBid: 1.0,
          volumeAsk: 1.0,
          priceScale: FOREX_SCALE,
        }),
      );
      const bytes = concatBytes(parts);
      const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
      const bars = ticksToSecondBars(ticks);

      const totalTicks = bars.reduce((n, b) => n + b.tickCount, 0);
      expect(totalTicks).toBe(offsets.length);

      for (const b of bars) {
        expect(b.timestampMs % 1_000).toBe(0);
        expect(b.timestampMs).toBeGreaterThanOrEqual(HOUR_MS);
        expect(b.timestampMs).toBeLessThanOrEqual(HOUR_MS + ONE_HOUR_MS - 1_000);
      }
    }
  });

  it("volume conservation: Σ bar.volumeBid == Σ tick.volumeBid (per side) for f32-exact volumes", () => {
    // Volumes restricted to the dyadic-rational set {0.25, 0.5, 0.75,
    // 1.0, 1.25, 1.5, 2.0} so every f32 value is exact and the sums are
    // exact in double precision too.
    const offsets = [50, 250, 750, 1_250, 1_750, 2_500, 3_500];
    const volumes = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

    const parts = offsets.map((off, i) =>
      encodeBi5Record({
        msFromHourStart: off,
        bid: 1.1,
        ask: 1.10003,
        volumeBid: volumes[i % volumes.length]!,
        volumeAsk: volumes[(i + 3) % volumes.length]!,
        priceScale: FOREX_SCALE,
      }),
    );
    const bytes = concatBytes(parts);
    const ticks = decodeBi5Records(bytes, HOUR_MS, FOREX_SCALE);
    const bars = ticksToSecondBars(ticks);

    const sumTickBid = ticks.reduce((n, t) => n + t.volumeBid, 0);
    const sumTickAsk = ticks.reduce((n, t) => n + t.volumeAsk, 0);
    const sumBarBid = bars.reduce((n, b) => n + b.volumeBid, 0);
    const sumBarAsk = bars.reduce((n, b) => n + b.volumeAsk, 0);

    expect(sumBarBid).toBe(sumTickBid);
    expect(sumBarAsk).toBe(sumTickAsk);
  });
});
