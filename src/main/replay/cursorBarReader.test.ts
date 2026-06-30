import { describe, it, expect } from "vitest";
import type { Bar } from "../../shared/types.js";
import { toCatalogSymbol, type CatalogSymbol } from "../../shared/instruments.js";
import {
  InvalidClipInputError,
  NoPeekingViolationError,
} from "../../shared/replay/clip.js";
import { BarStoreError } from "../data/duckDbBarStore.js";
import { readBarsUpToCursor, type CursorBarSource } from "./cursorBarReader.js";

const EURUSD = toCatalogSymbol("EURUSD");

/** Minimal `Bar` — content is irrelevant to a fake source that just echoes it. */
function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1.1, hBid: 1.1, lBid: 1.1, cBid: 1.1,
    oAsk: 1.1, hAsk: 1.1, lAsk: 1.1, cAsk: 1.1,
    volumeBid: 1, volumeAsk: 1, tickCount: 1,
  };
}

interface RecordedCall {
  symbol: CatalogSymbol;
  fromMs: number;
  toMs: number;
}

/**
 * A `CursorBarSource` that records every `readBarsInRange` call so tests can
 * assert the reader handed the store a *clipped* range — or never called it
 * at all. Optionally returns canned bars or throws.
 */
function fakeSource(
  opts: { bars?: Bar[]; throwErr?: unknown } = {},
): CursorBarSource & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async readBarsInRange(args) {
      calls.push({ ...args });
      if (opts.throwErr !== undefined) throw opts.throwErr;
      return opts.bars ?? [];
    },
  };
}

/** Run a thunk and return whatever it threw/rejected with (or `undefined`). */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("cursorBarReader — core behaviour", () => {
  it("clips toMs down to the cursor before reading", async () => {
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 1_000, toMs: 10_000, cursorMs: 5_000 });
    expect(src.calls).toEqual([{ symbol: EURUSD, fromMs: 1_000, toMs: 5_001 }]);
  });

  it("leaves an already-past range unchanged", async () => {
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 1_000, toMs: 2_000, cursorMs: 5_000 });
    expect(src.calls).toEqual([{ symbol: EURUSD, fromMs: 1_000, toMs: 2_000 }]);
  });

  it("returns exactly the bars the store yields", async () => {
    const bars = [mkBar(1_000), mkBar(2_000), mkBar(3_000)];
    const src = fakeSource({ bars });
    const out = await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 0, toMs: 10_000, cursorMs: 9_000 });
    expect(out).toEqual(bars);
  });

  it("passes the symbol through to the store", async () => {
    const usdjpy = toCatalogSymbol("USDJPY");
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: usdjpy, fromMs: 0, toMs: 1_000, cursorMs: 5_000 });
    expect(src.calls[0]!.symbol).toBe(usdjpy);
  });
});

describe("cursorBarReader — edge cases", () => {
  it("floors a fractional cursor to the bar at or before it", async () => {
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 1_000, toMs: 10_000, cursorMs: 5_000.5 });
    expect(src.calls[0]!.toMs).toBe(5_001);
  });

  it("a fractional cursor just below a bar hides that bar", async () => {
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 1_000, toMs: 10_000, cursorMs: 4_999.9 });
    expect(src.calls[0]!.toMs).toBe(5_000);
  });

  it("fromMs equal to an integer cursor reads a single-bar window", async () => {
    const src = fakeSource();
    await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 5_000, toMs: 10_000, cursorMs: 5_000 });
    expect(src.calls).toEqual([{ symbol: EURUSD, fromMs: 5_000, toMs: 5_001 }]);
  });

  it("returns an empty array when the store has nothing in range", async () => {
    const src = fakeSource({ bars: [] });
    const out = await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 0, toMs: 1_000, cursorMs: 500 });
    expect(out).toEqual([]);
  });
});

describe("cursorBarReader — breaking tests (must throw / must not happen)", () => {
  it("propagates NoPeekingViolationError and never touches the store", async () => {
    const src = fakeSource();
    const err = await caught(
      readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 6_000, toMs: 10_000, cursorMs: 5_000 }),
    );
    expect(err).toBeInstanceOf(NoPeekingViolationError);
    expect((err as NoPeekingViolationError).cursorMs).toBe(5_000);
    expect(src.calls).toHaveLength(0); // the future read never reached the database
  });

  it("propagates InvalidClipInputError for bad bounds without touching the store", async () => {
    const src = fakeSource();
    const err = await caught(
      readBarsUpToCursor(src, { symbol: EURUSD, fromMs: Number.NaN, toMs: 10_000, cursorMs: 5_000 }),
    );
    expect(err).toBeInstanceOf(InvalidClipInputError);
    expect((err as InvalidClipInputError).code).toBe("range");
    expect(src.calls).toHaveLength(0);
  });

  it("propagates InvalidClipInputError for a bad cursor without touching the store", async () => {
    const src = fakeSource();
    const err = await caught(
      readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 0, toMs: 10_000, cursorMs: -1 }),
    );
    expect(err).toBeInstanceOf(InvalidClipInputError);
    expect((err as InvalidClipInputError).code).toBe("cursor");
    expect(src.calls).toHaveLength(0);
  });

  it("propagates a BarStoreError from the store unchanged (never reframed)", async () => {
    const storeErr = new BarStoreError("boom", { phase: "read" });
    const src = fakeSource({ throwErr: storeErr });
    const err = await caught(
      readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 0, toMs: 10_000, cursorMs: 5_000 }),
    );
    expect(err).toBe(storeErr); // same instance, same phase
  });
});

describe("cursorBarReader — invariants (property-style)", () => {
  const froms = [0, 1_000, 5_000];
  const widths = [1, 1_000, 50_000];
  const cursors = [0, 999, 1_000, 1_000.5, 5_000, 5_000.4, 9_999, 60_000.7];

  it("never asks the store for a range past the cursor or wider than requested", async () => {
    for (const fromMs of froms) {
      for (const width of widths) {
        const toMs = fromMs + width;
        for (const cursorMs of cursors) {
          if (fromMs > cursorMs) continue; // peeking — covered by breaking tests
          const src = fakeSource();
          await readBarsUpToCursor(src, { symbol: EURUSD, fromMs, toMs, cursorMs });
          expect(src.calls).toHaveLength(1);
          const call = src.calls[0]!;
          expect(call.fromMs).toBe(fromMs);
          expect(call.toMs).toBeGreaterThan(call.fromMs);
          expect(call.toMs).toBeLessThanOrEqual(toMs);
          expect(call.toMs).toBeLessThanOrEqual(Math.floor(cursorMs) + 1);
        }
      }
    }
  });

  it("returns the store's array by reference (pure pass-through)", async () => {
    for (const cursorMs of cursors) {
      const bars = [mkBar(0)];
      const src = fakeSource({ bars });
      const out = await readBarsUpToCursor(src, { symbol: EURUSD, fromMs: 0, toMs: 50_000, cursorMs });
      expect(out).toBe(bars);
    }
  });
});
