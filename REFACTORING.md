# Hindsight refactoring findings

Read-only analysis pass over `src/` and tests (as of 2026-06-30, after M3
slice 5). No code changed by this report — these are candidates to turn into
tests-first slices later (one commit each). Ranked by value-to-effort.

The two non-negotiables constrain every item below: each module owns its own
named error class (do **not** collapse error classes when deduplicating
validation), and `src/shared/` stays pure (no I/O, no imports from `main/`).

## High value

### 1. Numeric/bound validation idiom is copy-pasted across ~10 call sites
The `Number.isFinite(x) && Number.isInteger(x) && x >= 0` check (often plus
`x % ONE_HOUR_MS`) is hand-written, with its own throw, in:

- `shared/replay/clock.ts` `assertBound`
- `shared/replay/clip.ts` `assertRangeBound`
- `shared/bars/resample.ts` `assertPeriod` + `validateBar`
- `main/replay/session.ts` `assertTimeframe`
- `main/data/ingest.ts` `validateHourBound`
- `main/data/resumableIngest.ts` `validateHourBound`
- `main/data/duckDbBarStore.ts` `validateHourMs` / `validateRange` / `validateBarAt`

**Tension:** each module deliberately owns its own error class
(`InvalidClockInputError`, `BarStoreError`, …); that rule must not be collapsed
into one shared error. **Resolution that respects it:** put *pure boolean
predicates* in `src/shared` (e.g. `isNonNegativeInteger(x)`,
`isAlignedTo(x, step)`, `isFinitePositiveInteger(x)`) and let each module keep
its own `if (!isNonNegativeInteger(x)) throw new MyError(...)`. Removes the
repeated boolean logic (the part that drifts) while keeping error ownership and
messages local. Highest payoff, lowest risk.

### 2. `validateHourBound` / `validateRange` are byte-for-byte duplicated
`ingest.ts` and `resumableIngest.ts` are identical (both throw
`IngestError({ phase: "spec" })`). `resumableIngest.ts` already imports
`IngestError` from `ingest.ts` — it can import the validator too, or both move
to a shared `ingestSpec.ts`. ~20 lines of verbatim dup gone. Trivial and safe.

### 3. Store open→use→close lifecycle is duplicated between the two day-runners
`ingestDay.ts` (`ingestSymbolDay`) and `resumableIngestDay.ts`
(`resumableIngestSymbolDay`) share the same skeleton: `openStore`
(→ `phase: "open"`), `try { body } catch (→ phase: "ingest") } finally { close
(→ phase: "close", suppressed-if-already-failed) }`. Only the body and
deps-wiring differ. Extract a higher-order
`withOpenStore(root, openStore, async (store) => body)` that owns the lifecycle
+ phase-tagged `IngestRunError`s; each runner supplies just the body. Clean
template-method-via-HOF; removes the most error-prone duplicated control flow
(the finally/suppression logic).

### 4. `Bar`-invariant validation duplicated
`resample.ts` `validateBar` and `duckDbBarStore.ts` `validateBarAt` both check
the same `Bar` shape (finite OHLC, volumes >= 0, `tickCount` integer >= 1,
integer timestamp). The store adds the hour-window check on top. A shared
`assertValidBar(bar, index)` predicate/validator in `shared/` (thrown through
each module's own error) unifies the core checks.

## Medium value

### 5. Time constants redefined ~20 times
`ONE_HOUR_MS = 3_600_000` appears in ~15 files, `MS_PER_SECOND` in 4,
`ONE_DAY_MS` in 3 (src **and** tests). A `shared/time.ts` exporting these (and
reused by tests) removes the magic numbers and the risk of a typo'd constant.
Low risk; touches many files (mechanical).

### 6. Test `mkBar` fixture duplicated across 5 test files
`session.test.ts`, `session.integration.test.ts`, `cursorBarReader.test.ts`,
`cursorBarReader.integration.test.ts`, `duckDbBarStore.integration.test.ts`
each define a near-identical `mkBar(ts)`. A shared
`shared/testing/barFixtures.ts` (`mkBar`, `bars1s(start, count)`) unifies them.
Keep it test-only.

### 7. Ingest write path uses one awaited `INSERT` per bar
`duckDbBarStore.ts` `writeHour` loops `await connection.run(INSERT_BAR_SQL, …)`
per bar — the code's own comment flags the `@duckdb/node-api` `Appender` API as
~10x faster for bulk. The main lever for the full-year ingest acceptance pass;
ties to the load/perf-test and concurrency intentions. Worth a dedicated slice
**driven by a load test** (measure first), not a blind rewrite.

## Low value / tidy

### 8. Per-bar array allocation in the validation hot path
`duckDbBarStore.ts` `validateBarAt` builds a fresh 10-tuple `priceFields` array
*per bar* (3600 bars/hr × 8760 hr on a full year). `resample.ts` already does
this right with a module-level `PRICE_FIELDS` const. Hoist the store's array to
module scope to match. Micro-optimization, but free.

### 9. Fold-loop structural twins (note, lean toward leaving)
`aggregate.ts` `ticksToSecondBars` and `resample.ts` `resampleBars` share the
same bucket-fold skeleton (assign bucket, open/close/hi/lo/sum, sparse emit,
strictly-ascending guard). A generic fold *could* unify them, but the element
types (`Tick` vs `Bar`) and merge semantics differ enough that a generic
version likely reads worse than two clear kernels. **Recommendation: leave
as-is** — flagged for completeness, not endorsed.

### 10. Per-tick re-read in `readVisibleBars` — already a known, deferred item
`session.ts` re-reads `[startMs, cursor]` and re-folds every call. Intentionally
simple for now; the caching strategy already designates an append-only forward
replay-window cache as the measured-first optimization. Listed only so it is in
the same report — **not** something to do now.

## Suggested sequencing (if turned into slices)
1. #2 then #1 — pure, near-zero-risk, high dedup.
2. #4 then #3 — consolidate validation + lifecycle.
3. #5 / #6 — mechanical tidy.
4. #7 — its own load-test-driven performance slice.

Each follows the normal tests-first slice discipline and is one commit.
