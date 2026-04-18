import { describe, expect, it } from "vitest";
import type { Tick } from "../types.js";
import { InvalidTickStreamError, ticksToSecondBars } from "./aggregate.js";

// Base timestamp: 2024-01-15 10:00:00.000 UTC. Kept at a whole second so that
// `BASE` and `BASE + ms` both fall in predictable buckets.
const BASE = Date.UTC(2024, 0, 15, 10, 0, 0, 0);

function tick(overrides: Partial<Tick> & { timestampMs: number }): Tick {
  return {
    bid: 1.08540,
    ask: 1.08545,
    volumeBid: 1,
    volumeAsk: 1,
    ...overrides,
  };
}

describe("ticksToSecondBars — core behaviour", () => {
  it("empty input produces no bars", () => {
    expect(ticksToSecondBars([])).toEqual([]);
  });

  it("a single tick produces one bar with O=H=L=C equal to that tick", () => {
    const [bar] = ticksToSecondBars([
      tick({ timestampMs: BASE + 250, bid: 1.1, ask: 1.101, volumeBid: 3, volumeAsk: 4 }),
    ]);

    expect(bar).toBeDefined();
    expect(bar!.timestampMs).toBe(BASE);
    expect(bar!.oBid).toBe(1.1);
    expect(bar!.hBid).toBe(1.1);
    expect(bar!.lBid).toBe(1.1);
    expect(bar!.cBid).toBe(1.1);
    expect(bar!.oAsk).toBe(1.101);
    expect(bar!.hAsk).toBe(1.101);
    expect(bar!.lAsk).toBe(1.101);
    expect(bar!.cAsk).toBe(1.101);
    expect(bar!.volumeBid).toBe(3);
    expect(bar!.volumeAsk).toBe(4);
    expect(bar!.tickCount).toBe(1);
  });

  it("two ticks in the same second merge into one bar with correct O/H/L/C and summed volumes", () => {
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 100, bid: 1.10, ask: 1.101, volumeBid: 2, volumeAsk: 3 }),
      tick({ timestampMs: BASE + 900, bid: 1.11, ask: 1.111, volumeBid: 5, volumeAsk: 7 }),
    ]);
    expect(bars).toHaveLength(1);
    const b = bars[0]!;
    expect(b.timestampMs).toBe(BASE);
    expect(b.oBid).toBe(1.10);
    expect(b.cBid).toBe(1.11);
    expect(b.hBid).toBe(1.11);
    expect(b.lBid).toBe(1.10);
    expect(b.oAsk).toBe(1.101);
    expect(b.cAsk).toBe(1.111);
    expect(b.hAsk).toBe(1.111);
    expect(b.lAsk).toBe(1.101);
    expect(b.volumeBid).toBe(7);
    expect(b.volumeAsk).toBe(10);
    expect(b.tickCount).toBe(2);
  });

  it("two ticks in adjacent seconds produce two bars, one tick each", () => {
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 500, bid: 1.10, ask: 1.101 }),
      tick({ timestampMs: BASE + 1500, bid: 1.12, ask: 1.121 }),
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.timestampMs).toBe(BASE);
    expect(bars[1]!.timestampMs).toBe(BASE + 1000);
    expect(bars[0]!.oBid).toBe(1.10);
    expect(bars[1]!.oBid).toBe(1.12);
    expect(bars[0]!.tickCount).toBe(1);
    expect(bars[1]!.tickCount).toBe(1);
  });

  it("H and L track the extremes across 4 ticks in the same second", () => {
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 100, bid: 1.10, ask: 1.101 }),
      tick({ timestampMs: BASE + 300, bid: 1.15, ask: 1.152 }),  // hi bid + hi ask
      tick({ timestampMs: BASE + 500, bid: 1.05, ask: 1.053 }),  // lo bid + lo ask
      tick({ timestampMs: BASE + 900, bid: 1.12, ask: 1.122 }),  // close
    ]);
    expect(bars).toHaveLength(1);
    const b = bars[0]!;
    expect(b.oBid).toBe(1.10);
    expect(b.cBid).toBe(1.12);
    expect(b.hBid).toBe(1.15);
    expect(b.lBid).toBe(1.05);
    expect(b.oAsk).toBe(1.101);
    expect(b.cAsk).toBe(1.122);
    expect(b.hAsk).toBe(1.152);
    expect(b.lAsk).toBe(1.053);
    expect(b.tickCount).toBe(4);
  });

  it("gap seconds emit no bar (sparse series)", () => {
    // Ticks at BASE+100ms, BASE+5_200ms, BASE+5_800ms, BASE+12_000ms
    // Second buckets: BASE, BASE+5s, BASE+12s. Bar count: 3 (not 13).
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 100, bid: 1.0, ask: 1.0001 }),
      tick({ timestampMs: BASE + 5_200, bid: 1.1, ask: 1.1001 }),
      tick({ timestampMs: BASE + 5_800, bid: 1.2, ask: 1.2001 }),
      tick({ timestampMs: BASE + 12_000, bid: 1.3, ask: 1.3001 }),
    ]);
    expect(bars.map((b) => b.timestampMs - BASE)).toEqual([0, 5_000, 12_000]);
    expect(bars.map((b) => b.tickCount)).toEqual([1, 2, 1]);
  });
});

