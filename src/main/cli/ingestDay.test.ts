/**
 * Unit tests for the slice 7 day runner.
 *
 * Composition is covered with hand-rolled fakes for `DukascopyClient` and
 * `DuckDbBarStore` (plus an `openStore` factory the runner calls). The
 * I/O-bound seam — real DuckDB + real Dukascopy — is covered by slice 6's
 * integration test and the opt-in network test, respectively. This file
 * pins what `ingestSymbolDay` itself owns: date parsing, the 24-hour
 * range, lifecycle (open → ingest → close), and which error class /
 * phase surfaces under each failure mode.
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
import type {
  BarStore,
  IngestStats,
} from "../data/ingest.js";
import { IngestError } from "../data/ingest.js";
import {
  BarStoreError,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import {
  IngestRunError,
  ingestSymbolDay,
  type IngestRunPhase,
  type OpenDuckDbBarStore,
} from "./ingestDay.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const ROOT = "/tmp/hindsight-fake-root";
const DAY_2024_01_15 = "2024-01-15";
const DAY_2024_01_15_START = Date.UTC(2024, 0, 15, 0, 0, 0, 0);
const DAY_2024_01_15_END = DAY_2024_01_15_START + ONE_DAY_MS;

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
  /** Number of `writeHour` calls completed without throwing. */
  writes: StoreWrite[];
  /** Number of `close()` calls (successful or thrown — counted on entry). */
  closeCount(): number;
}

function makeFakeStore(opts: {
  /** Throw from `writeHour` for these hours. */
  writeErrors?: ReadonlyMap<number, Error>;
  /** Throw from `close()` (only fires once, on the first call). */
  closeError?: Error;
} = {}): FakeStoreHandle {
  const writes: StoreWrite[] = [];
  let closeCount = 0;
  const store: DuckDbBarStore = {
    async writeHour({ symbol, hourMs, bars }) {
      const err = opts.writeErrors?.get(hourMs);
      if (err) throw err;
      writes.push({ symbol, hourMs, bars });
    },
    async readBarsInRange() {
      return [];
    },
    async close() {
      closeCount += 1;
      if (opts.closeError && closeCount === 1) throw opts.closeError;
    },
  };
  return { store, writes, closeCount: () => closeCount };
}

interface OpenStoreHandle {
  openStore: OpenDuckDbBarStore;
  /** Roots passed to the factory in call order. */
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

/**
 * Encode a single bi5 record so a hand-crafted hour can decode → aggregate
 * → write a deterministic bar count. The `make` helper lives here (not in
 * a shared util) so the test file reads stand-alone.
 */
function encodeOneTickHour(
  msFromHourStart: number,
  bid: number,
  ask: number,
): Uint8Array {
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  const SCALE = 100_000;
  view.setUint32(0, msFromHourStart, false);
  view.setUint32(4, Math.round(ask * SCALE), false);
  view.setUint32(8, Math.round(bid * SCALE), false);
  view.setFloat32(12, 1, false);
  view.setFloat32(16, 1, false);
  return out;
}

/**
 * Per-file phase-asserting helper. The `phase`-not-class assertion is the
 * pattern from `duckDbBarStore.integration.test.ts`: a future throw site
 * built without a phase fails loudly here instead of every test going
 * green because "some IngestRunError" was raised.
 */
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
describe("ingestSymbolDay — core behaviour", () => {
  it("walks exactly 24 UTC hours and returns ingestSymbol's stats", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const stats: IngestStats = await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(calls.length).toBe(24);
    expect(calls[0]!.hourStartMs).toBe(DAY_2024_01_15_START);
    expect(calls[23]!.hourStartMs).toBe(DAY_2024_01_15_END - ONE_HOUR_MS);
    // Strict step check: every call is exactly one hour after the previous.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.hourStartMs - calls[i - 1]!.hourStartMs).toBe(ONE_HOUR_MS);
    }
    expect(stats.hoursFetched).toBe(24);
    expect(stats.hoursEmpty).toBe(24);
    expect(stats.totalTicks).toBe(0);
    expect(stats.totalBars).toBe(0);
  });

