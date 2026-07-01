import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/**
 * Props for {@link ErrorBoundary}.
 */
export interface ErrorBoundaryProps {
  /** The subtree the boundary guards. */
  children: ReactNode;
  /**
   * What to show once a descendant render throws. Either a static node, or a
   * function given the caught {@link Error} (e.g. to show its message).
   */
  fallback: ReactNode | ((error: Error) => ReactNode);
  /**
   * Called once when an error is caught, with the error and React's component
   * stack. The place to forward to structured logging in a later slice.
   */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  /** The caught error, or `null` while the subtree is healthy. */
  error: Error | null;
}

/**
 * React error boundary — the renderer's fault-isolation primitive.
 *
 * A render error in any guarded descendant is caught here and replaced with
 * {@link ErrorBoundaryProps.fallback}, so one bad panel degrades locally
 * instead of blanking the whole window. This is the UI half of the app-wide
 * resilience posture; `main` owns the process-level nets separately.
 *
 * Boundaries only catch errors thrown during React rendering/lifecycle of
 * descendants — not events, timeouts, or async callbacks (those handle their
 * own failures). It does not auto-recover: once tripped it shows the fallback
 * until it is remounted, which is the safe default for a trading UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  /** Move the boundary into its error state so the next render shows fallback. */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const { fallback } = this.props;
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
    return this.props.children;
  }
}
