/**
 * Resumable one-day ingest runner.
 *
 * The day-level sibling of `ingestSymbolDay` (slice 7). It owns the same
 * lifecycle — validate `dayUtc` and `symbol`, open the store, run, close in
 * `finally` — and reuses that runner's `parseDayUtc` / `parseSymbol`
 * helpers and its `IngestRunError` / `IngestRunPhase` contract verbatim, so
 * the date / symbol / open / close failure semantics are identical.
 *
 * What differs is the body: instead of the strict, stop-on-first-error
 * `ingestSymbol`, it composes `resumableIngestSymbol`, which
 *
 * 1. **continues on a per-hour error** (collected in `stats.failures`
 *    rather than thrown), so one corrupt hour does not abort a multi-hour
 *    backfill, and
 * 2. **skips hours already persisted**, via the `hasHour` predicate. This
 *    runner wires `hasHour` to the opened store's `readBarsInRange`: an hour
 *    counts as present when it holds at least one bar.
 *
 * Because per-hour failures are collected, the only ways a run *throws* are
 * the lifecycle phases shared with the strict runner: a bad `dayUtc`
 * (`phase: "date"`), a bad `symbol` (`phase: "symbol"`), an `openStore`
 * failure (`phase: "open"`), a fatal store-read inside `hasHour` or a spec
 * error from `resumableIngestSymbol` (`phase: "ingest"`, store still
 * closed), or a post-success `close` failure (`phase: "close"`). A run that
 * merely has failed *hours* resolves normally — the caller inspects
 * `stats.hoursFailed` / `stats.failures` and decides whether to re-run.
 */

import type { DukascopyClient } from "../data/dukascopyClient.js";
import type { DuckDbBarStore } from "../data/duckDbBarStore.js";
import {
  resumableIngestSymbol,
  type HourFailure,
  type ResumableIngestStats,
} from "../data/resumableIngest.js";
import {
  IngestRunError,
  parseDayUtc,
  parseSymbol,
  type OpenDuckDbBarStore,
} from "./ingestDay.js";

const ONE_HOUR_MS = 3_600_000;

/** What `resumableIngestSymbolDay` is asked to do (mirrors `IngestDaySpec`). */
export interface ResumableIngestDaySpec {
  /** Catalog symbol, e.g. `"EURUSD"`. Validated through `toCatalogSymbol`. */
  symbol: string;
  /** UTC calendar day to ingest, strict `YYYY-MM-DD`. */
  dayUtc: string;
  /** Filesystem root for the DuckDB hot store; forwarded to `openStore`. */
  root: string;
}

/** Injected collaborators for `resumableIngestSymbolDay`. */
export interface ResumableIngestDayDeps {
  /** Source of bi5 bytes. In production, `createDukascopyClient()`. */
  client: DukascopyClient;
  /** Store factory; the runner owns the open → close lifecycle. */
  openStore: OpenDuckDbBarStore;
  /** Fired after each successfully ingested (non-skipped) hour. */
  onHourComplete?: (hourMs: number, barCount: number) => void;
  /** Fired after each hour skipped because the store already held it. */
  onHourSkipped?: (hourMs: number) => void;
  /** Fired after each hour that errored and was recorded in `failures`. */
  onHourFailed?: (failure: HourFailure) => void;
}

/**
 * Ingest the 24 UTC hours of `spec.dayUtc` for `spec.symbol` into the DuckDB
 * store opened from `spec.root`, skipping hours already present and
 * collecting (not throwing) per-hour failures. Returns
 * `resumableIngestSymbol`'s stats unchanged.
 *
 * See the module docstring for the per-phase throw contract.
 */
export async function resumableIngestSymbolDay(
  spec: ResumableIngestDaySpec,
  deps: ResumableIngestDayDeps,
): Promise<ResumableIngestStats> {
  const { fromHourMs, toHourMs } = parseDayUtc(spec.dayUtc);
  const symbol = parseSymbol(spec.symbol);

  let store: DuckDbBarStore;
  try {
    store = await deps.openStore(spec.root);
  } catch (err) {
    throw new IngestRunError(
      `failed to open bar store at ${JSON.stringify(spec.root)}`,
      { phase: "open", cause: err },
    );
  }

  let stats: ResumableIngestStats;
  let ingestFailure: unknown = null;
  try {
    try {
      const ingestDeps: Parameters<typeof resumableIngestSymbol>[1] = {
        client: deps.client,
        store,
        // An hour is "already ingested" when the store has ≥1 bar for it.
        // Empty hours (weekends/holidays) read back as zero bars, so they
        // are re-fetched on resume — harmless, the datafeed answers an
        // empty hour cheaply (see resumableIngest.ts).
        hasHour: async (hourMs: number) => {
          const bars = await store.readBarsInRange({
            symbol,
            fromMs: hourMs,
            toMs: hourMs + ONE_HOUR_MS,
          });
          return bars.length > 0;
        },
      };
      if (deps.onHourComplete !== undefined) {
        ingestDeps.onHourComplete = deps.onHourComplete;
      }
      if (deps.onHourSkipped !== undefined) {
        ingestDeps.onHourSkipped = deps.onHourSkipped;
      }
      if (deps.onHourFailed !== undefined) {
        ingestDeps.onHourFailed = deps.onHourFailed;
      }
      stats = await resumableIngestSymbol(
        { symbol, fromHourMs, toHourMs },
        ingestDeps,
      );
    } catch (err) {
      ingestFailure = err;
      throw new IngestRunError(
        `resumableIngestSymbol failed for ${spec.symbol} on ${spec.dayUtc}`,
        { phase: "ingest", cause: err },
      );
    }
  } finally {
    try {
      await store.close();
    } catch (closeErr) {
      // Same lifecycle contract as ingestSymbolDay: if the run already
      // failed, that error is the more useful signal and the close failure
      // is dropped; if the run succeeded, surface the close failure as its
      // own phase so the user knows the DuckDB file may be in a bad state.
      if (ingestFailure === null) {
        throw new IngestRunError(
          `store.close() failed after a successful resumable ingest of ${spec.symbol} on ${spec.dayUtc}`,
          { phase: "close", cause: closeErr },
        );
      }
    }
  }

  return stats;
}
