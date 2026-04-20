/**
 * Integration test: the DuckDB-backed `BarStore` against a real DuckDB
 * database in a per-test tmpdir.
 *
 * This is the project's first I/O-bound integration test. Per
 * `DEVELOPMENT.md` §3 "Integration tests" and §4 "adapter pattern", the
 * rule for DuckDB is **no fs/duckdb mocks — use real instances against
 * tmpdirs**. Mocks drift from reality; DuckDB is fast enough that the
 * whole file runs in well under a second.
 *
 * Each test creates its own `fs.mkdtempSync(... "hindsight-")` directory
 * and destroys it in `afterEach`. DuckDB holds file handles, so the
 * store MUST be `close()`d before the rmSync, or Windows will refuse to
 * delete the file; the cleanup below walks that order explicitly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bar } from "../../shared/types.js";
import {
  toCatalogSymbol,
  type CatalogSymbol,
} from "../../shared/instruments.js";
import {
  BarStoreError,
  createDuckDbBarStore,
  type BarStorePhase,
  type DuckDbBarStore,
} from "./duckDbBarStore.js";

const ONE_HOUR_MS = 3_600_000;
const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const HOUR_1 = HOUR_0 + ONE_HOUR_MS;
const HOUR_2 = HOUR_0 + 2 * ONE_HOUR_MS;

const EURUSD = toCatalogSymbol("EURUSD");
const USDJPY = toCatalogSymbol("USDJPY");
const XAUUSD = toCatalogSymbol("XAUUSD");

/** Build a plausible `Bar` at the given `timestampMs`. */
function mkBar(timestampMs: number, overrides: Partial<Bar> = {}): Bar {
  return {
    timestampMs,
    oBid: 1.1,
    hBid: 1.10005,
    lBid: 1.09998,
    cBid: 1.10003,
    oAsk: 1.10003,
    hAsk: 1.10008,
    lAsk: 1.10001,
    cAsk: 1.10006,
    volumeBid: 1.5,
    volumeAsk: 1.25,
    tickCount: 3,
    ...overrides,
  };
}

/**
 * Assert that `promise` rejects with a `BarStoreError` carrying the
 * expected `phase`. Checking the phase — not just the class — pins
 * the refactor surface: if a future change re-throws a failure under
 * a different phase, the specific test that encodes that contract
 * fails loudly, instead of every test in the file going green because
 * "some BarStoreError" was thrown.
 *
 * Returns the caught error for tests that want to do further assertions.
 */
async function expectBarStoreError(
  promise: Promise<unknown>,
  expected: { phase: BarStorePhase },
): Promise<BarStoreError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BarStoreError);
  const err = caught as BarStoreError;
  expect(err.phase).toBe(expected.phase);
  return err;
}

