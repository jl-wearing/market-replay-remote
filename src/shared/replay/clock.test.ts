import { describe, it, expect } from "vitest";
import {
  createClock,
  play,
  pause,
  setSpeed,
  tick,
  step,
  scrubTo,
  InvalidClockInputError,
  type ClockErrorCode,
} from "./clock.js";

/**
 * Assert a thunk throws `InvalidClockInputError` with the expected
 * discriminating `code`. Asserting the bare class is not enough — a throw
 * site that forgets its `code` must fail loudly here.
 */
function expectClockError(fn: () => unknown, expected: { code: ClockErrorCode }): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InvalidClockInputError);
  expect((thrown as InvalidClockInputError).code).toBe(expected.code);
}

/** Standard 10-second replay session used across the happy-path tests. */
const SESSION = { startMs: 0, endMs: 10_000 } as const;

describe("replay clock — core behaviour", () => {
  it("createClock starts paused at startMs with the given speed", () => {
    const c = createClock({ ...SESSION, speed: 2, nowWallMs: 500 });
    expect(c.status).toBe("paused");
    expect(c.cursorMs).toBe(0);
    expect(c.speed).toBe(2);
    expect(c.startMs).toBe(0);
    expect(c.endMs).toBe(10_000);
  });

  it("createClock defaults speed to 1", () => {
    const c = createClock({ ...SESSION });
    expect(c.speed).toBe(1);
  });

  it("play then tick advances the cursor by elapsed wall time x speed", () => {
    let c = createClock({ ...SESSION, speed: 2 });
    c = play(c, 1_000);
    expect(c.status).toBe("playing");
    c = tick(c, 1_500);
    // 0 + (1500 - 1000) * 2 = 1000
    expect(c.cursorMs).toBe(1_000);
    expect(c.status).toBe("playing");
  });

  it("pause freezes the cursor at its projected position", () => {
    let c = createClock({ ...SESSION, speed: 2 });
    c = play(c, 1_000);
    c = pause(c, 1_300);
    // 0 + (1300 - 1000) * 2 = 600
    expect(c.cursorMs).toBe(600);
    expect(c.status).toBe("paused");
  });

  it("tick after pause is a no-op (frozen cursor)", () => {
    let c = createClock({ ...SESSION, speed: 2 });
    c = play(c, 1_000);
    c = pause(c, 1_300);
    c = tick(c, 9_999);
    expect(c.cursorMs).toBe(600);
    expect(c.status).toBe("paused");
  });

  it("setSpeed mid-play settles at the old speed then advances at the new one", () => {
    let c = createClock({ ...SESSION, speed: 1 });
    c = play(c, 1_000);
    c = setSpeed(c, 4, 2_000);
    // settled: 0 + (2000 - 1000) * 1 = 1000
    expect(c.cursorMs).toBe(1_000);
    expect(c.speed).toBe(4);
    c = tick(c, 2_100);
    // 1000 + (2100 - 2000) * 4 = 1400
    expect(c.cursorMs).toBe(1_400);
  });

  it("step forward moves the cursor by delta and pauses", () => {
    let c = createClock({ ...SESSION });
    c = step(c, 1_000);
    expect(c.cursorMs).toBe(1_000);
    expect(c.status).toBe("paused");
  });

  it("step backward subtracts delta", () => {
    let c = createClock({ ...SESSION });
    c = scrubTo(c, 5_000);
    c = step(c, -1_500);
    expect(c.cursorMs).toBe(3_500);
  });

  it("scrubTo sets the absolute cursor and pauses", () => {
    let c = createClock({ ...SESSION });
    c = play(c, 1_000);
    c = scrubTo(c, 7_000);
    expect(c.cursorMs).toBe(7_000);
    expect(c.status).toBe("paused");
  });

  it("playing resumes from the scrubbed position at the current speed", () => {
    let c = createClock({ ...SESSION, speed: 3 });
    c = scrubTo(c, 2_000);
    c = play(c, 5_000);
    c = tick(c, 5_100);
    // 2000 + (5100 - 5000) * 3 = 2300
    expect(c.cursorMs).toBe(2_300);
  });
});

describe("replay clock — edge cases", () => {
  it("clamps to endMs and auto-pauses when play overruns the session", () => {
    let c = createClock({ startMs: 0, endMs: 1_000, speed: 10 });
    c = play(c, 0);
    c = tick(c, 1_000);
    // raw 0 + 1000*10 = 10000, clamped to endMs
    expect(c.cursorMs).toBe(1_000);
    expect(c.status).toBe("paused");
  });

  it("step overshoot clamps to endMs", () => {
    let c = createClock({ startMs: 0, endMs: 1_000 });
    c = step(c, 5_000);
    expect(c.cursorMs).toBe(1_000);
  });

  it("step undershoot clamps to startMs", () => {
    let c = createClock({ startMs: 0, endMs: 1_000 });
    c = scrubTo(c, 500);
    c = step(c, -5_000);
    expect(c.cursorMs).toBe(0);
  });

  it("scrubTo to the exact bounds is allowed", () => {
    let c = createClock({ ...SESSION });
    c = scrubTo(c, 0);
    expect(c.cursorMs).toBe(0);
    c = scrubTo(c, 10_000);
    expect(c.cursorMs).toBe(10_000);
  });

  it("a zero-elapsed tick leaves the cursor unchanged", () => {
    let c = createClock({ ...SESSION, speed: 5 });
    c = play(c, 1_000);
    c = tick(c, 1_000);
    expect(c.cursorMs).toBe(0);
    expect(c.status).toBe("playing");
  });

  it("supports fractional (slow-motion) speed", () => {
    let c = createClock({ ...SESSION, speed: 0.5 });
    c = play(c, 0);
    c = tick(c, 1_000);
    // 0 + 1000 * 0.5 = 500
    expect(c.cursorMs).toBe(500);
  });

  it("setSpeed while paused changes speed without moving the cursor", () => {
    let c = createClock({ ...SESSION, speed: 1 });
    c = setSpeed(c, 3, 999);
    expect(c.speed).toBe(3);
    expect(c.cursorMs).toBe(0);
    expect(c.status).toBe("paused");
    c = play(c, 1_000);
    c = tick(c, 1_100);
    // 0 + (1100 - 1000) * 3 = 300
    expect(c.cursorMs).toBe(300);
  });

  it("pause while already paused is idempotent", () => {
    let c = createClock({ ...SESSION });
    c = scrubTo(c, 4_000);
    const again = pause(c, 8_000);
    expect(again.cursorMs).toBe(4_000);
    expect(again.status).toBe("paused");
  });
});

