/**
 * One-day ingest runner — slice 7 of M2.
 *
 * Composes `createDukascopyClient()` (slice 4b) + `createDuckDbBarStore()`
 * (slice 6) + `ingestSymbol` (slice 5) into a single call:
 *
 *     ingestSymbolDay(
 *       { symbol: "EURUSD", dayUtc: "2024-01-15", root: "C:/data" },
 *       { client, openStore },
 *     )
 *
 * Walks the 24 UTC hours of the requested calendar day. The store factory
 * (not a pre-built store) is injected so this module owns the store
 * lifecycle symmetrically — open → ingest → close. A future CLI bin shim
 * passes `createDuckDbBarStore` here directly; tests pass an in-memory
 * fake. Either way `close()` runs in `finally` whenever `openStore`
 * succeeded, including when ingest itself throws.
 *
 * Failure surface is the single `IngestRunError` class with a `phase`
 * tag (`date | symbol | open | ingest | close`). The originating error
 * (date-parse, `UnknownInstrumentError`, store-factory failure,
 * `IngestError`, store-close failure) is preserved as `cause` so callers
 * can introspect without `instanceof`-walking every adapter's hierarchy.
 *
 * Non-goals for this slice: no CLI argv parsing, no progress bar, no
 * retry/resume, no multi-day. Those layer above this runner.
 */

import { toCatalogSymbol } from "../../shared/instruments.js";
import type { CatalogSymbol } from "../../shared/instruments.js";
import type { DukascopyClient } from "../data/dukascopyClient.js";
import type { IngestStats } from "../data/ingest.js";
import { ingestSymbol } from "../data/ingest.js";
import type { DuckDbBarStore } from "../data/duckDbBarStore.js";

const ONE_DAY_MS = 24 * 3_600_000;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Phase of `ingestSymbolDay` where a failure surfaced:
 *
 * - `"date"`   — `dayUtc` failed strict `YYYY-MM-DD` parsing or fell
 *                outside `[1970, 9999]` (date-string layer).
 * - `"symbol"` — `toCatalogSymbol` rejected `symbol` (unknown / wrong
 *                case / non-string).
 * - `"open"`   — `openStore(root)` threw before any ingest started; no
 *                close happens because there is nothing to close.
 * - `"ingest"` — `ingestSymbol` threw mid-walk. The store IS closed in
 *                `finally`; if that close itself throws, the original
 *                ingest error wins (close failure is suppressed).
 * - `"close"`  — `close()` threw after a successful ingest.
 */
export type IngestRunPhase = "date" | "symbol" | "open" | "ingest" | "close";

/**
 * Single error class for `ingestSymbolDay`. `phase` identifies which
 * step of the runner failed; `cause` is the originating error from the
 * underlying layer. Mirrors the `phase`-tagged shape of `IngestError`
 * and `BarStoreError` so a caller can route on `phase` alone without
 * knowing the inner adapter hierarchy.
 */
export class IngestRunError extends Error {
  override readonly cause?: unknown;
  /** Where in the runner the failure surfaced. */
  readonly phase: IngestRunPhase;

