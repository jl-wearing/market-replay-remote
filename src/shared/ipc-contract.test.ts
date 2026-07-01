import { describe, expect, it } from "vitest";
import {
  InvalidIpcPayloadError,
  REPLAY_CHANNELS,
  validateCreateSessionRequest,
  validateScrubToRequest,
  validateSetSpeedRequest,
  validateSetTimeframeRequest,
  validateStepRequest,
  type ReplayChannel,
} from "./ipc-contract.js";

/** Assert a thunk throws InvalidIpcPayloadError tagged with the given channel. */
function expectIpcError(
  fn: () => unknown,
  expected: { channel: ReplayChannel; field?: string },
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(InvalidIpcPayloadError);
  const e = thrown as InvalidIpcPayloadError;
  expect(e.channel).toBe(expected.channel);
  if (expected.field !== undefined) expect(e.field).toBe(expected.field);
}

const CREATE = REPLAY_CHANNELS.createSession;

describe("ipc-contract — core behaviour", () => {
  it("accepts a well-formed createSession request and returns it typed", () => {
    const req = validateCreateSessionRequest({
      symbol: "EURUSD",
      startMs: 1_000,
      endMs: 2_000,
      timeframeMs: 60_000,
      speed: 2,
    });
    expect(req).toEqual({
      symbol: "EURUSD",
      startMs: 1_000,
      endMs: 2_000,
      timeframeMs: 60_000,
      speed: 2,
    });
  });

  it("accepts createSession without the optional speed", () => {
    const req = validateCreateSessionRequest({
      symbol: "EURUSD",
      startMs: 0,
      endMs: 10,
      timeframeMs: 1_000,
    });
    expect(req.speed).toBeUndefined();
    expect(req.symbol).toBe("EURUSD");
  });

  it("accepts the single-number command requests", () => {
    expect(validateSetSpeedRequest({ speed: 4 })).toEqual({ speed: 4 });
    expect(validateStepRequest({ deltaMs: -60_000 })).toEqual({ deltaMs: -60_000 });
    expect(validateScrubToRequest({ targetMs: 1_500 })).toEqual({ targetMs: 1_500 });
    expect(validateSetTimeframeRequest({ timeframeMs: 300_000 })).toEqual({
      timeframeMs: 300_000,
    });
  });

  it("exposes a stable, namespaced channel map", () => {
    expect(REPLAY_CHANNELS.createSession).toBe("replay:createSession");
    expect(REPLAY_CHANNELS.getVisibleBars).toBe("replay:getVisibleBars");
    for (const channel of Object.values(REPLAY_CHANNELS)) {
      expect(channel.startsWith("replay:")).toBe(true);
    }
  });
});

describe("ipc-contract — edge cases", () => {
  it("ignores unknown extra fields (forward-compatible wire messages)", () => {
    const req = validateCreateSessionRequest({
      symbol: "EURUSD",
      startMs: 0,
      endMs: 10,
      timeframeMs: 1_000,
      unexpected: "ignored",
    });
    expect(req).toEqual({ symbol: "EURUSD", startMs: 0, endMs: 10, timeframeMs: 1_000 });
  });

  it("does NOT enforce domain rules — leaves those to the kernels", () => {
    // startMs >= endMs, speed <= 0, sub-second timeframe: all structurally
    // valid numbers, so the contract accepts them; createReplaySession / the
    // clock reject them downstream with their own error classes.
    const req = validateCreateSessionRequest({
      symbol: "not-a-real-symbol",
      startMs: 5_000,
      endMs: 5_000,
      timeframeMs: 500,
      speed: -1,
    });
    expect(req.startMs).toBe(5_000);
    expect(req.speed).toBe(-1);
  });
});

describe("ipc-contract — breaking tests (must throw / must not happen)", () => {
  it("rejects non-object payloads", () => {
    for (const bad of [null, undefined, 42, "str", [], true]) {
      expectIpcError(() => validateCreateSessionRequest(bad), { channel: CREATE });
    }
  });

  it("rejects a missing or non-string symbol", () => {
    expectIpcError(
      () => validateCreateSessionRequest({ startMs: 0, endMs: 1, timeframeMs: 1_000 }),
      { channel: CREATE, field: "symbol" },
    );
    expectIpcError(
      () =>
        validateCreateSessionRequest({ symbol: 5, startMs: 0, endMs: 1, timeframeMs: 1_000 }),
      { channel: CREATE, field: "symbol" },
    );
    expectIpcError(
      () =>
        validateCreateSessionRequest({ symbol: "", startMs: 0, endMs: 1, timeframeMs: 1_000 }),
      { channel: CREATE, field: "symbol" },
    );
  });

  it("rejects NaN / Infinity / non-number numeric fields", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "10", null]) {
      expectIpcError(
        () =>
          validateCreateSessionRequest({
            symbol: "EURUSD",
            startMs: bad,
            endMs: 1_000,
            timeframeMs: 1_000,
          }),
        { channel: CREATE, field: "startMs" },
      );
    }
  });

  it("rejects a present-but-non-finite optional speed", () => {
    expectIpcError(
      () =>
        validateCreateSessionRequest({
          symbol: "EURUSD",
          startMs: 0,
          endMs: 1,
          timeframeMs: 1_000,
          speed: Number.NaN,
        }),
      { channel: CREATE, field: "speed" },
    );
  });

  it("rejects malformed single-number command requests, tagged per channel", () => {
    expectIpcError(() => validateSetSpeedRequest({ speed: "fast" }), {
      channel: REPLAY_CHANNELS.setSpeed,
      field: "speed",
    });
    expectIpcError(() => validateStepRequest({}), {
      channel: REPLAY_CHANNELS.step,
      field: "deltaMs",
    });
    expectIpcError(() => validateScrubToRequest(null), {
      channel: REPLAY_CHANNELS.scrubTo,
    });
    expectIpcError(() => validateSetTimeframeRequest({ timeframeMs: Number.NaN }), {
      channel: REPLAY_CHANNELS.setTimeframe,
      field: "timeframeMs",
    });
  });
});

describe("ipc-contract — invariants (property-style)", () => {
  it("every numeric-field validator rejects the same grid of non-finite values", () => {
    const bads: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined, {}];
    for (const bad of bads) {
      expectIpcError(() => validateSetSpeedRequest({ speed: bad }), {
        channel: REPLAY_CHANNELS.setSpeed,
      });
      expectIpcError(() => validateStepRequest({ deltaMs: bad }), {
        channel: REPLAY_CHANNELS.step,
      });
      expectIpcError(() => validateScrubToRequest({ targetMs: bad }), {
        channel: REPLAY_CHANNELS.scrubTo,
      });
      expectIpcError(() => validateSetTimeframeRequest({ timeframeMs: bad }), {
        channel: REPLAY_CHANNELS.setTimeframe,
      });
    }
  });

  it("accepts any finite number for the numeric commands", () => {
    for (const n of [0, 1, -1, 1.5, 1e9, -3600000]) {
      expect(validateStepRequest({ deltaMs: n }).deltaMs).toBe(n);
      expect(validateScrubToRequest({ targetMs: n }).targetMs).toBe(n);
    }
  });
});
