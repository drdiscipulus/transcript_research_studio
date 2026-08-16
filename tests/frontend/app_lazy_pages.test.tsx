import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, describe, expect, it, vi } from "vitest";

import App from "../../src/App";
import { ErrorBoundary } from "../../src/components/workbench/ErrorBoundary";
import { WorkbenchLifecycleProvider } from "../../src/components/workbench/WorkbenchLifecycle";

const lazyModules = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return {
      promise,
      resolve,
      reject,
      requested: 0,
      activeEffects: 0,
      effectStarts: 0
    };
  }

  return {
    models: deferred(),
    transcription: deferred(),
    editor: deferred(),
    codes: deferred(),
    prompting: deferred(),
    help: deferred()
  };
});

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async () => vi.fn()),
    destroy: vi.fn(async () => undefined)
  })
}));
vi.mock("../../src/lib/api", () => ({
  openStartupLog: vi.fn(async () => undefined),
  restartSidecar: vi.fn(async () => undefined)
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
        state: { batchIsActive: false, liveBatch: null },
        actions: { retryPolling: vi.fn() }
      }
    },
    shell: {
      polling: {
        error: null,
        compatibilityError: null,
        lastUpdatedAt: null,
        checking: false
      },
      activeJob: false,
      activityLabel: "",
      suggestedPromptSourceFile: "",
      browseHomeFolder: ""
    }
  })
}));

vi.mock("../../src/components/HomePage", () => ({
  HomePage: () => <div>Home workspace</div>
}));
vi.mock("../../src/components/ModelsPage", async () => {
  lazyModules.models.requested += 1;
  await lazyModules.models.promise;
  const React = await import("react");

  function ModelsPage() {
    const [value, setValue] = React.useState("");
    React.useEffect(() => {
      lazyModules.models.activeEffects += 1;
      lazyModules.models.effectStarts += 1;
      return () => {
        lazyModules.models.activeEffects -= 1;
      };
    }, []);
    return React.createElement(
      "label",
      null,
      "Models retained value",
      React.createElement("input", {
        "aria-label": "Models retained value",
        value,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value)
      })
    );
  }

  return { ModelsPage };
});
vi.mock("../../src/components/TranscriptionPage", async () => {
  lazyModules.transcription.requested += 1;
  await lazyModules.transcription.promise;
  return { TranscriptionPage: () => <div>Transcription workspace</div> };
});
vi.mock("../../src/components/TranscriptEditorPage", async () => {
  lazyModules.editor.requested += 1;
  await lazyModules.editor.promise;
  return { TranscriptEditorPage: () => <div>Editor workspace</div> };
});
vi.mock("../../src/components/CodesPage", async () => {
  lazyModules.codes.requested += 1;
  await lazyModules.codes.promise;
  return { CodesPage: () => <div>Codes workspace</div> };
});
vi.mock("../../src/components/PromptingPage", async () => {
  lazyModules.prompting.requested += 1;
  await lazyModules.prompting.promise;
  return { PromptingPage: () => <div>Analysis workspace</div> };
});
vi.mock("../../src/components/HelpPage", async () => {
  lazyModules.help.requested += 1;
  await lazyModules.help.promise;
  const React = await import("react");

  function HelpPage() {
    React.useEffect(() => {
      lazyModules.help.activeEffects += 1;
      lazyModules.help.effectStarts += 1;
      return () => {
        lazyModules.help.activeEffects -= 1;
      };
    }, []);
    return React.createElement("div", null, "Help workspace");
  }

  return { HelpPage };
});

function renderApp() {
  return render(
    <StrictMode>
      <ErrorBoundary>
        <WorkbenchLifecycleProvider>
          <App />
        </WorkbenchLifecycleProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

describe("retained lazy workbench pages", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("loads pages on first visit, retains loaded instances, and surfaces import failures safely", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);

    renderApp();

    expect(screen.getByText("Home workspace")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(Object.values(lazyModules).map((control) => control.requested)).toEqual([0, 0, 0, 0, 0, 0]);

    await user.click(screen.getByRole("button", { name: "Models" }));

    expect(lazyModules.models.requested).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Models…");
    expect(lazyModules.transcription.requested).toBe(0);
    expect(lazyModules.editor.requested).toBe(0);
    expect(lazyModules.codes.requested).toBe(0);
    expect(lazyModules.prompting.requested).toBe(0);
    expect(lazyModules.help.requested).toBe(0);

    await act(async () => lazyModules.models.resolve());
    const retainedInput = await screen.findByRole("textbox", { name: "Models retained value" });
    await user.type(retainedInput, "kept draft");
    expect(lazyModules.models.activeEffects).toBe(1);
    const modelEffectStarts = lazyModules.models.effectStarts;

    await user.click(screen.getByRole("button", { name: "Home" }));
    const modelsHost = document.querySelector<HTMLElement>('[data-page-id="models"]');
    expect(modelsHost).toBeTruthy();
    expect(modelsHost).toHaveAttribute("hidden");
    expect(modelsHost).toHaveAttribute("aria-hidden", "true");
    expect(lazyModules.models.activeEffects).toBe(1);

    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(await screen.findByRole("textbox", { name: "Models retained value" })).toHaveValue("kept draft");
    expect(lazyModules.models.requested).toBe(1);
    expect(lazyModules.models.effectStarts).toBe(modelEffectStarts);

    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(lazyModules.help.requested).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Help…");
    await act(async () => lazyModules.help.resolve());
    expect(await screen.findByText("Help workspace")).toBeVisible();
    expect(lazyModules.help.activeEffects).toBe(1);
    expect(modelsHost).toHaveAttribute("hidden");
    expect(screen.queryByRole("textbox", { name: "Models retained value" })).not.toBeInTheDocument();
    const helpHost = document.querySelector<HTMLElement>('[data-page-id="help"]');
    expect(helpHost).not.toHaveAttribute("hidden");
    expect(helpHost).toHaveAttribute("aria-hidden", "false");

    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(await screen.findByRole("textbox", { name: "Models retained value" })).toHaveValue("kept draft");
    expect(lazyModules.help.activeEffects).toBe(1);
    expect(lazyModules.help.requested).toBe(1);

    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(lazyModules.editor.requested).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Editor…");
    await act(async () => lazyModules.editor.reject(new Error("internal chunk path must stay private")));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong in the interface");
    });
    expect(screen.getByRole("alert")).not.toHaveTextContent("internal chunk path");
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    window.removeEventListener("unhandledrejection", unhandledRejection);
  });
});
