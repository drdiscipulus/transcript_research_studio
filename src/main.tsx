import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/workbench/ErrorBoundary";
import { WorkbenchLifecycleProvider } from "./components/workbench/WorkbenchLifecycle";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WorkbenchLifecycleProvider>
        <App />
      </WorkbenchLifecycleProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
