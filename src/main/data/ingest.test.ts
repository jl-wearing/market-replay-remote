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
import {
  type BarStore,
  type IngestPhase,
  IngestError,
  ingestSymbol,
} from "./ingest.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixture helpers — encode hand-crafted bi5 byte buffers and gather
// hand-rolled fake DukascopyClient / BarStore call logs. The bi5 encoder
// duplicates the one in `bi5.test.ts` and `aggregate.integration.test.ts`
// on purpose so each test file reads stand-alone.
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
  /** Per-hour canned responses. Hour not present → returns `defaultBytes`. */
  responses?: ReadonlyMap<number, Uint8Array>;
  /** Per-hour rejections. Wins over `responses`. */
  errors?: ReadonlyMap<number, Error>;
  /** Returned for any hour not in `responses`/`errors`. Default: empty. */
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
  /** Per-hour rejections. */
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

// 2024-01-15 10:00:00 UTC. A whole UTC hour, mid-London-session, settled.
const HOUR_0 = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const HOUR_1 = HOUR_0 + ONE_HOUR_MS;
const HOUR_2 = HOUR_0 + 2 * ONE_HOUR_MS;

const EURUSD = catalogToDukascopy("EURUSD");
const EURUSD_CAT = toCatalogSymbol("EURUSD");
const USDJPY_CAT = toCatalogSymbol("USDJPY");

// ─────────────────────────────────────────────────────────────────────────
// — core behaviour
// ─────────────────────────────────────────────────────────────────────────

