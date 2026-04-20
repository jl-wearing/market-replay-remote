/**
 * DuckDB-backed `BarStore` implementation (M2 slice 6).
 *
 * ## Physical layout — architectural decision
 *
 * The canonical long-term layout described in `ARCHITECTURE.md` is
 * per-(symbol, year) Parquet (`<root>/bars/1s/<SYMBOL>_<YYYY>.parquet`).
 * In practice that shape is the wrong *hot* store: `writeHour` arrives
 * one UTC hour at a time, Parquet files are immutable, and "append one
 * hour to the year file" means rewrite-the-whole-year-file, which goes
 * quadratic over a full year ingest (8760 hours × up-to-megabytes of
 * compressed Parquet rewrite each).
 *
 * This slice therefore splits the data layout in two:
 *
 * - **Hot store (this module).** A single DuckDB database file at
 *   `<root>/bars/1s.duckdb` with one `bars_1s` table keyed on
 *   `(symbol, timestamp_ms)`. `writeHour` runs an idempotent
 *   DELETE-then-INSERT in a transaction; `readBarsInRange` does a
 *   straightforward `WHERE symbol = ? AND timestamp_ms BETWEEN …`.
 *   Durable after each `writeHour`, O(1) per-hour writes, and M3 replay
 *   (cursor-clipped range queries) can read directly from here.
 *
 * - **Archival / export (future slice).** Producing the canonical
 *   `<SYMBOL>_<YYYY>.parquet` files from the DuckDB store, once per
 *   completed year or on demand. `src/shared/storage/paths.ts` still
 *   owns the target paths for that export; this module never writes to
 *   them.
 *
 * The DuckDB hot store and the Parquet export together are what
 * `ARCHITECTURE.md` "DuckDB + Parquet files" really means. Before the
 * export slice exists, the DuckDB file is the full source of truth.
 *
 * ## Concurrency
 *
 * One store instance per process. DuckDB holds an exclusive file lock;
 * opening a second instance against the same path will fail. This is
 * fine for Hindsight's single-user, single-process Electron model.
 *
 * The store is NOT internally serialized. Callers are responsible for
 * the following two invariants:
 *
 * 1. **Single writer.** Do not invoke `writeHour` concurrently on the
 *    same instance. Two overlapping transactions on the same DuckDB
 *    connection are undefined behaviour in the native binding.
 * 2. **`close()` drains first.** Before calling `close()`, every
 *    in-flight `writeHour` / `readBarsInRange` promise from that
 *    instance must have settled. Closing mid-transaction is likewise
 *    undefined behaviour.
 *
 * `ingestSymbol` (src/main/data/ingest.ts) satisfies both by
 * construction: it awaits every `writeHour` inside its sequential
 * per-hour loop before the call either returns or throws, so any
 * caller that does `try { await ingestSymbol(...) } finally { await
 * store.close() }` is safe without extra bookkeeping. A multi-writer
 * or Electron `before-quit` shutdown path would need an explicit
 * mutex / drain inside this module — deferred until a slice actually
 * introduces one, at which point the doc claim here must be revisited.
 *
 * ## Windows note
 *
 * DuckDB keeps an OS-level file handle open; test cleanup MUST `close()`
 * the store before `rmSync`-ing the tmpdir, or Windows refuses to
 * delete the file.
 */

import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Bar } from "../../shared/types.js";
import type { BarStore } from "./ingest.js";
import type { CatalogSymbol } from "../../shared/instruments.js";

const ONE_HOUR_MS = 3_600_000;
const MS_PER_SECOND = 1_000;

/**
 * Phase of the DuckDB bar store where a failure surfaced:
 *
 * - `"validation"` — synchronous pre-flight input rejection (invalid
 *   `hourMs`, out-of-window bar, non-finite numerics, reversed read
 *   range, …). No DuckDB round-trip happened.
 * - `"write"` — the DuckDB transaction itself failed. Transactional, so
 *   the row set is unchanged on disk; see the `"a failed write leaves
 *   …"` test.
 * - `"read"` — a `readBarsInRange` SQL query failed (I/O error,
 *   corrupted row, unexpected NULL where we expected a value).
 * - `"open"` — `createDuckDbBarStore` itself failed to open or
 *   initialise the DuckDB file (permissions, existing lock, schema
 *   mismatch).
 * - `"closed"` — `writeHour` or `readBarsInRange` was invoked after
 *   `close()`.
 */
