import { describe, it, expect } from "vitest";
import {
  clipRangeToCursor,
  InvalidClipInputError,
  NoPeekingViolationError,
  type ClipErrorCode,
} from "./clip.js";

/**
 * Assert a thunk throws `InvalidClipInputError` with the expected
 * discriminating `code`. Asserting the bare class is not enough — a throw
 * site that forgets its `code` must fail loudly here.
 */
function expectClipError(fn: () => unknown, expected: { code: ClipErrorCode }): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InvalidClipInputError);
  expect((thrown as InvalidClipInputError).code).toBe(expected.code);
}

/**
 * Assert a thunk throws `NoPeekingViolationError` carrying the offending
 * `fromMs` / `cursorMs`. The dedicated class is the discriminator here, but
 * the carried values are what a caller logs, so pin them too.
 */
function expectNoPeeking(
  fn: () => unknown,
  expected: { fromMs: number; cursorMs: number },
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(NoPeekingViolationError);
  expect((thrown as NoPeekingViolationError).fromMs).toBe(expected.fromMs);
  expect((thrown as NoPeekingViolationError).cursorMs).toBe(expected.cursorMs);
}

describe("replay clip — core behaviour", () => {
  it("leaves a range entirely at/before the cursor unchanged", () => {
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 2_000, cursorMs: 5_000 });
    expect(r).toEqual({ fromMs: 1_000, toMs: 2_000 });
  });

  it("clips toMs down to floor(cursor)+1 when the range extends past the cursor", () => {
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 10_000, cursorMs: 5_000 });
    // cursor 5000 inclusive -> exclusive upper bound 5001 (admits a bar at 5000)
    expect(r).toEqual({ fromMs: 1_000, toMs: 5_001 });
  });

  it("passes fromMs through unchanged regardless of clipping", () => {
    const r = clipRangeToCursor({ fromMs: 3_000, toMs: 10_000, cursorMs: 4_000 });
    expect(r.fromMs).toBe(3_000);
    expect(r.toMs).toBe(4_001);
  });

  it("a fractional cursor floors to the bar at or before it", () => {
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 10_000, cursorMs: 5_000.5 });
    // floor(5000.5)+1 = 5001 -> bar at 5000 is visible, 5001+ hidden
    expect(r).toEqual({ fromMs: 1_000, toMs: 5_001 });
  });

  it("a fractional cursor just below a bar hides that bar", () => {
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 10_000, cursorMs: 4_999.9 });
    // floor(4999.9)+1 = 5000 -> [.. , 5000) excludes the bar at 5000
    expect(r).toEqual({ fromMs: 1_000, toMs: 5_000 });
  });

  it("fromMs equal to an integer cursor yields a non-empty single-bar window", () => {
    const r = clipRangeToCursor({ fromMs: 5_000, toMs: 10_000, cursorMs: 5_000 });
    expect(r).toEqual({ fromMs: 5_000, toMs: 5_001 });
  });
});

describe("replay clip — edge cases", () => {
  it("a fractional cursor does not throw (slow-motion replay is legal)", () => {
    expect(() =>
      clipRangeToCursor({ fromMs: 0, toMs: 10_000, cursorMs: 1_234.567 }),
    ).not.toThrow();
  });

  it("cursor exactly at the requested toMs leaves the range unchanged", () => {
    // requested toMs 5000 is already <= floor(5000)+1 = 5001
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 5_000, cursorMs: 5_000 });
    expect(r).toEqual({ fromMs: 1_000, toMs: 5_000 });
  });

  it("a one-millisecond requested window survives clipping", () => {
    const r = clipRangeToCursor({ fromMs: 1_000, toMs: 1_001, cursorMs: 1_000 });
    expect(r).toEqual({ fromMs: 1_000, toMs: 1_001 });
  });

  it("cursor at zero with a zero fromMs admits the bar at zero", () => {
    const r = clipRangeToCursor({ fromMs: 0, toMs: 1_000, cursorMs: 0 });
    expect(r).toEqual({ fromMs: 0, toMs: 1 });
  });

  it("fromMs equal to a fractional cursor is allowed and clips to floor+1", () => {
    const r = clipRangeToCursor({ fromMs: 5_000, toMs: 10_000, cursorMs: 5_000.9 });
    expect(r).toEqual({ fromMs: 5_000, toMs: 5_001 });
  });

  it("handles large epoch-ms values without losing precision", () => {
    const from = 1_700_000_000_000;
    const r = clipRangeToCursor({ fromMs: from, toMs: from + 3_600_000, cursorMs: from + 100 });
    expect(r).toEqual({ fromMs: from, toMs: from + 101 });
  });
});