  constructor(
    message: string,
    options: { phase: IngestRunPhase; cause?: unknown },
  ) {
    super(message);
    this.name = "IngestRunError";
    this.phase = options.phase;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** What `ingestSymbolDay` is asked to do. */
export interface IngestDaySpec {
  /** Catalog symbol, e.g. `"EURUSD"`. Validated through `toCatalogSymbol`. */
  symbol: string;
  /**
   * UTC calendar day to ingest, in strict `YYYY-MM-DD` form. Must round-trip
   * through `Date.UTC(y, m-1, d)` to itself (rejects Feb 30, month 13, etc.)
   * and must fall inside `[1970, 9999]`.
   */
  dayUtc: string;
  /**
   * Filesystem root for the DuckDB hot store. Forwarded verbatim to
   * `openStore`; the runner does not validate it. The real
   * `createDuckDbBarStore` performs its own non-empty / writability checks
   * and surfaces failures here as `phase: "open"`.
   */
  root: string;
}

/**
 * Factory that opens (or creates) a DuckDB-backed bar store rooted at
 * `root`. In production this is `createDuckDbBarStore`; tests pass an
 * in-memory fake. Errors thrown here surface as
 * `IngestRunError({ phase: "open" })`.
 */
export type OpenDuckDbBarStore = (root: string) => Promise<DuckDbBarStore>;

/** Injected collaborators. */
export interface IngestDayDeps {
  /** Source of bi5 bytes. In production, `createDukascopyClient()`. */
  client: DukascopyClient;
  /** Store factory; the runner owns the open → close lifecycle. */
  openStore: OpenDuckDbBarStore;
  /**
   * Optional progress hook forwarded to `ingestSymbol`, fired after each
   * hour's `writeHour` resolves. Receives the just-written hour's UTC
   * ms and the bar count for that hour (0 for empty hours).
   */
  onHourComplete?: (hourMs: number, barCount: number) => void;
}

/**
 * Ingest the 24 UTC hours of `spec.dayUtc` for `spec.symbol` into the
 * DuckDB store opened from `spec.root`. Returns `ingestSymbol`'s stats
 * unchanged on success.
 *
 * Lifecycle: validates `dayUtc` and `symbol` first (no I/O on rejection);
 * then `openStore`; then `ingestSymbol` over `[startOfDayUtc,
 * startOfNextDayUtc)`; then `close()`. The store is closed in `finally`
 * whenever `openStore` succeeded, regardless of whether ingest threw.
 *
 * See `IngestRunPhase` for the per-phase failure semantics.
 */
export async function ingestSymbolDay(
  spec: IngestDaySpec,
  deps: IngestDayDeps,
): Promise<IngestStats> {
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

  let stats: IngestStats;
  let ingestFailure: unknown = null;
  try {
    try {
      const ingestDeps: Parameters<typeof ingestSymbol>[1] = {
        client: deps.client,
        store,
      };
      if (deps.onHourComplete !== undefined) {
        ingestDeps.onHourComplete = deps.onHourComplete;
      }
      stats = await ingestSymbol(
        { symbol, fromHourMs, toHourMs },
        ingestDeps,
      );
    } catch (err) {
      ingestFailure = err;
      throw new IngestRunError(
        `ingestSymbol failed for ${spec.symbol} on ${spec.dayUtc}`,
        { phase: "ingest", cause: err },
      );
    }
  } finally {
    try {
      await store.close();
    } catch (closeErr) {
      // If ingest already failed, the ingest error is the more useful
      // signal; the close failure is a downstream consequence we drop.
      // If ingest succeeded, surface the close failure as its own phase.
      if (ingestFailure === null) {
        // Throwing from `finally` is the documented contract here: when
        // ingest succeeded, a close failure is the user's only signal
        // that the DuckDB file may be in a bad state.
        throw new IngestRunError(
          `store.close() failed after a successful ingest of ${spec.symbol} on ${spec.dayUtc}`,
          { phase: "close", cause: closeErr },
        );
      }
    }
  }

  return stats;
}

interface ParsedDay {
  fromHourMs: number;
  toHourMs: number;
}

function parseDayUtc(dayUtc: unknown): ParsedDay {
  if (typeof dayUtc !== "string") {
    throw new IngestRunError(
      `dayUtc must be a YYYY-MM-DD string, got ${JSON.stringify(dayUtc)}`,
      { phase: "date" },
    );
  }
  const m = DATE_RE.exec(dayUtc);
  if (m === null) {
    throw new IngestRunError(
      `dayUtc must match /^\\d{4}-\\d{2}-\\d{2}$/, got ${JSON.stringify(dayUtc)}`,
      { phase: "date" },
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new IngestRunError(
      `dayUtc year must be in [${MIN_YEAR}, ${MAX_YEAR}], got ${year}`,
      { phase: "date" },
    );
  }
  // UTC round-trip catches calendar-impossible inputs (Feb 30, month 13,
  // day 0). `Date.UTC` silently rolls those over (Feb 30 → Mar 2), so we
  // re-extract the components and demand byte-for-byte equality.
  const fromHourMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const back = new Date(fromHourMs);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new IngestRunError(
      `dayUtc ${JSON.stringify(dayUtc)} is not a valid calendar date`,
      { phase: "date" },
    );
  }
  return { fromHourMs, toHourMs: fromHourMs + ONE_DAY_MS };
}

function parseSymbol(symbol: unknown): CatalogSymbol {
  try {
    // Cast to `string` only at the typed boundary; `toCatalogSymbol`
    // re-checks `typeof === "string"` itself.
    return toCatalogSymbol(symbol as string);
  } catch (err) {
    throw new IngestRunError(
      `unknown or unsupported catalog symbol: ${JSON.stringify(symbol)}`,
      { phase: "symbol", cause: err },
    );
  }
}
