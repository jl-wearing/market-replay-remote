/**
 * Ingest orchestrator: walks a `(catalog symbol, half-open hour range)`,
 * fetches one UTC hour of bi5 bytes at a time via a `DukascopyClient`,
 * decodes them into ticks, aggregates into 1 s OHLCV bars, and hands the
 * bars to a `BarStore` for persistence.
 *
 * This is the first module in the project that *composes* I/O (the
 * Dukascopy client and the bar store) with pure logic (`decodeBi5Records`
 * and `ticksToSecondBars`). It owns no I/O of its own — both adapters
 * are injected — so it stays unit-testable with hand-rolled fakes.
 *
 * Failure policy in v1: stop on first error. No retry, no backoff, no
 * "skip this hour and continue". Each failure is wrapped in
 * `IngestError` with the originating phase tagged so callers can route
 * the error or surface it in a UI without having to do `instanceof`
 * walks across every adapter's error hierarchy. Resume / skip / retry
 * belong in later slices once we know whether they are real needs.
 *
 * Empty hours (the Dukascopy datafeed returns 0 bytes for weekends,
 * holidays, and gaps) are *not* errors. They write through to the store
 * as `bars: []` so a future resume path can tell "we checked, nothing
 * was here" apart from "we never checked this hour". Whether the store
 * materialises an empty-hour marker is the store's call.
 */

import type { Bar } from "../../shared/types.js";
import { decodeBi5Records } from "../../shared/dukascopy/bi5.js";
import { ticksToSecondBars } from "../../shared/bars/aggregate.js";
import { catalogToDukascopy } from "../../shared/dukascopy/symbolMap.js";
import type { DukascopyClient } from "./dukascopyClient.js";
import { dukascopyPriceScale } from "./priceScale.js";

const ONE_HOUR_MS = 3_600_000;

/**
 * Persistence sink for ingested bars.
 *
 * Keyed on the catalog symbol (e.g. `"EURUSD"`) — the user-facing form
 * — to keep query paths from having to round-trip through
 * `catalogToDukascopy`. Branded `CatalogSymbol` is deliberately *not*
 * introduced here; we will brand it the first time a second consumer of
 * a catalog-string parameter shows up (the renderer or the slice-6
 * DuckDB store), to avoid type ceremony without a real second caller.
 */
export interface BarStore {
  /**
   * Persist all bars for a single (symbol, UTC hour). `bars` is sorted
   * by `timestampMs` ascending, every entry's `timestampMs` lies in
   * `[hourMs, hourMs + 3_600_000)`, and `bars: []` is a valid call —
   * it means "we checked this hour and the datafeed had nothing", and
   * the store decides whether to record a marker.
   */
  writeHour(args: {
    symbol: string;
    hourMs: number;
    bars: readonly Bar[];
  }): Promise<void>;
}

/** Phase in the ingest loop where a failure surfaced. */
export type IngestPhase =
  | "spec"
  | "symbol"
  | "fetch"
  | "decode"
  | "aggregate"
  | "store";

/**
 * The single error class for `ingestSymbol`. `phase` identifies which
 * step in the loop failed; `hourMs` (when present) is the UTC hour the
 * loop was processing; `cause` is the originating error from the
 * adapter or pure layer (e.g. `DukascopyFetchError`, `InvalidBi5Error`,
 * `InvalidTickStreamError`, an `UnmappedSymbolError`, or the store's
 * own rejection).
 */
export class IngestError extends Error {
  override readonly cause?: unknown;
  /** Loop phase where the failure surfaced. */
  readonly phase: IngestPhase;
  /** UTC hour being processed at the time of failure (absent for `phase === "spec"` or `"symbol"`). */
  readonly hourMs?: number;