/** Deep-compare two bars up to float-representable precision. */
function assertBarsMatch(actual: Bar, expected: Bar): void {
  expect(actual.timestampMs).toBe(expected.timestampMs);
  expect(actual.oBid).toBeCloseTo(expected.oBid, 9);
  expect(actual.hBid).toBeCloseTo(expected.hBid, 9);
  expect(actual.lBid).toBeCloseTo(expected.lBid, 9);
  expect(actual.cBid).toBeCloseTo(expected.cBid, 9);
  expect(actual.oAsk).toBeCloseTo(expected.oAsk, 9);
  expect(actual.hAsk).toBeCloseTo(expected.hAsk, 9);
  expect(actual.lAsk).toBeCloseTo(expected.lAsk, 9);
  expect(actual.cAsk).toBeCloseTo(expected.cAsk, 9);
  expect(actual.volumeBid).toBeCloseTo(expected.volumeBid, 9);
  expect(actual.volumeAsk).toBeCloseTo(expected.volumeAsk, 9);
  expect(actual.tickCount).toBe(expected.tickCount);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-test tmpdir fixture. The store and root are set up per test so
// tests are fully isolated; the close-then-rmSync order matters on
// Windows because DuckDB keeps an exclusive lock on its data file.
// ─────────────────────────────────────────────────────────────────────────

let root: string;
let store: DuckDbBarStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-barstore-"));
  store = await createDuckDbBarStore({ root });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// — core behaviour
// ─────────────────────────────────────────────────────────────────────────

describe("DuckDbBarStore — core behaviour", () => {
  it("writes a single hour of bars and reads them back unchanged", async () => {
    const bars: Bar[] = [
      mkBar(HOUR_0 + 0),
      mkBar(HOUR_0 + 1_000, { oBid: 1.10005 }),
      mkBar(HOUR_0 + 2_000, { oBid: 1.10010, tickCount: 7 }),
    ];
    await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toHaveLength(3);
    for (let i = 0; i < bars.length; i++) assertBarsMatch(read[i]!, bars[i]!);
  });

  it("reads bars across two adjacent hours in one query", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 500_000)],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_1,
      bars: [mkBar(HOUR_1 + 100_000), mkBar(HOUR_1 + 200_000)],
    });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_2,
    });
    expect(read).toHaveLength(3);
    expect(read.map((b) => b.timestampMs)).toEqual([
      HOUR_0 + 500_000,
      HOUR_1 + 100_000,
      HOUR_1 + 200_000,
    ]);
  });

  it("isolates symbols: a read for EURUSD does not return USDJPY bars at the same timestamp", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000, { oBid: 1.1 })],
    });
    await store.writeHour({
      symbol: USDJPY,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000, { oBid: 147.12 })],
    });

    const eur = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    const jpy = await store.readBarsInRange({
      symbol: USDJPY,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(eur).toHaveLength(1);
    expect(jpy).toHaveLength(1);
    expect(eur[0]!.oBid).toBeCloseTo(1.1, 6);
    expect(jpy[0]!.oBid).toBeCloseTo(147.12, 6);
  });

  it("persists across store close + reopen from the same root", async () => {
    await store.writeHour({
      symbol: XAUUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 42_000, { oBid: 2_034.5 })],
    });
    await store.close();

    // Reopen; afterEach will close this one.
    store = await createDuckDbBarStore({ root });
    const read = await store.readBarsInRange({
      symbol: XAUUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toHaveLength(1);
    expect(read[0]!.oBid).toBeCloseTo(2_034.5, 6);
  });

  it("returns bars in ascending timestamp order even when inserted out of hour order", async () => {
    // Insert hour 2 first, hour 0 last. Query spanning all three.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_2,
      bars: [mkBar(HOUR_2 + 1_000)],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_1,
      bars: [mkBar(HOUR_1 + 1_000)],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000)],
    });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_2 + ONE_HOUR_MS,
    });
    expect(read.map((b) => b.timestampMs)).toEqual([
      HOUR_0 + 1_000,
      HOUR_1 + 1_000,
      HOUR_2 + 1_000,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — edge cases
// ─────────────────────────────────────────────────────────────────────────

describe("DuckDbBarStore — edge cases", () => {
  it("writeHour with bars: [] is a no-op (no rows inserted; read returns empty)", async () => {
    await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars: [] });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toEqual([]);
  });

  it("idempotent re-writeHour for the same hour replaces the prior bars entirely", async () => {
    // First write: three bars.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [
        mkBar(HOUR_0 + 1_000, { oBid: 1.0 }),
        mkBar(HOUR_0 + 2_000, { oBid: 1.0 }),
        mkBar(HOUR_0 + 3_000, { oBid: 1.0 }),
      ],
    });
    // Second write: one bar at a different timestamp, same hour.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 9_000, { oBid: 2.0 })],
    });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toHaveLength(1);
    expect(read[0]!.timestampMs).toBe(HOUR_0 + 9_000);
    expect(read[0]!.oBid).toBeCloseTo(2.0, 6);
  });

  it("idempotent re-write to bars: [] clears a previously populated hour", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000)],
    });
    await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars: [] });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toEqual([]);
  });

  it("writing hour H does not touch hour H-1 or H+1 for the same symbol", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000, { oBid: 1.0 })],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_2,
      bars: [mkBar(HOUR_2 + 1_000, { oBid: 3.0 })],
    });
    // Rewrite HOUR_1 with something different; HOUR_0 and HOUR_2 must survive.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_1,
      bars: [mkBar(HOUR_1 + 1_000, { oBid: 2.0 })],
    });

    const all = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_2 + ONE_HOUR_MS,
    });
    expect(all).toHaveLength(3);
    expect(all[0]!.oBid).toBeCloseTo(1.0, 6);
    expect(all[1]!.oBid).toBeCloseTo(2.0, 6);
    expect(all[2]!.oBid).toBeCloseTo(3.0, 6);
  });

  it("readBarsInRange on empty database returns []", async () => {
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toEqual([]);
  });

  it("read range is half-open: fromMs is inclusive, toMs is exclusive", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [
        mkBar(HOUR_0 + 1_000),
        mkBar(HOUR_0 + 2_000),
        mkBar(HOUR_0 + 3_000),
      ],
    });

    const inclusiveFrom = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0 + 1_000,
      toMs: HOUR_0 + 3_000,
    });
    expect(inclusiveFrom.map((b) => b.timestampMs)).toEqual([
      HOUR_0 + 1_000,
      HOUR_0 + 2_000,
    ]);

    const singleBar = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0 + 2_000,
      toMs: HOUR_0 + 2_001,
    });
    expect(singleBar.map((b) => b.timestampMs)).toEqual([HOUR_0 + 2_000]);
  });

  it("range query ending exactly at a bar's timestamp excludes that bar (exclusive upper)", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 5_000)],
    });
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_0 + 5_000,
    });
    expect(read).toEqual([]);
  });

  it("read range starting at exactly a bar's timestamp includes that bar (inclusive lower)", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 5_000)],
    });
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0 + 5_000,
      toMs: HOUR_0 + 6_000,
    });
    expect(read).toHaveLength(1);
    expect(read[0]!.timestampMs).toBe(HOUR_0 + 5_000);
  });

  it("negative volumes are rejected even if finite (policy matches tick stream)", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000, { volumeBid: -0.1 })],
      }),
      { phase: "validation" },
    );
  });

  it("close() is idempotent (calling twice does not throw)", async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("unix-epoch hour (hourMs = 0) works end-to-end", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: 0,
      bars: [mkBar(1_000)],
    });
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: 0,
      toMs: ONE_HOUR_MS,
    });
    expect(read).toHaveLength(1);
    expect(read[0]!.timestampMs).toBe(1_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — breaking tests (must throw)
//
// The store rejects inputs that violate its invariants rather than letting
// garbage land in the database. Every rejection raises `BarStoreError`
// with a populated `phase` so callers can route on it.
// ─────────────────────────────────────────────────────────────────────────

describe("DuckDbBarStore — breaking tests (writeHour validation)", () => {
  it("rejects non-integer hourMs", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0 + 0.5,
        bars: [mkBar(HOUR_0 + 1_000)],
      }),
      { phase: "validation" },
    );
  });

  it("rejects non-finite hourMs (NaN)", async () => {
    await expectBarStoreError(
      store.writeHour({ symbol: EURUSD, hourMs: NaN, bars: [] }),
      { phase: "validation" },
    );
  });

  it("rejects non-finite hourMs (+Infinity)", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: Number.POSITIVE_INFINITY,
        bars: [],
      }),
      { phase: "validation" },
    );
  });

  it("rejects negative hourMs", async () => {
    await expectBarStoreError(
      store.writeHour({ symbol: EURUSD, hourMs: -ONE_HOUR_MS, bars: [] }),
      { phase: "validation" },
    );
  });

  it("rejects non-aligned hourMs (one minute past the hour)", async () => {
    await expectBarStoreError(
      store.writeHour({ symbol: EURUSD, hourMs: HOUR_0 + 60_000, bars: [] }),
      { phase: "validation" },
    );
  });

  it("rejects bars whose timestampMs is outside [hourMs, hourMs + 3_600_000) — below", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_1,
        bars: [mkBar(HOUR_1 - 1_000)],
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars whose timestampMs is outside the hour — at the upper boundary", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + ONE_HOUR_MS)], // == HOUR_1, exclusive upper
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars with non-multiple-of-1000 timestampMs", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_234)],
      }),
      { phase: "validation" },
    );
  });

  it("rejects a non-monotonic bar sequence", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 2_000), mkBar(HOUR_0 + 1_000)],
      }),
      { phase: "validation" },
    );
  });

  it("rejects duplicate timestamps within the same writeHour batch", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000), mkBar(HOUR_0 + 1_000)],
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars with non-finite price fields (NaN oBid)", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000, { oBid: NaN })],
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars with non-finite volumes (Infinity)", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [
          mkBar(HOUR_0 + 1_000, { volumeAsk: Number.POSITIVE_INFINITY }),
        ],
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars with tickCount < 1", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000, { tickCount: 0 })],
      }),
      { phase: "validation" },
    );
  });

  it("rejects bars with non-integer tickCount", async () => {
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000, { tickCount: 2.5 })],
      }),
      { phase: "validation" },
    );
  });

  it("a failed write leaves the hour's prior contents untouched (atomicity)", async () => {
    // Seed hour 0 with one good bar.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000, { oBid: 1.0 })],
    });
    // Attempt to replace with a bad batch (non-monotonic) — must throw
    // at the validation phase, BEFORE any DuckDB round-trip, so the
    // prior row is trivially preserved. The stronger "transaction
    // rolls back on a mid-write DuckDB error" guarantee would require
    // injecting a post-BEGIN failure, which the validation surface
    // does not allow; this test pins the cheap half only.
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 2_000), mkBar(HOUR_0 + 1_000)],
      }),
      { phase: "validation" },
    );
    // Original bar still there.
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toHaveLength(1);
    expect(read[0]!.timestampMs).toBe(HOUR_0 + 1_000);
    expect(read[0]!.oBid).toBeCloseTo(1.0, 6);
  });
});

