import { describe, expect, it } from "vitest";
import type { Bar } from "../types.js";
import {
  resampleBars,
  InvalidResampleInputError,
  type ResampleErrorCode,
} from "./resample.js";

// 2024-01-15 10:00:00.000 UTC — a whole second, minute, and hour, so BASE is
// aligned to every timeframe under test and bucket maths stay predictable.
const BASE = Date.UTC(2024, 0, 15, 10, 0, 0, 0);
const SEC = 1_000;
const MIN = 60_000;
const FIVE_MIN = 300_000;
const HOUR = 3_600_000;

/** Build a 1 s `Bar` at `timestampMs` with plausible defaults. */
function bar(timestampMs: number, overrides: Partial<Bar> = {}): Bar {
  return {
    timestampMs,
    oBid: 1.10, hBid: 1.105, lBid: 1.095, cBid: 1.10,
    oAsk: 1.101, hAsk: 1.106, lAsk: 1.096, cAsk: 1.101,
    volumeBid: 1, volumeAsk: 1, tickCount: 1,
    ...overrides,
  };
}

/**
 * Deterministic synthetic 1 s bar series with consistent OHLC
 * (`h >= max(o,c)`, `l <= min(o,c)`), strictly-ascending timestamps, and
 * small integer volumes/tickCounts (exactly representable, so regroup sums
 * stay exact). Used by the property-style invariants.
 */
function syntheticBars(count: number, startMs: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const o = 1.1 + Math.sin(i / 5) * 0.01;
    const c = o + Math.cos(i / 3) * 0.002;
    const h = Math.max(o, c) + 0.0005 + (i % 7) * 0.0001;
    const l = Math.min(o, c) - 0.0005 - (i % 5) * 0.0001;
    bars.push({
      timestampMs: startMs + i * SEC,
      oBid: o, hBid: h, lBid: l, cBid: c,
      oAsk: o + 0.0002, hAsk: h + 0.0002, lAsk: l + 0.0002, cAsk: c + 0.0002,
      volumeBid: 1 + (i % 4), volumeAsk: 1 + (i % 3),
      tickCount: 1 + (i % 6),
    });
  }
  return bars;
}

/**
 * Assert a thunk throws `InvalidResampleInputError` with the expected `code`
 * (and `barIndex` when given). The bare class is not enough — a throw site
 * that forgets its `code`/`barIndex` must fail loudly here.
 */
function expectResampleError(
  fn: () => unknown,
  expected: { code: ResampleErrorCode; barIndex?: number },
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InvalidResampleInputError);
  const err = thrown as InvalidResampleInputError;
  expect(err.code).toBe(expected.code);
  if (expected.barIndex !== undefined) expect(err.barIndex).toBe(expected.barIndex);
}

