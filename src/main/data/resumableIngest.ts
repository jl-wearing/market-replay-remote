/**
 * Resumable, fault-tolerant ingest runner.
 *
 * `ingestSymbol` (the slice-5 orchestrator) is intentionally strict: it walks
 * a half-open hour range and stops on the first error. That is the right
 * default for a short, attended run, but it is the wrong shape for the M2
 * full-year acceptance pass — one corrupt hour out of 8 760 aborts the whole
 * backfill, and re-running starts again from hour 0.
 *
 * This module wraps `ingestSymbol` one UTC hour at a time to add the two
 * behaviours a long backfill needs, without duplicating any of the
 * fetch / decode / aggregate / write / error-wrapping logic:
 *
 * 1. **Continue-on-error.** A failing hour is captured in `failures` (with
 *    the originating `IngestError`'s phase + cause) and the walk continues to
 *    the next hour, rather than throwing. Callers inspect `failures` /
 *    `hoursFailed` afterwards and decide whether to re-run the gaps.
 * 2. **Skip-existing (resume).** An optional injected `hasHour(hourMs)`
 *    predicate is consulted before each hour; when it returns `true` the hour
 *    is skipped entirely (no fetch, no write). Production wires this to the
 *    DuckDB store's `readBarsInRange`, so a re-run only fetches the hours that
 *    are not yet persisted. Hours that legitimately hold zero bars (weekends,
 *    holidays) are not distinguishable from "never ingested" by a bar-count
 *    check, so they are re-fetched on resume — harmless, since the datafeed
 *    answers an empty hour with a cheap 404.
 *
 * The seam stays at `ingestSymbol`: this runner reuses its branded-symbol
 * resolution, price-scale threading, and `IngestError` phases verbatim. Bad
 * *spec* input throws `IngestError({ phase: "spec" })` — the same contract as
 * `ingestSymbol`, so callers route bad ranges identically. Per-hour runtime
 * failures never throw; they only populate `failures`.
 */

import { ingestSymbol, IngestError } from "./ingest.js";
import type { BarStore, IngestPhase } from "./ingest.js";
import type { CatalogSymbol } from "../../shared/instruments.js";
import type { DukascopyClient } from "./dukascopyClient.js";

const ONE_HOUR_MS = 3_600_000;

/**
 * Phase tag carried by a recorded per-hour failure. It is `ingestSymbol`'s
 * own `IngestPhase` for any failure it raised (the normal case), plus
 * `"unknown"` as a defensive fallback for the by-contract-impossible case
 * where a non-`IngestError` escapes the orchestrator.
 */
export type FailurePhase = IngestPhase | "unknown";

/**
 * A single hour that could not be ingested. Collected rather than thrown so a
 * long backfill can finish the hours that *do* work and report the gaps.
 */
export interface HourFailure {
  /** UTC hour (epoch ms, aligned) that failed. */
  readonly hourMs: number;
  /** Originating `IngestError` phase, or `"unknown"` for a non-`IngestError`. */
  readonly phase: FailurePhase;
  /** Human-readable message from the originating error. */
  readonly message: string;
  /** The originating error, preserved for `instanceof` / `cause` inspection. */
  readonly cause: unknown;
}

/** Summary returned by `resumableIngestSymbol`. */
export interface ResumableIngestStats {
  /** Total hours in `[fromHourMs, toHourMs)` — always `(to - from) / 3_600_000`. */
  hoursTotal: number;
  /** Hours fetched + written successfully this run (includes empty hours). */
  hoursIngested: number;
  /** Hours skipped because `hasHour` reported them already present. */
  hoursSkipped: number;
  /** Subset of `hoursIngested` whose datafeed returned zero ticks. */
  hoursEmpty: number;
  /** Hours that errored and were recorded in `failures`. */
  hoursFailed: number;
  /** Total ticks decoded across the ingested (non-skipped, non-failed) hours. */
  totalTicks: number;
  /** Total bars written across the ingested hours. */
  totalBars: number;
  /** One entry per failed hour, in ascending hour order. */
  failures: HourFailure[];
}

/** What `resumableIngestSymbol` is asked to do (mirrors `IngestSpec`). */
export interface ResumableIngestSpec {
  /** Catalog symbol, validated by `toCatalogSymbol`. */
  symbol: CatalogSymbol;
  /** Inclusive lower bound, aligned to a UTC hour boundary. */
  fromHourMs: number;
  /** Exclusive upper bound, aligned, strictly greater than `fromHourMs`. */
  toHourMs: number;
}

/** Injected collaborators for `resumableIngestSymbol`. */
export interface ResumableIngestDeps {
  /** Source of bi5 bytes. In production, `createDukascopyClient()`. */
  client: DukascopyClient;
  /** Sink for bars. In production, the DuckDB-backed store. */
  store: BarStore;
  /**
   * Optional resume predicate. Returns `true` if the given UTC hour is
   * already persisted and should be skipped. Omit it to ingest every hour.
   */
  hasHour?: (hourMs: number) => Promise<boolean>;
  /** Fired after each successfully ingested hour with `(hourMs, barCount)`. */
  onHourComplete?: (hourMs: number, barCount: number) => void;
  /** Fired after each failed hour, with the recorded failure. */
  onHourFailed?: (failure: HourFailure) => void;
  /** Fired after each skipped hour, with its UTC ms. */
  onHourSkipped?: (hourMs: number) => void;
}