describe("replay clock — breaking tests (must throw / must not happen)", () => {
  it("rejects endMs <= startMs", () => {
    expectClockError(() => createClock({ startMs: 1_000, endMs: 1_000 }), { code: "range" });
    expectClockError(() => createClock({ startMs: 2_000, endMs: 1_000 }), { code: "range" });
  });

  it("rejects non-finite bounds", () => {
    expectClockError(() => createClock({ startMs: Number.NaN, endMs: 1_000 }), { code: "range" });
    expectClockError(() => createClock({ startMs: 0, endMs: Number.POSITIVE_INFINITY }), { code: "range" });
  });

  it("rejects non-integer or negative bounds", () => {
    expectClockError(() => createClock({ startMs: 1.5, endMs: 1_000 }), { code: "range" });
    expectClockError(() => createClock({ startMs: -1, endMs: 1_000 }), { code: "range" });
  });

  it("rejects speed <= 0, NaN, or Infinity", () => {
    expectClockError(() => createClock({ ...SESSION, speed: 0 }), { code: "speed" });
    expectClockError(() => createClock({ ...SESSION, speed: -1 }), { code: "speed" });
    expectClockError(() => createClock({ ...SESSION, speed: Number.NaN }), { code: "speed" });
    expectClockError(() => createClock({ ...SESSION, speed: Number.POSITIVE_INFINITY }), { code: "speed" });
  });

  it("setSpeed rejects an illegal new speed", () => {
    const c = createClock({ ...SESSION });
    expectClockError(() => setSpeed(c, 0, 100), { code: "speed" });
    expectClockError(() => setSpeed(c, Number.NaN, 100), { code: "speed" });
  });

  it("rejects a non-finite wall reading on play / tick / pause", () => {
    const c = createClock({ ...SESSION });
    expectClockError(() => play(c, Number.NaN), { code: "wall" });
    expectClockError(() => tick(c, Number.POSITIVE_INFINITY), { code: "wall" });
    expectClockError(() => pause(c, Number.NaN), { code: "wall" });
  });

  it("rejects wall time moving backward while playing", () => {
    let c = createClock({ ...SESSION });
    c = play(c, 1_000);
    expectClockError(() => tick(c, 500), { code: "wall" });
    expectClockError(() => pause(c, 500), { code: "wall" });
  });

  it("scrubTo rejects targets outside [startMs, endMs]", () => {
    const c = createClock({ ...SESSION });
    expectClockError(() => scrubTo(c, 10_001), { code: "scrub" });
    expectClockError(() => scrubTo(c, -1), { code: "scrub" });
  });

  it("scrubTo rejects non-finite or non-integer targets", () => {
    const c = createClock({ ...SESSION });
    expectClockError(() => scrubTo(c, Number.NaN), { code: "scrub" });
    expectClockError(() => scrubTo(c, 100.5), { code: "scrub" });
  });

  it("step rejects non-finite or non-integer deltas", () => {
    const c = createClock({ ...SESSION });
    expectClockError(() => step(c, Number.NaN), { code: "step" });
    expectClockError(() => step(c, Number.POSITIVE_INFINITY), { code: "step" });
    expectClockError(() => step(c, 1.5), { code: "step" });
  });
});

describe("replay clock — invariants (property-style)", () => {
  it("cursor stays within [startMs, endMs] across any play/tick sequence", () => {
    for (const speed of [0.25, 1, 4, 60, 1_000]) {
      let c = createClock({ startMs: 0, endMs: 10_000, speed });
      c = play(c, 0);
      let wall = 0;
      for (const dt of [1, 7, 50, 333, 5_000, 20_000]) {
        wall += dt;
        c = tick(c, wall);
        expect(c.cursorMs).toBeGreaterThanOrEqual(0);
        expect(c.cursorMs).toBeLessThanOrEqual(10_000);
      }
    }
  });

  it("cursor is non-decreasing while playing forward", () => {
    for (const speed of [0.5, 1, 3, 10]) {
      let c = createClock({ startMs: 0, endMs: 100_000, speed });
      c = play(c, 0);
      let wall = 0;
      let prev = c.cursorMs;
      for (const dt of [3, 3, 100, 7, 900, 50]) {
        wall += dt;
        c = tick(c, wall);
        expect(c.cursorMs).toBeGreaterThanOrEqual(prev);
        prev = c.cursorMs;
      }
    }
  });

  it("scrubTo to any in-range integer leaves the cursor exactly there and paused", () => {
    const c = createClock({ startMs: 0, endMs: 10_000 });
    for (const target of [0, 1, 999, 5_000, 9_999, 10_000]) {
      const moved = scrubTo(c, target);
      expect(moved.cursorMs).toBe(target);
      expect(moved.status).toBe("paused");
    }
  });
});