describe("DuckDbBarStore — breaking tests (readBarsInRange validation)", () => {
  it("rejects fromMs >= toMs (empty range is an error)", async () => {
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: HOUR_0,
        toMs: HOUR_0,
      }),
      { phase: "validation" },
    );
  });

  it("rejects fromMs > toMs (reversed range)", async () => {
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: HOUR_1,
        toMs: HOUR_0,
      }),
      { phase: "validation" },
    );
  });

  it("rejects NaN fromMs", async () => {
    await expectBarStoreError(
      store.readBarsInRange({ symbol: EURUSD, fromMs: NaN, toMs: HOUR_1 }),
      { phase: "validation" },
    );
  });

  it("rejects +Infinity toMs", async () => {
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: HOUR_0,
        toMs: Number.POSITIVE_INFINITY,
      }),
      { phase: "validation" },
    );
  });

  it("rejects negative fromMs", async () => {
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: -1,
        toMs: HOUR_1,
      }),
      { phase: "validation" },
    );
  });

  it("rejects non-integer bounds", async () => {
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: HOUR_0 + 0.5,
        toMs: HOUR_1,
      }),
      { phase: "validation" },
    );
  });
});

describe("DuckDbBarStore — breaking tests (open path)", () => {
  it("rejects empty root with BarStoreError(phase 'open')", async () => {
    await expectBarStoreError(createDuckDbBarStore({ root: "" }), {
      phase: "open",
    });
  });

  it("opening a second store while the first is live fails with phase 'open' (symptom test: pins DuckDB's exclusive file lock; does NOT itself exercise the factory's instance-cleanup branch, which would require injecting a post-`DuckDBInstance.create` failure)", async () => {
    // First store (`store`) is already open from beforeEach and holds
    // the exclusive lock on <root>/bars/1s.duckdb.
    await expectBarStoreError(createDuckDbBarStore({ root }), {
      phase: "open",
    });

    // After the first store is closed, opening a fresh store on the
    // same root MUST succeed — i.e. the lock was actually released,
    // not leaked. afterEach closes this one.
    await store.close();
    store = await createDuckDbBarStore({ root });
    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(read).toEqual([]);
  });
});

