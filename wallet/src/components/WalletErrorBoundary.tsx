import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorBoundaryFallback } from "./Primitives";

export class WalletErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Bearer data can appear in thrown protocol values, so errors are not logged from this surface.
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="fatal-error">
          <ErrorBoundaryFallback
            message="An unexpected display error stopped the wallet. Stored proofs and recovery records were not cleared."
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
