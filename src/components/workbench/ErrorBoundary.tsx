import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  failed: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("The desktop interface encountered an unexpected error.", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="fatal-error-screen" role="alert">
          <section className="section-card">
            <h1>Something went wrong in the interface</h1>
            <p>Your local files were not deleted. Reload the interface and check the startup log if the problem returns.</p>
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              Reload interface
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