describe("ticksToSecondBars — edge cases", () => {
  it("tick at exact second boundary (timestampMs % 1000 === 0) floors to itself", () => {
    const [bar] = ticksToSecondBars([tick({ timestampMs: BASE })]);
    expect(bar!.timestampMs).toBe(BASE);
  });

  it("tick at timestampMs % 1000 === 999 floors to the second start", () => {
    const [bar] = ticksToSecondBars([tick({ timestampMs: BASE + 999 })]);
    expect(bar!.timestampMs).toBe(BASE);
  });

  it("bid === ask (zero spread) is preserved", () => {
    const [bar] = ticksToSecondBars([
      tick({ timestampMs: BASE + 10, bid: 1.5, ask: 1.5 }),
    ]);
    expect(bar!.oBid).toBe(1.5);
    expect(bar!.oAsk).toBe(1.5);
  });

  it("multiple ticks with identical timestampMs all aggregate into one bar", () => {
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 500, bid: 1.0, ask: 1.0001, volumeBid: 1, volumeAsk: 1 }),
      tick({ timestampMs: BASE + 500, bid: 1.01, ask: 1.0101, volumeBid: 2, volumeAsk: 2 }),
      tick({ timestampMs: BASE + 500, bid: 0.99, ask: 0.9901, volumeBid: 3, volumeAsk: 3 }),
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.tickCount).toBe(3);
    expect(bars[0]!.volumeBid).toBe(6);
    expect(bars[0]!.volumeAsk).toBe(6);
    expect(bars[0]!.hBid).toBe(1.01);
    expect(bars[0]!.lBid).toBe(0.99);
  });

  it("a 60 s gap produces exactly 2 bars, not 60", () => {
    const bars = ticksToSecondBars([
      tick({ timestampMs: BASE + 100 }),
      tick({ timestampMs: BASE + 60_100 }),
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[1]!.timestampMs - bars[0]!.timestampMs).toBe(60_000);
  });

  it("zero volumes round-trip to exactly zero", () => {
    const [bar] = ticksToSecondBars([
      tick({ timestampMs: BASE + 100, volumeBid: 0, volumeAsk: 0 }),
    ]);
    expect(bar!.volumeBid).toBe(0);
    expect(bar!.volumeAsk).toBe(0);
  });
});

