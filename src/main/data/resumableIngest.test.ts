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
import type { DukascopyClient, FetchHourArgs } from "./dukascopyClient.js";
import { DukascopyFetchError } from "./dukascopyClient.js";
import { IngestError, type BarStore } from "./ingest.js";
import {
  resumableIngestSymbol,
  type HourFailure,
} from "./resumableIngest.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixture helpers — same hand-rolled bi5 encoder + fake client/store as
// `ingest.test.ts`, duplicated on purpose so this file reads stand-alone.
// ─────────────────────────────────────────────────────────────────────────

const ONE_HOUR_MS = 3_600_000;
const FOREX_SCALE = 100_000;

interface RecordSpec {
  msFromHourStart: number;
  bid: number;
  ask: number;
  volumeBid?: number;
  volumeAsk?: number;
}

function encodeRecords(records: readonly RecordSpec[], scale = FOREX_SCALE): Uint8Array {
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

interface ClientCall {
  symbol: DukascopySymbol;
  hourStartMs: number;
}

interface FakeClient {
  client: DukascopyClient;
  calls: ClientCall[];
}

function makeFakeClient(opts: {
  responses?: ReadonlyMap<number, Uint8Array>;
  errors?: ReadonlyMap<number, Error>;
  defaultBytes?: Uint8Array;
} = {}): FakeClient {
  const calls: ClientCall[] = [];
  const client: DukascopyClient = {
    async fetchHour(args: FetchHourArgs): Promise<Uint8Array> {
      calls.push({ symbol: args.symbol, hourStartMs: args.hourStartMs });
      const err = opts.errors?.get(args.hourStartMs);
      if (err) throw err;
      const bytes = opts.responses?.get(args.hourStartMs);
      return bytes ?? opts.defaultBytes ?? new Uint8Array(0);
    },
  };
  return { client, calls };
}

interface StoreCall {
  symbol: CatalogSymbol;
  hourMs: number;
  bars: readonly Bar[];
}

interface FakeStore {
  store: BarStore;
  calls: StoreCall[];
}

function makeFakeStore(opts: {
  errors?: ReadonlyMap<number, Error>;
} = {}): FakeStore {
  const calls: StoreCall[] = [];
  const store: BarStore = {
    async writeHour(args): Promise<void> {
      const err = opts.errors?.get(args.hourMs);
      if (err) throw err;
      calls.push({ symbol: args.symbol, hourMs: args.hourMs, bars: args.bars });
    },
  };
  return { store, calls };
}

const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const HOUR_1 = HOUR_0 + ONE_HOUR_MS;
const HOUR_2 = HOUR_0 + 2 * ONE_HOUR_MS;

const EURUSD = catalogToDukascopy("EURUSD");
const EURUSD_CAT = toCatalogSymbol("EURUSD");

// One tick → one bar; reused to make a hour "non-empty".
const ONE_TICK = encodeRecords([{ msFromHourStart: 100, bid: 1.1, ask: 1.10003 }]);

// ─────────────────────────────────────────────────────────────────────────
// — core behaviour
// ─────────────────────────────────────────────────────────────────────────

describe("resumableIngestSymbol — core behaviour", () => {
  it("ingests every hour when none are skipped and none fail", async () => {
    const client = makeFakeClient({
      responses: new Map([
        [HOUR_0, ONE_TICK],
        [HOUR_1, ONE_TICK],
        [HOUR_2, ONE_TICK],
      ]),
    });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(client.calls.map((c) => c.hourStartMs)).toEqual([HOUR_0, HOUR_1, HOUR_2]);
    expect(client.calls.every((c) => c.symbol === EURUSD)).toBe(true);
    expect(store.calls).toHaveLength(3);
    expect(stats.hoursTotal).toBe(3);
    expect(stats.hoursIngested).toBe(3);
    expect(stats.hoursSkipped).toBe(0);
    expect(stats.hoursFailed).toBe(0);
    expect(stats.totalTicks).toBe(3);
    expect(stats.totalBars).toBe(3);
    expect(stats.failures).toEqual([]);
  });

  it("skips hours for which hasHour returns true: no fetch, no write, counted as skipped", async () => {
    const client = makeFakeClient({ defaultBytes: ONE_TICK });
    const store = makeFakeStore();
    const skipped: number[] = [];

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      {
        client: client.client,
        store: store.store,
        hasHour: async (hourMs) => hourMs === HOUR_1,
        onHourSkipped: (hourMs) => skipped.push(hourMs),
      },
    );

    // HOUR_1 skipped → never fetched, never written.
    expect(client.calls.map((c) => c.hourStartMs)).toEqual([HOUR_0, HOUR_2]);
    expect(store.calls.map((c) => c.hourMs)).toEqual([HOUR_0, HOUR_2]);
    expect(skipped).toEqual([HOUR_1]);
    expect(stats.hoursSkipped).toBe(1);
    expect(stats.hoursIngested).toBe(2);
  });

  it("continues past a failing hour instead of throwing, recording the failure and ingesting later hours", async () => {
    const fetchCause = new DukascopyFetchError("HTTP 500");
    const client = makeFakeClient({
      responses: new Map([
        [HOUR_0, ONE_TICK],
        [HOUR_2, ONE_TICK],
      ]),
      errors: new Map([[HOUR_1, fetchCause]]),
    });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    // All three hours attempted; HOUR_1 failed but HOUR_2 still ran.
    expect(client.calls.map((c) => c.hourStartMs)).toEqual([HOUR_0, HOUR_1, HOUR_2]);
    expect(store.calls.map((c) => c.hourMs)).toEqual([HOUR_0, HOUR_2]);
    expect(stats.hoursIngested).toBe(2);
    expect(stats.hoursFailed).toBe(1);
    expect(stats.failures).toHaveLength(1);
    const failure = stats.failures[0]!;
    expect(failure.hourMs).toBe(HOUR_1);
    expect(failure.phase).toBe("fetch");
    expect(failure.cause).toBe(fetchCause);
  });

  it("fires onHourComplete for ingested hours, onHourFailed for failed hours", async () => {
    const client = makeFakeClient({
      responses: new Map([[HOUR_0, ONE_TICK]]),
      errors: new Map([[HOUR_1, new DukascopyFetchError("nope")]]),
    });
    const store = makeFakeStore();
    const completed: Array<[number, number]> = [];
    const failed: HourFailure[] = [];

    await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_2 },
      {
        client: client.client,
        store: store.store,
        onHourComplete: (hourMs, barCount) => completed.push([hourMs, barCount]),
        onHourFailed: (failure) => failed.push(failure),
      },
    );

    expect(completed).toEqual([[HOUR_0, 1]]);
    expect(failed.map((f) => f.hourMs)).toEqual([HOUR_1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — edge cases
// ─────────────────────────────────────────────────────────────────────────

describe("resumableIngestSymbol — edge cases", () => {
  it("no hasHour predicate → nothing is skipped, every hour attempted", async () => {
    const client = makeFakeClient({ defaultBytes: ONE_TICK });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 4 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(stats.hoursSkipped).toBe(0);
    expect(stats.hoursIngested).toBe(4);
    expect(client.calls).toHaveLength(4);
  });

  it("all hours already present → everything skipped, store and client untouched", async () => {
    const client = makeFakeClient({ defaultBytes: ONE_TICK });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: client.client, store: store.store, hasHour: async () => true },
    );

    expect(client.calls).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(stats.hoursSkipped).toBe(3);
    expect(stats.hoursIngested).toBe(0);
    expect(stats.hoursTotal).toBe(3);
  });

  it("an empty hour counts as ingested and empty, never failed", async () => {
    const client = makeFakeClient(); // default: empty bytes
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: client.client, store: store.store },
    );

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.bars).toEqual([]);
    expect(stats.hoursIngested).toBe(1);
    expect(stats.hoursEmpty).toBe(1);
    expect(stats.hoursFailed).toBe(0);
  });

  it("works at the unix epoch (fromHourMs = 0)", async () => {
    const client = makeFakeClient({ defaultBytes: ONE_TICK });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: 0, toHourMs: ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(client.calls[0]!.hourStartMs).toBe(0);
    expect(stats.hoursIngested).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — breaking tests (must throw / must not happen)
//
// Bad *spec* throws IngestError({ phase: "spec" }) — same contract as
// `ingestSymbol`. Per-hour *runtime* failures are collected, never thrown.
// ─────────────────────────────────────────────────────────────────────────

describe("resumableIngestSymbol — breaking tests (spec validation throws)", () => {
  function noopDeps() {
    return {
      client: makeFakeClient().client,
      store: makeFakeStore().store,
    };
  }

  function expectSpecError(overrides: { fromHourMs?: number; toHourMs?: number }) {
    return expect(
      resumableIngestSymbol(
        {
          symbol: EURUSD_CAT,
          fromHourMs: overrides.fromHourMs ?? HOUR_0,
          toHourMs: overrides.toHourMs ?? HOUR_1,
        },
        noopDeps(),
      ),
    ).rejects.toBeInstanceOf(IngestError);
  }

  it("throws on NaN fromHourMs", async () => {
    await expectSpecError({ fromHourMs: NaN });
  });

  it("throws on +Infinity toHourMs", async () => {
    await expectSpecError({ toHourMs: Number.POSITIVE_INFINITY });
  });

  it("throws on negative fromHourMs", async () => {
    await expectSpecError({ fromHourMs: -ONE_HOUR_MS });
  });

  it("throws on non-aligned fromHourMs (one ms past the hour)", async () => {
    await expectSpecError({ fromHourMs: HOUR_0 + 1 });
  });

  it("throws on reversed range (fromHourMs > toHourMs)", async () => {
    await expectSpecError({ fromHourMs: HOUR_1, toHourMs: HOUR_0 });
  });

  it("throws on empty range (fromHourMs == toHourMs)", async () => {
    await expectSpecError({ fromHourMs: HOUR_0, toHourMs: HOUR_0 });
  });

  it("the thrown IngestError carries phase 'spec'", async () => {
    let caught: unknown = null;
    try {
      await resumableIngestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: NaN, toHourMs: HOUR_1 },
        noopDeps(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as IngestError).phase).toBe("spec");
  });

  it("spec validation runs before any I/O (no fetch / write on bad spec)", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();
    await expect(
      resumableIngestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: NaN, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      ),
    ).rejects.toBeInstanceOf(IngestError);
    expect(client.calls).toEqual([]);
    expect(store.calls).toEqual([]);
  });
});

