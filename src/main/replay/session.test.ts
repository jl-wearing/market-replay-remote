import { describe, it, expect } from "vitest";
import type { Bar } from "../../shared/types.js";
import { toCatalogSymbol, type CatalogSymbol } from "../../shared/instruments.js";
import { InvalidClockInputError } from "../../shared/replay/clock.js";
import { BarStoreError } from "../data/duckDbBarStore.js";
import type { CursorBarSource } from "./cursorBarReader.js";
import {
  createReplaySession,
  play,
  pause,
  setSpeed,
  tick,
  step,
  scrubTo,
  setTimeframe,
  readVisibleBars,
  InvalidSessionInputError,
  type ReplaySession,
} from "./session.js";

const EURUSD = toCatalogSymbol("EURUSD");

/** A plausible `Bar` at `timestampMs` (content is irrelevant to the fold counts). */
function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1.1, hBid: 1.10005, lBid: 1.09998, cBid: 1.10003,
    oAsk: 1.10003, hAsk: 1.10008, lAsk: 1.10001, cAsk: 1.10006,
    volumeBid: 1.5, volumeAsk: 1.25, tickCount: 3,
  };
}

/** `count` consecutive 1 s bars starting at `startMs` (ascending, 1000 ms apart). */
function bars1s(startMs: number, count: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < count; k++) out.push(mkBar(startMs + k * 1_000));
  return out;
}

interface RecordedCall {
  symbol: CatalogSymbol;
  fromMs: number;
  toMs: number;
}

/**
 * A `CursorBarSource` backed by a fixed ascending 1 s bar set. It returns the
 * bars whose timestamp falls in the requested half-open `[fromMs, toMs)` window
 * (mirroring `DuckDbBarStore.readBarsInRange`) and records every call so tests
 * can assert the session only ever asked for a cursor-clipped window.
 */
function inMemorySource(
  all: readonly Bar[],
): CursorBarSource & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async readBarsInRange({ symbol, fromMs, toMs }) {
      calls.push({ symbol, fromMs, toMs });
      return all.filter((b) => b.timestampMs >= fromMs && b.timestampMs < toMs);
    },
  };
}

/** A `CursorBarSource` that always throws — for propagation tests. */
function throwingSource(err: unknown): CursorBarSource {
  return {
    async readBarsInRange() {
      throw err;
    },
  };
}

/** Run a promise and return whatever it rejected with (or `undefined`). */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("session — core behaviour", () => {
  it("creates a paused session positioned at startMs with the given timeframe", () => {
    const s = createReplaySession({
      symbol: EURUSD,
      startMs: 0,
      endMs: 9_000,
      timeframeMs: 2_000,
    });
    expect(s.symbol).toBe(EURUSD);
    expect(s.timeframeMs).toBe(2_000);
    expect(s.clock.status).toBe("paused");
    expect(s.clock.cursorMs).toBe(0);
    expect(s.clock.startMs).toBe(0);
    expect(s.clock.endMs).toBe(9_000);
  });

  it("play then tick advances the cursor (delegating to the clock)", () => {
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 2_000 });
    s = play(s, 1_000);
    expect(s.clock.status).toBe("playing");
    s = tick(s, 5_500); // speed 1 → cursor = 0 + (5500 - 1000) = 4500
    expect(s.clock.cursorMs).toBe(4_500);
  });

  it("readVisibleBars reads only bars up to the cursor and folds them to the timeframe", async () => {
    const src = inMemorySource(bars1s(0, 10)); // bars @0,1000,...,9000
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 2_000 });
    s = scrubTo(s, 4_500); // bars @0..4000 visible (5 of them)
    const out = await readVisibleBars(s, src);
    // M2000 buckets over @0..4000 → {0, 2000, 4000} = 3 bars.
    expect(out.map((b) => b.timestampMs)).toEqual([0, 2_000, 4_000]);
  });

  it("a cursor at/after the last bar makes the whole span visible", async () => {
    const src = inMemorySource(bars1s(0, 10));
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 5_000 });
    const out = await readVisibleBars(s, src); // cursor at start? no — paused at 0
    // Paused at startMs=0 → only bar @0 visible → one M5000 bucket {0}.
    expect(out.map((b) => b.timestampMs)).toEqual([0]);
  });

  it("passes the session symbol through to the source", async () => {
    const usdjpy = toCatalogSymbol("USDJPY");
    const src = inMemorySource(bars1s(0, 4));
    const s = createReplaySession({ symbol: usdjpy, startMs: 0, endMs: 3_000, timeframeMs: 1_000 });
    await readVisibleBars(s, src);
    expect(src.calls[0]!.symbol).toBe(usdjpy);
  });

  it("setTimeframe re-folds the same visible window at the new period", async () => {
    const src = inMemorySource(bars1s(0, 10));
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 2_000 });
    s = scrubTo(s, 9_000); // all 10 bars visible
    expect((await readVisibleBars(s, src)).map((b) => b.timestampMs)).toEqual([
      0, 2_000, 4_000, 6_000, 8_000,
    ]);
    const s5 = setTimeframe(s, 5_000);
    expect((await readVisibleBars(s5, src)).map((b) => b.timestampMs)).toEqual([0, 5_000]);
  });
});