describe("DuckDbBarStore — breaking tests (closed store)", () => {
  it("writeHour after close throws BarStoreError(phase 'closed')", async () => {
    await store.close();
    await expectBarStoreError(
      store.writeHour({
        symbol: EURUSD,
        hourMs: HOUR_0,
        bars: [mkBar(HOUR_0 + 1_000)],
      }),
      { phase: "closed" },
    );
  });

  it("readBarsInRange after close throws BarStoreError(phase 'closed')", async () => {
    await store.close();
    await expectBarStoreError(
      store.readBarsInRange({
        symbol: EURUSD,
        fromMs: HOUR_0,
        toMs: HOUR_1,
      }),
      { phase: "closed" },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — invariants (property-style)
// ─────────────────────────────────────────────────────────────────────────

describe("DuckDbBarStore — invariants (property-style)", () => {
  it("Σ writeHour bar counts == count of readBarsInRange bars over the full range, for a mixed two-symbol run", async () => {
    // Build a deterministic mix across 4 hours × 2 symbols.
    const symbols: CatalogSymbol[] = [EURUSD, USDJPY];
    const hourTicks: ReadonlyArray<ReadonlyArray<number>> = [
      [0, 1_000, 2_000],
      [],
      [1_000, 3_000, 5_000, 7_000],
      [42_000],
    ];
    let expectedTotal = 0;
    for (const sym of symbols) {
      for (let i = 0; i < hourTicks.length; i++) {
        const offsets = hourTicks[i]!;
        const bars = offsets.map((off) => mkBar(HOUR_0 + i * ONE_HOUR_MS + off));
        await store.writeHour({
          symbol: sym,
          hourMs: HOUR_0 + i * ONE_HOUR_MS,
          bars,
        });
        expectedTotal += bars.length;
      }
    }

    let readTotal = 0;
    for (const sym of symbols) {
      const read = await store.readBarsInRange({
        symbol: sym,
        fromMs: HOUR_0,
        toMs: HOUR_0 + hourTicks.length * ONE_HOUR_MS,
      });
      readTotal += read.length;
      for (const b of read) {
        expect(b.timestampMs).toBeGreaterThanOrEqual(HOUR_0);
        expect(b.timestampMs).toBeLessThan(HOUR_0 + hourTicks.length * ONE_HOUR_MS);
      }
    }
    expect(readTotal).toBe(expectedTotal);
  });

  it("readBarsInRange never returns bars outside [fromMs, toMs), across a grid of sub-ranges", async () => {
    const bars = [
      HOUR_0 + 0,
      HOUR_0 + 1_000,
      HOUR_0 + 2_000,
      HOUR_0 + 10_000,
      HOUR_0 + 3_599_000,
    ].map((ts) => mkBar(ts));
    await store.writeHour({ symbol: EURUSD, hourMs: HOUR_0, bars });

    const ranges: ReadonlyArray<readonly [number, number]> = [
      [HOUR_0, HOUR_0 + 1],
      [HOUR_0, HOUR_0 + 1_000],
      [HOUR_0 + 1_000, HOUR_0 + 2_000],
      [HOUR_0 + 1_000, HOUR_0 + 10_001],
      [HOUR_0 + 3_598_000, HOUR_1],
      [HOUR_0, HOUR_1],
    ];
    for (const [from, to] of ranges) {
      const read = await store.readBarsInRange({
        symbol: EURUSD,
        fromMs: from,
        toMs: to,
      });
      for (const b of read) {
        expect(b.timestampMs).toBeGreaterThanOrEqual(from);
        expect(b.timestampMs).toBeLessThan(to);
      }
    }
  });

  it("results are strictly ascending by timestampMs for every non-empty readBarsInRange", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [
        mkBar(HOUR_0 + 1_000),
        mkBar(HOUR_0 + 3_000),
        mkBar(HOUR_0 + 5_000),
        mkBar(HOUR_0 + 60_000),
      ],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_1,
      bars: [mkBar(HOUR_1 + 1_000), mkBar(HOUR_1 + 3_000)],
    });

    const read = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_2,
    });
    for (let i = 1; i < read.length; i++) {
      expect(read[i]!.timestampMs).toBeGreaterThan(read[i - 1]!.timestampMs);
    }
  });

  it("writeHour for hour H only ever affects rows in [H, H + 3_600_000) for the written symbol", async () => {
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000), mkBar(HOUR_0 + 5_000)],
    });
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_1,
      bars: [mkBar(HOUR_1 + 1_000)],
    });
    await store.writeHour({
      symbol: USDJPY,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 1_000, { oBid: 147.0 })],
    });

    // Rewrite EURUSD HOUR_0 with one bar.
    await store.writeHour({
      symbol: EURUSD,
      hourMs: HOUR_0,
      bars: [mkBar(HOUR_0 + 10_000, { oBid: 9.9 })],
    });

    // EURUSD HOUR_1 must survive.
    const eurHour1 = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_1,
      toMs: HOUR_2,
    });
    expect(eurHour1).toHaveLength(1);
    // USDJPY HOUR_0 must survive (different symbol).
    const jpyHour0 = await store.readBarsInRange({
      symbol: USDJPY,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(jpyHour0).toHaveLength(1);
    expect(jpyHour0[0]!.oBid).toBeCloseTo(147.0, 6);
    // EURUSD HOUR_0 replaced with exactly the new payload.
    const eurHour0 = await store.readBarsInRange({
      symbol: EURUSD,
      fromMs: HOUR_0,
      toMs: HOUR_1,
    });
    expect(eurHour0).toHaveLength(1);
    expect(eurHour0[0]!.timestampMs).toBe(HOUR_0 + 10_000);
    expect(eurHour0[0]!.oBid).toBeCloseTo(9.9, 6);
  });
});
