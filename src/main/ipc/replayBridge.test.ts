import { describe, expect, it } from "vitest";
import type { Bar } from "../../shared/types.js";
import { UnknownInstrumentError } from "../../shared/instruments.js";
import { InvalidClockInputError } from "../../shared/replay/clock.js";
import { InvalidSessionInputError } from "../replay/session.js";
import { InvalidIpcPayloadError } from "../../shared/ipc-contract.js";
import type { CursorBarSource } from "../replay/cursorBarReader.js";
import { createReplayBridge, ReplayBridgeError } from "./replayBridge.js";

// ── fixtures ──────────────────────────────────────────────────────────────

function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1, hBid: 1, lBid: 1, cBid: 1,
    oAsk: 1, hAsk: 1, lAsk: 1, cAsk: 1,
    volumeBid: 0, volumeAsk: 0, tickCount: 1,
  };
}

function bars1s(startMs: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => mkBar(startMs + i * 1_000));
}

/** In-memory source: returns its bars filtered to the half-open [fromMs, toMs). */
function fakeSource(bars: Bar[]): CursorBarSource {
  return {
    async readBarsInRange({ fromMs, toMs }) {
      return bars.filter((b) => b.timestampMs >= fromMs && b.timestampMs < toMs);
    },
  };
}

/** A source whose read always rejects with the given error (identity-checked). */
function throwingSource(err: unknown): CursorBarSource {
  return {
    readBarsInRange() {
      return Promise.reject(err);
    },
  };
}

const BASE_REQ = { symbol: "EURUSD", startMs: 0, endMs: 3_600_000, timeframeMs: 60_000 };

/** A bridge over `bars` with a controllable wall clock. */
function makeBridge(bars: Bar[] = []) {
  const clock = { nowMs: 1_000_000 };
  const bridge = createReplayBridge({
    source: fakeSource(bars),
    now: () => clock.nowMs,
  });
  return { bridge, clock };
}

describe("replayBridge — core behaviour", () => {
  it("createSession returns a paused snapshot positioned at startMs", () => {
    const { bridge } = makeBridge();
    const snap = bridge.createSession(BASE_REQ);
    expect(snap).toEqual({
      symbol: "EURUSD",
      timeframeMs: 60_000,
      startMs: 0,
      endMs: 3_600_000,
      cursorMs: 0,
      speed: 1,
      status: "paused",
    });
  });

  it("carries the optional speed through to the snapshot", () => {
    const { bridge } = makeBridge();
    expect(bridge.createSession({ ...BASE_REQ, speed: 4 }).speed).toBe(4);
  });

  it("step nudges the cursor forward and pauses", () => {
    const { bridge } = makeBridge();
    bridge.createSession(BASE_REQ);
    const snap = bridge.step({ deltaMs: 120_000 });
    expect(snap.cursorMs).toBe(120_000);
    expect(snap.status).toBe("paused");
  });

  it("play then tick advances the cursor by elapsed wall-time × speed", () => {
    const { bridge, clock } = makeBridge();
    bridge.createSession(BASE_REQ);
    bridge.play();
    clock.nowMs += 60_000; // 60 wall-seconds at speed 1
    const snap = bridge.tick();
    expect(snap.cursorMs).toBe(60_000);
    expect(snap.status).toBe("playing");
  });

  it("getVisibleBars folds the cursor-clipped 1 s bars to the timeframe", async () => {
    // 1 s bars across the first ~2.5 minutes.
    const { bridge } = makeBridge(bars1s(0, 200));
    bridge.createSession(BASE_REQ);
    bridge.step({ deltaMs: 120_000 }); // cursor = 120_000 (inclusive)
    const bars = await bridge.getVisibleBars();
    // Visible 1 s bars are t=0..120_000 → M1 buckets 0, 60_000, 120_000.
    expect(bars.map((b) => b.timestampMs)).toEqual([0, 60_000, 120_000]);
  });
});