describe("ticksToSecondBars — breaking tests (must throw)", () => {
  it("throws on NaN timestampMs", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: Number.NaN })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on Infinity timestampMs", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: Number.POSITIVE_INFINITY })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on NaN bid", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: BASE, bid: Number.NaN })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on Infinity bid", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, bid: Number.POSITIVE_INFINITY }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on NaN ask", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: BASE, ask: Number.NaN })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on Infinity ask", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, ask: Number.POSITIVE_INFINITY }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on NaN volumeBid", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, volumeBid: Number.NaN }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on NaN volumeAsk", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, volumeAsk: Number.NaN }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on Infinity volumeBid", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, volumeBid: Number.POSITIVE_INFINITY }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on Infinity volumeAsk", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE, volumeAsk: Number.POSITIVE_INFINITY }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on negative volumeBid", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: BASE, volumeBid: -1 })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on negative volumeAsk", () => {
    expect(() =>
      ticksToSecondBars([tick({ timestampMs: BASE, volumeAsk: -0.001 })]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on out-of-order timestamps (2nd tick earlier than 1st)", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE + 500 }),
        tick({ timestampMs: BASE + 400 }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("throws on a later out-of-order tick deep in the stream", () => {
    expect(() =>
      ticksToSecondBars([
        tick({ timestampMs: BASE + 100 }),
        tick({ timestampMs: BASE + 200 }),
        tick({ timestampMs: BASE + 150 }), // back in time
        tick({ timestampMs: BASE + 300 }),
      ]),
    ).toThrow(InvalidTickStreamError);
  });

  it("InvalidTickStreamError carries the offending tick index", () => {
    try {
      ticksToSecondBars([
        tick({ timestampMs: BASE }),
        tick({ timestampMs: BASE + 500, bid: Number.NaN }),
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTickStreamError);
      expect((err as InvalidTickStreamError).tickIndex).toBe(1);
    }
  });
});

describe("ticksToSecondBars — invariants (property-style)", () => {
  it("tick conservation: sum(bar.tickCount) === ticks.length over varied grids", () => {
    const grids: Tick[][] = [
      [],
      [tick({ timestampMs: BASE })],
      [
        tick({ timestampMs: BASE + 10 }),
        tick({ timestampMs: BASE + 20 }),
        tick({ timestampMs: BASE + 30 }),
      ],
      [
        tick({ timestampMs: BASE + 10 }),
        tick({ timestampMs: BASE + 1_010 }),
        tick({ timestampMs: BASE + 2_010 }),
      ],
      [
        tick({ timestampMs: BASE + 100 }),
        tick({ timestampMs: BASE + 5_200 }),
        tick({ timestampMs: BASE + 5_800 }),
        tick({ timestampMs: BASE + 12_000 }),
        tick({ timestampMs: BASE + 12_500 }),
        tick({ timestampMs: BASE + 12_999 }),
      ],
    ];
    for (const ticks of grids) {
      const bars = ticksToSecondBars(ticks);
      const totalTicks = bars.reduce((n, b) => n + b.tickCount, 0);
      expect(totalTicks).toBe(ticks.length);
    }
  });

  it("bar timestamps are strictly monotonically increasing and multiples of 1000", () => {
    const ticks: Tick[] = [];
    // Random-ish bursts across 20 seconds of a single hour.
    for (let s = 0; s < 20; s += 3) {
      const count = (s % 4) + 1;
      for (let k = 0; k < count; k++) {
        ticks.push(
          tick({ timestampMs: BASE + s * 1000 + k * 137 + 5 }),
        );
      }
    }
    const bars = ticksToSecondBars(ticks);
    for (let i = 0; i < bars.length; i++) {
      expect(bars[i]!.timestampMs % 1000).toBe(0);
      if (i > 0) {
        expect(bars[i]!.timestampMs).toBeGreaterThan(bars[i - 1]!.timestampMs);
      }
    }
  });

  it("O/H/L/C self-consistency: low <= open, close, high; high >= open, close; on both sides", () => {
    const ticks: Tick[] = [];
    // Ladder of prices across several seconds, mixed within each second.
    for (let s = 0; s < 5; s++) {
      for (let k = 0; k < 6; k++) {
        const offset = k * 137;
        const bid = 1.0 + (Math.sin(s * 7 + k) + 1) * 0.01;
        ticks.push(
          tick({
            timestampMs: BASE + s * 1000 + offset,
            bid,
            ask: bid + 0.0002,
          }),
        );
      }
    }
    const bars = ticksToSecondBars(ticks);
    for (const b of bars) {
      expect(b.lBid).toBeLessThanOrEqual(b.oBid);
      expect(b.lBid).toBeLessThanOrEqual(b.cBid);
      expect(b.lBid).toBeLessThanOrEqual(b.hBid);
      expect(b.hBid).toBeGreaterThanOrEqual(b.oBid);
      expect(b.hBid).toBeGreaterThanOrEqual(b.cBid);
      expect(b.lAsk).toBeLessThanOrEqual(b.oAsk);
      expect(b.lAsk).toBeLessThanOrEqual(b.cAsk);
      expect(b.lAsk).toBeLessThanOrEqual(b.hAsk);
      expect(b.hAsk).toBeGreaterThanOrEqual(b.oAsk);
      expect(b.hAsk).toBeGreaterThanOrEqual(b.cAsk);
      expect(b.volumeBid).toBeGreaterThanOrEqual(0);
      expect(b.volumeAsk).toBeGreaterThanOrEqual(0);
      expect(b.tickCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("volume conservation: sum of bar volumes == sum of tick volumes (per side)", () => {
    const ticks: Tick[] = [];
    for (let s = 0; s < 10; s++) {
      for (let k = 0; k < 4; k++) {
        ticks.push(
          tick({
            timestampMs: BASE + s * 1000 + k * 200,
            volumeBid: 0.5 + k * 0.25,
            volumeAsk: 1 + k,
          }),
        );
      }
    }
    const sumTickBid = ticks.reduce((n, t) => n + t.volumeBid, 0);
    const sumTickAsk = ticks.reduce((n, t) => n + t.volumeAsk, 0);
    const bars = ticksToSecondBars(ticks);
    const sumBarBid = bars.reduce((n, b) => n + b.volumeBid, 0);
    const sumBarAsk = bars.reduce((n, b) => n + b.volumeAsk, 0);
    expect(sumBarBid).toBeCloseTo(sumTickBid, 9);
    expect(sumBarAsk).toBeCloseTo(sumTickAsk, 9);
  });
});
