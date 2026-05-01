/**
 * Entry point for `npm run ingest` (slice 8 of M2).
 *
 * Wires the production `DukascopyClient` and `DuckDbBarStore` factories
 * into `runIngestCli`. Intentionally a five-liner: every testable
 * branch lives in `runIngestCli.ts`; this file is the I/O boundary
 * between `process.argv` / `process.stdout` / `process.exitCode` and
 * the pure shell. It is run directly by `tsx` (see the `ingest` npm
 * script) and never imported by tests.
 */

import { createDukascopyClient } from "../data/dukascopyClient.js";
import { createDuckDbBarStore } from "../data/duckDbBarStore.js";
import { runIngestCli } from "./runIngestCli.js";

const exitCode = await runIngestCli(process.argv.slice(2), {
  createClient: () => createDukascopyClient(),
  openStore: (root) => createDuckDbBarStore({ root }),
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
});
process.exitCode = exitCode;
