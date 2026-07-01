import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Bar } from "@shared/types.js";
import type { ReplayBridgeApi, SessionSnapshot } from "@shared/ipc-contract.js";
import { ReplayDebugPanel } from "./ReplayDebugPanel.js";

function mkBar(timestampMs: number): Bar {
  return {
    timestampMs,
    oBid: 1, hBid: 1, lBid: 1, cBid: 1,
    oAsk: 1, hAsk: 1, lAsk: 1, cAsk: 1,
    volumeBid: 0, volumeAsk: 0, tickCount: 1,
  };
}

/** A stateful in-memory stand-in for the preload replay API. */
function makeFakeApi(overrides: Partial<ReplayBridgeApi> = {}): ReplayBridgeApi {
  let cursor = 0;
  const snap = (): SessionSnapshot => ({
    symbol: "EURUSD",
    timeframeMs: 60_000,
    startMs: 0,
    endMs: 3_600_000,
    cursorMs: cursor,
    speed: 1,
    status: "paused",
  });
  return {
    createSession: async () => {
      cursor = 0;
      return snap();
    },
    play: async () => snap(),
    pause: async () => snap(),
    tick: async () => snap(),
    setSpeed: async () => snap(),
    step: async ({ deltaMs }) => {
      cursor += deltaMs;
      return snap();
    },
    scrubTo: async ({ targetMs }) => {
      cursor = targetMs;
      return snap();
    },
    setTimeframe: async () => snap(),
    getVisibleBars: async () =>
      Array.from({ length: cursor / 60_000 + 1 }, (_, i) => mkBar(i * 60_000)),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("ReplayDebugPanel — core behaviour", () => {
  it("shows the snapshot after loading a session", async () => {
    render(<ReplayDebugPanel api={makeFakeApi()} />);
    fireEvent.click(screen.getByTestId("btn-create"));
    expect((await screen.findByTestId("cursor")).textContent).toBe("0");
    expect(screen.getByTestId("status").textContent).toBe("paused");
    expect(screen.getByTestId("timeframe").textContent).toBe("60000");
  });

  it("advances the displayed cursor when stepping", async () => {
    render(<ReplayDebugPanel api={makeFakeApi()} />);
    fireEvent.click(screen.getByTestId("btn-create"));
    await screen.findByTestId("cursor");
    fireEvent.click(screen.getByTestId("btn-step"));
    expect((await screen.findByText("60000")).textContent).toBe("60000");
  });

  it("shows the visible-bar count after refreshing", async () => {
    render(<ReplayDebugPanel api={makeFakeApi()} />);
    fireEvent.click(screen.getByTestId("btn-create"));
    await screen.findByTestId("cursor");
    fireEvent.click(screen.getByTestId("btn-refresh"));
    expect((await screen.findByTestId("bar-count")).textContent).toBe("1");
  });
});

describe("ReplayDebugPanel — edge cases", () => {
  it("disables step and refresh until a session exists", () => {
    render(<ReplayDebugPanel api={makeFakeApi()} />);
    expect((screen.getByTestId("btn-step") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("btn-refresh") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ReplayDebugPanel — breaking tests (must throw / must not happen)", () => {
  it("shows an error state (and does not blank) when a command rejects", async () => {
    const api = makeFakeApi({
      createSession: () => Promise.reject(new Error("bridge said no")),
    });
    render(<ReplayDebugPanel api={api} />);
    fireEvent.click(screen.getByTestId("btn-create"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("bridge said no");
    // The panel itself is still mounted — the error degraded locally.
    expect(screen.getByTestId("replay-debug")).toBeTruthy();
  });
});

describe("ReplayDebugPanel — invariants (property-style)", () => {
  it("displayed cursor tracks the number of steps taken", async () => {
    render(<ReplayDebugPanel api={makeFakeApi()} />);
    fireEvent.click(screen.getByTestId("btn-create"));
    await screen.findByTestId("cursor");
    for (let n = 1; n <= 4; n++) {
      fireEvent.click(screen.getByTestId("btn-step"));
      expect((await screen.findByTestId("cursor")).textContent).toBe(String(n * 60_000));
    }
  });
});