/**
 * Walk `[spec.fromHourMs, spec.toHourMs)` one UTC hour at a time, ingesting
 * each hour via `ingestSymbol`, skipping hours `deps.hasHour` reports present,
 * and collecting (not throwing) per-hour failures.
 *
 * Throws `IngestError({ phase: "spec" })` for an invalid range (same rules and
 * error type as `ingestSymbol`). Otherwise always resolves, with the outcome
 * of every hour reflected in the returned stats.
 */
export async function resumableIngestSymbol(
  spec: ResumableIngestSpec,
  deps: ResumableIngestDeps,
): Promise<ResumableIngestStats> {
  validateRange(spec.fromHourMs, spec.toHourMs);

  const stats: ResumableIngestStats = {
    hoursTotal: (spec.toHourMs - spec.fromHourMs) / ONE_HOUR_MS,
    hoursIngested: 0,
    hoursSkipped: 0,
    hoursEmpty: 0,
    hoursFailed: 0,
    totalTicks: 0,
    totalBars: 0,
    failures: [],
  };

  for (let h = spec.fromHourMs; h < spec.toHourMs; h += ONE_HOUR_MS) {
    if (deps.hasHour !== undefined && (await deps.hasHour(h))) {
      stats.hoursSkipped += 1;
      deps.onHourSkipped?.(h);
      continue;
    }

    try {
      // One-hour range: `ingestSymbol` does the fetch/decode/aggregate/write
      // and fires `onHourComplete` for the single hour. Its stats describe
      // exactly that hour, so accumulation is a straight sum.
      const hourStats = await ingestSymbol(
        { symbol: spec.symbol, fromHourMs: h, toHourMs: h + ONE_HOUR_MS },
        forwardDeps(deps),
      );
      stats.hoursIngested += 1;
      stats.hoursEmpty += hourStats.hoursEmpty;
      stats.totalTicks += hourStats.totalTicks;
      stats.totalBars += hourStats.totalBars;
    } catch (err) {
      const failure = toHourFailure(h, err);
      stats.failures.push(failure);
      stats.hoursFailed += 1;
      deps.onHourFailed?.(failure);
    }
  }

  return stats;
}

/** Build the `ingestSymbol` deps, forwarding `onHourComplete` only when set. */
function forwardDeps(
  deps: ResumableIngestDeps,
): Parameters<typeof ingestSymbol>[1] {
  const out: Parameters<typeof ingestSymbol>[1] = {
    client: deps.client,
    store: deps.store,
  };
  if (deps.onHourComplete !== undefined) {
    out.onHourComplete = deps.onHourComplete;
  }
  return out;
}

function toHourFailure(hourMs: number, err: unknown): HourFailure {
  if (err instanceof IngestError) {
    return { hourMs, phase: err.phase, message: err.message, cause: err.cause ?? err };
  }
  // By `ingestSymbol`'s contract this is unreachable — it wraps everything in
  // `IngestError`. Recorded defensively so a future regression surfaces in the
  // failure list instead of crashing the whole backfill.
  return {
    hourMs,
    phase: "unknown",
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  };
}

/**
 * Validate the overall hour range up front. Mirrors `ingestSymbol`'s spec
 * rules and reuses its `IngestError({ phase: "spec" })` so a bad range is a
 * throw with the same type and shape, rather than a silently-empty success.
 * (The per-hour `ingestSymbol` calls also validate, but an out-of-range or
 * reversed `from`/`to` would otherwise skip the loop body entirely and return
 * zero stats — hence the explicit up-front check.)
 */
function validateRange(fromHourMs: number, toHourMs: number): void {
  validateHourBound("fromHourMs", fromHourMs);
  validateHourBound("toHourMs", toHourMs);
  if (fromHourMs >= toHourMs) {
    throw new IngestError(
      `fromHourMs (${fromHourMs}) must be strictly less than toHourMs ` +
        `(${toHourMs}); empty and reversed ranges are not permitted`,
      { phase: "spec" },
    );
  }
}

function validateHourBound(name: "fromHourMs" | "toHourMs", value: number): void {
  if (!Number.isFinite(value)) {
    throw new IngestError(`${name} must be finite, got ${value}`, { phase: "spec" });
  }
  if (!Number.isInteger(value)) {
    throw new IngestError(`${name} must be an integer, got ${value}`, { phase: "spec" });
  }
  if (value < 0) {
    throw new IngestError(`${name} must be >= 0, got ${value}`, { phase: "spec" });
  }
  if (value % ONE_HOUR_MS !== 0) {
    throw new IngestError(
      `${name} must be aligned to a UTC hour boundary ` +
        `(multiple of ${ONE_HOUR_MS}), got ${value}`,
      { phase: "spec" },
    );
  }
}
