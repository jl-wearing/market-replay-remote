/**
 * Unit tests for the resumable one-day runner.
 *
 * `resumableIngestSymbolDay` is the day-level sibling of `ingestSymbolDay`
 * (slice 7): it owns the same lifecycle — validate `dayUtc` and `symbol`,
 * `openStore`, run, `close()` in `finally` — but composes
 * `resumableIngestSymbol` instead of `ingestSymbol`, and wires the
 * resume predicate (`hasHour`) to the opened store's `readBarsInRange`.
 *
 * The two behaviours that make it different from the strict runner are
 * pinned here with hand-rolled fakes:
 *
 * - **Skip-existing.** An hour whose `readBarsInRange` reports ≥1 bar is
 *   skipped (no fetch, no write) and counted in `hoursSkipped`.
 * - **Continue-on-error.** A per-hour fetch/decode failure is collected in
 *   `stats.failures` and the walk continues; it does NOT abort the run.
 *
 * The lifecycle / error-phase contract is identical to `ingestSymbolDay`,
 * so the breaking block mirrors `ingestDay.test.ts`: bad date / symbol
 * never opens anything; an `open` failure never closes; a fatal store-read
 * inside `hasHour` surfaces as `phase: "ingest"` and still closes; a
 * post-success `close` failure surfaces as `phase: "close"`.
 */