export type BarStorePhase =
  | "validation"
  | "write"
  | "read"
  | "open"
  | "closed";

/**
 * Error class raised by the DuckDB bar store. Carries the originating
 * `phase` so callers can route on it without `instanceof`-walking every
 * underlying DuckDB error subtype. Underlying failures (DuckDB SQL
 * errors, fs errors) are attached as `cause`.
 */
export class BarStoreError extends Error {
  override readonly cause?: unknown;
  /** Where in the store lifecycle the failure surfaced. */
  readonly phase: BarStorePhase;

  constructor(message: string, options: { phase: BarStorePhase; cause?: unknown }) {
    super(message);
    this.name = "BarStoreError";
    this.phase = options.phase;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Read surface added by the DuckDB-backed bar store. Deliberately kept
 * off the base `BarStore` interface (which stays write-only) so the
 * ingest orchestrator's test fakes do not have to stub methods nobody
 * calls. Integration tests and the future M3 replay engine import this
 * extended type.
 *
 * `readBarsInRange` returns bars in ascending `timestampMs` order,
 * half-open over `[fromMs, toMs)`.
 */
export interface DuckDbBarStore extends BarStore {
  /**
   * Return all stored bars for `symbol` whose `timestampMs` falls in
   * the half-open interval `[fromMs, toMs)`. Bounds must be finite
   * integers with `fromMs < toMs`, both `>= 0`; violations throw
   * `BarStoreError({ phase: "validation" })`. The result is ordered
   * by `timestampMs` ascending.
   */
  readBarsInRange(args: {
    symbol: CatalogSymbol;
    fromMs: number;
    toMs: number;
  }): Promise<Bar[]>;

  /**
   * Release the DuckDB connection and file lock. Idempotent: calling
   * again after the first close is a no-op. After `close()`, any
   * `writeHour` / `readBarsInRange` call throws
   * `BarStoreError({ phase: "closed" })`.
   *
   * **Precondition:** every in-flight `writeHour` /
   * `readBarsInRange` promise on this instance must have settled
   * before `close()` is called. The implementation does not drain
   * outstanding work — see the "Concurrency" section of the module
   * header for why, and for the documented shape of safe callers.
   */
  close(): Promise<void>;
}

/**
 * Open (or create) the DuckDB hot store under `root` and return a
 * `DuckDbBarStore` handle. The database file lives at
 * `<root>/bars/1s.duckdb`; the parent `bars/` directory is created if
 * it does not exist.
 *
 * Throws `BarStoreError({ phase: "open", cause })` if the path cannot
 * be created, the file is already locked by another process, or the
 * initial schema migration fails.
 */
export async function createDuckDbBarStore(opts: {
  root: string;
}): Promise<DuckDbBarStore> {
  if (typeof opts.root !== "string" || opts.root.length === 0) {
    throw new BarStoreError(
      `root must be a non-empty string, got ${JSON.stringify(opts.root)}`,
      { phase: "open" },
    );
  }

  const dbPath = path.join(opts.root, "bars", "1s.duckdb");
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const openedInstance = await DuckDBInstance.create(dbPath);
    // Once `DuckDBInstance.create` resolves, an exclusive OS-level file
    // lock is held. Any failure between here and the end of the schema
    // migration MUST release that lock, or the next
    // `createDuckDbBarStore` against the same path will hang on an
    // orphaned handle (particularly on Windows, where the lock is
    // mandatory and survives the failed factory call for the lifetime
    // of the Node process).
    let openedConnection: DuckDBConnection | null = null;
    try {
      openedConnection = await openedInstance.connect();
      await openedConnection.run(CREATE_TABLE_SQL);
    } catch (inner) {
      if (openedConnection !== null) {
        try {
          openedConnection.closeSync();
        } catch {
          // best-effort cleanup
        }
      }
      try {
        openedInstance.closeSync();
      } catch {
        // best-effort cleanup
      }
      throw inner;
    }
    instance = openedInstance;
    connection = openedConnection;
  } catch (err) {
    throw new BarStoreError(
      `failed to open DuckDB bar store at ${JSON.stringify(dbPath)}`,
      { phase: "open", cause: err },
    );
  }

  let closed = false;

  const writeHour: DuckDbBarStore["writeHour"] = async ({
    symbol,
    hourMs,
    bars,
  }) => {
    if (closed) {
      throw new BarStoreError(
        `writeHour called on a closed store (symbol=${JSON.stringify(symbol)}, hourMs=${hourMs})`,
        { phase: "closed" },
      );
    }
    validateHourMs(hourMs);
    validateBarsForHour(bars, hourMs);

    try {
      await connection.run("BEGIN TRANSACTION");
      try {
        await connection.run(
          "DELETE FROM bars_1s WHERE symbol = $sym AND timestamp_ms >= $lo AND timestamp_ms < $hi",
          {
            sym: symbol,
            lo: BigInt(hourMs),
            hi: BigInt(hourMs + ONE_HOUR_MS),
          },
        );
        // One awaited INSERT per bar: simple, transactional, and fast
        // enough for `writeHour`'s typical 3600-row hour. For full-year
        // backfills (8760 hours × up to 3600 bars) the `@duckdb/node-api`
        // `Appender` API is ~10× faster for bulk writes and is the first
        // place to look if M2's "full year ingest" acceptance test is
        // slow. The switch is local to this loop.
        for (const b of bars) {
          await connection.run(INSERT_BAR_SQL, toInsertParams(symbol, b));
        }
        await connection.run("COMMIT");
      } catch (inner) {
        try {
          await connection.run("ROLLBACK");
        } catch {
          // Ignore rollback failure; surface the original error.
        }
        throw inner;
      }
    } catch (err) {
      throw new BarStoreError(
        `writeHour failed (symbol=${JSON.stringify(symbol)}, hourMs=${hourMs}, bars=${bars.length})`,
        { phase: "write", cause: err },
      );
    }
  };

  const readBarsInRange: DuckDbBarStore["readBarsInRange"] = async ({
    symbol,
    fromMs,
    toMs,
  }) => {
    if (closed) {
      throw new BarStoreError(
        `readBarsInRange called on a closed store (symbol=${JSON.stringify(symbol)})`,
        { phase: "closed" },
      );
    }
    validateRange(fromMs, toMs);

    let rows: Record<string, unknown>[];
    try {
      const reader = await connection.runAndReadAll(SELECT_RANGE_SQL, {
        sym: symbol,
        lo: BigInt(fromMs),
        hi: BigInt(toMs),
      });
      rows = reader.getRowObjectsJS() as Record<string, unknown>[];
    } catch (err) {
      throw new BarStoreError(
        `readBarsInRange failed (symbol=${JSON.stringify(symbol)}, fromMs=${fromMs}, toMs=${toMs})`,
        { phase: "read", cause: err },
      );
    }
    return rows.map(rowToBar);
  };

  const close: DuckDbBarStore["close"] = async () => {
    if (closed) return;
    closed = true;
    try {
      connection.closeSync();
    } catch {
      // Best-effort: DuckDB may already be closed by GC.
    }
    try {
      instance.closeSync();
    } catch {
      // Best-effort.
    }
  };

  return { writeHour, readBarsInRange, close };
}

// ─────────────────────────────────────────────────────────────────────────
// Schema + SQL
// ─────────────────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS bars_1s (
    symbol       VARCHAR NOT NULL,
    timestamp_ms BIGINT  NOT NULL,
    o_bid DOUBLE NOT NULL, h_bid DOUBLE NOT NULL, l_bid DOUBLE NOT NULL, c_bid DOUBLE NOT NULL,
    o_ask DOUBLE NOT NULL, h_ask DOUBLE NOT NULL, l_ask DOUBLE NOT NULL, c_ask DOUBLE NOT NULL,
    volume_bid DOUBLE NOT NULL,
    volume_ask DOUBLE NOT NULL,
    tick_count  INTEGER NOT NULL,
    PRIMARY KEY (symbol, timestamp_ms)
  )
