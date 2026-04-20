/**
 * Integration test: bi5 bytes → ingest orchestrator → BarStore.
 *
 * Co-located with `ingest.ts` because the orchestrator is the
 * composition's terminal step. The pipeline runs end-to-end for real
 * (`decodeBi5Records` and `ticksToSecondBars` are not mocked); only the
 * I/O endpoints — `DukascopyClient` and `BarStore` — are faked, so the
 * test runs entirely offline and deterministically.
 *
 * The unit test (`ingest.test.ts`) pins control-flow contracts: call
 * counts, error wrapping, validation, callback ordering. This file
 * pins what the *data* looks like after a realistic multi-hour run —
 * the kind of regression a control-flow test would not notice (e.g. a
 * scale being threaded through wrong, a timestamp drifting by an hour,
 * a tick from one hour landing in the next hour's writeHour batch).
 *
 * What this catches that per-module tests cannot:
 * - `priceScale` is the right value for the symbol being ingested
 *   (EURUSD's 1e5 vs USDJPY's 1e3 vs XAUUSD's 1e3 — a wrong choice
 *   would mis-scale prices by 100x and would *not* throw, just produce
 *   silently wrong bars).
 * - `hourStartMs` parameter to `decodeBi5Records` matches the loop
 *   variable, so a tick at `msFromHourStart=500` of hour H produces a
 *   bar at `H + 0` (not at `(H-1h) + 500ms` or some other off-by-hour
 *   skew).
 * - Bars from hour H always arrive in the `writeHour` call for hour H,
 *   never the wrong hour.
 */

import { describe, expect, it } from "vitest";
import type { Bar } from "../../shared/types.js";
import {
  catalogToDukascopy,
  type DukascopySymbol,
} from "../../shared/dukascopy/symbolMap.js";
import {
  toCatalogSymbol,
  type CatalogSymbol,
} from "../../shared/instruments.js";
import type { DukascopyClient } from "./dukascopyClient.js";
import { type BarStore, IngestError, ingestSymbol } from "./ingest.js";

const ONE_HOUR_MS = 3_600_000;

function encodeBi5(records: ReadonlyArray<{
  msFromHourStart: number;
  bid: number;
  ask: number;
  volumeBid?: number;
  volumeAsk?: number;
}>, scale: number): Uint8Array {
  const out = new Uint8Array(records.length * 20);
  const view = new DataView(out.buffer);
  records.forEach((r, i) => {
    const base = i * 20;
    view.setUint32(base, r.msFromHourStart, false);
    view.setUint32(base + 4, Math.round(r.ask * scale), false);
    view.setUint32(base + 8, Math.round(r.bid * scale), false);
    view.setFloat32(base + 12, r.volumeAsk ?? 1, false);
    view.setFloat32(base + 16, r.volumeBid ?? 1, false);
  });
  return out;
}

interface CapturedHour {
  symbol: CatalogSymbol;
  hourMs: number;
  bars: readonly Bar[];
}

function makeStore(): { store: BarStore; written: CapturedHour[] } {
  const written: CapturedHour[] = [];
  const store: BarStore = {
    async writeHour(args) {
      written.push({ symbol: args.symbol, hourMs: args.hourMs, bars: args.bars });
    },
  };
  return { store, written };
}

function makeClient(
  responses: ReadonlyMap<string, ReadonlyMap<number, Uint8Array>>,
): DukascopyClient {
  return {
    async fetchHour({ symbol, hourStartMs }) {
      return (
        responses.get(symbol)?.get(hourStartMs) ?? new Uint8Array(0)
      );
    },
  };
}

const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const HOUR_1 = HOUR_0 + ONE_HOUR_MS;

const EURUSD_CAT = toCatalogSymbol("EURUSD");
const USDJPY_CAT = toCatalogSymbol("USDJPY");
const XAUUSD_CAT = toCatalogSymbol("XAUUSD");

