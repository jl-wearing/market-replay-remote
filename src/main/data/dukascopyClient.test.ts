import { describe, expect, it } from "vitest";
import {
  catalogToDukascopy,
  type DukascopySymbol,
} from "../../shared/dukascopy/symbolMap.js";
import {
  DukascopyFetchError,
  createDukascopyClient,
  type LzmaDecompressFn,
} from "./dukascopyClient.js";

// 2024-01-15 10:00:00 UTC.
const VALID_HOUR_MS = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const ONE_HOUR_MS = 3_600_000;
const EURUSD = catalogToDukascopy("EURUSD");

interface FakeFetch {
  fn: typeof fetch;
  calls: string[];
}

function makeFakeFetch(
  opts: {
    status?: number;
    body?: Uint8Array;
    throwError?: Error;
  } = {},
): FakeFetch {
  const calls: string[] = [];
  const fn: typeof fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push(url);
    if (opts.throwError) throw opts.throwError;
    const body = opts.body ?? new Uint8Array(0);
    return new Response(body, { status: opts.status ?? 200 });
  };
  return { fn, calls };
}

interface FakeDecompress {
  fn: LzmaDecompressFn;
  calls: Uint8Array[];
}

function makeFakeDecompress(
  opts: {
    output?: Uint8Array;
    throwError?: Error;
  } = {},
): FakeDecompress {
  const calls: Uint8Array[] = [];
  const fn: LzmaDecompressFn = (compressed) => {
    calls.push(compressed);
    if (opts.throwError) throw opts.throwError;
    return opts.output ?? new Uint8Array(0);
  };
  return { fn, calls };
}

describe("createDukascopyClient — core behaviour", () => {
  it("fetches the canonical Dukascopy bi5 URL for the requested hour", async () => {
    const fetchFake = makeFakeFetch({ body: new Uint8Array([0xff, 0xfe]) });
    const decompressFake = makeFakeDecompress({
      output: new Uint8Array([1, 2, 3, 4]),
    });

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    await client.fetchHour({ symbol: EURUSD, hourStartMs: VALID_HOUR_MS });

    expect(fetchFake.calls).toHaveLength(1);
    const url = fetchFake.calls[0]!;
    // Dukascopy URL convention: 0-indexed month (Jan = "00"), 2-digit padded
    // year/month/day/hour, instrument upper-cased. We assert the structural
    // tail rather than the full host so we don't pin to a specific datafeed
    // host string (dukascopy-node owns that).
    expect(url).toMatch(/\/EURUSD\/2024\/00\/15\/10h_ticks\.bi5$/);
  });

  it("hands the raw response body to the LZMA decompressor and returns its output", async () => {
    const compressed = new Uint8Array([0x5d, 0x00, 0x00, 0x80, 0x00]);
    const decompressed = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const fetchFake = makeFakeFetch({ body: compressed });
    const decompressFake = makeFakeDecompress({ output: decompressed });

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    const out = await client.fetchHour({
      symbol: EURUSD,
      hourStartMs: VALID_HOUR_MS,
    });

    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([0x10, 0x20, 0x30, 0x40]);
    expect(decompressFake.calls).toHaveLength(1);
    expect(Array.from(decompressFake.calls[0]!)).toEqual(Array.from(compressed));
  });

  it("returned Uint8Array is independent of the response body backing buffer", async () => {
    const compressed = new Uint8Array([0xaa, 0xbb]);
    const decompressed = new Uint8Array([1, 2, 3]);
    const fetchFake = makeFakeFetch({ body: compressed });
    const decompressFake = makeFakeDecompress({ output: decompressed });

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    const out = await client.fetchHour({
      symbol: EURUSD,
      hourStartMs: VALID_HOUR_MS,
    });

    decompressed[0] = 99;
    expect(out[0]).toBe(99);
  });
});

describe("createDukascopyClient — edge cases", () => {
  it("returns an empty Uint8Array for an empty 200 response without invoking decompress", async () => {
    const fetchFake = makeFakeFetch({ body: new Uint8Array(0), status: 200 });
    const decompressFake = makeFakeDecompress();

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    const out = await client.fetchHour({
      symbol: EURUSD,
      hourStartMs: VALID_HOUR_MS,
    });

    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(0);
    expect(decompressFake.calls).toHaveLength(0);
  });

  it("treats a 404 as 'no data this hour' and returns an empty Uint8Array", async () => {
    const fetchFake = makeFakeFetch({ status: 404 });
    const decompressFake = makeFakeDecompress();

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    const out = await client.fetchHour({
      symbol: EURUSD,
      hourStartMs: VALID_HOUR_MS,
    });

    expect(out.length).toBe(0);
    expect(decompressFake.calls).toHaveLength(0);
  });

  it("works at the unix epoch (hourStartMs = 0)", async () => {
    const fetchFake = makeFakeFetch({ body: new Uint8Array(0) });
    const decompressFake = makeFakeDecompress();

    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    await client.fetchHour({ symbol: EURUSD, hourStartMs: 0 });

    const url = fetchFake.calls[0]!;
    expect(url).toMatch(/\/EURUSD\/1970\/00\/01\/00h_ticks\.bi5$/);
  });

  it("constructs a default client with no opts (factory must not throw)", () => {
    expect(() => createDukascopyClient()).not.toThrow();
  });
});

