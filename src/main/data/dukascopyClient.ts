/**
 * Dukascopy fetcher adapter.
 *
 * The first I/O-bound module in the project. Wraps `dukascopy-node` (for
 * URL generation) plus native `fetch` (Node ≥ 22) and a pure-JS LZMA
 * decompressor so the rest of the app can ask one question — "give me one
 * UTC hour of raw bi5 bytes for this Dukascopy symbol" — without knowing
 * anything about HTTP, the Dukascopy datafeed URL layout, or LZMA.
 *
 * The seam between this module and its consumers is the `DukascopyClient`
 * interface; the ingest orchestrator (M2 slice 5) takes a `DukascopyClient`
 * by argument and unit-tests itself against a hand-rolled fake. The real
 * client (network + library) is exercised in `dukascopyClient.network.test.ts`,
 * which is opt-in (gated by `HINDSIGHT_RUN_NETWORK=1`) so `npm test` stays
 * deterministic and offline.
 *
 * The factory accepts optional `fetch` and `decompress` overrides so the
 * unit tests in this directory can drive the wiring (URL composition,
 * status-code handling, error wrapping) without hitting the network — the
 * library layer between us and the network is `generateUrls` (a pure
 * string function), so there is no third-party HTTP layer to mock under;
 * we mock our own direct dependencies on `fetch` and `lzma.decompress`.
 */

import { decompress as lzmaDecompress } from "lzma";
import {
  Price,
  Timeframe,
  generateUrls,
  type InstrumentType,
} from "dukascopy-node";

import type { DukascopySymbol } from "../../shared/dukascopy/symbolMap.js";

const ONE_HOUR_MS = 3_600_000;

/**
 * Synchronous LZMA decompression contract used by `createDukascopyClient`.
 * Takes a Dukascopy `.bi5` LZMA1-compressed payload and returns the raw
 * decoded byte stream (whose length, on a healthy hour, is a multiple of
 * 20 — the bi5 record size).
 */
export type LzmaDecompressFn = (compressed: Uint8Array) => Uint8Array;

/**
 * Single-hour fetch request: a branded Dukascopy symbol (only producible by
 * `catalogToDukascopy`) and an absolute UTC epoch ms aligned to the top of
 * an hour.
 */
export interface FetchHourArgs {
  /** Dukascopy instrument identifier, branded by the catalog→Dukascopy map. */
  symbol: DukascopySymbol;
  /**
   * Epoch ms at the top of the UTC hour to fetch. Must be a finite,
   * non-negative integer divisible by 3 600 000.
   */
  hourStartMs: number;
}

/**
 * Adapter exposed to the rest of the app. Produced by `createDukascopyClient`
 * (real impl) or by hand-rolled fakes in upstream tests.
 */
export interface DukascopyClient {
  /**
   * Resolve to the LZMA-decompressed `.bi5` payload for the requested hour.
   * Empty hours (404 from the datafeed, or 200 with a zero-byte body)
   * resolve to a length-0 `Uint8Array` — they are not an error.
   *
   * Failure modes — every one throws `DukascopyFetchError`:
   * - Invalid `args` (per `FetchHourArgs` constraints).
   * - Network failure (DNS, connection reset, etc.) — original error in `cause`.
   * - HTTP status other than 200 or 404.
   * - LZMA decompression failure — original error in `cause`.
   */
  fetchHour(args: FetchHourArgs): Promise<Uint8Array>;
}

/**
 * Optional knobs for `createDukascopyClient`. In production both fields
 * are undefined and the client uses Node's native `fetch` and the real
 * `lzma` decompressor; tests inject fakes for both to exercise the real
 * client's wiring without touching the network.
 */
export interface CreateDukascopyClientOpts {
  /** Override for `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Override for the default LZMA decompressor. */
  decompress?: LzmaDecompressFn;
}

/**
 * Thrown by the real `DukascopyClient` for every input-validation, network,
 * HTTP-status, or decompression failure. The `cause` property holds the
 * underlying error (e.g. the original `fetch` rejection) when one exists.
 */
export class DukascopyFetchError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "DukascopyFetchError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Construct a real `DukascopyClient` backed by `dukascopy-node` (URL
 * scheme), Node's native `fetch`, and the pure-JS `lzma` decompressor.
 *
 * Pass `opts.fetch` / `opts.decompress` to inject test fakes; the
 * production call site uses no opts.
 */
