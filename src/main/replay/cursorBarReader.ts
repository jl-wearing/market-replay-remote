/**
 * Cursor-clipped bar read — the data-layer "no peeking" read (M3 slice 3).
 *
 * Composes the pure {@link clipRangeToCursor} kernel (M3 slice 2) with a bar
 * store's range read so that a replay read can **never** return a bar whose
 * timestamp is past the replay cursor. This is where Hindsight's "no peeking"
 * non-negotiable is enforced against real stored data: the clip runs first, so
 * a malformed request or a request that reaches past the cursor is rejected
 * *before the store is touched*.
 *
 * The module owns **no error class of its own**. It is a thin composition:
 * - {@link clipRangeToCursor} owns input validation
 *   ({@link InvalidClipInputError}) and the no-peeking refusal
 *   ({@link NoPeekingViolationError}); both propagate unchanged.
 * - The injected {@link CursorBarSource} owns its own read failures (the
 *   DuckDB store throws `BarStoreError`); those propagate unchanged too.
 *
 * Reframing either layer's errors here would hide which layer actually failed,
 * so we deliberately do not (same contract as `aggregate.integration.test.ts`).
 *
 * The dependency is a narrow read port, not the full store, so the orchestrator
 * (M3 slice 5) and tests can inject the minimum surface; the real
 * `DuckDbBarStore` satisfies it structurally.
 */

import type { Bar } from "../../shared/types.js";
import type { CatalogSymbol } from "../../shared/instruments.js";
import { clipRangeToCursor } from "../../shared/replay/clip.js";

/**
 * The minimal read surface {@link readBarsUpToCursor} needs from a bar store:
 * a half-open, ascending range read. `DuckDbBarStore` satisfies this
 * structurally, so production passes the store directly and tests inject a
 * fake.
 */
export interface CursorBarSource {
  /**
   * Return all stored bars for `symbol` whose `timestampMs` falls in the
   * half-open interval `[fromMs, toMs)`, ordered by `timestampMs` ascending.
   */
  readBarsInRange(args: {
    symbol: CatalogSymbol;
    fromMs: number;
    toMs: number;
  }): Promise<Bar[]>;
}

/**
 * Read the bars for `symbol` in the requested half-open window `[fromMs, toMs)`
 * that the trader could legitimately see at `cursorMs` — i.e. with the future
 * tail clipped off so no bar past the cursor is ever returned.
 *
 * The requested window is clipped via {@link clipRangeToCursor} (cursor
 * inclusive; a fractional `cursorMs` is floored to the bar at or before it),
 * then the clipped range is read from `source`.
 *
 * @param source The bar store read port (the real `DuckDbBarStore` or a fake).
 * @param args.symbol   Catalog-validated instrument symbol.
 * @param args.fromMs   Requested lower bound, inclusive (integer >= 0 ms).
 * @param args.toMs     Requested upper bound, exclusive (integer > fromMs).
 * @param args.cursorMs Replay cursor (>= 0 ms; may be fractional).
 * @returns The clipped, ascending bars; `[]` when nothing is in range.
 * @throws {InvalidClipInputError} on malformed bounds/cursor (before any read).
 * @throws {NoPeekingViolationError} when `fromMs > cursorMs` (before any read).
 * @throws Whatever `source.readBarsInRange` throws (e.g. `BarStoreError`),
 *   unchanged.
 */
export async function readBarsUpToCursor(
  source: CursorBarSource,
  args: {
    symbol: CatalogSymbol;
    fromMs: number;
    toMs: number;
    cursorMs: number;
  },
): Promise<Bar[]> {
  const { symbol, fromMs, toMs, cursorMs } = args;
  const clipped = clipRangeToCursor({ fromMs, toMs, cursorMs });
  return source.readBarsInRange({
    symbol,
    fromMs: clipped.fromMs,
    toMs: clipped.toMs,
  });
}