  constructor(
    message: string,
    options: { phase: IngestPhase; hourMs?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "IngestError";
    this.phase = options.phase;
    if (options.hourMs !== undefined) this.hourMs = options.hourMs;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** What `ingestSymbol` is asked to do. */
export interface IngestSpec {
  /** Catalog symbol, e.g. `"EURUSD"`. Resolved internally via `catalogToDukascopy`. */
  symbol: string;
  /** Inclusive lower bound of the hour range. Aligned to a UTC hour boundary. */
  fromHourMs: number;
  /** Exclusive upper bound. Aligned, strictly greater than `fromHourMs`. */
  toHourMs: number;
}

/** Summary returned on success. */
export interface IngestStats {
  /** Total hours walked (always `(toHourMs - fromHourMs) / 3_600_000`). */
  hoursFetched: number;
  /** Hours where the datafeed returned zero ticks. */
  hoursEmpty: number;
  /** Total ticks decoded across the whole range. */
  totalTicks: number;
  /** Total bars produced across the whole range. */
  totalBars: number;
}

/** Injected collaborators. */
export interface IngestDeps {
  /** Source of bi5 bytes. In production, `createDukascopyClient()`. */
  client: DukascopyClient;
  /** Sink for bars. Slice 6 lands the DuckDB-backed real implementation. */
  store: BarStore;
  /**
   * Optional progress hook fired *after* `store.writeHour` resolves for
   * each hour. Receives the just-written hour's UTC ms and the count of
   * bars persisted for that hour (0 for empty hours).
   */
  onHourComplete?: (hourMs: number, barCount: number) => void;
}

/**
 * Walk `[spec.fromHourMs, spec.toHourMs)` one UTC hour at a time,
 * fetching bi5 bytes via `deps.client`, decoding and aggregating them
 * via the pure pipeline in `src/shared/`, and writing the resulting
 * bars to `deps.store`.
 *
 * Sequential (no concurrent hour fetches in v1). Stops on first error.
 * See `IngestError` and module-level docstring for the full failure
 * contract; see `IngestSpec` for the input invariants.
 */
export async function ingestSymbol(
  spec: IngestSpec,
  deps: IngestDeps,
): Promise<IngestStats> {
  validateSpec(spec);

  let dukaSymbol;
  let priceScale;
  try {
    dukaSymbol = catalogToDukascopy(spec.symbol);
    priceScale = dukascopyPriceScale(dukaSymbol);
  } catch (err) {
    throw new IngestError(
      `unknown or unsupported catalog symbol: ${JSON.stringify(spec.symbol)}`,
      { phase: "symbol", cause: err },
    );
  }

  let hoursFetched = 0;
  let hoursEmpty = 0;
  let totalTicks = 0;
  let totalBars = 0;

  for (let h = spec.fromHourMs; h < spec.toHourMs; h += ONE_HOUR_MS) {
    let bytes: Uint8Array;
    try {
      bytes = await deps.client.fetchHour({
        symbol: dukaSymbol,
        hourStartMs: h,
      });
    } catch (err) {
      throw new IngestError(
        `client.fetchHour failed for hour ${h}`,
        { phase: "fetch", hourMs: h, cause: err },
      );
    }

    let ticks;
    try {
      ticks = decodeBi5Records(bytes, h, priceScale);
    } catch (err) {
      throw new IngestError(`decodeBi5Records failed for hour ${h}`, {
        phase: "decode",
        hourMs: h,
        cause: err,
      });
    }

    let bars;
    try {
      bars = ticksToSecondBars(ticks);
    } catch (err) {
      throw new IngestError(`ticksToSecondBars failed for hour ${h}`, {
        phase: "aggregate",
        hourMs: h,
        cause: err,
      });
    }

    hoursFetched += 1;
    if (ticks.length === 0) hoursEmpty += 1;
    totalTicks += ticks.length;
    totalBars += bars.length;

    try {
      await deps.store.writeHour({
        symbol: spec.symbol,
        hourMs: h,
        bars,
      });
    } catch (err) {
      throw new IngestError(
        `store.writeHour failed for hour ${h}`,
        { phase: "store", hourMs: h, cause: err },
      );
    }

    deps.onHourComplete?.(h, bars.length);
  }

  return { hoursFetched, hoursEmpty, totalTicks, totalBars };
}

function validateSpec(spec: IngestSpec): void {
  validateHourBound("fromHourMs", spec.fromHourMs);
  validateHourBound("toHourMs", spec.toHourMs);
  if (spec.fromHourMs >= spec.toHourMs) {
    throw new IngestError(
      `fromHourMs (${spec.fromHourMs}) must be strictly less than toHourMs ` +
        `(${spec.toHourMs}); empty and reversed ranges are not permitted`,
      { phase: "spec" },
    );
  }
}

function validateHourBound(name: "fromHourMs" | "toHourMs", value: number): void {
  if (!Number.isFinite(value)) {
    throw new IngestError(`${name} must be finite, got ${value}`, {
      phase: "spec",
    });
  }
  if (!Number.isInteger(value)) {
    throw new IngestError(`${name} must be an integer, got ${value}`, {
      phase: "spec",
    });
  }
  if (value < 0) {
    throw new IngestError(`${name} must be >= 0, got ${value}`, {
      phase: "spec",
    });
  }
  if (value % ONE_HOUR_MS !== 0) {
    throw new IngestError(
      `${name} must be aligned to a UTC hour boundary ` +
        `(multiple of ${ONE_HOUR_MS}), got ${value}`,
      { phase: "spec" },
    );
  }
}
