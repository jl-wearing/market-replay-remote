/**
 * CLI shell for the slice 7 day runner — slice 8 of M2.
 *
 * `runIngestCli` is the testable core of the `npm run ingest` entry point:
 * it parses argv, constructs the production `DukascopyClient` via the
 * injected `createClient` factory, and calls `ingestSymbolDay` (slice 7)
 * with the injected `openStore` factory threaded through. It returns the
 * intended process exit code so the bin shim is a thin
 * `process.exitCode = await runIngestCli(...)` wrapper.
 *
 * The two seams are deliberate: tests inject hand-rolled fakes for
 * `createClient` + `openStore`, the bin shim wires
 * `() => createDukascopyClient()` + `(root) => createDuckDbBarStore({
 * root })`. Neither layer talks to `process.argv`, `process.stdout`, or
 * `process.exit` directly — those live in `ingestDayMain.ts`.
 *
 * Argv shape (all three required, any order; `--key value` only, no
 * `--key=value` form):
 *
 *     --symbol <CatalogSymbol>  e.g. EURUSD
 *     --day    <YYYY-MM-DD>     UTC calendar day to ingest
 *     --root   <PATH>           filesystem root for the DuckDB hot store
 *
 * `--help` / `-h` print the usage banner to stdout and return exit 0.
 *
 * Exit codes:
 *
 *     0  success (or `--help`)
 *     1  runner failure — `IngestRunError`, message + phase + cause on stderr
 *     2  argv failure  — `CliArgsError`, message + usage on stderr
 *
 * Non-goals for this slice: no `--key=value` form, no `--config` file,
 * no `--from`/`--to` ranges (multi-day belongs in a later runner above
 * `ingestSymbolDay`), no progress bar or coloured output.
 */

import type { DukascopyClient } from "../data/dukascopyClient.js";
import { ingestSymbolDay, IngestRunError } from "./ingestDay.js";
import type { OpenDuckDbBarStore } from "./ingestDay.js";

/**
 * Discriminating tag on `CliArgsError`. Mirrors the `phase` tag pattern
 * used by `IngestRunError` and `BarStoreError` so a future throw site
 * built without a code fails loudly in the per-file helper instead of
 * going green on a bare class match.
 *
 * - `"missing-flag"`   — one of `--symbol` / `--day` / `--root` absent.
 * - `"unknown-flag"`   — an unrecognised `--name` token.
 * - `"missing-value"`  — a known flag's value is missing or itself a flag.
 * - `"duplicate-flag"` — the same flag appears twice.
 * - `"positional-arg"` — a non-flag token appeared.
 */
export type CliArgsErrorCode =
  | "missing-flag"
  | "unknown-flag"
  | "missing-value"
  | "duplicate-flag"
  | "positional-arg";

/** Single error class for `parseArgv` failures. */
export class CliArgsError extends Error {
  /** Which class of argv shape failure surfaced. */
  readonly code: CliArgsErrorCode;

  constructor(message: string, options: { code: CliArgsErrorCode }) {
    super(message);
    this.name = "CliArgsError";
    this.code = options.code;
  }
}

/**
 * Successful argv parse: the three required flag values, untouched.
 * `parseArgv` does NOT validate `symbol`/`day`/`root` semantically — that
 * is `ingestSymbolDay`'s job (and surfaces as `IngestRunError` with a
 * runner-level phase). Keeping the seam at "string shape" only means
 * argv parsing has a small, total domain.
 */
export interface ParsedArgs {
  readonly kind: "args";
  readonly symbol: string;
  readonly day: string;
  readonly root: string;
}

/** Help was requested. The runner short-circuits, prints usage, exits 0. */
export interface HelpRequested {
  readonly kind: "help";
}

/** Discriminated union returned by `parseArgv` on success. */
export type ParseResult = ParsedArgs | HelpRequested;

/** Injected collaborators for `runIngestCli`. */
export interface RunIngestCliDeps {
  /**
   * Constructs the `DukascopyClient`. In production
   * `() => createDukascopyClient()`; tests pass a hand-rolled fake. Not
   * called on argv failure or `--help`.
   */
  createClient: () => DukascopyClient;
  /**
   * Forwarded verbatim to `ingestSymbolDay`. In production
   * `(root) => createDuckDbBarStore({ root })`; tests pass a fake.
   */
  openStore: OpenDuckDbBarStore;
  /** One stdout line at a time; the writer adds the trailing newline. */
  stdout: (line: string) => void;
  /** One stderr line at a time. */
  stderr: (line: string) => void;
}

