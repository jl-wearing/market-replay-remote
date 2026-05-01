/**
 * Unit tests for the slice 8 CLI shell.
 *
 * Two surfaces are exercised:
 *
 * - `parseArgv` — argv-string → `{ symbol, day, root }`. Pure, throws
 *   `CliArgsError` with a discriminating `code` tag.
 * - `runIngestCli` — argv + injected deps → `Promise<exitCode>`. Wires
 *   the parser, the real `ingestSymbolDay` runner from slice 7, and the
 *   stdout/stderr writers. Construct-once seam for the production
 *   `DukascopyClient` (`createClient`) and the production
 *   `DuckDbBarStore` factory (`openStore`) so tests inject fakes and
 *   the bin shim wires real ones.
 *
 * The breaking-block split (parser shape vs. propagation) is allowed
 * here under the slice-7 precedent: 10 breaking tests across two
 * orthogonal surfaces.
 */

import { describe, expect, it } from "vitest";
import type { Bar } from "../../shared/types.js";
import type {
  DukascopyClient,
  FetchHourArgs,
} from "../data/dukascopyClient.js";
import { IngestError } from "../data/ingest.js";
import {
  BarStoreError,
  type DuckDbBarStore,
} from "../data/duckDbBarStore.js";
import type { OpenDuckDbBarStore } from "./ingestDay.js";
import {
  CliArgsError,
  parseArgv,
  runIngestCli,
  type CliArgsErrorCode,
  type RunIngestCliDeps,
} from "./runIngestCli.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const ROOT = "/tmp/hindsight-fake-root";
const DAY = "2024-01-15";
const DAY_START = Date.UTC(2024, 0, 15, 0, 0, 0, 0);

interface FakeStoreHandle {
  store: DuckDbBarStore;
  closeCount: () => number;
}

function makeFakeStore(opts: { closeError?: Error } = {}): FakeStoreHandle {
  let closeCount = 0;
  const store: DuckDbBarStore = {
    async writeHour() {
      // accept silently
    },
    async readBarsInRange(): Promise<Bar[]> {
      return [];
    },
    async close() {
      closeCount += 1;
      if (opts.closeError !== undefined && closeCount === 1) {
        throw opts.closeError;
      }
    },
  };
  return { store, closeCount: () => closeCount };
}

interface ClientHandle {
  client: DukascopyClient;
  callCount: () => number;
}

function makeFakeClient(opts: { error?: Error } = {}): ClientHandle {
  let callCount = 0;
  const client: DukascopyClient = {
    async fetchHour(_args: FetchHourArgs): Promise<Uint8Array> {
      callCount += 1;
      if (opts.error !== undefined) throw opts.error;
      return new Uint8Array(0);
    },
  };
  return { client, callCount: () => callCount };
}

interface Recorders {
  stdout: string[];
  stderr: string[];
  createClientCalls: number;
  openStoreCalls: string[];
}

interface TestDeps {
  deps: RunIngestCliDeps;
  rec: Recorders;
}

function makeDeps(opts: {
  client?: DukascopyClient;
  openStore?: OpenDuckDbBarStore;
} = {}): TestDeps {
  const rec: Recorders = {
    stdout: [],
    stderr: [],
    createClientCalls: 0,
    openStoreCalls: [],
  };
  const fakeClient = opts.client ?? makeFakeClient().client;
  const fakeOpener: OpenDuckDbBarStore = opts.openStore ?? (async () => makeFakeStore().store);
  const deps: RunIngestCliDeps = {
    createClient: () => {
      rec.createClientCalls += 1;
      return fakeClient;
    },
    openStore: async (root: string) => {
      rec.openStoreCalls.push(root);
      return fakeOpener(root);
    },
    stdout: (line: string) => rec.stdout.push(line),
    stderr: (line: string) => rec.stderr.push(line),
  };
  return { deps, rec };
}

/**
 * Per-file phase-asserting helper for `parseArgv` failures. Mirrors
 * `expectRunError` in `ingestDay.test.ts`: a future `CliArgsError`
 * constructed without a `code` would fail loudly here instead of going
 * green on a class match alone.
 */
