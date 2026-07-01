import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "../../shared/types.js";
import { toCatalogSymbol } from "../../shared/instruments.js";
import {
  BarStoreError,
  createDuckDbBarStore,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import { createReplayBridge } from "./replayBridge.js";

/**
 * I/O-bound integration: the real replay bridge over a real DuckDB store in a
 * per-test tmpdir (no mocks). Proves the cursor-clipped read composes end to
 * end and — most importantly — that "no peeking" holds against real stored
 * rows, including when future bars are written while the cursor is held.
 *
 * Windows: the store MUST be `close()`d before `rmSync` or DuckDB's file handle
 * blocks the delete.
 */

const SYMBOL = toCatalogSymbol("EURUSD");
const ONE_HOUR_MS = 3_600_000;

function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1, hBid: 1, lBid: 1, cBid: 1,
    oAsk: 1, hAsk: 1, lAsk: 1, cAsk: 1,
    volumeBid: 0, volumeAsk: 0, tickCount: 1,
  };
}

function bars1s(startMs: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => mkBar(startMs + i * 1_000));
}

let tmpDir: string;
let store: DuckDbBarStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-"));
  store = await createDuckDbBarStore({ root: tmpDir });
  // Hour 0: 1 s bars for the first ~3.3 minutes.
  await store.writeHour({ symbol: SYMBOL, hourMs: 0, bars: bars1s(0, 200) });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Bridge over the real store; constant wall clock (timing not under test). */
function bridgeOverStore() {
  return createReplayBridge({ source: store, now: () => 1 });
}

describe("replayBridge (integration) — core behaviour", () => {
  it("folds real stored 1 s bars up to the cursor into the timeframe", async () => {
    const bridge = bridgeOverStore();
    bridge.createSession({ symbol: "EURUSD", startMs: 0, endMs: ONE_HOUR_MS, timeframeMs: 60_000 });
    bridge.step({ deltaMs: 120_000 }); // cursor = 120_000
    const bars = await bridge.getVisibleBars();
    expect(bars.map((b) => b.timestampMs)).toEqual([0, 60_000, 120_000]);
  });
});

describe("replayBridge (integration) — edge cases", () => {
  it("setTimeframe re-folds the same visible window without moving the cursor", async () => {
    const bridge = bridgeOverStore();
    bridge.createSession({ symbol: "EURUSD", startMs: 0, endMs: ONE_HOUR_MS, timeframeMs: 60_000 });
    bridge.scrubTo({ targetMs: 180_000 });
    const m1 = await bridge.getVisibleBars();
    const snap = bridge.setTimeframe({ timeframeMs: 300_000 });
    const m5 = await bridge.getVisibleBars();
    expect(snap.cursorMs).toBe(180_000);
    // Coarser timeframe → same-or-fewer bars.
    expect(m5.length).toBeLessThanOrEqual(m1.length);
    expect(m5.every((b) => b.timestampMs <= 180_000)).toBe(true);
  });
});

describe("replayBridge (integration) — breaking tests (must throw / must not happen)", () => {
  it("no peeking: a future bar written while the cursor is held is not revealed", async () => {
    const bridge = bridgeOverStore();
    bridge.createSession({ symbol: "EURUSD", startMs: 0, endMs: 2 * ONE_HOUR_MS, timeframeMs: 60_000 });
    bridge.scrubTo({ targetMs: 60_000 });

    const before = await bridge.getVisibleBars();

    // Append a bar an hour into the future — well past the held cursor.
    await store.writeHour({ symbol: SYMBOL, hourMs: ONE_HOUR_MS, bars: [mkBar(ONE_HOUR_MS)] });

    const after = await bridge.getVisibleBars();
    expect(after).toEqual(before);
    expect(after.every((b) => b.timestampMs <= 60_000)).toBe(true);
  });

  it("propagates a closed-store BarStoreError(phase 'closed') through getVisibleBars", async () => {
    const bridge = bridgeOverStore();
    bridge.createSession({ symbol: "EURUSD", startMs: 0, endMs: ONE_HOUR_MS, timeframeMs: 60_000 });
    bridge.step({ deltaMs: 60_000 });
    await store.close(); // afterEach's second close() is a no-op

    let thrown: unknown;
    try {
      await bridge.getVisibleBars();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BarStoreError);
    expect((thrown as BarStoreError).phase).toBe("closed");
  });
});

describe("replayBridge (integration) — invariants (property-style)", () => {
  it("no folded bar sits past the cursor, across a grid of scrub targets", async () => {
    const bridge = bridgeOverStore();
    bridge.createSession({ symbol: "EURUSD", startMs: 0, endMs: ONE_HOUR_MS, timeframeMs: 60_000 });
    for (const cursor of [0, 1_000, 59_000, 90_000, 150_000, 199_000]) {
      bridge.scrubTo({ targetMs: cursor });
      const bars = await bridge.getVisibleBars();
      for (const b of bars) expect(b.timestampMs).toBeLessThanOrEqual(cursor);
    }
  });
});
