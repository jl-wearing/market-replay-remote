import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

/** A child that throws during render — the thing a boundary must contain. */
function Boom({ message }: { message: string }): ReactElement {
  throw new Error(message);
}

/** A child that renders normally. */
function Ok(): ReactElement {
  return <span>child-ok</span>;
}

// React logs caught render errors to console.error; silence it so the four
// blocks below read cleanly. (Renderer test file — the console ban is for
// src/shared and src/main production code, not tests.)
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

describe("ErrorBoundary — core behaviour", () => {
  it("renders its children when they do not throw", () => {
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <Ok />
      </ErrorBoundary>,
    );
    expect(screen.getByText("child-ok")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("does not call onError on a clean render", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary fallback={<p>fallback</p>} onError={onError}>
        <Ok />
      </ErrorBoundary>,
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("ErrorBoundary — edge cases", () => {
  it("supports a render-function fallback that receives the caught error", () => {
    render(
      <ErrorBoundary fallback={(error) => <p>caught: {error.message}</p>}>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught: kaboom")).toBeTruthy();
  });

  it("isolates a throwing subtree: an outer boundary's other children survive", () => {
    render(
      <ErrorBoundary fallback={<p>outer-fallback</p>}>
        <span>outer-sibling</span>
        <ErrorBoundary fallback={<p>inner-fallback</p>}>
          <Boom message="inner-only" />
        </ErrorBoundary>
      </ErrorBoundary>,
    );
    // Inner boundary caught it; the outer boundary never trips.
    expect(screen.getByText("inner-fallback")).toBeTruthy();
    expect(screen.getByText("outer-sibling")).toBeTruthy();
    expect(screen.queryByText("outer-fallback")).toBeNull();
  });
});

describe("ErrorBoundary — breaking tests (must throw / must not happen)", () => {
  it("a throwing child renders the fallback and does NOT blank the app", () => {
    render(
      <ErrorBoundary fallback={<p>fallback-shown</p>}>
        <Boom message="render-exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback-shown")).toBeTruthy();
  });

  it("surfaces the caught value to onError as an Error with the thrown message", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary fallback={<p>fallback</p>} onError={onError}>
        <Boom message="reported-message" />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("reported-message");
    expect(typeof (info as { componentStack: string }).componentStack).toBe("string");
  });

  it("must not let the error propagate past the boundary (sibling outside stays mounted)", () => {
    render(
      <div>
        <span>outside-sibling</span>
        <ErrorBoundary fallback={<p>fallback</p>}>
          <Boom message="contained" />
        </ErrorBoundary>
      </div>,
    );
    // If the throw had escaped, the whole render would have unmounted.
    expect(screen.getByText("outside-sibling")).toBeTruthy();
    expect(screen.getByText("fallback")).toBeTruthy();
  });
});

describe("ErrorBoundary — invariants (property-style)", () => {
  it("shows the fallback and reports the message for any throwing child", () => {
    const messages = ["e1", "another-error", "3rd", "with spaces"];
    for (const message of messages) {
      const onError = vi.fn();
      render(
        <ErrorBoundary fallback={(error) => <p>fb:{error.message}</p>} onError={onError}>
          <Boom message={message} />
        </ErrorBoundary>,
      );
      expect(screen.getByText(`fb:${message}`)).toBeTruthy();
      expect((onError.mock.calls[0]![0] as Error).message).toBe(message);
      cleanup();
    }
  });
});
