# Hindsight — Development method

This document is the **how**. For the **what** and the **why**, read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first.

The rule is: **every feature ships as a small, reviewable slice, and every slice ships tests before code.** No exceptions, including for "obviously trivial" code — the USD-quoted lot-size calculator in `src/shared/sizing.ts` was trivial too, and its test file is still almost twice the size of its implementation. That is the target ratio.

---

## 1. The unit of work: a "slice"

A slice is the smallest thing that is:

1. **Independently useful** — after it lands, the app is strictly more capable than before.
2. **Independently testable** — it has a clean input/output surface you can call from a test without booting Electron, Vite, or a UI.
3. **Independently reviewable** — one PR, readable in ~15 minutes, ideally < ~400 lines diff including tests.

Milestones in `ARCHITECTURE.md` (M0–M8) are *not* slices. They're collections of slices. Before opening the editor on a milestone, break it into a numbered slice list in the PR description or a milestone doc.

### Good slice examples

- "Instrument catalog: add USD/JPY with cross-rate-aware pip value."
- "Replay clock: play/pause with configurable speed, pure (no chart yet)."
- "Dukascopy adapter: download one (symbol, year) to a local `.bi5` tree, with retry + resume."
- "Parquet writer: build a 1s-OHLCV Parquet file from an async iterator of ticks."
- "Paper broker: market order fills at next bar open, positions/P&L updated, no swaps yet."

### Bad slice examples (too big)

- "Implement the replay engine." → 6+ slices.
- "Wire up Electron and the chart." → Electron shell, preload+IPC, chart mount, data bridge — at least 4.
- "Paper broker." → orders, positions, fills, P&L, margin, swap — each a slice.

### Bad slice examples (too small)

- "Add a type alias." → fold into the slice that needs it.
- "Rename a variable." → not a slice, just a commit.

---

## 2. The workflow, per slice

Each slice goes through exactly these phases, in order. Do not skip ahead.

### Phase 1 — Design note (before any code)

A short written description, either in the PR description draft or a sticky comment. Covers:

- **Purpose.** One sentence: what this slice makes possible.
- **Inputs.** Types and units (USD? pips? Unix ms?). Who calls this.
- **Outputs.** Types, units, and invariants (e.g. "realised risk ≤ intended risk").
- **Failure modes.** What inputs are illegal, and what error type is thrown. NaN, Infinity, negatives, zeros, out-of-domain enums, I/O errors — list them explicitly.
- **Non-goals.** What this slice deliberately does *not* handle. (e.g. "non-USD quotes throw — that's M1".)
- **Module placement.** `shared/`, `main/`, or `renderer/`? If it touches I/O, what adapter interface hides it?

This note is the contract. Reviewers hold the code to it, and the tests in Phase 2 encode it.

### Phase 2 — Tests first

Write the test file (`foo.test.ts`) next to where `foo.ts` will live. Do not write `foo.ts` yet — not even the export signature stubs. Let TypeScript complain; the test file drives the shape of the API.

A slice's test file has **four categories**, each as its own `describe` block. Use these names verbatim for consistency:

| `describe` block | What it proves | Typical count |
| --- | --- | --- |
| `— core behaviour` | The happy path with concrete, hand-computed expected values. No "assert it runs" tests. | 3–10 |
| `— edge cases` | Boundary rounding, clamps, empty inputs, min/max, off-by-one risks. | 3–8 |
| `— breaking tests (must throw / must not happen)` | Everything the module must *refuse* to do. NaN, Infinity, negatives, illegal enum values, invariant violations. | 5–15 |
| `— invariants (property-style)` | Loops over a grid of inputs and asserts properties that must hold for all of them. | 1–3 |

**Breaking tests are not optional.** Half of the real defects in a trading tool are "the system did something it should have refused to do" — oversized lots, trades during a halted market, indicator reading bars past the replay cursor. Every slice writes down in executable form what it refuses to do.

**Integration tests** live alongside unit tests, in the same test file or a sibling `foo.integration.test.ts`, whenever the slice crosses a real boundary (filesystem, SQLite, DuckDB, Parquet, child process). They use real I/O into a `tmpdir` — no mocks of the filesystem. See §4.