describe("replay clip — breaking tests (input validation)", () => {
  it("rejects a non-finite fromMs / toMs", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: Number.NaN, toMs: 1_000, cursorMs: 500 }), { code: "range" });
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, cursorMs: 500 }), { code: "range" });
    expectClipError(() => clipRangeToCursor({ fromMs: Number.NEGATIVE_INFINITY, toMs: 1_000, cursorMs: 500 }), { code: "range" });
  });

  it("rejects a non-integer fromMs / toMs", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: 100.5, toMs: 1_000, cursorMs: 500 }), { code: "range" });
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: 999.9, cursorMs: 500 }), { code: "range" });
  });

  it("rejects a negative fromMs / toMs", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: -1, toMs: 1_000, cursorMs: 500 }), { code: "range" });
    expectClipError(() => clipRangeToCursor({ fromMs: -2_000, toMs: -1_000, cursorMs: 500 }), { code: "range" });
  });

  it("rejects an empty or inverted range (fromMs >= toMs)", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: 1_000, toMs: 1_000, cursorMs: 5_000 }), { code: "range" });
    expectClipError(() => clipRangeToCursor({ fromMs: 2_000, toMs: 1_000, cursorMs: 5_000 }), { code: "range" });
  });

  it("rejects a non-finite cursorMs", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: 1_000, cursorMs: Number.NaN }), { code: "cursor" });
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: 1_000, cursorMs: Number.POSITIVE_INFINITY }), { code: "cursor" });
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: 1_000, cursorMs: Number.NEGATIVE_INFINITY }), { code: "cursor" });
  });

  it("rejects a negative cursorMs", () => {
    expectClipError(() => clipRangeToCursor({ fromMs: 0, toMs: 1_000, cursorMs: -1 }), { code: "cursor" });
  });
});

describe("replay clip — breaking tests (no peeking)", () => {
  it("throws when the whole range starts past an integer cursor", () => {
    expectNoPeeking(() => clipRangeToCursor({ fromMs: 6_000, toMs: 10_000, cursorMs: 5_000 }), {
      fromMs: 6_000,
      cursorMs: 5_000,
    });
  });

  it("throws when fromMs is one past an integer cursor", () => {
    expectNoPeeking(() => clipRangeToCursor({ fromMs: 5_001, toMs: 10_000, cursorMs: 5_000 }), {
      fromMs: 5_001,
      cursorMs: 5_000,
    });
  });

  it("throws when fromMs is past a fractional cursor", () => {
    expectNoPeeking(() => clipRangeToCursor({ fromMs: 5_001, toMs: 10_000, cursorMs: 5_000.5 }), {
      fromMs: 5_001,
      cursorMs: 5_000.5,
    });
  });
});

describe("replay clip — invariants (property-style)", () => {
  const froms = [0, 1_000, 5_000];
  const widths = [1, 1_000, 50_000];
  const cursors = [0, 999, 1_000, 1_000.5, 5_000, 5_000.4, 9_999, 60_000.7];

  it("non-peeking inputs yield a valid non-empty range within the request and at/before the cursor", () => {
    for (const fromMs of froms) {
      for (const width of widths) {
        const toMs = fromMs + width;
        for (const cursorMs of cursors) {
          if (fromMs > cursorMs) continue; // peeking — covered by breaking tests
          const r = clipRangeToCursor({ fromMs, toMs, cursorMs });
          expect(r.fromMs).toBe(fromMs);
          expect(r.toMs).toBeGreaterThan(r.fromMs); // non-empty half-open range
          expect(r.toMs).toBeLessThanOrEqual(toMs); // never widens the request
          expect(r.toMs).toBeLessThanOrEqual(Math.floor(cursorMs) + 1); // no peeking past cursor
        }
      }
    }
  });

  it("the maximum admitted bar timestamp never exceeds the cursor", () => {
    for (const fromMs of froms) {
      for (const cursorMs of cursors) {
        if (fromMs > cursorMs) continue;
        const r = clipRangeToCursor({ fromMs, toMs: fromMs + 50_000, cursorMs });
        const maxBarTs = r.toMs - 1; // largest integer t with t < toMs
        expect(maxBarTs).toBeLessThanOrEqual(cursorMs);
      }
    }
  });

  it("is idempotent: clipping an already-clipped range is a no-op", () => {
    for (const fromMs of froms) {
      for (const cursorMs of cursors) {
        if (fromMs > cursorMs) continue;
        const once = clipRangeToCursor({ fromMs, toMs: fromMs + 50_000, cursorMs });
        const twice = clipRangeToCursor({ ...once, cursorMs });
        expect(twice).toEqual(once);
      }
    }
  });

  it("is monotonic in the cursor: a later cursor never reveals fewer bars", () => {
    const ordered = [...cursors].sort((a, b) => a - b);
    for (const fromMs of froms) {
      let prevToMs = -1;
      for (const cursorMs of ordered) {
        if (fromMs > cursorMs) continue;
        const r = clipRangeToCursor({ fromMs, toMs: fromMs + 100_000, cursorMs });
        expect(r.toMs).toBeGreaterThanOrEqual(prevToMs);
        prevToMs = r.toMs;
      }
    }
  });
});