describe("resampleBars — core behaviour", () => {
  it("empty input produces no bars", () => {
    expect(resampleBars([], MIN)).toEqual([]);
  });

  it("a single bar folds to its bucket with O/H/L/C and volumes preserved", () => {
    const [out] = resampleBars(
      [bar(BASE + 30_000, { oBid: 1.2, hBid: 1.25, lBid: 1.15, cBid: 1.22, volumeBid: 5, volumeAsk: 6, tickCount: 9 })],
      MIN,
    );
    expect(out).toBeDefined();
    expect(out!.timestampMs).toBe(BASE);
    expect(out!.oBid).toBe(1.2);
    expect(out!.hBid).toBe(1.25);
    expect(out!.lBid).toBe(1.15);
    expect(out!.cBid).toBe(1.22);
    expect(out!.volumeBid).toBe(5);
    expect(out!.volumeAsk).toBe(6);
    expect(out!.tickCount).toBe(9);
  });

  it("three bars in one minute fold into one M1 bar (open=first, close=last, H/L extremes, sums)", () => {
    const out = resampleBars(
      [
        bar(BASE + 0, { oBid: 1.10, hBid: 1.12, lBid: 1.09, cBid: 1.11, volumeBid: 2, volumeAsk: 3, tickCount: 4 }),
        bar(BASE + 1_000, { oBid: 1.11, hBid: 1.15, lBid: 1.08, cBid: 1.13, volumeBid: 5, volumeAsk: 1, tickCount: 6 }),
        bar(BASE + 2_000, { oBid: 1.13, hBid: 1.14, lBid: 1.10, cBid: 1.12, volumeBid: 1, volumeAsk: 2, tickCount: 5 }),
      ],
      MIN,
    );
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.timestampMs).toBe(BASE);
    expect(b.oBid).toBe(1.10); // first bar's open
    expect(b.cBid).toBe(1.12); // last bar's close
    expect(b.hBid).toBe(1.15); // max high
    expect(b.lBid).toBe(1.08); // min low
    expect(b.volumeBid).toBe(8);
    expect(b.volumeAsk).toBe(6);
    expect(b.tickCount).toBe(15);
  });

  it("bars spanning two minutes produce two M1 bars", () => {
    const out = resampleBars(
      [bar(BASE + 30_000, { cBid: 1.20 }), bar(BASE + 90_000, { oBid: 1.30 })],
      MIN,
    );
    expect(out.map((b) => b.timestampMs)).toEqual([BASE, BASE + MIN]);
    expect(out[0]!.cBid).toBe(1.20);
    expect(out[1]!.oBid).toBe(1.30);
  });

  it("folds to a 5-minute timeframe", () => {
    const out = resampleBars(
      [
        bar(BASE + 0),
        bar(BASE + 200_000), // 3:20 — first 5m bucket
        bar(BASE + 250_000), // 4:10 — first 5m bucket
        bar(BASE + 320_000), // 5:20 — second 5m bucket
      ],
      FIVE_MIN,
    );
    expect(out.map((b) => b.timestampMs)).toEqual([BASE, BASE + FIVE_MIN]);
    expect(out[0]!.tickCount).toBe(3);
    expect(out[1]!.tickCount).toBe(1);
  });
});

describe("resampleBars — edge cases", () => {
  it("period of 1 second is an identity fold (bars already on the 1 s grid)", () => {
    const bars = [bar(BASE + 0), bar(BASE + 1_000, { oBid: 1.2 }), bar(BASE + 2_000, { cBid: 1.3 })];
    expect(resampleBars(bars, SEC)).toEqual(bars);
  });

  it("sparse input emits no bar for empty buckets", () => {
    const out = resampleBars([bar(BASE + 0), bar(BASE + 185_000)], MIN); // 0:00 and 3:05
    expect(out.map((b) => b.timestampMs)).toEqual([BASE, BASE + 180_000]); // no minutes 1 or 2
  });

  it("a bar exactly on a bucket boundary belongs to the new bucket", () => {
    const out = resampleBars([bar(BASE + 59_000), bar(BASE + 60_000)], MIN);
    expect(out.map((b) => b.timestampMs)).toEqual([BASE, BASE + MIN]);
  });

  it("folds a whole hour into one H1 bar", () => {
    const bars = [bar(BASE + 0, { oBid: 1.0 }), bar(BASE + 1_800_000), bar(BASE + 3_599_000, { cBid: 1.9 })];
    const out = resampleBars(bars, HOUR);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestampMs).toBe(BASE);
    expect(out[0]!.oBid).toBe(1.0);
    expect(out[0]!.cBid).toBe(1.9);
  });

  it("high and low can come from a middle bar, not just open/close", () => {
    const out = resampleBars(
      [
        bar(BASE + 0, { hBid: 1.11, lBid: 1.10 }),
        bar(BASE + 1_000, { hBid: 1.20, lBid: 1.05 }), // extremes here
        bar(BASE + 2_000, { hBid: 1.12, lBid: 1.09 }),
      ],
      MIN,
    );
    expect(out[0]!.hBid).toBe(1.20);
    expect(out[0]!.lBid).toBe(1.05);
  });
});

describe("resampleBars — breaking tests (period)", () => {
  const one = [bar(BASE)];

  it("rejects a non-finite periodMs", () => {
    expectResampleError(() => resampleBars(one, Number.NaN), { code: "period" });
    expectResampleError(() => resampleBars(one, Number.POSITIVE_INFINITY), { code: "period" });
  });

  it("rejects a zero or negative periodMs", () => {
    expectResampleError(() => resampleBars(one, 0), { code: "period" });
    expectResampleError(() => resampleBars(one, -60_000), { code: "period" });
  });

  it("rejects a non-integer periodMs", () => {
    expectResampleError(() => resampleBars(one, 1_500.5), { code: "period" });
  });

  it("rejects a periodMs that is not a whole number of seconds", () => {
    expectResampleError(() => resampleBars(one, 1_500), { code: "period" });
    expectResampleError(() => resampleBars(one, 500), { code: "period" });
  });
});