Example of what a good test file looks like today: [`src/shared/sizing.test.ts`](./src/shared/sizing.test.ts). Note the four blocks, the hand-computed numbers (not `toMatchSnapshot`), and the property sweep at the bottom.

### Phase 3 — Red

Run `npm test`. Every new test must fail, with a clear error. If a test passes before you've written the implementation, it's a bad test — fix it.

### Phase 4 — Implement

Write the minimum code needed to turn every test green. No extra public exports. No "while I'm here" refactors of unrelated code — those are separate PRs.

Stop coding the moment the tests pass. Do not add untested branches "just in case".

### Phase 5 — Green, then invariant-check

All tests green. Then, before opening the PR, walk through the test list and ask: *which property that I described in the design note is not covered by at least one test?* Add it. Re-run.

### Phase 6 — Definition of Done checklist

A slice is done when **all** of these are true:

- [ ] Design note exists and matches the code.
- [ ] All four `describe` blocks present (even if one has a single test).
- [ ] Breaking tests cover NaN, Infinity, zero, negative, and out-of-domain inputs for every numeric/enum parameter.
- [ ] No `// TODO`, `// FIXME`, or `console.log` in the committed code.
- [ ] `npm test` green.
- [ ] `npm run typecheck` green. No new `any`, no new `@ts-expect-error`, no new `@ts-ignore`.
- [ ] The slice does not import from layers above it (`shared/` never imports from `main/` or `renderer/`; `main/` never imports from `renderer/`).
- [ ] If the slice added a dependency, the dependency is pinned per the rules in `ARCHITECTURE.md` → "Technology stack".
- [ ] Public API has TSDoc on every exported name, including units (USD, pips, ms, etc.).

Anything unchecked → not mergeable.

---

## 3. Test categories in detail

### Unit tests

- Live next to the module: `foo.ts` → `foo.test.ts`.
- Test **one module at a time**. If a unit test of `foo` fails because `bar` is broken, the test is wrong — inject `bar` as a fake.
- Prefer hand-computed expected values over snapshots. "0.20 lots, $2/pip, $100 risk" is reviewable; a 600-byte snapshot is not.

### Breaking tests

- Phrased as "must throw" or "must not happen".
- Use a typed error class per failure mode (e.g. `InvalidSizingInputError`, `UnsupportedQuoteCurrencyError`, `NoPeekingViolationError`). Assert with `.toThrow(SpecificErrorClass)`, not just `.toThrow()`.
- For the replay engine specifically, there is a **dedicated "no-peeking" breaking test category** — see §5.

### Integration tests

- Any slice that touches the filesystem, SQLite, DuckDB, Parquet, or spawns `dukascopy-node` has integration tests.
- Use `fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-"))` per test, clean it in `afterEach`. Never share a tmpdir between tests.
- Never mock `fs`, `sqlite`, or `duckdb`. Use real instances against tmpdirs. These tools are fast and mocks drift from reality.
- External network calls (Dukascopy) are behind an adapter interface; integration tests use a canned-response fake of the adapter, not real HTTP. A separate, opt-in test (`npm test -- --run -t "@network"`, or similar gating) hits the real network; it's informational and never required green for merge.

### Invariant / property tests

- Small hand-rolled grid loops are fine and often clearer than a property-based library. The `positionSize` sweep in `sizing.test.ts` is the template.
- If a slice's output space is large or structural (e.g. order books), reach for [`fast-check`](https://github.com/dubzzz/fast-check). Add it only then.
- Every financial slice has at least one invariant test. Examples: "realised risk ≤ intended risk", "sum of position P&L + cash = equity", "bar count after aggregation = ceil(input bars / ratio)".

---

## 4. The adapter pattern for I/O-bound modules

Pure logic lives in `src/shared/` and is unit-testable synchronously. Anything that touches the outside world is split in two:

```
src/main/data/
├── dukascopy.ts              ← DukascopyClient interface + real impl
├── dukascopy.test.ts         ← tests the real impl against a local fixture server (integration)
├── downloader.ts             ← orchestrator: takes a DukascopyClient
└── downloader.test.ts        ← tests orchestrator with a FakeDukascopyClient (unit)
```

The orchestrator never `import`s the real client directly — it takes it as a constructor argument or factory. This makes the orchestrator's unit tests trivial and the real client's integration tests focused on the wire protocol only.

Rule of thumb: **if a module has both I/O and logic, split it.** The logic half gets unit tests with a fake; the I/O half gets integration tests against a real instance in a tmpdir.

---

## 5. The "no-peeking" rule — a special-case test category

Per `ARCHITECTURE.md`, the replay engine must make it structurally impossible for any consumer to see market data past the current replay cursor. Starting at M3, every slice that reads market data adds a breaking test of the form:

```ts
it("refuses to return bars past the cursor", () => {
  const store = makeStoreWith(bars);
  const cursor = someTimestamp;
  expect(() => store.query({ symbol, from: cursor + 1, to: cursor + 1000 }, { cursor }))
    .toThrow(NoPeekingViolationError);
});
```

And every indicator / drawing / order slice adds a test that it does *not* observe a change when a future bar is appended to the store while the cursor is held.

No slice that reads market data is mergeable without both tests.

---

## 6. Commit / PR conventions

- **One slice per PR.** If you opened two, split them.
- **Commit title:** `<area>: <imperative present-tense summary>`, e.g. `sizing: add USD/JPY support via cross rate`. Lowercase area; area matches a directory under `src/`.
- **Commit body:** reference the design note (paste it if it isn't captured elsewhere). Call out anything a reviewer might miss.
- **Tests and implementation land in the same commit.** Not two commits, not one PR with two commits. The test file's git blame should always align with the implementation's git blame.
- **No merge commits on `main`.** Rebase and fast-forward.

---

## 7. What *not* to do

These are anti-patterns that will get caught in review:

- Writing `foo.ts` before `foo.test.ts`. If the tests came after, it's not TDD, and reviewers will ask you to redo it.
- `toMatchSnapshot` for numeric results. Always hand-compute.
- Catching an error with `.toThrow()` and no error class. Always assert the class.
- "Smoke tests" that only assert a function returned something truthy.
- A single monolithic test like `it("works", () => { /* 80 lines */ })`.
- Adding a dependency without updating the "Technology stack" table in `ARCHITECTURE.md`.
- Editing anything in `src/shared/` that causes it to import from `electron`, `node:fs`, `better-sqlite3`, `duckdb`, or any `renderer/` module. `shared/` stays pure.
- Mocking `fs`, `sqlite`, `duckdb`, or the system clock inside `shared/`. If a `shared/` module needs time, take a `now: () => number` parameter and pass a real clock in production, a fake in tests.
- Committing any file matched by `.gitignore` — especially `*.bi5`, `*.parquet`, `*.sqlite`, or anything under `data/`.

---

## 8. Milestone playbook (how M0 became M0)

M0 was carved into three slices, which is the kind of breakdown every future milestone starts with:

1. **Repo scaffold + test runner.** `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/` skeleton. No production code, but `npm test` runs and reports "no tests found" cleanly.
2. **Instrument catalog (USD-quoted only).** `src/shared/instruments.ts` with a frozen `INSTRUMENTS` map, `getInstrument()`, and `UnknownInstrumentError`. Tests: catalog-shape invariant ("all quotes are USD"), and `getInstrument` throwing on unknown symbols.
3. **Lot-size calculator.** `src/shared/sizing.ts` + `sizing.test.ts` as currently committed.

When starting M1, the first deliverable is the slice list, posted for review *before* any code.

---

## 9. Tooling summary

| Command | Use |
| --- | --- |
| `npm test` | Run the full suite once (CI-style). |
| `npm run test:watch` | TDD inner loop. |
| `npm run typecheck` | `tsc --noEmit`; must be green before a PR. |

CI (when added) runs `npm test && npm run typecheck` on Node 22 and 24 on Windows. Slices that don't pass both don't merge.
