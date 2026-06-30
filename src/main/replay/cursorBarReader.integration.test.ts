/**
 * Integration test: the real `cursorBarReader` composed with a real
 * DuckDB-backed `DuckDbBarStore` in a per-test tmpdir. No mocks — this is
 * the end-to-end re-assertion of Hindsight's "no peeking" non-negotiable at
 * the data layer: bars written *past* the cursor must never come back.
 *
 * Per `DEVELOPMENT.md` §3, an I/O-bound integration test uses real instances
 * against a `fs.mkdtempSync` tmpdir, cleaned in `afterEach`. DuckDB holds an
 * exclusive file handle, so the store MUST be `close()`d before the rmSync or
 * Windows refuses to delete the file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bar } from "../../shared/types.js";
import { toCatalogSymbol } from "../../shared/instruments.js";
import { NoPeekingViolationError } from "../../shared/replay/clip.js";
import {
  BarStoreError,
  createDuckDbBarStore,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import { readBarsUpToCursor } from "./cursorBarReader.js";

const EURUSD = toCatalogSymbol("EURUSD");
const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const SPAN_MS = 10_000;

/** Build a plausible `Bar` at `timestampMs`. */
function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1.1, hBid: 1.10005, lBid: 1.09998, cBid: 1.10003,
    oAsk: 1.10003, hAsk: 1.10008, lAsk: 1.10001, cAsk: 1.10006,
    volumeBid: 1.5, volumeAsk: 1.25, tickCount: 3,
  };
}

let root: string;
let store: DuckDbBarStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-cursorread-"));
  store = await createDuckDbBarStore({ root });
  // Ten 1 s bars at HOUR_0 + {0, 1000, ..., 9000}.
  const bars: Bar[] = [];
  for (let k = 0; k < SPAN_MS / 1_000; k++) bars.push(mkBar(HOUR_0 + k * 1_000));
  await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cursorBarReader (integration) — core behaviour", () => {
  it("returns only bars at or before the cursor", async () => {
    const out = await readBarsUpToCursor(store, {
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + SPAN_MS,
      cursorMs: HOUR_0 + 4_500, // between bar @4000 and bar @5000
    });
    expect(out.map((b) => b.timestampMs)).toEqual([
      HOUR_0 + 0, HOUR_0 + 1_000, HOUR_0 + 2_000, HOUR_0 + 3_000, HOUR_0 + 4_000,
    ]);
  });

  it("a cursor exactly on a bar includes that bar (inclusive cursor)", async () => {
    const out = await readBarsUpToCursor(store, {
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + SPAN_MS,
      cursorMs: HOUR_0 + 5_000,
    });
    expect(out.map((b) => b.timestampMs)).toContain(HOUR_0 + 5_000);
    expect(out).toHaveLength(6); // bars @0..5000
  });

  it("a cursor at/after the last bar returns the whole span", async () => {
    const out = await readBarsUpToCursor(store, {
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + SPAN_MS,
      cursorMs: HOUR_0 + SPAN_MS,
    });
    expect(out).toHaveLength(10);
  });
});

describe("cursorBarReader (integration) — edge cases", () => {
  it("floors a fractional cursor against real stored bars", async () => {
    const out = await readBarsUpToCursor(store, {
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + SPAN_MS,
      cursorMs: HOUR_0 + 4_999.9, // floors to 4999 -> excludes bar @5000
    });
    expect(out.map((b) => b.timestampMs)).not.toContain(HOUR_0 + 5_000);
    expect(out).toHaveLength(5); // bars @0..4000
  });

  it("a cursor exactly at the first bar returns only that bar", async () => {
    const out = await readBarsUpToCursor(store, {
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + SPAN_MS,
      cursorMs: HOUR_0, // inclusive lower boundary — exactly one bar visible
    });
    expect(out.map((b) => b.timestampMs)).toEqual([HOUR_0]);
  });
});

describe("cursorBarReader (integration) — breaking tests (must throw / must not happen)", () => {
  it("refuses a window that starts past the cursor (no peeking, real store)", async () => {
    let caught: unknown = null;
    try {
      await readBarsUpToCursor(store, {
        symbol: EURUSD,
        fromMs: HOUR_0 + 6_000,
        toMs: HOUR_0 + SPAN_MS,
        cursorMs: HOUR_0 + 5_000,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoPeekingViolationError);
  });

  it("propagates a closed-store BarStoreError through the real read path", async () => {
    await store.close();
    let caught: unknown = null;
    try {
      await readBarsUpToCursor(store, {
        symbol: EURUSD,
        fromMs: HOUR_0,
        toMs: HOUR_0 + SPAN_MS,
        cursorMs: HOUR_0 + 5_000,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BarStoreError);
    expect((caught as BarStoreError).phase).toBe("closed");
  });
});

describe("cursorBarReader (integration) — invariants (property-style)", () => {
  it("no returned bar ever exceeds the cursor, for any cursor across the span", async () => {
    for (const offset of [0, 500, 1_000, 3_333.3, 5_000, 7_777, 9_000, 9_999.9, SPAN_MS]) {
      const cursorMs = HOUR_0 + offset;
      const out = await readBarsUpToCursor(store, {
        symbol: EURUSD,
        fromMs: HOUR_0,
        toMs: HOUR_0 + SPAN_MS,
        cursorMs,
      });
      for (const bar of out) {
        expect(bar.timestampMs).toBeLessThanOrEqual(cursorMs);
      }
    }
  });
});