function expectArgsError(
  fn: () => unknown,
  expected: { code: CliArgsErrorCode },
): CliArgsError {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CliArgsError);
  const err = caught as CliArgsError;
  expect(err.code).toBe(expected.code);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────
describe("runIngestCli — core behaviour", () => {
  it("parseArgv accepts the canonical argv and returns the three values", () => {
    const result = parseArgv([
      "--symbol",
      "EURUSD",
      "--day",
      DAY,
      "--root",
      ROOT,
    ]);
    expect(result).toEqual({
      kind: "args",
      symbol: "EURUSD",
      day: DAY,
      root: ROOT,
    });
  });

  it("parseArgv accepts flags in any order", () => {
    const result = parseArgv([
      "--root",
      ROOT,
      "--day",
      DAY,
      "--symbol",
      "EURUSD",
    ]);
    expect(result).toEqual({
      kind: "args",
      symbol: "EURUSD",
      day: DAY,
      root: ROOT,
    });
  });

  it("parseArgv recognises --help and -h as a help request", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["-h"])).toEqual({ kind: "help" });
    expect(parseArgv(["--symbol", "EURUSD", "--help"])).toEqual({
      kind: "help",
    });
  });

  it("happy run: parses argv, opens store with --root, returns 0, prints stats JSON", async () => {
    const { deps, rec } = makeDeps();

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(0);
    expect(rec.createClientCalls).toBe(1);
    expect(rec.openStoreCalls).toEqual([ROOT]);
    // Final line on stdout must be parseable JSON containing the four
    // IngestStats fields.
    const last = rec.stdout[rec.stdout.length - 1];
    expect(last).toBeDefined();
    const stats = JSON.parse(last!) as Record<string, number>;
    expect(stats["hoursFetched"]).toBe(24);
    expect(stats["hoursEmpty"]).toBe(24);
    expect(stats["totalTicks"]).toBe(0);
    expect(stats["totalBars"]).toBe(0);
    expect(rec.stderr).toEqual([]);
  });

  it("emits a per-hour progress line on stdout for each of the 24 hours", async () => {
    const { deps, rec } = makeDeps();

    await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    // 24 progress lines + 1 final stats line = 25 stdout entries.
    expect(rec.stdout.length).toBe(25);
    // Each progress line must mention the hour's UTC ms (sanity-check the
    // first and last; the runner walks them sequentially in slice 7).
    expect(rec.stdout[0]).toContain(String(DAY_START));
    expect(rec.stdout[23]).toContain(String(DAY_START + 23 * 3_600_000));
  });

  it("--help short-circuits: prints usage to stdout, returns 0, no client/store touched", async () => {
    const { deps, rec } = makeDeps();

    const code = await runIngestCli(["--help"], deps);

    expect(code).toBe(0);
    expect(rec.createClientCalls).toBe(0);
    expect(rec.openStoreCalls).toEqual([]);
    expect(rec.stderr).toEqual([]);
    expect(rec.stdout.length).toBeGreaterThan(0);
    expect(rec.stdout.join("\n")).toMatch(/--symbol/);
    expect(rec.stdout.join("\n")).toMatch(/--day/);
    expect(rec.stdout.join("\n")).toMatch(/--root/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("runIngestCli — edge cases", () => {
  it("parseArgv treats --help anywhere in argv as a help request", () => {
    expect(parseArgv(["--root", ROOT, "--help", "--symbol", "EURUSD"])).toEqual({
      kind: "help",
    });
  });

  it("usage banner names all three required flags", async () => {
    const { deps, rec } = makeDeps();
    await runIngestCli(["--help"], deps);
    const banner = rec.stdout.join("\n");
    expect(banner).toMatch(/--symbol/);
    expect(banner).toMatch(/--day/);
    expect(banner).toMatch(/--root/);
  });

  it("argv parsing ignores nothing — unknown flag fails even when all required flags are present", async () => {
    const { deps, rec } = makeDeps();
    const code = await runIngestCli(
      [
        "--symbol",
        "EURUSD",
        "--day",
        DAY,
        "--root",
        ROOT,
        "--turbo",
      ],
      deps,
    );
    expect(code).toBe(2);
    expect(rec.createClientCalls).toBe(0);
    expect(rec.openStoreCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("runIngestCli — breaking tests (parseArgv shape)", () => {
  it("rejects empty argv as missing-flag", () => {
    expectArgsError(() => parseArgv([]), { code: "missing-flag" });
  });

  it("rejects missing --symbol", () => {
    expectArgsError(
      () => parseArgv(["--day", DAY, "--root", ROOT]),
      { code: "missing-flag" },
    );
  });

  it("rejects missing --day", () => {
    expectArgsError(
      () => parseArgv(["--symbol", "EURUSD", "--root", ROOT]),
      { code: "missing-flag" },
    );
  });

  it("rejects missing --root", () => {
    expectArgsError(
      () => parseArgv(["--symbol", "EURUSD", "--day", DAY]),
      { code: "missing-flag" },
    );
  });

  it("rejects an unknown flag", () => {
    expectArgsError(
      () =>
        parseArgv([
          "--symbol",
          "EURUSD",
          "--day",
          DAY,
          "--root",
          ROOT,
          "--foo",
        ]),
      { code: "unknown-flag" },
    );
  });

  it("rejects --symbol as the last token (no value)", () => {
    expectArgsError(
      () => parseArgv(["--day", DAY, "--root", ROOT, "--symbol"]),
      { code: "missing-value" },
    );
  });

  it("rejects --day with another flag where its value should be", () => {
    expectArgsError(
      () =>
        parseArgv([
          "--symbol",
          "EURUSD",
          "--day",
          "--root",
          ROOT,
        ]),
      { code: "missing-value" },
    );
  });

  it("rejects a duplicate --symbol", () => {
    expectArgsError(
      () =>
        parseArgv([
          "--symbol",
          "EURUSD",
          "--symbol",
          "USDJPY",
          "--day",
          DAY,
          "--root",
          ROOT,
        ]),
      { code: "duplicate-flag" },
    );
  });

  it("rejects a positional argument", () => {
    expectArgsError(
      () =>
        parseArgv([
          "stray",
          "--symbol",
          "EURUSD",
          "--day",
          DAY,
          "--root",
          ROOT,
        ]),
      { code: "positional-arg" },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("runIngestCli — breaking tests (runIngestCli propagation)", () => {
  it("argv error → exit 2, no client/store touched, stderr non-empty, no stats on stdout", async () => {
    const { deps, rec } = makeDeps();

    const code = await runIngestCli([], deps);

    expect(code).toBe(2);
    expect(rec.createClientCalls).toBe(0);
    expect(rec.openStoreCalls).toEqual([]);
    expect(rec.stderr.length).toBeGreaterThan(0);
    // Final stats line never written.
    for (const line of rec.stdout) {
      expect(line.startsWith("{")).toBe(false);
    }
  });

  it("phase=date → exit 1, stderr names the phase", async () => {
    const { deps, rec } = makeDeps();

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", "not-a-date", "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("date");
    // Date validation runs before openStore, so the store is never opened.
    expect(rec.openStoreCalls).toEqual([]);
  });

  it("phase=symbol → exit 1, stderr names the phase", async () => {
    const { deps, rec } = makeDeps();

    const code = await runIngestCli(
      ["--symbol", "ZZZBOGUS", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("symbol");
    expect(rec.openStoreCalls).toEqual([]);
  });

  it("phase=open → exit 1, stderr names the phase", async () => {
    const failingOpener: OpenDuckDbBarStore = async () => {
      throw new BarStoreError("disk full", { phase: "open" });
    };
    const { deps, rec } = makeDeps({ openStore: failingOpener });

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("open");
    expect(rec.openStoreCalls).toEqual([ROOT]);
  });

  it("phase=ingest → exit 1, stderr names the phase, store still closed", async () => {
    const fakeStore = makeFakeStore();
    const opener: OpenDuckDbBarStore = async () => fakeStore.store;
    const failingClient = makeFakeClient({
      error: new Error("network down"),
    });
    const { deps, rec } = makeDeps({
      client: failingClient.client,
      openStore: opener,
    });

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("ingest");
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("phase=close → exit 1, stderr names the phase", async () => {
    const fakeStore = makeFakeStore({
      closeError: new BarStoreError("file lock stuck", { phase: "closed" }),
    });
    const opener: OpenDuckDbBarStore = async () => fakeStore.store;
    const { deps, rec } = makeDeps({ openStore: opener });

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("close");
    expect(fakeStore.closeCount()).toBe(1);
  });

  it("on phase=ingest, ingest's IngestError appears somewhere in the stderr trail (cause chain visible)", async () => {
    const ingestErr = new IngestError("fetch boom", {
      phase: "fetch",
      hourMs: DAY_START,
    });
    const fakeStore = makeFakeStore();
    const opener: OpenDuckDbBarStore = async () => fakeStore.store;
    const failingClient: DukascopyClient = {
      async fetchHour() {
        throw ingestErr;
      },
    };
    const { deps, rec } = makeDeps({
      client: failingClient,
      openStore: opener,
    });

    const code = await runIngestCli(
      ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      deps,
    );

    expect(code).toBe(1);
    expect(rec.stderr.join("\n")).toContain("ingest");
    // The user must be able to see *why* the ingest failed without an
    // instanceof walk: cause chain content is on stderr.
    expect(rec.stderr.join("\n")).toContain("fetch");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("runIngestCli — invariants (property-style)", () => {
  it("the returned exit code is always 0, 1, or 2", async () => {
    const scenarios: Array<() => Promise<number>> = [
      // 0 — happy.
      async () => {
        const { deps } = makeDeps();
        return runIngestCli(
          ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
          deps,
        );
      },
      // 0 — help.
      async () => {
        const { deps } = makeDeps();
        return runIngestCli(["--help"], deps);
      },
      // 1 — runner failure (bad symbol).
      async () => {
        const { deps } = makeDeps();
        return runIngestCli(
          ["--symbol", "ZZZBOGUS", "--day", DAY, "--root", ROOT],
          deps,
        );
      },
      // 2 — argv failure.
      async () => {
        const { deps } = makeDeps();
        return runIngestCli([], deps);
      },
    ];
    for (const scenario of scenarios) {
      const code = await scenario();
      expect([0, 1, 2]).toContain(code);
    }
  });

  it("any non-zero exit writes to stderr; any zero exit does not", async () => {
    const scenarios: Array<{ argv: string[]; expectedZero: boolean }> = [
      { argv: ["--help"], expectedZero: true },
      { argv: ["--symbol", "EURUSD", "--day", DAY, "--root", ROOT], expectedZero: true },
      { argv: ["--symbol", "ZZZBOGUS", "--day", DAY, "--root", ROOT], expectedZero: false },
      { argv: [], expectedZero: false },
      { argv: ["--unknown"], expectedZero: false },
    ];
    for (const { argv, expectedZero } of scenarios) {
      const { deps, rec } = makeDeps();
      const code = await runIngestCli(argv, deps);
      if (expectedZero) {
        expect(code).toBe(0);
        expect(rec.stderr).toEqual([]);
      } else {
        expect(code).not.toBe(0);
        expect(rec.stderr.length).toBeGreaterThan(0);
      }
    }
  });

  it("createClient is never called on an argv failure", async () => {
    const argvFailures: string[][] = [
      [],
      ["--symbol"],
      ["--unknown"],
      ["positional", "--symbol", "EURUSD", "--day", DAY, "--root", ROOT],
      ["--symbol", "EURUSD", "--symbol", "USDJPY", "--day", DAY, "--root", ROOT],
    ];
    for (const argv of argvFailures) {
      const { deps, rec } = makeDeps();
      await runIngestCli(argv, deps);
      expect(rec.createClientCalls).toBe(0);
      expect(rec.openStoreCalls).toEqual([]);
    }
  });
});