describe("ingestSymbol — integration: bi5 → orchestrator → store", () => {
  it("for EURUSD (1e5 wire scale): 4 records across 2 hours produce the correct bars in the correct writeHour batches", async () => {
    // Hour 0: two ticks in the 0th second, two ticks in the 2nd second.
    // Hour 1: one tick in the 5th second.
    const eurusdHour0 = encodeBi5([
      { msFromHourStart: 100, bid: 1.10000, ask: 1.10003, volumeBid: 1.0, volumeAsk: 1.0 },
      { msFromHourStart: 200, bid: 1.10005, ask: 1.10008, volumeBid: 0.5, volumeAsk: 0.5 },
      { msFromHourStart: 2_100, bid: 1.10010, ask: 1.10013, volumeBid: 1.0, volumeAsk: 1.5 },
      { msFromHourStart: 2_700, bid: 1.10004, ask: 1.10007, volumeBid: 0.5, volumeAsk: 0.5 },
    ], 100_000);
    const eurusdHour1 = encodeBi5([
      { msFromHourStart: 5_500, bid: 1.10020, ask: 1.10023, volumeBid: 0.25, volumeAsk: 0.25 },
    ], 100_000);

    const responses = new Map<string, Map<number, Uint8Array>>([
      ["eurusd", new Map([
        [HOUR_0, eurusdHour0],
        [HOUR_1, eurusdHour1],
      ])],
    ]);

    const { store, written } = makeStore();
    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 + ONE_HOUR_MS },
      { client: makeClient(responses), store },
    );

    expect(stats).toEqual({
      hoursFetched: 2,
      hoursEmpty: 0,
      totalTicks: 5,
      totalBars: 3, // hour 0: 2 bars (sec 0, sec 2), hour 1: 1 bar (sec 5)
    });

    expect(written).toHaveLength(2);
    const [h0, h1] = written;
    expect(h0!.symbol).toBe("EURUSD");
    expect(h0!.hourMs).toBe(HOUR_0);
    expect(h0!.bars.map((b) => b.timestampMs)).toEqual([HOUR_0, HOUR_0 + 2_000]);
    // Sec 0: O=1.10000, H=1.10005, L=1.10000, C=1.10005 (bid side).
    expect(h0!.bars[0]!.oBid).toBeCloseTo(1.10000, 6);
    expect(h0!.bars[0]!.hBid).toBeCloseTo(1.10005, 6);
    expect(h0!.bars[0]!.lBid).toBeCloseTo(1.10000, 6);
    expect(h0!.bars[0]!.cBid).toBeCloseTo(1.10005, 6);
    expect(h0!.bars[0]!.tickCount).toBe(2);
    // Sec 2: O=1.10010, H=1.10010, L=1.10004, C=1.10004.
    expect(h0!.bars[1]!.oBid).toBeCloseTo(1.10010, 6);
    expect(h0!.bars[1]!.lBid).toBeCloseTo(1.10004, 6);
    expect(h0!.bars[1]!.cBid).toBeCloseTo(1.10004, 6);
    expect(h0!.bars[1]!.tickCount).toBe(2);

    expect(h1!.symbol).toBe("EURUSD");
    expect(h1!.hourMs).toBe(HOUR_1);
    expect(h1!.bars).toHaveLength(1);
    expect(h1!.bars[0]!.timestampMs).toBe(HOUR_1 + 5_000);
    expect(h1!.bars[0]!.oBid).toBeCloseTo(1.10020, 6);
  });

  it("for USDJPY (1e3 wire scale): the orchestrator picks the right scale and prices come back un-mis-scaled", async () => {
    // If the orchestrator wired EURUSD's 1e5 instead of USDJPY's 1e3,
    // 147.123 would come out as 1.47123 — not throw, just be silently
    // 100x too small. This test pins that the scale selection is right.
    const usdjpyBytes = encodeBi5([
      { msFromHourStart: 0, bid: 147.123, ask: 147.125 },
    ], 1_000);

    const responses = new Map<string, Map<number, Uint8Array>>([
      ["usdjpy", new Map([[HOUR_0, usdjpyBytes]])],
    ]);

    const { store, written } = makeStore();
    await ingestSymbol(
      { symbol: USDJPY_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: makeClient(responses), store },
    );

    expect(written).toHaveLength(1);
    expect(written[0]!.bars[0]!.oBid).toBeCloseTo(147.123, 3);
    expect(written[0]!.bars[0]!.oAsk).toBeCloseTo(147.125, 3);
    expect(written[0]!.bars[0]!.oBid).toBeGreaterThan(100);
  });

  it("for XAUUSD (1e3 wire scale, USD-quoted): does not fall back to the FX 1e5 default", async () => {
    // Catches the easy bug "if quote is USD use 1e5". Gold's wire
    // scale is 1e3 even though it's USD-quoted.
    const xauBytes = encodeBi5([
      { msFromHourStart: 0, bid: 2_034.567, ask: 2_034.812 },
    ], 1_000);

    const responses = new Map<string, Map<number, Uint8Array>>([
      ["xauusd", new Map([[HOUR_0, xauBytes]])],
    ]);

    const { store, written } = makeStore();
    await ingestSymbol(
      { symbol: XAUUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: makeClient(responses), store },
    );

    expect(written[0]!.bars[0]!.oBid).toBeCloseTo(2_034.567, 3);
    expect(written[0]!.bars[0]!.oBid).toBeGreaterThan(1_000);
  });

  it("a mixed run (full hour, empty hour, full hour) writes one bars entry per hour, with [] for the empty hour", async () => {
    const bytesH0 = encodeBi5([
      { msFromHourStart: 0, bid: 1.1, ask: 1.10003 },
    ], 100_000);
    const bytesH2 = encodeBi5([
      { msFromHourStart: 0, bid: 1.10010, ask: 1.10013 },
    ], 100_000);

    const responses = new Map<string, Map<number, Uint8Array>>([
      ["eurusd", new Map([
        [HOUR_0, bytesH0],
        // HOUR_1 absent → empty
        [HOUR_0 + 2 * ONE_HOUR_MS, bytesH2],
      ])],
    ]);

    const { store, written } = makeStore();
    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: makeClient(responses), store },
    );

    expect(written).toHaveLength(3);
    expect(written[0]!.bars).toHaveLength(1);
    expect(written[1]!.bars).toEqual([]);
    expect(written[2]!.bars).toHaveLength(1);

    expect(stats).toEqual({
      hoursFetched: 3,
      hoursEmpty: 1,
      totalTicks: 2,
      totalBars: 2,
    });
  });

  it("corrupt bi5 (length not a multiple of 20) surfaces as IngestError(phase='decode') wrapping InvalidBi5Error, after the fetch and before the store write", async () => {
    const corrupt = new Uint8Array(21);
    const responses = new Map<string, Map<number, Uint8Array>>([
      ["eurusd", new Map([[HOUR_0, corrupt]])],
    ]);
    const { store, written } = makeStore();

    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client: makeClient(responses), store },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as IngestError).phase).toBe("decode");
    expect((caught as IngestError).hourMs).toBe(HOUR_0);
    expect(written).toEqual([]);
  });
});