  it("forwards the configured root to the store factory once", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(opener.rootsSeen).toEqual([ROOT]);
  });

  it("closes the store exactly once on a successful run", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(fakeStore.closeCount()).toBe(1);
  });

  it("hands the validated CatalogSymbol straight through to writeHour", async () => {
    const responses = new Map<number, Uint8Array>([
      [DAY_2024_01_15_START, encodeOneTickHour(0, 1.1, 1.10003)],
    ]);
    const { client } = makeFakeClient({ responses });
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "USDJPY", dayUtc: DAY_2024_01_15, root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(fakeStore.writes[0]!.symbol).toBe(toCatalogSymbol("USDJPY"));
  });

  it("invokes onHourComplete once per hour with the bar count", async () => {
    const responses = new Map<number, Uint8Array>([
      [DAY_2024_01_15_START, encodeOneTickHour(500, 1.1, 1.10003)],
    ]);
    const { client } = makeFakeClient({ responses });
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    const events: Array<[number, number]> = [];
    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
      {
        client,
        openStore: opener.openStore,
        onHourComplete: (hourMs, count) => events.push([hourMs, count]),
      },
    );

    expect(events.length).toBe(24);
    expect(events[0]).toEqual([DAY_2024_01_15_START, 1]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]![1]).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("ingestSymbolDay — edge cases", () => {
  it("handles the leap day 2024-02-29 as a normal 24-hour day", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: "2024-02-29", root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(calls[0]!.hourStartMs).toBe(Date.UTC(2024, 1, 29, 0, 0, 0, 0));
    expect(calls.length).toBe(24);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("handles the year boundary 2023-12-31 (end of 2023)", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: "2023-12-31", root: ROOT },
      { client, openStore: opener.openStore },
    );

    const start = Date.UTC(2023, 11, 31, 0, 0, 0, 0);
    expect(calls[0]!.hourStartMs).toBe(start);
    expect(calls[23]!.hourStartMs).toBe(start + 23 * ONE_HOUR_MS);
  });

  it("handles the Unix epoch (1970-01-01) at the lower year bound", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await ingestSymbolDay(
      { symbol: "EURUSD", dayUtc: "1970-01-01", root: ROOT },
      { client, openStore: opener.openStore },
    );

    expect(calls[0]!.hourStartMs).toBe(0);
    expect(calls.length).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("ingestSymbolDay — breaking tests (must throw / must not happen)", () => {
  for (const bad of [
    "",
    "2024-1-15",
    "2024-01-1",
    "24-01-15",
    "2024/01/15",
    "Jan 15 2024",
    "2024-13-01",
    "2024-02-30",
    "2023-02-29",
    "2024-00-15",
    "2024-01-00",
    "2024-01-32",
    "1969-12-31",
    "10000-01-01",
    "2024-01-15T00:00:00Z",
  ]) {
    it(`rejects malformed or impossible dayUtc ${JSON.stringify(bad)}`, async () => {
      const { client, calls } = makeFakeClient();
      const fakeStore = makeFakeStore();
      const opener = makeOpenStore(fakeStore);

      await expectRunError(
        ingestSymbolDay(
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

  it("rejects an unknown catalog symbol before opening anything", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await expectRunError(
      ingestSymbolDay(
        { symbol: "ZZZBOGUS", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "symbol" },
    );
    expect(opener.rootsSeen.length).toBe(0);
    expect(calls.length).toBe(0);
    expect(fakeStore.closeCount()).toBe(0);
  });

  it("rejects a wrong-case symbol (catalog is uppercase) without normalising", async () => {
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const opener = makeOpenStore(fakeStore);

    await expectRunError(
      ingestSymbolDay(
        { symbol: "eurusd", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "symbol" },
    );
  });

  it("wraps an openStore failure with phase=\"open\" and never calls close", async () => {
    const { client, calls } = makeFakeClient();
    const fakeStore = makeFakeStore();
    const openErr = new BarStoreError("disk full", { phase: "open" });
    const failingOpener = makeFailingOpenStore(openErr);

    const err = await expectRunError(
      ingestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: failingOpener.openStore },
      ),
      { phase: "open" },
    );
    expect(err.cause).toBe(openErr);
    expect(failingOpener.rootsSeen).toEqual([ROOT]);
    expect(calls.length).toBe(0);
    expect(fakeStore.closeCount()).toBe(0);
  });

  it("wraps an ingestSymbol failure with phase=\"ingest\", preserving the IngestError as cause, and still closes", async () => {
    const ingestErr = new IngestError("write blew up", {
      phase: "store",
      hourMs: DAY_2024_01_15_START + 5 * ONE_HOUR_MS,
    });
    const writeErrors = new Map<number, Error>([
      [DAY_2024_01_15_START + 5 * ONE_HOUR_MS, ingestErr],
    ]);
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore({ writeErrors });
    const opener = makeOpenStore(fakeStore);

    const err = await expectRunError(
      ingestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "ingest" },
    );
    expect(err.cause).toBeInstanceOf(IngestError);
    // ingestSymbol re-wraps store failures inside its own IngestError; we
    // walk one cause hop to recover the original sentinel.
    expect((err.cause as IngestError).cause).toBe(ingestErr);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("wraps a successful ingest's close failure with phase=\"close\"", async () => {
    const closeErr = new BarStoreError("file lock stuck", { phase: "closed" });
    const { client } = makeFakeClient();
    const fakeStore = makeFakeStore({ closeError: closeErr });
    const opener = makeOpenStore(fakeStore);

    const err = await expectRunError(
      ingestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "close" },
    );
    expect(err.cause).toBe(closeErr);
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("when both ingest and close fail, the ingest error wins; close is suppressed", async () => {
    const ingestErr = new IngestError("fetch died", {
      phase: "fetch",
      hourMs: DAY_2024_01_15_START,
    });
    const errors = new Map<number, Error>([[DAY_2024_01_15_START, ingestErr]]);
    const closeErr = new BarStoreError("trailing", { phase: "closed" });
    const { client } = makeFakeClient({ errors });
    const fakeStore = makeFakeStore({ closeError: closeErr });
    const opener = makeOpenStore(fakeStore);

    const err = await expectRunError(
      ingestSymbolDay(
        { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
        { client, openStore: opener.openStore },
      ),
      { phase: "ingest" },
    );
    expect(err.cause).toBeInstanceOf(IngestError);
    expect(fakeStore.closeCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("ingestSymbolDay — invariants (property-style)", () => {
  it("close() is called at most once across every reachable outcome", async () => {
    const cases: Array<() => Promise<void>> = [
      // Success path.
      async () => {
        const { client } = makeFakeClient();
        const fakeStore = makeFakeStore();
        const opener = makeOpenStore(fakeStore);
        await ingestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(1);
      },
      // Ingest error path (close still runs).
      async () => {
        const errs = new Map<number, Error>([
          [
            DAY_2024_01_15_START,
            new IngestError("x", { phase: "fetch", hourMs: DAY_2024_01_15_START }),
          ],
        ]);
        const { client } = makeFakeClient({ errors: errs });
        const fakeStore = makeFakeStore();
        const opener = makeOpenStore(fakeStore);
        await ingestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(1);
      },
      // Open error path (close never runs — there is nothing to close).
      async () => {
        const fakeStore = makeFakeStore();
        const opener = makeFailingOpenStore(
          new BarStoreError("nope", { phase: "open" }),
        );
        const { client } = makeFakeClient();
        await ingestSymbolDay(
          { symbol: "EURUSD", dayUtc: DAY_2024_01_15, root: ROOT },
          { client, openStore: opener.openStore },
        ).catch(() => {});
        expect(fakeStore.closeCount()).toBe(0);
      },
    ];
    for (const c of cases) await c();
  });

  it("hoursFetched on a successful run is always exactly 24", async () => {
    for (const day of ["2024-01-15", "2024-02-29", "2023-12-31", "1970-01-01", "2099-06-30"]) {
      const { client } = makeFakeClient();
      const fakeStore = makeFakeStore();
      const opener = makeOpenStore(fakeStore);
      const stats = await ingestSymbolDay(
        { symbol: "EURUSD", dayUtc: day, root: ROOT },
        { client, openStore: opener.openStore },
      );
      expect(stats.hoursFetched).toBe(24);
    }
  });
});