describe("replayBridge — edge cases", () => {
  it("setTimeframe changes the timeframe but preserves the cursor (headline)", () => {
    const { bridge } = makeBridge();
    bridge.createSession(BASE_REQ);
    bridge.step({ deltaMs: 120_000 });
    const snap = bridge.setTimeframe({ timeframeMs: 300_000 });
    expect(snap.timeframeMs).toBe(300_000);
    expect(snap.cursorMs).toBe(120_000);
  });

  it("setSpeed while paused changes only the speed", () => {
    const { bridge } = makeBridge();
    bridge.createSession(BASE_REQ);
    const snap = bridge.setSpeed({ speed: 8 });
    expect(snap.speed).toBe(8);
    expect(snap.cursorMs).toBe(0);
    expect(snap.status).toBe("paused");
  });

  it("scrubTo jumps the cursor to an absolute time and pauses", () => {
    const { bridge } = makeBridge();
    bridge.createSession(BASE_REQ);
    const snap = bridge.scrubTo({ targetMs: 900_000 });
    expect(snap.cursorMs).toBe(900_000);
    expect(snap.status).toBe("paused");
  });

  it("getVisibleBars at the start cursor returns only the first bucket", async () => {
    const { bridge } = makeBridge(bars1s(0, 200));
    bridge.createSession(BASE_REQ);
    const bars = await bridge.getVisibleBars();
    expect(bars.map((b) => b.timestampMs)).toEqual([0]);
  });
});

describe("replayBridge — breaking tests (must throw / must not happen)", () => {
  it("every command before createSession throws ReplayBridgeError(code 'no-session')", async () => {
    const { bridge } = makeBridge();
    const sync: Array<() => unknown> = [
      () => bridge.play(),
      () => bridge.pause(),
      () => bridge.tick(),
      () => bridge.setSpeed({ speed: 2 }),
      () => bridge.step({ deltaMs: 1_000 }),
      () => bridge.scrubTo({ targetMs: 0 }),
      () => bridge.setTimeframe({ timeframeMs: 60_000 }),
    ];
    for (const call of sync) {
      expect(call).toThrow(ReplayBridgeError);
      try {
        call();
      } catch (e) {
        expect((e as ReplayBridgeError).code).toBe("no-session");
      }
    }
    await expect(bridge.getVisibleBars()).rejects.toBeInstanceOf(ReplayBridgeError);
  });

  it("createSession rejects a malformed payload with InvalidIpcPayloadError", () => {
    const { bridge } = makeBridge();
    expect(() => bridge.createSession({ symbol: "EURUSD" })).toThrow(InvalidIpcPayloadError);
  });

  it("createSession propagates UnknownInstrumentError for a symbol off the catalog", () => {
    const { bridge } = makeBridge();
    expect(() => bridge.createSession({ ...BASE_REQ, symbol: "FAKE" })).toThrow(
      UnknownInstrumentError,
    );
  });

  it("createSession propagates the kernel's domain errors unchanged", () => {
    const { bridge } = makeBridge();
    // sub-second timeframe → session's own validation.
    expect(() => bridge.createSession({ ...BASE_REQ, timeframeMs: 500 })).toThrow(
      InvalidSessionInputError,
    );
    // startMs >= endMs → clock's range validation.
    expect(() => bridge.createSession({ ...BASE_REQ, startMs: 10, endMs: 10 })).toThrow(
      InvalidClockInputError,
    );
  });

  it("getVisibleBars propagates a source read failure unchanged (identity)", async () => {
    const boom = new Error("store exploded");
    const bridge = createReplayBridge({ source: throwingSource(boom), now: () => 1 });
    bridge.createSession(BASE_REQ);
    await expect(bridge.getVisibleBars()).rejects.toBe(boom);
  });

  it("no peeking: never returns a bar whose timestamp is past the cursor", async () => {
    // A bar sits at 120_000 but the cursor is only at 0.
    const { bridge } = makeBridge([...bars1s(0, 1), mkBar(120_000)]);
    bridge.createSession(BASE_REQ);
    const bars = await bridge.getVisibleBars();
    expect(bars.every((b) => b.timestampMs <= 0)).toBe(true);
    expect(bars.some((b) => b.timestampMs === 120_000)).toBe(false);
  });
});

describe("replayBridge — invariants (property-style)", () => {
  it("for any scrubbed cursor, no folded bar's bucket start exceeds the cursor", async () => {
    const { bridge } = makeBridge(bars1s(0, 600)); // 10 minutes of 1 s bars
    bridge.createSession(BASE_REQ);
    for (const cursor of [0, 1_000, 59_000, 60_000, 123_000, 300_000, 599_000]) {
      bridge.scrubTo({ targetMs: cursor });
      const bars = await bridge.getVisibleBars();
      for (const b of bars) {
        expect(b.timestampMs).toBeLessThanOrEqual(cursor);
      }
    }
  });
});