describe("resumableIngestSymbol — breaking tests (per-hour failures must not throw)", () => {
  it("a per-hour fetch failure resolves (does not reject) — continue-on-error contract", async () => {
    const client = makeFakeClient({
      errors: new Map([[HOUR_0, new DukascopyFetchError("boom")]]),
    });
    const store = makeFakeStore();

    await expect(
      resumableIngestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      ),
    ).resolves.toBeDefined();
  });

  it("even when every hour fails, the run resolves with hoursFailed == hoursTotal", async () => {
    const client = makeFakeClient({
      errors: new Map([
        [HOUR_0, new DukascopyFetchError("a")],
        [HOUR_1, new DukascopyFetchError("b")],
      ]),
    });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_2 },
      { client: client.client, store: store.store },
    );

    expect(stats.hoursFailed).toBe(2);
    expect(stats.hoursIngested).toBe(0);
    expect(stats.failures.map((f) => f.hourMs)).toEqual([HOUR_0, HOUR_1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — invariants (property-style)
// ─────────────────────────────────────────────────────────────────────────

describe("resumableIngestSymbol — invariants (property-style)", () => {
  it("hoursIngested + hoursSkipped + hoursFailed == hoursTotal across a mixed grid", async () => {
    // Build a 6-hour run with a mix of: ingest, skip, fail.
    const hours = [0, 1, 2, 3, 4, 5].map((i) => HOUR_0 + i * ONE_HOUR_MS);
    const client = makeFakeClient({
      responses: new Map(hours.map((h) => [h, ONE_TICK] as const)),
      errors: new Map([[hours[2]!, new DukascopyFetchError("x")]]),
    });
    const store = makeFakeStore();

    const stats = await resumableIngestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: hours[0]!, toHourMs: hours[5]! + ONE_HOUR_MS },
      {
        client: client.client,
        store: store.store,
        hasHour: async (hourMs) => hourMs === hours[4]!,
      },
    );

    expect(stats.hoursTotal).toBe(6);
    expect(stats.hoursIngested + stats.hoursSkipped + stats.hoursFailed).toBe(
      stats.hoursTotal,
    );
    expect(stats.failures.length).toBe(stats.hoursFailed);
    expect(stats.hoursEmpty).toBeLessThanOrEqual(stats.hoursIngested);
  });

  it("hoursTotal always equals (toHourMs - fromHourMs) / hour for several ranges", async () => {
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [HOUR_0, HOUR_0 + ONE_HOUR_MS],
      [HOUR_0, HOUR_0 + 5 * ONE_HOUR_MS],
      [HOUR_0, HOUR_0 + 24 * ONE_HOUR_MS],
    ];
    for (const [from, to] of ranges) {
      const client = makeFakeClient({ defaultBytes: ONE_TICK });
      const store = makeFakeStore();
      const stats = await resumableIngestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: from, toHourMs: to },
        { client: client.client, store: store.store },
      );
      expect(stats.hoursTotal).toBe((to - from) / ONE_HOUR_MS);
    }
  });
});