describe("ingestSymbol — integration: invariants over a multi-hour synthetic run", () => {
  it("Σ written.bars.tickCount == Σ encoded records, and every bar's timestamp is in its writeHour's hour window", async () => {
    // Encode a deterministic mix: each hour gets between 0 and 7
    // records at semi-random ms offsets across the hour.
    const hours = 6;
    const recordsPerHour: ReadonlyArray<ReadonlyArray<number>> = [
      [],                                             // hour 0: empty
      [100],                                          // hour 1: one tick
      [50, 200, 1_500, 2_750],                        // hour 2: four ticks across 3 secs
      [0, 999, 1_000, 1_001, 3_500_000, 3_599_999],   // hour 3: boundary mix
      [],                                             // hour 4: empty
      [42, 84, 168, 336, 672, 1_344, 2_688],          // hour 5: seven ticks all in sec 0..2
    ];

    const responses = new Map<string, Map<number, Uint8Array>>();
    const eurusdMap = new Map<number, Uint8Array>();
    let totalEncoded = 0;
    for (let i = 0; i < hours; i++) {
      const offsets = recordsPerHour[i]!;
      totalEncoded += offsets.length;
      if (offsets.length === 0) continue;
      const bytes = encodeBi5(
        offsets.map((off, k) => ({
          msFromHourStart: off,
          bid: 1.1 + k * 0.0001,
          ask: 1.10003 + k * 0.0001,
        })),
        100_000,
      );
      eurusdMap.set(HOUR_0 + i * ONE_HOUR_MS, bytes);
    }
    responses.set("eurusd", eurusdMap);

    const { store, written } = makeStore();
    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + hours * ONE_HOUR_MS },
      { client: makeClient(responses), store },
    );

    expect(written).toHaveLength(hours);
    expect(stats.hoursFetched).toBe(hours);
    expect(stats.totalTicks).toBe(totalEncoded);

    let sumTickCount = 0;
    for (let i = 0; i < hours; i++) {
      const w = written[i]!;
      expect(w.hourMs).toBe(HOUR_0 + i * ONE_HOUR_MS);
      for (const b of w.bars) {
        expect(b.timestampMs).toBeGreaterThanOrEqual(w.hourMs);
        expect(b.timestampMs).toBeLessThan(w.hourMs + ONE_HOUR_MS);
        expect(b.timestampMs % 1_000).toBe(0);
      }
      sumTickCount += w.bars.reduce((n, b) => n + b.tickCount, 0);
    }
    expect(sumTickCount).toBe(totalEncoded);
  });

  it("the dukascopy-symbol passed to fetchHour is exactly catalogToDukascopy(spec.symbol) for several catalog symbols", async () => {
    // Sanity: orchestrator threads the brand right. One sample from
    // each scale class.
    const samples: ReadonlyArray<readonly [CatalogSymbol, DukascopySymbol]> = [
      [toCatalogSymbol("EURUSD"), catalogToDukascopy("EURUSD")],
      [toCatalogSymbol("USDJPY"), catalogToDukascopy("USDJPY")],
      [toCatalogSymbol("XAUUSD"), catalogToDukascopy("XAUUSD")],
      [toCatalogSymbol("GER40"), catalogToDukascopy("GER40")],
    ];
    for (const [catalog, expectedDuka] of samples) {
      const seen: DukascopySymbol[] = [];
      const client: DukascopyClient = {
        async fetchHour({ symbol }) {
          seen.push(symbol);
          return new Uint8Array(0);
        },
      };
      const { store } = makeStore();
      await ingestSymbol(
        { symbol: catalog, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client, store },
      );
      expect(seen).toEqual([expectedDuka]);
    }
  });
});
