import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * Renderer entry point. Mounts the React tree behind a top-level
 * {@link ErrorBoundary} so a render error in any panel shows a fallback instead
 * of blanking the whole window (the app-wide fault boundary).
 */
const container = document.getElementById("root");
if (container === null) {
  throw new Error("renderer bootstrap: #root element not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={<p role="alert">Something went wrong. Please restart Hindsight.</p>}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
