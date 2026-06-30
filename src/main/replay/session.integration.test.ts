/**
 * Integration test: the real `ReplaySession` orchestrator composed with a real
 * DuckDB-backed `DuckDbBarStore` in a per-test tmpdir. No mocks — this exercises
 * the full slice-5 stack end to end (clock cursor → cursor-clipped read →
 * higher-timeframe fold) and re-asserts Hindsight's "no peeking" non-negotiable
 * against real stored data: bars past the cursor never come back, and switching
 * timeframe re-folds without moving the cursor.
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
import {
  BarStoreError,
  createDuckDbBarStore,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import {
  createReplaySession,
  readVisibleBars,
  scrubTo,
  setTimeframe,
} from "./session.js";

const EURUSD = toCatalogSymbol("EURUSD");
const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const BAR_COUNT = 600; // 10 minutes of 1 s bars: HOUR_0 + {0, 1000, ..., 599000}
const LAST_BAR_MS = HOUR_0 + (BAR_COUNT - 1) * 1_000;

const MINUTE = 60_000;
const FIVE_MINUTES = 300_000;

/** A plausible `Bar` at `timestampMs`. */
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-session-"));
  store = await createDuckDbBarStore({ root });
  const bars: Bar[] = [];
  for (let k = 0; k < BAR_COUNT; k++) bars.push(mkBar(HOUR_0 + k * 1_000));
  await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("session (integration) — core behaviour", () => {
  it("folds the visible 1 s bars to the chart timeframe at the cursor", async () => {
    let s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: MINUTE,
    });
    s = scrubTo(s, HOUR_0 + 5 * MINUTE + 30_000); // 5.5 minutes in
    const out = await readVisibleBars(s, store);
    // Bars up to second 330 → minute buckets 0..5 = 6 M1 bars.
    expect(out.map((b) => b.timestampMs)).toEqual([
      HOUR_0 + 0 * MINUTE,
      HOUR_0 + 1 * MINUTE,
      HOUR_0 + 2 * MINUTE,
      HOUR_0 + 3 * MINUTE,
      HOUR_0 + 4 * MINUTE,
      HOUR_0 + 5 * MINUTE,
    ]);
  });

  it("a cursor at the session start exposes a single coarse bar", async () => {
    const s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: MINUTE,
    });
    const out = await readVisibleBars(s, store); // paused at HOUR_0
    expect(out.map((b) => b.timestampMs)).toEqual([HOUR_0]);
  });
});

describe("session (integration) — timeframe switch preserves the cursor", () => {
  it("re-folds at the new period without moving the cursor", async () => {
    let s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: MINUTE,
    });
    s = scrubTo(s, HOUR_0 + 5 * MINUTE + 30_000);
    const m1 = await readVisibleBars(s, store);
    expect(m1).toHaveLength(6); // M1 buckets 0..5

    const s5 = setTimeframe(s, FIVE_MINUTES);
    expect(s5.clock).toBe(s.clock); // cursor + clock state untouched
    const m5 = await readVisibleBars(s5, store);
    // Same window (seconds 0..330) re-folded at M5 → buckets [0,300000) and
    // [300000,600000) = 2 bars.
    expect(m5.map((b) => b.timestampMs)).toEqual([HOUR_0, HOUR_0 + FIVE_MINUTES]);
  });
});

describe("session (integration) — breaking tests (must throw / must not happen)", () => {
  it("never returns a bar past the cursor (no peeking against the real store)", async () => {
    let s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: MINUTE,
    });
    const cursorMs = HOUR_0 + 3 * MINUTE + 12_000; // 3.2 minutes in
    s = scrubTo(s, cursorMs);
    const out = await readVisibleBars(s, store);
    for (const bar of out) expect(bar.timestampMs).toBeLessThanOrEqual(cursorMs);
    // The bars after the cursor exist in the store but must not surface.
    expect(out.map((b) => b.timestampMs)).not.toContain(HOUR_0 + 4 * MINUTE);
  });

  it("propagates a closed-store BarStoreError through the read path", async () => {
    await store.close();
    const s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: MINUTE,
    });
    let caught: unknown = null;
    try {
      await readVisibleBars(scrubTo(s, LAST_BAR_MS), store);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BarStoreError);
    expect((caught as BarStoreError).phase).toBe("closed");
  });
});

describe("session (integration) — invariants (property-style)", () => {
  it("folded-bar count is monotonic non-increasing as the timeframe coarsens", async () => {
    let s = createReplaySession({
      symbol: EURUSD,
      startMs: HOUR_0,
      endMs: LAST_BAR_MS,
      timeframeMs: 1_000,
    });
    s = scrubTo(s, LAST_BAR_MS); // whole span visible
    let prev = Number.POSITIVE_INFINITY;
    for (const tf of [1_000, 2_000, MINUTE, FIVE_MINUTES]) {
      const out = await readVisibleBars(setTimeframe(s, tf), store);
      expect(out.length).toBeLessThanOrEqual(prev);
      prev = out.length;
    }
  });
});