describe("ingestSymbol — core behaviour", () => {
  it("walks a single-hour range: one fetchHour call, one writeHour call, stats reflect that hour", async () => {
    const bytes = encodeRecords([
      { msFromHourStart: 100, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 200, bid: 1.10001, ask: 1.10004 },
    ]);
    const client = makeFakeClient({
      responses: new Map([[HOUR_0, bytes]]),
    });
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: client.client, store: store.store },
    );

    expect(client.calls).toEqual([{ symbol: EURUSD, hourStartMs: HOUR_0 }]);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.symbol).toBe("EURUSD");
    expect(store.calls[0]!.hourMs).toBe(HOUR_0);
    expect(store.calls[0]!.bars).toHaveLength(1);
    expect(stats).toEqual({
      hoursFetched: 1,
      hoursEmpty: 0,
      totalTicks: 2,
      totalBars: 1,
    });
  });

  it("walks a 3-hour range in chronological order, fetch and write interleave per hour", async () => {
    const order: string[] = [];
    const tickyBytes = encodeRecords([{ msFromHourStart: 0, bid: 1.1, ask: 1.10003 }]);
    const client: DukascopyClient = {
      async fetchHour(args) {
        order.push(`fetch:${args.hourStartMs}`);
        return tickyBytes;
      },
    };
    const store: BarStore = {
      async writeHour(args) {
        order.push(`write:${args.hourMs}`);
      },
    };

    await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client, store },
    );

    expect(order).toEqual([
      `fetch:${HOUR_0}`,
      `write:${HOUR_0}`,
      `fetch:${HOUR_1}`,
      `write:${HOUR_1}`,
      `fetch:${HOUR_2}`,
      `write:${HOUR_2}`,
    ]);
  });

  it("passes the catalog symbol to the store and the Dukascopy symbol to the client", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();

    await ingestSymbol(
      { symbol: USDJPY_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: client.client, store: store.store },
    );

    expect(client.calls[0]!.symbol).toBe(catalogToDukascopy("USDJPY"));
    expect(client.calls[0]!.symbol).toBe("usdjpy");
    expect(store.calls[0]!.symbol).toBe("USDJPY");
  });

  it("calls onHourComplete after each successful hour with (hourMs, barCount)", async () => {
    const bytesH0 = encodeRecords([
      { msFromHourStart: 100, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 1_500, bid: 1.10005, ask: 1.10008 },
    ]); // → 2 bars
    const bytesH1 = encodeRecords([
      { msFromHourStart: 200, bid: 1.1, ask: 1.10003 },
    ]); // → 1 bar
    const client = makeFakeClient({
      responses: new Map([
        [HOUR_0, bytesH0],
        [HOUR_1, bytesH1],
      ]),
    });
    const store = makeFakeStore();
    const progress: Array<[number, number]> = [];

    await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_2 },
      {
        client: client.client,
        store: store.store,
        onHourComplete: (hourMs, barCount) => progress.push([hourMs, barCount]),
      },
    );

    expect(progress).toEqual([
      [HOUR_0, 2],
      [HOUR_1, 1],
    ]);
  });

  it("aggregates stats across a mixed run (some empty hours, varying tick counts)", async () => {
    const bytesH0 = encodeRecords([
      { msFromHourStart: 100, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 200, bid: 1.10001, ask: 1.10004 },
      { msFromHourStart: 1_500, bid: 1.10002, ask: 1.10005 },
    ]); // 3 ticks → 2 bars
    const bytesH2 = encodeRecords([
      { msFromHourStart: 0, bid: 1.1, ask: 1.10003 },
    ]); // 1 tick → 1 bar
    // H1 has no entry → empty
    const client = makeFakeClient({
      responses: new Map([
        [HOUR_0, bytesH0],
        [HOUR_2, bytesH2],
      ]),
    });
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(stats).toEqual({
      hoursFetched: 3,
      hoursEmpty: 1,
      totalTicks: 4,
      totalBars: 3,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — edge cases
// ─────────────────────────────────────────────────────────────────────────

describe("ingestSymbol — edge cases", () => {
  it("calls store.writeHour with bars: [] for an empty hour and increments hoursEmpty", async () => {
    const client = makeFakeClient(); // default: empty bytes
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: client.client, store: store.store },
    );

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.bars).toEqual([]);
    expect(stats).toEqual({
      hoursFetched: 1,
      hoursEmpty: 1,
      totalTicks: 0,
      totalBars: 0,
    });
  });

  it("an entirely-empty range (multiple empty hours) writes one bars: [] per hour and reports zeros", async () => {
    const client = makeFakeClient(); // default: empty
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 5 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(store.calls).toHaveLength(5);
    for (const c of store.calls) expect(c.bars).toEqual([]);
    expect(stats.hoursFetched).toBe(5);
    expect(stats.hoursEmpty).toBe(5);
    expect(stats.totalTicks).toBe(0);
    expect(stats.totalBars).toBe(0);
  });

  it("walks a 24-hour range without losing or duplicating an hour", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();

    await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 24 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(client.calls).toHaveLength(24);
    expect(store.calls).toHaveLength(24);
    for (let i = 0; i < 24; i++) {
      expect(client.calls[i]!.hourStartMs).toBe(HOUR_0 + i * ONE_HOUR_MS);
      expect(store.calls[i]!.hourMs).toBe(HOUR_0 + i * ONE_HOUR_MS);
    }
  });

  it("onHourComplete is optional (omitting it does not throw)", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();

    await expect(
      ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      ),
    ).resolves.toBeDefined();
  });

  it("works at the unix epoch (fromHourMs = 0)", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();

    await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: 0, toHourMs: ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    expect(client.calls[0]!.hourStartMs).toBe(0);
    expect(store.calls[0]!.hourMs).toBe(0);
  });

  it("a single-tick hour produces totalBars=1, totalTicks=1 with the bar carrying the right timestamp", async () => {
    const bytes = encodeRecords([
      { msFromHourStart: 1_234, bid: 1.1, ask: 1.10003 },
    ]);
    const client = makeFakeClient({ responses: new Map([[HOUR_0, bytes]]) });
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
      { client: client.client, store: store.store },
    );

    expect(stats.totalTicks).toBe(1);
    expect(stats.totalBars).toBe(1);
    expect(store.calls[0]!.bars[0]!.timestampMs).toBe(HOUR_0 + 1_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — breaking tests (must throw)
//
// Spec validation throws synchronously *before* any I/O. Adapter-layer
// failures throw `IngestError` with `phase` / `hourMs` / `cause` populated
// and stop the loop — no further fetch / write / progress callbacks.
// ─────────────────────────────────────────────────────────────────────────

describe("ingestSymbol — breaking tests (spec validation, no I/O)", () => {
  function noopDeps() {
    return {
      client: makeFakeClient().client,
      store: makeFakeStore().store,
    };
  }

  function expectSpecError(
    overrides: { fromHourMs?: number; toHourMs?: number; symbol?: CatalogSymbol },
  ) {
    const spec = {
      symbol: overrides.symbol ?? EURUSD_CAT,
      fromHourMs: overrides.fromHourMs ?? HOUR_0,
      toHourMs: overrides.toHourMs ?? HOUR_1,
    };
    return expect(ingestSymbol(spec, noopDeps())).rejects.toBeInstanceOf(
      IngestError,
    );
  }

  it("throws on NaN fromHourMs", async () => {
    await expectSpecError({ fromHourMs: NaN });
  });

  it("throws on +Infinity fromHourMs", async () => {
    await expectSpecError({ fromHourMs: Number.POSITIVE_INFINITY });
  });

  it("throws on -Infinity fromHourMs", async () => {
    await expectSpecError({ fromHourMs: Number.NEGATIVE_INFINITY });
  });

  it("throws on negative fromHourMs", async () => {
    await expectSpecError({ fromHourMs: -ONE_HOUR_MS });
  });

  it("throws on non-integer fromHourMs", async () => {
    await expectSpecError({ fromHourMs: HOUR_0 + 0.5 });
  });

  it("throws on non-aligned fromHourMs (one minute past the hour)", async () => {
    await expectSpecError({ fromHourMs: HOUR_0 + 60_000 });
  });

  it("throws on non-aligned fromHourMs (one ms past the hour)", async () => {
    await expectSpecError({ fromHourMs: HOUR_0 + 1 });
  });

  it("throws on NaN toHourMs", async () => {
    await expectSpecError({ toHourMs: NaN });
  });

  it("throws on +Infinity toHourMs", async () => {
    await expectSpecError({ toHourMs: Number.POSITIVE_INFINITY });
  });

  it("throws on -Infinity toHourMs", async () => {
    await expectSpecError({ toHourMs: Number.NEGATIVE_INFINITY });
  });

  it("throws on negative toHourMs", async () => {
    await expectSpecError({ toHourMs: -ONE_HOUR_MS });
  });

  it("throws on non-integer toHourMs", async () => {
    await expectSpecError({ toHourMs: HOUR_1 + 0.5 });
  });

  it("throws on non-aligned toHourMs", async () => {
    await expectSpecError({ toHourMs: HOUR_1 + 1 });
  });

  it("throws on fromHourMs == toHourMs (empty range — pin: this is an error, not a zero-stat success)", async () => {
    await expectSpecError({ fromHourMs: HOUR_0, toHourMs: HOUR_0 });
  });

  it("throws on fromHourMs > toHourMs (reversed range)", async () => {
    await expectSpecError({ fromHourMs: HOUR_1, toHourMs: HOUR_0 });
  });

  it("IngestError from spec validation has phase 'spec' and no hourMs", async () => {
    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: NaN, toHourMs: HOUR_1 },
        noopDeps(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as IngestError).phase).toBe("spec");
    expect((caught as IngestError).hourMs).toBeUndefined();
  });

  it("spec validation does not call client.fetchHour or store.writeHour", async () => {
    const client = makeFakeClient();
    const store = makeFakeStore();
    await expect(
      ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: NaN, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      ),
    ).rejects.toBeInstanceOf(IngestError);
    expect(client.calls).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("throws IngestError with phase 'symbol' when a bypassed CatalogSymbol does not map to Dukascopy (defensive runtime check)", async () => {
    // The `CatalogSymbol` brand is normally produced only by
    // `toCatalogSymbol`, which rejects non-catalog strings at compile
    // time + runtime. The `as` cast below simulates an upstream escape
    // hatch (unsafe cast, corrupted config file, data-shape regression
    // in `dukascopy-node`). The orchestrator's defensive try/catch
    // around `catalogToDukascopy` / `dukascopyPriceScale` must still
    // wrap the failure as `IngestError({ phase: "symbol" })` so the
    // caller sees a consistent error type.
    const client = makeFakeClient();
    const store = makeFakeStore();
    let caught: unknown = null;
    try {
      await ingestSymbol(
        {
          symbol: "ZZZBOGUS" as unknown as CatalogSymbol,
          fromHourMs: HOUR_0,
          toHourMs: HOUR_1,
        },
        { client: client.client, store: store.store },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngestError);
    expect((caught as IngestError).phase).toBe("symbol");
    expect((caught as IngestError).cause).toBeDefined();
    expect(client.calls).toEqual([]);
    expect(store.calls).toEqual([]);
  });
});

describe("ingestSymbol — breaking tests (adapter / pipeline failures)", () => {
  it("wraps a DukascopyFetchError from client.fetchHour and stops at the failing hour (phase 'fetch')", async () => {
    const fetchCause = new DukascopyFetchError("HTTP 500");
    const client = makeFakeClient({
      errors: new Map([[HOUR_1, fetchCause]]),
    });
    const store = makeFakeStore();

    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
        { client: client.client, store: store.store },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IngestError);
    const e = caught as IngestError;
    expect(e.phase).toBe<IngestPhase>("fetch");
    expect(e.hourMs).toBe(HOUR_1);
    expect(e.cause).toBe(fetchCause);
    // Ran HOUR_0 fully, started HOUR_1, did not start HOUR_2.
    expect(client.calls.map((c) => c.hourStartMs)).toEqual([HOUR_0, HOUR_1]);
    // Wrote HOUR_0 (succeeded). Did not write HOUR_1 (fetch failed).
    expect(store.calls.map((c) => c.hourMs)).toEqual([HOUR_0]);
  });

  it("wraps an InvalidBi5Error from decode (corrupt bytes) with phase 'decode' and the offending hourMs", async () => {
    // Length 21 (not a multiple of 20) → bi5 throws InvalidBi5Error.
    const corrupt = new Uint8Array(21);
    const client = makeFakeClient({
      responses: new Map([[HOUR_0, corrupt]]),
    });
    const store = makeFakeStore();

    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as IngestError;
    expect(e).toBeInstanceOf(IngestError);
    expect(e.phase).toBe<IngestPhase>("decode");
    expect(e.hourMs).toBe(HOUR_0);
    expect(e.cause).toBeDefined();
    expect((e.cause as Error).name).toBe("InvalidBi5Error");
    expect(store.calls).toEqual([]);
  });

  it("wraps an InvalidTickStreamError from aggregate (non-monotonic ticks) with phase 'aggregate'", async () => {
    // bi5 doesn't enforce monotonic order — aggregate does.
    const nonMonotonic = encodeRecords([
      { msFromHourStart: 500, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 200, bid: 1.10001, ask: 1.10004 },
    ]);
    const client = makeFakeClient({
      responses: new Map([[HOUR_0, nonMonotonic]]),
    });
    const store = makeFakeStore();

    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_1 },
        { client: client.client, store: store.store },
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as IngestError;
    expect(e).toBeInstanceOf(IngestError);
    expect(e.phase).toBe<IngestPhase>("aggregate");
    expect(e.hourMs).toBe(HOUR_0);
    expect(e.cause).toBeDefined();
    expect((e.cause as Error).name).toBe("InvalidTickStreamError");
    expect(store.calls).toEqual([]);
  });

  it("wraps a store.writeHour rejection with phase 'store' and stops", async () => {
    const storeCause = new Error("disk full");
    const client = makeFakeClient();
    const store = makeFakeStore({
      errors: new Map([[HOUR_0, storeCause]]),
    });

    let caught: unknown = null;
    try {
      await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 2 * ONE_HOUR_MS },
        { client: client.client, store: store.store },
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as IngestError;
    expect(e).toBeInstanceOf(IngestError);
    expect(e.phase).toBe<IngestPhase>("store");
    expect(e.hourMs).toBe(HOUR_0);
    expect(e.cause).toBe(storeCause);
    expect(client.calls.map((c) => c.hourStartMs)).toEqual([HOUR_0]);
  });

  it("does not invoke onHourComplete for the failing hour", async () => {
    const client = makeFakeClient({
      errors: new Map([[HOUR_1, new DukascopyFetchError("nope")]]),
    });
    const store = makeFakeStore();
    const progress: number[] = [];

    await expect(
      ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
        {
          client: client.client,
          store: store.store,
          onHourComplete: (hourMs) => progress.push(hourMs),
        },
      ),
    ).rejects.toBeInstanceOf(IngestError);

    // Only HOUR_0 succeeded, so only HOUR_0 fired the callback.
    expect(progress).toEqual([HOUR_0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// — invariants (property-style)
// ─────────────────────────────────────────────────────────────────────────

describe("ingestSymbol — invariants (property-style)", () => {
  it("for any successful run: client and store both called exactly N times where N == (to - from) / hour", async () => {
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [HOUR_0, HOUR_0 + ONE_HOUR_MS],
      [HOUR_0, HOUR_0 + 2 * ONE_HOUR_MS],
      [HOUR_0, HOUR_0 + 7 * ONE_HOUR_MS],
      [HOUR_0, HOUR_0 + 24 * ONE_HOUR_MS],
    ];
    for (const [from, to] of ranges) {
      const client = makeFakeClient();
      const store = makeFakeStore();
      const stats = await ingestSymbol(
        { symbol: EURUSD_CAT, fromHourMs: from, toHourMs: to },
        { client: client.client, store: store.store },
      );
      const expected = (to - from) / ONE_HOUR_MS;
      expect(client.calls).toHaveLength(expected);
      expect(store.calls).toHaveLength(expected);
      expect(stats.hoursFetched).toBe(expected);
    }
  });

  it("Σ store.calls[i].bars.length == stats.totalBars across mixed runs", async () => {
    const bytesH0 = encodeRecords([
      { msFromHourStart: 100, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 1_500, bid: 1.10005, ask: 1.10008 },
      { msFromHourStart: 2_500, bid: 1.10003, ask: 1.10006 },
    ]); // 3 ticks → 3 bars
    const bytesH2 = encodeRecords([
      { msFromHourStart: 0, bid: 1.1, ask: 1.10003 },
      { msFromHourStart: 100, bid: 1.10001, ask: 1.10004 },
    ]); // 2 ticks → 1 bar

    const client = makeFakeClient({
      responses: new Map([
        [HOUR_0, bytesH0],
        // HOUR_1 empty
        [HOUR_2, bytesH2],
      ]),
    });
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 3 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    const sumBars = store.calls.reduce((n, c) => n + c.bars.length, 0);
    expect(sumBars).toBe(stats.totalBars);
    expect(sumBars).toBe(4);
  });

  it("for each hour H in a successful run: fetch(H) precedes write(H), and write(H) precedes fetch(H + 1h)", async () => {
    const order: Array<{ kind: "fetch" | "write"; hour: number }> = [];
    const client: DukascopyClient = {
      async fetchHour(args) {
        order.push({ kind: "fetch", hour: args.hourStartMs });
        return new Uint8Array(0);
      },
    };
    const store: BarStore = {
      async writeHour(args) {
        order.push({ kind: "write", hour: args.hourMs });
      },
    };

    await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 4 * ONE_HOUR_MS },
      { client, store },
    );

    for (let i = 0; i < 4; i++) {
      expect(order[2 * i]).toEqual({
        kind: "fetch",
        hour: HOUR_0 + i * ONE_HOUR_MS,
      });
      expect(order[2 * i + 1]).toEqual({
        kind: "write",
        hour: HOUR_0 + i * ONE_HOUR_MS,
      });
    }
  });

  it("hoursEmpty + (hours with bars) == hoursFetched (every fetched hour is one or the other)", async () => {
    const bytesH1 = encodeRecords([
      { msFromHourStart: 0, bid: 1.1, ask: 1.10003 },
    ]);
    const client = makeFakeClient({
      responses: new Map([[HOUR_1, bytesH1]]),
    });
    const store = makeFakeStore();

    const stats = await ingestSymbol(
      { symbol: EURUSD_CAT, fromHourMs: HOUR_0, toHourMs: HOUR_0 + 4 * ONE_HOUR_MS },
      { client: client.client, store: store.store },
    );

    const hoursWithBars = store.calls.filter((c) => c.bars.length > 0).length;
    expect(stats.hoursEmpty + hoursWithBars).toBe(stats.hoursFetched);
  });
});