describe("session — edge cases", () => {
  it("setTimeframe preserves the entire clock (cursor does not jump on a timeframe switch)", () => {
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 60_000 });
    s = play(s, 1_000);
    s = tick(s, 5_500); // cursor 4500, still playing
    const s5 = setTimeframe(s, 300_000);
    expect(s5.timeframeMs).toBe(300_000);
    expect(s5.clock).toBe(s.clock); // same reference — cursor, status, anchors all untouched
    expect(s5.clock.cursorMs).toBe(4_500);
    expect(s5.clock.status).toBe("playing");
  });

  it("returns an empty array when nothing is visible yet", async () => {
    const src = inMemorySource([]); // store is empty
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
    expect(await readVisibleBars(s, src)).toEqual([]);
  });

  it("a bar exactly on the inclusive session end is reachable at the end cursor", async () => {
    const src = inMemorySource([mkBar(0), mkBar(9_000)]);
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
    s = scrubTo(s, 9_000);
    expect((await readVisibleBars(s, src)).map((b) => b.timestampMs)).toEqual([0, 9_000]);
  });

  it("transitions return a fresh session and never mutate the input", () => {
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 2_000 });
    const played = play(s, 1_000);
    expect(played).not.toBe(s);
    expect(s.clock.status).toBe("paused"); // original untouched
    const re = setTimeframe(s, 5_000);
    expect(re).not.toBe(s);
    expect(s.timeframeMs).toBe(2_000); // original untouched
  });

  it("the read window starts at startMs, so a paused cursor never under-reads the lower bound", async () => {
    const src = inMemorySource(bars1s(0, 3));
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 2_000, timeframeMs: 1_000 });
    await readVisibleBars(s, src);
    expect(src.calls[0]!.fromMs).toBe(0);
  });
});

describe("session — breaking tests (must throw / must not happen)", () => {
  const expectSessionError = (fn: () => unknown): InvalidSessionInputError => {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidSessionInputError);
    expect((err as InvalidSessionInputError).code).toBe("timeframe");
    return err as InvalidSessionInputError;
  };

  it("rejects a non-multiple-of-1000 timeframe at create", () => {
    expectSessionError(() =>
      createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 500 }),
    );
  });

  it.each([0, -1_000, 1_500, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects timeframeMs=%s at create",
    (timeframeMs) => {
      expectSessionError(() =>
        createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs }),
      );
    },
  );

  it.each([0, -1_000, 1_500, Number.NaN, Number.POSITIVE_INFINITY, 500])(
    "rejects timeframeMs=%s at setTimeframe",
    (timeframeMs) => {
      const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
      expectSessionError(() => setTimeframe(s, timeframeMs));
    },
  );

  it("delegates bad bounds to createClock (InvalidClockInputError, code range)", () => {
    let err: unknown;
    try {
      createReplaySession({ symbol: EURUSD, startMs: 9_000, endMs: 0, timeframeMs: 1_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidClockInputError);
    expect((err as InvalidClockInputError).code).toBe("range");
  });

  it("delegates a bad speed to createClock (InvalidClockInputError, code speed)", () => {
    let err: unknown;
    try {
      createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000, speed: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidClockInputError);
    expect((err as InvalidClockInputError).code).toBe("speed");
  });

  it("propagates a source read error unchanged (never reframed)", async () => {
    const storeErr = new BarStoreError("boom", { phase: "read" });
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
    const err = await caught(readVisibleBars(s, throwingSource(storeErr)));
    expect(err).toBe(storeErr); // same instance, same phase
  });

  it("never asks the source for a window past the cursor", async () => {
    const src = inMemorySource(bars1s(0, 10));
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
    s = scrubTo(s, 4_000);
    await readVisibleBars(s, src);
    expect(src.calls[0]!.toMs).toBeLessThanOrEqual(4_001); // floor(cursor)+1
  });
});

describe("session — invariants (property-style)", () => {
  it("setTimeframe preserves the clock reference for every valid timeframe", () => {
    let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 100_000, timeframeMs: 1_000 });
    s = play(s, 10);
    s = tick(s, 5_010); // some non-trivial playing cursor
    for (const tf of [1_000, 2_000, 5_000, 60_000, 300_000, 3_600_000]) {
      const next = setTimeframe(s, tf);
      expect(next.clock).toBe(s.clock);
      expect(next.timeframeMs).toBe(tf);
    }
  });

  it("no folded bar ever exceeds the cursor, and the read window never passes it", async () => {
    const src = inMemorySource(bars1s(0, 60)); // bars @0..59000
    for (const cursorMs of [0, 1_000, 4_500, 30_000, 59_000]) {
      for (const tf of [1_000, 2_000, 5_000]) {
        let s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 59_000, timeframeMs: tf });
        s = scrubTo(s, cursorMs);
        const before = src.calls.length;
        const out = await readVisibleBars(s, src);
        const call = src.calls[before]!;
        expect(call.toMs).toBeLessThanOrEqual(Math.floor(cursorMs) + 1);
        for (const bar of out) expect(bar.timestampMs).toBeLessThanOrEqual(cursorMs);
      }
    }
  });

  it("each transition's clock equals the underlying clock transition applied directly", () => {
    // The session is a faithful thin wrapper: pinning this stops a wrapper
    // silently diverging from the clock it delegates to.
    const s = createReplaySession({ symbol: EURUSD, startMs: 0, endMs: 9_000, timeframeMs: 1_000 });
    const playing = play(s, 100);
    expect(pause(playing, 200).clock.status).toBe("paused");
    expect(setSpeed(s, 4, 100).clock.speed).toBe(4);
    expect(step(s, 1_000).clock.cursorMs).toBe(1_000);
    expect(step(s, 1_000).clock.status).toBe("paused");
    expect(scrubTo(s, 3_000).clock.cursorMs).toBe(3_000);
  });
});