`;

const INSERT_BAR_SQL = `
  INSERT INTO bars_1s (
    symbol, timestamp_ms,
    o_bid, h_bid, l_bid, c_bid,
    o_ask, h_ask, l_ask, c_ask,
    volume_bid, volume_ask, tick_count
  ) VALUES (
    $sym, $ts,
    $oBid, $hBid, $lBid, $cBid,
    $oAsk, $hAsk, $lAsk, $cAsk,
    $volBid, $volAsk, $tickCount
  )
`;

const SELECT_RANGE_SQL = `
  SELECT
    timestamp_ms,
    o_bid, h_bid, l_bid, c_bid,
    o_ask, h_ask, l_ask, c_ask,
    volume_bid, volume_ask, tick_count
  FROM bars_1s
  WHERE symbol = $sym
    AND timestamp_ms >= $lo
    AND timestamp_ms <  $hi
  ORDER BY timestamp_ms ASC
`;

/**
 * Typed parameter bag for `INSERT_BAR_SQL`. The explicit keys pin the
 * contract between `toInsertParams` and the placeholder names in the
 * SQL; the `string` index signature is there to make the shape
 * assignable to `@duckdb/node-api`'s `Record<string, DuckDBValue>`
 * expected by `connection.run`.
 */
interface InsertBarParams {
  sym: CatalogSymbol;
  ts: bigint;
  oBid: number;
  hBid: number;
  lBid: number;
  cBid: number;
  oAsk: number;
  hAsk: number;
  lAsk: number;
  cAsk: number;
  volBid: number;
  volAsk: number;
  tickCount: number;
  [key: string]: string | number | bigint;
}

function toInsertParams(symbol: CatalogSymbol, b: Bar): InsertBarParams {
  return {
    sym: symbol,
    ts: BigInt(b.timestampMs),
    oBid: b.oBid,
    hBid: b.hBid,
    lBid: b.lBid,
    cBid: b.cBid,
    oAsk: b.oAsk,
    hAsk: b.hAsk,
    lAsk: b.lAsk,
    cAsk: b.cAsk,
    volBid: b.volumeBid,
    volAsk: b.volumeAsk,
    tickCount: b.tickCount,
  };
}

function rowToBar(row: Record<string, unknown>): Bar {
  return {
    timestampMs: coerceNumber(row["timestamp_ms"]),
    oBid: row["o_bid"] as number,
    hBid: row["h_bid"] as number,
    lBid: row["l_bid"] as number,
    cBid: row["c_bid"] as number,
    oAsk: row["o_ask"] as number,
    hAsk: row["h_ask"] as number,
    lAsk: row["l_ask"] as number,
    cAsk: row["c_ask"] as number,
    volumeBid: row["volume_bid"] as number,
    volumeAsk: row["volume_ask"] as number,
    tickCount: coerceNumber(row["tick_count"]),
  };
}

/**
 * DuckDB returns BIGINT columns as `bigint`. Our `Bar.timestampMs` fits
 * comfortably in `Number.MAX_SAFE_INTEGER` (year 9999 in ms is ~2.5e14,
 * well below 2^53), so a narrowing conversion is safe — but we still
 * sanity-check it with `Number.isSafeInteger` against upstream
 * corruption.
 */
function coerceNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new BarStoreError(
        `DuckDB returned a BIGINT outside Number.MAX_SAFE_INTEGER: ${value}`,
        { phase: "read" },
      );
    }
    return asNumber;
  }
  throw new BarStoreError(
    `DuckDB returned an unexpected type for an integer column: ${typeof value}`,
    { phase: "read" },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Validation — synchronous pre-flight checks. Any failure here throws
// BarStoreError({ phase: "validation" }) BEFORE any DuckDB round-trip.
// ─────────────────────────────────────────────────────────────────────────

function validateHourMs(hourMs: number): void {
  if (!Number.isFinite(hourMs)) {
    throw new BarStoreError(`hourMs must be finite, got ${hourMs}`, {
      phase: "validation",
    });
  }
  if (!Number.isInteger(hourMs)) {
    throw new BarStoreError(`hourMs must be an integer, got ${hourMs}`, {
      phase: "validation",
    });
  }
  if (hourMs < 0) {
    throw new BarStoreError(`hourMs must be >= 0, got ${hourMs}`, {
      phase: "validation",
    });
  }
  if (hourMs % ONE_HOUR_MS !== 0) {
    throw new BarStoreError(
      `hourMs must be aligned to a UTC hour boundary (multiple of ${ONE_HOUR_MS}), got ${hourMs}`,
      { phase: "validation" },
    );
  }
}

function validateBarsForHour(bars: readonly Bar[], hourMs: number): void {
  const hourHi = hourMs + ONE_HOUR_MS;
  let prevTs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    validateBarAt(b, i, hourMs, hourHi);
    if (b.timestampMs <= prevTs) {
      throw new BarStoreError(
        `bars[${i}].timestampMs=${b.timestampMs} must be strictly greater than the previous bar's ${prevTs}`,
        { phase: "validation" },
      );
    }
    prevTs = b.timestampMs;
  }
}