/**
 * Usage banner. Single line per flag so `--help` output stays grep-able.
 * Tests assert each flag name appears exactly once.
 */
export const USAGE = [
  "Usage: npm run ingest -- --symbol <SYMBOL> --day <YYYY-MM-DD> --root <PATH>",
  "",
  "  --symbol  Catalog symbol (e.g. EURUSD, USDJPY, XAUUSD).",
  "  --day     UTC calendar day to ingest, strict YYYY-MM-DD.",
  "  --root    Filesystem root for the DuckDB hot store.",
  "  --help    Show this message and exit.",
].join("\n");

const KNOWN_FLAGS = new Set(["--symbol", "--day", "--root"]);

/**
 * Parse a CLI argv slice (already with `node` and the script path
 * removed) into either `{ kind: "args", … }` or `{ kind: "help" }`.
 * Throws `CliArgsError` for every other shape; never returns a partial
 * result.
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  // `--help` / `-h` anywhere wins — checked first so the parser does
  // not bail on a separate shape problem when the user just wants help.
  for (const tok of argv) {
    if (tok === "--help" || tok === "-h") return { kind: "help" };
  }

  let symbol: string | null = null;
  let day: string | null = null;
  let root: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (KNOWN_FLAGS.has(tok)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value === "-h") {
        throw new CliArgsError(`flag ${tok} requires a value`, {
          code: "missing-value",
        });
      }
      if (tok === "--symbol") {
        if (symbol !== null) {
          throw new CliArgsError(`flag --symbol specified more than once`, {
            code: "duplicate-flag",
          });
        }
        symbol = value;
      } else if (tok === "--day") {
        if (day !== null) {
          throw new CliArgsError(`flag --day specified more than once`, {
            code: "duplicate-flag",
          });
        }
        day = value;
      } else {
        if (root !== null) {
          throw new CliArgsError(`flag --root specified more than once`, {
            code: "duplicate-flag",
          });
        }
        root = value;
      }
      i += 1;
      continue;
    }
    if (tok.startsWith("--")) {
      throw new CliArgsError(`unknown flag ${tok}`, { code: "unknown-flag" });
    }
    throw new CliArgsError(
      `unexpected positional argument ${JSON.stringify(tok)}`,
      { code: "positional-arg" },
    );
  }

  const missing: string[] = [];
  if (symbol === null) missing.push("--symbol");
  if (day === null) missing.push("--day");
  if (root === null) missing.push("--root");
  if (missing.length > 0) {
    throw new CliArgsError(
      `missing required flag(s): ${missing.join(", ")}`,
      { code: "missing-flag" },
    );
  }

  return { kind: "args", symbol: symbol!, day: day!, root: root! };
}

/**
 * Run the ingest CLI with the given argv slice and injected deps.
 * Returns the exit code; does not touch `process.exit`.
 *
 * Side-effect ordering on a happy run: argv parse, `createClient`,
 * `ingestSymbolDay` (which itself calls `openStore`, runs the 24-hour
 * loop, and closes the store), final stats line on stdout.
 */
export async function runIngestCli(
  argv: readonly string[],
  deps: RunIngestCliDeps,
): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`error: ${message}`);
    deps.stderr(USAGE);
    return 2;
  }

  if (parsed.kind === "help") {
    deps.stdout(USAGE);
    return 0;
  }

  const client = deps.createClient();
  try {
    const stats = await ingestSymbolDay(
      { symbol: parsed.symbol, dayUtc: parsed.day, root: parsed.root },
      {
        client,
        openStore: deps.openStore,
        onHourComplete: (hourMs, count) =>
          deps.stdout(`hour ${hourMs} → ${count} bars`),
      },
    );
    deps.stdout(JSON.stringify(stats));
    return 0;
  } catch (err) {
    if (err instanceof IngestRunError) {
      deps.stderr(`error [phase=${err.phase}]: ${err.message}`);
      if (err.cause !== undefined) {
        deps.stderr(`caused by: ${describeCause(err.cause)}`);
      }
      return 1;
    }
    // An error that isn't `IngestRunError` is by contract impossible —
    // the slice 7 runner wraps everything. Surface it loudly rather than
    // silently swallowing it so a future regression in slice 7's
    // wrapping is visible from the CLI.
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`error [phase=unknown]: ${message}`);
    return 1;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const phase = (cause as { phase?: unknown }).phase;
    const phaseSuffix = typeof phase === "string" ? ` (phase=${phase})` : "";
    return `${cause.name}${phaseSuffix}: ${cause.message}`;
  }
  return String(cause);
}