export function createDukascopyClient(
  opts: CreateDukascopyClientOpts = {},
): DukascopyClient {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const decompress = opts.decompress ?? defaultLzmaDecompress;

  return {
    async fetchHour(args: FetchHourArgs): Promise<Uint8Array> {
      validateFetchHourArgs(args);

      const url = buildHourUrl(args);

      let response: Response;
      try {
        response = await fetchFn(url);
      } catch (err) {
        throw new DukascopyFetchError(
          `network error fetching ${url}: ${describeError(err)}`,
          { cause: err },
        );
      }

      if (response.status === 404) {
        return new Uint8Array(0);
      }
      if (response.status !== 200) {
        throw new DukascopyFetchError(
          `unexpected HTTP ${response.status} fetching ${url}`,
        );
      }

      const compressed = new Uint8Array(await response.arrayBuffer());
      if (compressed.length === 0) {
        return new Uint8Array(0);
      }

      try {
        return decompress(compressed);
      } catch (err) {
        throw new DukascopyFetchError(
          `LZMA decompression failed for ${url}: ${describeError(err)}`,
          { cause: err },
        );
      }
    },
  };
}

function validateFetchHourArgs(args: FetchHourArgs): void {
  if (typeof args.symbol !== "string" || args.symbol.length === 0) {
    throw new DukascopyFetchError(
      `symbol must be a non-empty DukascopySymbol, got ${JSON.stringify(args.symbol)}`,
    );
  }
  const t = args.hourStartMs;
  if (!Number.isFinite(t)) {
    throw new DukascopyFetchError(
      `hourStartMs must be a finite number, got ${t}`,
    );
  }
  if (!Number.isInteger(t)) {
    throw new DukascopyFetchError(
      `hourStartMs must be an integer, got ${t}`,
    );
  }
  if (t < 0) {
    throw new DukascopyFetchError(
      `hourStartMs must be >= 0, got ${t}`,
    );
  }
  if (t % ONE_HOUR_MS !== 0) {
    throw new DukascopyFetchError(
      `hourStartMs must be aligned to a UTC hour boundary ` +
        `(multiple of ${ONE_HOUR_MS}), got ${t}`,
    );
  }
}

function buildHourUrl(args: FetchHourArgs): string {
  // `generateUrls` derives the Dukascopy URL from a half-open date range.
  // For a single hour the boundary handling pushes us into a 2-URL result
  // unless `endDate - startDate > 3 600 000`, so we add 1 ms to the end
  // bound to land in the single-URL branch. The length assertion below is
  // a tripwire if dukascopy-node ever changes that arithmetic.
  const startDate = new Date(args.hourStartMs);
  const endDate = new Date(args.hourStartMs + ONE_HOUR_MS + 1);

  // The brand `DukascopySymbol` is a phantom on top of `string`; the value
  // came out of `catalogToDukascopy` and is a known Dukascopy identifier,
  // so widening it to the library's `InstrumentType` enum-key union is a
  // safe, documentation-only cast.
  const urls = generateUrls({
    instrument: args.symbol as unknown as InstrumentType,
    timeframe: Timeframe.tick,
    priceType: Price.bid,
    startDate,
    endDate,
  });

  if (urls.length !== 1) {
    throw new DukascopyFetchError(
      `expected exactly 1 URL from dukascopy-node for one hour, ` +
        `got ${urls.length} (hourStartMs=${args.hourStartMs})`,
    );
  }
  return urls[0]!;
}

function defaultLzmaDecompress(compressed: Uint8Array): Uint8Array {
  // The real `lzma.decompress` violates its own `@types/lzma` signature:
  // - On binary payloads it returns a plain `Array<number>` of signed
  //   bytes (−128..127), not a `Uint8Array`. Two's-complement values
  //   round-trip correctly through `Uint8Array.from` because
  //   typed-array stores narrow to mod-256 on assignment (e.g. −27 → 229).
  // - It returns a `string` if and only if the decompressed payload is
  //   valid UTF-8. Dukascopy bi5 binary is never valid UTF-8 in practice,
  //   but we handle it defensively; UTF-8 encode/decode round-trips
  //   exactly for any valid UTF-8 string.
  const result = lzmaDecompress(compressed) as
    | Uint8Array
    | ArrayLike<number>
    | string;
  if (typeof result === "string") {
    return new TextEncoder().encode(result);
  }
  if (result instanceof Uint8Array) {
    return result;
  }
  return Uint8Array.from(result);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