function validateBarAt(
  b: Bar,
  index: number,
  hourMs: number,
  hourHi: number,
): void {
  const at = `bars[${index}]`;

  if (!Number.isFinite(b.timestampMs) || !Number.isInteger(b.timestampMs)) {
    throw new BarStoreError(
      `${at}.timestampMs must be a finite integer, got ${b.timestampMs}`,
      { phase: "validation" },
    );
  }
  if (b.timestampMs < hourMs || b.timestampMs >= hourHi) {
    throw new BarStoreError(
      `${at}.timestampMs=${b.timestampMs} is outside the half-open hour window [${hourMs}, ${hourHi})`,
      { phase: "validation" },
    );
  }
  if (b.timestampMs % MS_PER_SECOND !== 0) {
    throw new BarStoreError(
      `${at}.timestampMs=${b.timestampMs} must be a multiple of ${MS_PER_SECOND} (1 s bar bucket)`,
      { phase: "validation" },
    );
  }

  // Price fields are only checked for finiteness, not sign. Hindsight's
  // v1 instrument universe (forex, metals, indices) cannot produce
  // negative prices; commodities that historically have (crude oil,
  // April 2020) are out of scope until they join `INSTRUMENTS`.
  const priceFields: Array<[keyof Bar, number]> = [
    ["oBid", b.oBid],
    ["hBid", b.hBid],
    ["lBid", b.lBid],
    ["cBid", b.cBid],
    ["oAsk", b.oAsk],
    ["hAsk", b.hAsk],
    ["lAsk", b.lAsk],
    ["cAsk", b.cAsk],
    ["volumeBid", b.volumeBid],
    ["volumeAsk", b.volumeAsk],
  ];
  for (const [name, value] of priceFields) {
    if (!Number.isFinite(value)) {
      throw new BarStoreError(
        `${at}.${String(name)} must be finite, got ${value}`,
        { phase: "validation" },
      );
    }
  }
  if (b.volumeBid < 0) {
    throw new BarStoreError(
      `${at}.volumeBid must be >= 0, got ${b.volumeBid}`,
      { phase: "validation" },
    );
  }
  if (b.volumeAsk < 0) {
    throw new BarStoreError(
      `${at}.volumeAsk must be >= 0, got ${b.volumeAsk}`,
      { phase: "validation" },
    );
  }
  if (!Number.isInteger(b.tickCount) || b.tickCount < 1) {
    throw new BarStoreError(
      `${at}.tickCount must be a positive integer, got ${b.tickCount}`,
      { phase: "validation" },
    );
  }
}

function validateRange(fromMs: number, toMs: number): void {
  for (const [name, value] of [
    ["fromMs", fromMs],
    ["toMs", toMs],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new BarStoreError(`${name} must be finite, got ${value}`, {
        phase: "validation",
      });
    }
    if (!Number.isInteger(value)) {
      throw new BarStoreError(`${name} must be an integer, got ${value}`, {
        phase: "validation",
      });
    }
    if (value < 0) {
      throw new BarStoreError(`${name} must be >= 0, got ${value}`, {
        phase: "validation",
      });
    }
  }
  if (fromMs >= toMs) {
    throw new BarStoreError(
      `fromMs (${fromMs}) must be strictly less than toMs (${toMs})`,
      { phase: "validation" },
    );
  }
}
