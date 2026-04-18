/**
 * Storage-path helpers for Hindsight's on-disk data layout.
 *
 * Layout (mirrors `ARCHITECTURE.md`):
 *
 *     <root>/
 *     ├── ticks/<SYMBOL>/<YYYY>/<MM>/<DD>/<HH>h_ticks.bi5
 *     └── bars/1s/<SYMBOL>_<YYYY>.parquet
 *
 * Paths are composed with POSIX separators (`/`). The Electron/main layer is
 * responsible for converting to the OS-native form when it actually opens a
 * file — keeping paths POSIX everywhere else makes them stable to compare,
 * diff, and serialise.
 *
 * This module does no I/O. It's pure string manipulation with strict input
 * validation: every numeric field must be a finite integer within its
 * allowed range, `symbol` must match `/^[A-Z0-9]+$/` to keep path-traversal
 * characters out, and `root` must be non-empty.
 */

const SYMBOL_PATTERN = /^[A-Z0-9]+$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;
const MS_PER_HOUR = 3_600_000;

/**
 * Thrown when any argument to a path helper is invalid — empty `root` or
 * `symbol`, a `symbol` with unsafe characters, an out-of-range or non-
 * integer calendar field, or a non-finite timestamp.
 */
export class InvalidStoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStoragePathError";
  }
}

/**
 * Build the path to the `.bi5` tick file for a single UTC hour.
 *
 * - `month` is 1-indexed (January = 1).
 * - `hour` is 0-indexed (00..23).
 * - `symbol` must match `/^[A-Z0-9]+$/` — the catalog already guarantees
 *   this; passing a lowercase or punctuated symbol throws rather than
 *   silently normalising.
 * - `root` is used verbatim aside from stripping a single trailing `/`.
 */
export function tickHourPath(args: {
  root: string;
  symbol: string;
  year: number;
  month: number;
  day: number;
  hour: number;
}): string {
  const root = validateRoot(args.root);
  const symbol = validateSymbol(args.symbol);
  validateYear(args.year);
  validateIntegerInRange("month", args.month, 1, 12);
  validateIntegerInRange("day", args.day, 1, 31);
  validateIntegerInRange("hour", args.hour, 0, 23);

  const yy = String(args.year);
  const mm = pad2(args.month);
  const dd = pad2(args.day);
  const hh = pad2(args.hour);
  return `${root}/ticks/${symbol}/${yy}/${mm}/${dd}/${hh}h_ticks.bi5`;
}

/**
 * Build the path to the `.bi5` tick file containing the UTC hour that
 * `timestampMs` falls within. Bit-equivalent to `tickHourPath` called with
 * the UTC components of `timestampMs`.
 *
 * `timestampMs` must be a finite integer. Non-finite and non-integer
 * timestamps throw `InvalidStoragePathError`.
 */
export function tickPathForTimestamp(args: {
  root: string;
  symbol: string;
  timestampMs: number;
}): string {
  if (!Number.isFinite(args.timestampMs)) {
    throw new InvalidStoragePathError(
      `timestampMs must be a finite number, got ${args.timestampMs}`,
    );
  }
  if (!Number.isInteger(args.timestampMs)) {
    throw new InvalidStoragePathError(
      `timestampMs must be an integer, got ${args.timestampMs}`,
    );
  }

  const hourStart = Math.floor(args.timestampMs / MS_PER_HOUR) * MS_PER_HOUR;
  const d = new Date(hourStart);
  return tickHourPath({
    root: args.root,
    symbol: args.symbol,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  });
}

/**
 * Build the path to the per-(symbol, year) 1-second OHLCV Parquet file.
 *
 * One file per symbol per UTC year, as described in `ARCHITECTURE.md`.
 * `year` must be a finite integer in `[1970, 9999]`.
 */
export function barParquetPath(args: {
  root: string;
  symbol: string;
  year: number;
}): string {
  const root = validateRoot(args.root);
  const symbol = validateSymbol(args.symbol);
  validateYear(args.year);
  return `${root}/bars/1s/${symbol}_${args.year}.parquet`;
}

function validateRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new InvalidStoragePathError(
      `root must be a non-empty string, got ${JSON.stringify(root)}`,
    );
  }
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function validateSymbol(symbol: string): string {
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new InvalidStoragePathError(
      `symbol must be a non-empty string, got ${JSON.stringify(symbol)}`,
    );
  }
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new InvalidStoragePathError(
      `symbol must match /^[A-Z0-9]+$/ (uppercase letters and digits only), got ${JSON.stringify(symbol)}`,
    );
  }
  return symbol;
}

function validateYear(year: number): void {
  validateIntegerInRange("year", year, MIN_YEAR, MAX_YEAR);
}

function validateIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value)) {
    throw new InvalidStoragePathError(
      `${name} must be a finite number, got ${value}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new InvalidStoragePathError(
      `${name} must be an integer, got ${value}`,
    );
  }
  if (value < min || value > max) {
    throw new InvalidStoragePathError(
      `${name} must be in [${min}, ${max}], got ${value}`,
    );
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