describe("createDukascopyClient — breaking tests (must throw)", () => {
  function makeClient() {
    return createDukascopyClient({
      fetch: makeFakeFetch().fn,
      decompress: makeFakeDecompress().fn,
    });
  }

  it("throws DukascopyFetchError on NaN hourStartMs", async () => {
    await expect(
      makeClient().fetchHour({ symbol: EURUSD, hourStartMs: NaN }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("throws DukascopyFetchError on +Infinity / -Infinity hourStartMs", async () => {
    await expect(
      makeClient().fetchHour({ symbol: EURUSD, hourStartMs: Infinity }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
    await expect(
      makeClient().fetchHour({ symbol: EURUSD, hourStartMs: -Infinity }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("throws DukascopyFetchError on negative hourStartMs", async () => {
    await expect(
      makeClient().fetchHour({ symbol: EURUSD, hourStartMs: -ONE_HOUR_MS }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("throws DukascopyFetchError on non-integer hourStartMs", async () => {
    await expect(
      makeClient().fetchHour({ symbol: EURUSD, hourStartMs: 1.5 }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("throws DukascopyFetchError on hourStartMs not aligned to a UTC hour boundary", async () => {
    await expect(
      makeClient().fetchHour({
        symbol: EURUSD,
        hourStartMs: VALID_HOUR_MS + 1,
      }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
    await expect(
      makeClient().fetchHour({
        symbol: EURUSD,
        hourStartMs: VALID_HOUR_MS + 60_000,
      }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("throws DukascopyFetchError on empty / non-string symbol at runtime", async () => {
    await expect(
      makeClient().fetchHour({
        symbol: "" as unknown as DukascopySymbol,
        hourStartMs: VALID_HOUR_MS,
      }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
    await expect(
      makeClient().fetchHour({
        symbol: undefined as unknown as DukascopySymbol,
        hourStartMs: VALID_HOUR_MS,
      }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
    await expect(
      makeClient().fetchHour({
        symbol: 123 as unknown as DukascopySymbol,
        hourStartMs: VALID_HOUR_MS,
      }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("does not call fetch when validation fails", async () => {
    const fetchFake = makeFakeFetch();
    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: makeFakeDecompress().fn,
    });
    await expect(
      client.fetchHour({ symbol: EURUSD, hourStartMs: NaN }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
    expect(fetchFake.calls).toHaveLength(0);
  });

  it("wraps a fetch rejection in a DukascopyFetchError (preserves cause)", async () => {
    const cause = new Error("ECONNRESET");
    const fetchFake = makeFakeFetch({ throwError: cause });
    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: makeFakeDecompress().fn,
    });

    let caught: unknown = null;
    try {
      await client.fetchHour({ symbol: EURUSD, hourStartMs: VALID_HOUR_MS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DukascopyFetchError);
    expect((caught as DukascopyFetchError).cause).toBe(cause);
  });

  it("throws DukascopyFetchError on non-empty non-2xx HTTP responses other than 404", async () => {
    const fetchFake = makeFakeFetch({ status: 500, body: new Uint8Array([0]) });
    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: makeFakeDecompress().fn,
    });
    await expect(
      client.fetchHour({ symbol: EURUSD, hourStartMs: VALID_HOUR_MS }),
    ).rejects.toBeInstanceOf(DukascopyFetchError);
  });

  it("wraps a decompressor failure in a DukascopyFetchError (preserves cause)", async () => {
    const cause = new Error("bad lzma stream");
    const fetchFake = makeFakeFetch({ body: new Uint8Array([1, 2, 3]) });
    const decompressFake = makeFakeDecompress({ throwError: cause });
    const client = createDukascopyClient({
      fetch: fetchFake.fn,
      decompress: decompressFake.fn,
    });

    let caught: unknown = null;
    try {
      await client.fetchHour({ symbol: EURUSD, hourStartMs: VALID_HOUR_MS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DukascopyFetchError);
    expect((caught as DukascopyFetchError).cause).toBe(cause);
  });
});

describe("createDukascopyClient — invariants", () => {
  it("for any aligned past UTC hour, the fetched URL ends in `<HH>h_ticks.bi5` and contains the upper-cased symbol", async () => {
    // All entries must be in the past — dukascopy-node's `generateUrls`
    // owns the holiday / availability calendar and produces zero URLs for
    // future hours. Validating future-hour rejection is not this test's
    // job; the ingest orchestrator (slice 5) is the right layer for that
    // policy.
    const baseHours = [
      Date.UTC(2010, 0, 1, 0, 0, 0, 0),
      Date.UTC(2024, 0, 15, 10, 0, 0, 0),
      Date.UTC(2024, 11, 31, 23, 0, 0, 0),
      Date.UTC(2025, 5, 30, 13, 0, 0, 0),
    ];

    for (const h of baseHours) {
      const fetchFake = makeFakeFetch({ body: new Uint8Array(0) });
      const client = createDukascopyClient({
        fetch: fetchFake.fn,
        decompress: makeFakeDecompress().fn,
      });
      await client.fetchHour({ symbol: EURUSD, hourStartMs: h });
      const url = fetchFake.calls[0]!;
      expect(url).toMatch(/\/\d{2}h_ticks\.bi5$/);
      expect(url).toContain("/EURUSD/");
    }
  });
});
