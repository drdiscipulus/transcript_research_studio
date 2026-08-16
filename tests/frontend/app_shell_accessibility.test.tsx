import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { WorkbenchLifecycleProvider } from "../../src/components/workbench/WorkbenchLifecycle";

const mocks = vi.hoisted(() => ({
  batchId: "batch-1",
  batchIsActive: true,
  restartSidecar: vi.fn<() => Promise<void>>(),
  retryPolling: vi.fn(),
  navigateDestroy: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => vi.fn()),
    destroy: mocks.navigateDestroy
  })
}));
vi.mock("../../src/lib/api", () => ({
  openStartupLog: vi.fn(async () => undefined),
  restartSidecar: mocks.restartSidecar
}));

vi.mock("../../src/hooks/useAppSettingsTheme", () => ({
  useAppSettingsTheme: () => ({
    appSettings: null,
    setAppSettings: vi.fn(),
    settingsLoading: false,
    settingsError: null,
    setSettingsError: vi.fn(),
    isSavingTheme: false,
    resolvedTheme: "light",
    handleSetTheme: vi.fn(async () => undefined)
  })
}));
vi.mock("../../src/hooks/useProviderStatuses", () => ({
  useProviderStatuses: () => ({
    providerStatuses: [],
    providersLoading: false,
    providersError: null,
    refreshProviders: vi.fn(async () => undefined)
  })
}));
vi.mock("../../src/hooks/useModelsWorkspace", () => ({
  useModelsWorkspace: () => ({
    shared: {
      modelsStatus: null,
      modelsStatusLoading: false,
      modelsStatusError: null
    },
    shell: { activeJob: false, activityLabel: "" },
    page: {}
  })
}));
vi.mock("../../src/hooks/useHardwareDetection", () => ({
  useHardwareDetection: () => ({
    snapshot: {
      generation: 1,
      status: "ready",
      phase: "ready",
      message: "Hardware detection complete.",
      system: null,
      hardware: null,
      retryable: false
    },
    requestError: null,
    retry: vi.fn(async () => false),
    refresh: vi.fn()
  })
}));
vi.mock("../../src/hooks/useTranscriptionWorkspace", () => ({
  useTranscriptionWorkspace: () => ({
    page: {
      run: {
        state: {
          batchIsActive: mocks.batchIsActive,
          liveBatch: mocks.batchId ? { batch_id: mocks.batchId } : null
        },
        actions: { retryPolling: mocks.retryPolling }
      }
    },
    shell: {
      polling: {
        error: "Service unavailable.",
        compatibilityError: null,
        lastUpdatedAt: null,
        checking: false
      },
      activeJob: mocks.batchIsActive,
      activityLabel: "Transcribing",
      hardware: null,
      suggestedPromptSourceFile: "",
      browseHomeFolder: ""
    }
  })
}));

vi.mock("../../src/components/HomePage", () => ({ HomePage: () => <div>Home workspace</div> }));
vi.mock("../../src/components/ModelsPage", () => ({ ModelsPage: () => <div>Models workspace</div> }));
vi.mock("../../src/components/TranscriptionPage", () => ({ TranscriptionPage: () => <div>Transcription workspace</div> }));
vi.mock("../../src/components/TranscriptEditorPage", () => ({ TranscriptEditorPage: () => <div>Editor workspace</div> }));
vi.mock("../../src/components/CodesPage", () => ({ CodesPage: () => <div>Codes workspace</div> }));
vi.mock("../../src/components/PromptingPage", () => ({ PromptingPage: () => <div>Analysis workspace</div> }));
vi.mock("../../src/components/HelpPage", () => ({ HelpPage: () => <div>Help workspace</div> }));

function renderApp() {
  return render(
    <WorkbenchLifecycleProvider>
      <App />
    </WorkbenchLifecycleProvider>
  );
}

describe("responsive App shell accessibility", () => {
  beforeEach(() => {
    mocks.batchId = "batch-1";
    mocks.batchIsActive = true;
    mocks.restartSidecar.mockReset().mockResolvedValue(undefined);
    mocks.retryPolling.mockReset();
  });

  it("keeps all seven named destinations reachable and identifies the current page", async () => {
    const user = userEvent.setup();
    renderApp();

    const labels = ["Home", "Models", "Transcription", "Editor", "Codes", "Analysis", "Help"];
    for (const label of labels) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}(?:$|\\s)`) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("button", { name: "Help" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("cancels or confirms a target-bound active-run service restart exactly once", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Restart service" }));
    expect(screen.getByRole("alertdialog", { name: "Restart Local Service?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.restartSidecar).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restart service" }));
    await user.click(screen.getByRole("button", { name: "Restart Service" }));
    await waitFor(() => expect(mocks.restartSidecar).toHaveBeenCalledOnce());
    expect(mocks.retryPolling).toHaveBeenCalledOnce();
  });

  it("does not restart when the active batch target changes behind an open confirmation", async () => {
    const user = userEvent.setup();
    const view = renderApp();

    await user.click(screen.getByRole("button", { name: "Restart service" }));
    mocks.batchId = "batch-2";
    view.rerender(
      <WorkbenchLifecycleProvider>
        <App />
      </WorkbenchLifecycleProvider>
    );
    await user.click(screen.getByRole("button", { name: "Restart Service" }));

    expect(mocks.restartSidecar).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Restart Local Service?" })).not.toBeInTheDocument();
  });
});