import { describe, expect, it } from "vitest";
import type { Bar } from "../../shared/types.js";
import {
  toCatalogSymbol,
  type CatalogSymbol,
} from "../../shared/instruments.js";
import type {
  DukascopyClient,
  FetchHourArgs,
} from "../data/dukascopyClient.js";
import { IngestError, type BarStore } from "../data/ingest.js";
import {
  BarStoreError,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import type { HourFailure } from "../data/resumableIngest.js";
import {
  IngestRunError,
  type IngestRunPhase,
  type OpenDuckDbBarStore,
} from "./ingestDay.js";
import { resumableIngestSymbolDay } from "./resumableIngestDay.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const ROOT = "/tmp/hindsight-fake-root";
const DAY = "2024-01-15";
const DAY_START = Date.UTC(2024, 0, 15, 0, 0, 0, 0);
const DAY_END = DAY_START + ONE_DAY_MS;

function hourOf(index: number): number {
  return DAY_START + index * ONE_HOUR_MS;
}

interface ClientCall {
  hourStartMs: number;
}

function makeFakeClient(opts: {
  /** Per-hour canned bytes. Hour not present → empty `Uint8Array`. */
  responses?: ReadonlyMap<number, Uint8Array>;
  /** Per-hour rejections. Wins over `responses`. */
  errors?: ReadonlyMap<number, Error>;
} = {}): { client: DukascopyClient; calls: ClientCall[] } {
  const calls: ClientCall[] = [];
  const client: DukascopyClient = {
    async fetchHour(args: FetchHourArgs): Promise<Uint8Array> {
      calls.push({ hourStartMs: args.hourStartMs });
      const err = opts.errors?.get(args.hourStartMs);
      if (err) throw err;
      return opts.responses?.get(args.hourStartMs) ?? new Uint8Array(0);
    },
  };
  return { client, calls };
}

interface StoreWrite {
  symbol: CatalogSymbol;
  hourMs: number;
  bars: readonly Bar[];
}

interface FakeStoreHandle {
  store: DuckDbBarStore;
  /** `writeHour` calls completed without throwing. */
  writes: StoreWrite[];
  /** `(symbol, fromMs)` of every `readBarsInRange` call, in order. */
  reads: Array<{ symbol: CatalogSymbol; fromMs: number; toMs: number }>;
  closeCount(): number;
}

/**
 * Fake `DuckDbBarStore`. `presentHours` drives the resume predicate:
 * `readBarsInRange` returns a one-bar array for an hour in the set
 * (so the runner treats it as already-ingested and skips it), and an
 * empty array otherwise. `readError`, if set, makes every
 * `readBarsInRange` throw — modelling a fatal store-read mid-walk.
 */
function makeFakeStore(opts: {
  presentHours?: ReadonlySet<number>;
  readError?: Error;
  writeErrors?: ReadonlyMap<number, Error>;
  closeError?: Error;
} = {}): FakeStoreHandle {
  const writes: StoreWrite[] = [];
  const reads: Array<{ symbol: CatalogSymbol; fromMs: number; toMs: number }> =
    [];
  let closeCount = 0;
  const store: DuckDbBarStore = {
    async writeHour({ symbol, hourMs, bars }) {
      const err = opts.writeErrors?.get(hourMs);
      if (err) throw err;
      writes.push({ symbol, hourMs, bars });
    },
    async readBarsInRange({ symbol, fromMs, toMs }) {
      reads.push({ symbol, fromMs, toMs });
      if (opts.readError) throw opts.readError;
      return opts.presentHours?.has(fromMs) ? [oneBarAt(fromMs)] : [];
    },
    async close() {
      closeCount += 1;
      if (opts.closeError && closeCount === 1) throw opts.closeError;
    },
  };
  return { store, writes, reads, closeCount: () => closeCount };
}

/** A single throwaway bar, only ever used to make `readBarsInRange` non-empty. */
function oneBarAt(hourMs: number): Bar {
  return {
    timestampMs: hourMs,
    oBid: 1, hBid: 1, lBid: 1, cBid: 1,
    oAsk: 1, hAsk: 1, lAsk: 1, cAsk: 1,
    volumeBid: 1, volumeAsk: 1, tickCount: 1,
  };
}

interface OpenStoreHandle {
  openStore: OpenDuckDbBarStore;
  rootsSeen: string[];
}

function makeOpenStore(handle: FakeStoreHandle): OpenStoreHandle {
  const rootsSeen: string[] = [];
  return {
    openStore: async (root: string) => {
      rootsSeen.push(root);
      return handle.store;
    },
    rootsSeen,
  };
}

function makeFailingOpenStore(err: Error): OpenStoreHandle {
  const rootsSeen: string[] = [];
  return {
    openStore: async (root: string) => {
      rootsSeen.push(root);
      throw err;
    },
    rootsSeen,
  };
}

/** Encode a single bi5 record so a hand-crafted hour decodes to one bar. */
function encodeOneTickHour(bid: number, ask: number): Uint8Array {
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  const SCALE = 100_000;
  view.setUint32(0, 0, false);
  view.setUint32(4, Math.round(ask * SCALE), false);
  view.setUint32(8, Math.round(bid * SCALE), false);
  view.setFloat32(12, 1, false);
  view.setFloat32(16, 1, false);
  return out;
}

/** Per-file phase-asserting helper (mirrors `expectRunError` in ingestDay.test.ts). */
async function expectRunError(
  promise: Promise<unknown>,
  expected: { phase: IngestRunPhase },
): Promise<IngestRunError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(IngestRunError);
  const err = caught as IngestRunError;
  expect(err.phase).toBe(expected.phase);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────
describe("resumableIngestSymbolDay — core behaviour", () => {
  it("walks exactly 24 UTC hours and returns ResumableIngestStats", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(calls.length).toBe(24);
    expect(calls[0]!.hourStartMs).toBe(DAY_START);
    expect(calls[23]!.hourStartMs).toBe(DAY_END - ONE_HOUR_MS);
    expect(stats.hoursTotal).toBe(24);
    expect(stats.hoursIngested).toBe(24);
    expect(stats.hoursSkipped).toBe(0);
    expect(stats.hoursFailed).toBe(0);
    expect(stats.failures).toEqual([]);
  });

  it("skips hours the store already holds (no fetch, no write) and counts them", async () => {
    const present = new Set<number>([hourOf(0), hourOf(5), hourOf(23)]);
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore({ presentHours: present });
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(stats.hoursSkipped).toBe(3);
    expect(stats.hoursIngested).toBe(21);
    // The three present hours were never fetched nor written.
    const fetched = new Set(calls.map((c) => c.hourStartMs));
    for (const h of present) expect(fetched.has(h)).toBe(false);
    expect(calls.length).toBe(21);
    expect(fakeStore.writes.length).toBe(21);
  });

  it("wires hasHour to readBarsInRange over each hour's own [h, h+1h) window", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(fakeStore.reads.length).toBe(24);
    expect(fakeStore.reads[0]).toEqual({
      symbol: toCatalogSymbol("EURUSD"),
      fromMs: DAY_START,
      toMs: DAY_START + ONE_HOUR_MS,
    });
    expect(fakeStore.reads[23]).toEqual({
      symbol: toCatalogSymbol("EURUSD"),
      fromMs: hourOf(23),
      toMs: hourOf(23) + ONE_HOUR_MS,
    });
  });

  it("collects a per-hour fetch failure and continues the rest of the day", async () => {
    const boom = new Error("network down");
    const errors = new Map<number, Error>([[hourOf(7), boom]]);
    const { client } = makeFakeClient({ errors });
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(stats.hoursFailed).toBe(1);
    expect(stats.hoursIngested).toBe(23);
    expect(stats.failures.length).toBe(1);
    expect(stats.failures[0]!.hourMs).toBe(hourOf(7));
    expect(stats.failures[0]!.phase).toBe("fetch");
    // The whole run still completes and the store is closed once.
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("accumulates ticks/bars across the ingested hours", async () => {
    const responses = new Map<number, Uint8Array>([
      [hourOf(0), encodeOneTickHour(1.1, 1.10003)],
      [hourOf(1), encodeOneTickHour(1.2, 1.20003)],
    ]);
    const { client } = makeFakeClient({ responses });
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(stats.totalTicks).toBe(2);
    expect(stats.totalBars).toBe(2);
    expect(stats.hoursEmpty).toBe(22);
  });

  it("forwards the configured root to the factory once and closes once", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(opener.rootsSeen).toEqual([ROOT]);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("fires onHourComplete / onHourSkipped / onHourFailed for the right hours", async () => {
    const present = new Set<number>([hourOf(2)]);
    const errors = new Map<number, Error>([[hourOf(4), new Error("boom")]]);
    const { client } = makeFakeClient({ errors });
    const fakeStore = makeFakeStore({ presentHours: present });
    const opener = makeOpenStore(fakeStore);

    const completed: number[] = [];
    const skipped: number[] = [];
    const failed: HourFailure[] = [];
    await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      {
        client,
        openStore: opener.openStore,
        onHourComplete: (hourMs) => completed.push(hourMs),
        onHourSkipped: (hourMs) => skipped.push(hourMs),
        onHourFailed: (f) => failed.push(f),
      },
    );

    expect(skipped).toEqual([hourOf(2)]);
    expect(failed.map((f) => f.hourMs)).toEqual([hourOf(4)]);
    expect(completed).not.toContain(hourOf(2));
    expect(completed).not.toContain(hourOf(4));
    expect(completed.length).toBe(22);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("resumableIngestSymbolDay — edge cases", () => {
  it("a fully-resumed day skips all 24 hours and never touches the client", async () => {
    const present = new Set<number>();
    for (let i = 0; i < 24; i++) present.add(hourOf(i));
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore({ presentHours: present });
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(stats.hoursSkipped).toBe(24);
    expect(stats.hoursIngested).toBe(0);
    expect(calls.length).toBe(0);
    expect(fakeStore.writes.length).toBe(0);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("handles the leap day 2024-02-29 as a normal 24-hour day", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: "2024-02-29", root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(calls[0]!.hourStartMs).toBe(Date.UTC(2024, 1, 29, 0, 0, 0, 0));
    expect(stats.hoursTotal).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("resumableIngestSymbolDay — breaking tests (must throw / must not happen)", () => {
  for (const bad of ["", "2024-1-15", "2024-13-01", "2024-02-30", "1969-12-31", "2024-01-15T00:00:00Z"]) {
    it(`rejects malformed or impossible dayUtc ${JSON.stringify(bad)} with phase "date" before any I/O`, async () => {
      const { client, calls } = makeFakeClient();
      const fakeStore = makeFakeStore();
      const opener = makeOpenStore(fakeStore);

      await expectRunError(
        resumableIngestSymbolDay(
          { symbol: "EURUSD", dayUtc: bad, root: ROOT },
          { client, openStore: opener.openStore },
        ),
        { phase: "date" },
      );
      expect(opener.rootsSeen.length).toBe(0);
      expect(calls.length).toBe(0);
      expect(fakeStore.closeCount()).toBe(0);
    });
  }

  it("rejects an unknown catalog symbol with phase \"symbol\" before opening anything", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await expectRunError(
      resumableIngestSymbolDay(
        { symbol: "ZZZBOGUS", dayUtc: DAY, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "symbol" },
    );
    expect(opener.rootsSeen.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("rejects a wrong-case symbol without normalising", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await expectRunError(
      resumableIngestSymbolDay(
        { symbol: "eurusd", dayUtc: DAY, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "symbol" },
    );
  });

  it("wraps an openStore failure with phase \"open\" and never calls close", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const openErr = new BarStoreError("disk full", { phase: "open" });
    const failingOpener = makeFailingOpenStore(openErr);

    const err = await expectRunError(
      resumableIngestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
        { client, openStore: failingOpener.openStore },
      ),
      { phase: "open" },
    );
    expect(err.cause).toBe(openErr);
    expect(failingOpener.rootsSeen).toEqual([ROOT]);
    expect(calls.length).toBe(0);
    expect(fakeStore.closeCount()).toBe(0);
  });

  it("a fatal store-read inside hasHour surfaces as phase \"ingest\" and still closes", async () => {
    const readErr = new BarStoreError("read corrupt", { phase: "read" });
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore({ readError: readErr });
    const opener = makeOpenStore(fakeStore);

    await expectRunError(
      resumableIngestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "ingest" },
    );
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("wraps a successful run's close failure with phase \"close\"", async () => {
    const closeErr = new BarStoreError("file lock stuck", { phase: "closed" });
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore({ closeError: closeErr });
    const opener = makeOpenStore(fakeStore);

    const err = await expectRunError(
      resumableIngestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "close" },
    );
    expect(err.cause).toBe(closeErr);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("a per-hour IngestError is collected, not thrown (run resolves)", async () => {
    const errors = new Map<number, Error>([
      [hourOf(0), new IngestError("decode boom", { phase: "decode", hourMs: hourOf(0) })],
    ]);
    const { client } = makeFakeClient({ errors });
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    // Must resolve, not reject.
    const stats = await resumableIngestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
      { client, openStore: opener.openStore },
    );
    expect(stats.hoursFailed).toBe(1);
    expect(stats.failures[0]!.phase).toBe("fetch");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("resumableIngestSymbolDay — invariants (property-style)", () => {
  it("ingested + skipped + failed == hoursTotal (== 24) across a grid of scenarios", async () => {
    const scenarios: Array<{
      present?: Set<number>;
      errors?: Map<number, Error>;
    }> = [
      {},
      { present: new Set([hourOf(0), hourOf(1)]) },
      { errors: new Map([[hourOf(3), new Error("x")]]) },
      {
        present: new Set([hourOf(10), hourOf(11), hourOf(12)]),
        errors: new Map([[hourOf(20), new Error("y")]]),
      },
    ];
    for (const s of scenarios) {
      const { client } = makeFakeClient(s.errors ? { errors: s.errors } : {});
      const fakeStore = makeFakeStore(
        s.present ? { presentHours: s.present } : {},
      );
      const opener = makeOpenStore(fakeStore);
      const stats = await resumableIngestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
        { client, openStore: opener.openStore },
      );
      expect(stats.hoursTotal).toBe(24);
      expect(stats.hoursIngested + stats.hoursSkipped + stats.hoursFailed).toBe(24);
    }
  });

  it("close() runs exactly once on every reachable outcome that opened the store", async () => {
    const cases: Array<() => Promise<void>> = [
      // success
      async () => {
        const { client } = makeFakeClient();
        const fakeStore = makeFakeStore();
        const opener = makeOpenStore(fakeStore);
        await resumableIngestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(1);
      },
      // fatal read → phase ingest, still closes
      async () => {
        const { client } = makeFakeClient();
        const fakeStore = makeFakeStore({
          readError: new BarStoreError("boom", { phase: "read" }),
        });
        const opener = makeOpenStore(fakeStore);
        await resumableIngestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(1);
      },
      // open failure → never closes
      async () => {
        const fakeStore = makeFakeStore();
        const opener = makeFailingOpenStore(
          new BarStoreError("nope", { phase: "open" }),
        );
        const { client } = makeFakeClient();
        await resumableIngestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(0);
      },
    ];
    for (const c of cases) await c();
  });
});
