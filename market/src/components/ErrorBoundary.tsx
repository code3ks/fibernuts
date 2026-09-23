import { Component, type ErrorInfo, type ReactNode } from "react";

import { safeErrorMessage } from "../domain/errors";
import { Button, Notice } from "./Primitives";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: safeErrorMessage(error, "The application could not continue.") };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Bearer values are deliberately not sent to a logger or telemetry service.
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error">
        <Notice tone="failed" title="FiberNuts stopped before moving more value">
          <p>{this.state.error}</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>Reload application</Button>
        </Notice>
      </main>
    );
  }
}