describe("resampleBars — breaking tests (bar stream)", () => {
  it("rejects a non-finite price field, pointing at the offending bar", () => {
    expectResampleError(
      () => resampleBars([bar(BASE), bar(BASE + 1_000, { hBid: Number.POSITIVE_INFINITY })], MIN),
      { code: "bars", barIndex: 1 },
    );
    expectResampleError(
      () => resampleBars([bar(BASE, { cAsk: Number.NaN })], MIN),
      { code: "bars", barIndex: 0 },
    );
  });

  it("rejects a non-finite or negative volume", () => {
    expectResampleError(() => resampleBars([bar(BASE, { volumeBid: -1 })], MIN), { code: "bars", barIndex: 0 });
    expectResampleError(() => resampleBars([bar(BASE, { volumeAsk: Number.NaN })], MIN), { code: "bars", barIndex: 0 });
  });

  it("rejects a tickCount that is not an integer >= 1", () => {
    expectResampleError(() => resampleBars([bar(BASE, { tickCount: 0 })], MIN), { code: "bars", barIndex: 0 });
    expectResampleError(() => resampleBars([bar(BASE, { tickCount: 1.5 })], MIN), { code: "bars", barIndex: 0 });
  });

  it("rejects a non-integer or negative timestampMs", () => {
    expectResampleError(() => resampleBars([bar(BASE + 0.5)], MIN), { code: "bars", barIndex: 0 });
    expectResampleError(() => resampleBars([bar(-1_000)], MIN), { code: "bars", barIndex: 0 });
  });

  it("rejects non-strictly-ascending timestamps (equal or regressing)", () => {
    expectResampleError(() => resampleBars([bar(BASE), bar(BASE)], MIN), { code: "bars", barIndex: 1 });
    expectResampleError(() => resampleBars([bar(BASE + 2_000), bar(BASE + 1_000)], MIN), { code: "bars", barIndex: 1 });
  });
});

describe("resampleBars — invariants (property-style)", () => {
  const bars = syntheticBars(600, BASE); // 10 minutes of 1 s bars, BASE-aligned
  const periods = [SEC, MIN, FIVE_MIN, HOUR];

  it("conserves total volume and tickCount across every timeframe", () => {
    const sumIn = bars.reduce(
      (a, b) => ({ vb: a.vb + b.volumeBid, va: a.va + b.volumeAsk, tc: a.tc + b.tickCount }),
      { vb: 0, va: 0, tc: 0 },
    );
    for (const period of periods) {
      const out = resampleBars(bars, period);
      const sumOut = out.reduce(
        (a, b) => ({ vb: a.vb + b.volumeBid, va: a.va + b.volumeAsk, tc: a.tc + b.tickCount }),
        { vb: 0, va: 0, tc: 0 },
      );
      expect(sumOut).toEqual(sumIn);
    }
  });

  it("output is strictly ascending and aligned to the period; never more bars than input", () => {
    for (const period of periods) {
      const out = resampleBars(bars, period);
      expect(out.length).toBeLessThanOrEqual(bars.length);
      let prev = Number.NEGATIVE_INFINITY;
      for (const b of out) {
        expect(b.timestampMs % period).toBe(0);
        expect(b.timestampMs).toBeGreaterThan(prev);
        expect(b.tickCount).toBeGreaterThanOrEqual(1);
        prev = b.timestampMs;
      }
    }
  });

  it("preserves the first open and the last close end-to-end", () => {
    for (const period of periods) {
      const out = resampleBars(bars, period);
      expect(out[0]!.oBid).toBe(bars[0]!.oBid);
      expect(out[0]!.oAsk).toBe(bars[0]!.oAsk);
      expect(out.at(-1)!.cBid).toBe(bars.at(-1)!.cBid);
      expect(out.at(-1)!.cAsk).toBe(bars.at(-1)!.cAsk);
    }
  });

  it("is hierarchically composable: 1s->5m equals 1s->1m->5m", () => {
    const direct = resampleBars(bars, FIVE_MIN);
    const staged = resampleBars(resampleBars(bars, MIN), FIVE_MIN);
    expect(staged).toEqual(direct);
  });
});
