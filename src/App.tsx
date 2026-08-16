import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  openStartupLog,
  restartSidecar
} from "./lib/api";
import {
  buildPromptingRecommendations,
  buildTranscriptionRecommendations,
} from "./lib/workflowUtils";
import { HomePage } from "./components/HomePage";
import { useAppSettingsTheme } from "./hooks/useAppSettingsTheme";
import { useModelsWorkspace } from "./hooks/useModelsWorkspace";
import { useHardwareDetection } from "./hooks/useHardwareDetection";
import { useProviderStatuses } from "./hooks/useProviderStatuses";
import { useTranscriptionWorkspace } from "./hooks/useTranscriptionWorkspace";
import { CloseGuardDialog } from "./components/workbench/CloseGuardDialog";
import {
  ConfirmationDialog,
  type ConfirmationIntent
} from "./components/workbench/ConfirmationDialog";
import {
  WorkbenchPageHost,
  useWorkbenchLifecycle,
  useWorkbenchPageLifecycle,
  type WorkbenchPageId
} from "./components/workbench/WorkbenchLifecycle";

type PageId = WorkbenchPageId;
type RestartConfirmationIntent = ConfirmationIntent & { batchId: string };
type NavItem = {
  id: PageId;
  label: string;
};

const navItems: NavItem[] = [
  { id: "home", label: "Home" },
  { id: "models", label: "Models" },
  { id: "transcription", label: "Transcription" },
  { id: "editor", label: "Editor" },
  { id: "codes", label: "Codes" },
  { id: "prompting", label: "Analysis" },
  { id: "help", label: "Help" }
];

const ModelsPage = lazy(() => import("./components/ModelsPage")
  .then((module) => ({ default: module.ModelsPage })));
const TranscriptionPage = lazy(() => import("./components/TranscriptionPage")
  .then((module) => ({ default: module.TranscriptionPage })));
const TranscriptEditorPage = lazy(() => import("./components/TranscriptEditorPage")
  .then((module) => ({ default: module.TranscriptEditorPage })));
const CodesPage = lazy(() => import("./components/CodesPage")
  .then((module) => ({ default: module.CodesPage })));
const PromptingPage = lazy(() => import("./components/PromptingPage")
  .then((module) => ({ default: module.PromptingPage })));
const HelpPage = lazy(() => import("./components/HelpPage")
  .then((module) => ({ default: module.HelpPage })));

function PageLoadingFallback({ pageLabel }: { pageLabel: string }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      Loading {pageLabel}…
    </div>
  );
}

function NavIcon({ pageId }: { pageId: PageId }) {
  switch (pageId) {
    case "home":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4.75 10.25 12 4.75l7.25 5.5v8a1.5 1.5 0 0 1-1.5 1.5H6.25a1.5 1.5 0 0 1-1.5-1.5z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M9.25 19.75v-4.5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v4.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "transcription":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4.5 13.5c1.3 0 1.3-3 2.6-3s1.3 6 2.6 6 1.3-10 2.6-10 1.3 12 2.6 12 1.3-7 2.6-7 1.3 2 2.5 2"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "prompting":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6.25 6.25h11.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H11l-3.75 3v-3H6.25a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M11.75 8.25 12.5 10l1.75.75-1.75.75-.75 1.75-.75-1.75L9.25 10.75 11 10z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </svg>
      );
    case "editor":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6.25 4.75h8.25l3.25 3.25v11.25H6.25z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M14.5 4.75V8h3.25M8.75 12h6.5M8.75 15.25h4.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "codes":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5.25 5.75h13.5v12.5H5.25z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M8.25 9.25h3.75M8.25 12h7.5M8.25 14.75h5.75"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="m15.25 8.9 1.9 1.9-2.65 2.65-1.9.75.75-1.9z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.45"
          />
        </svg>
      );
    case "models":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5.25 7.25 12 3.75l6.75 3.5L12 10.75z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="m5.25 11.25 6.75 3.5 6.75-3.5M5.25 15.25l6.75 3.5 6.75-3.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
        </svg>
      );
    case "help":
      return (
        <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="7.25"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M9.75 9.5a2.5 2.5 0 0 1 4.5 1.5c0 1.6-1.75 2.05-1.75 3.25"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.7"
          />
          <path
            d="M12 16.9h.01"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      );
    default:
      return null;
  }
}

export default function App() {
  const { activePage, navigateTo, pageStates } = useWorkbenchLifecycle();
  const {
    appSettings,
    setAppSettings,
    settingsLoading,
    settingsError,
    setSettingsError,
    isSavingTheme,
    resolvedTheme,
    handleSetTheme
  } = useAppSettingsTheme();
  const [promptOutputFolder, setPromptOutputFolder] = useState("");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [serviceActionError, setServiceActionError] = useState<string | null>(null);
  const [isRestartingService, setIsRestartingService] = useState(false);
  const [restartConfirmation, setRestartConfirmation] = useState<RestartConfirmationIntent | null>(null);

  const { providerStatuses, providersLoading, providersError, refreshProviders } = useProviderStatuses();
  const modelsWorkspace = useModelsWorkspace();
  const hardwareDetection = useHardwareDetection();
  const transcriptionWorkspace = useTranscriptionWorkspace({
    appSettings,
    settingsLoading,
    settingsError,
    modelsStatus: modelsWorkspace.shared.modelsStatus,
    modelsStatusLoading: modelsWorkspace.shared.modelsStatusLoading,
    modelsStatusError: modelsWorkspace.shared.modelsStatusError,
    hardwareSnapshot: hardwareDetection.snapshot,
    hardwareRequestError: hardwareDetection.requestError,
    onRetryHardwareScan: hardwareDetection.retry,
    onSettingsChanged: setAppSettings,
    onSettingsError: setSettingsError
  });
  const { page: transcriptionPage, shell: transcriptionShell } = transcriptionWorkspace;
  const pollingState = transcriptionShell.polling;

  useWorkbenchPageLifecycle("transcription", {
    activeJob: transcriptionShell.activeJob,
    activityLabel: transcriptionShell.activityLabel
  });
  useWorkbenchPageLifecycle("models", modelsWorkspace.shell);

  const allowWindowCloseRef = useRef(false);
  const closeReasons = useMemo(() => navItems.flatMap((item) => {
    const state = pageStates[item.id];
    const reasons: string[] = [];
    if (state.activeJob) {
      reasons.push(state.activityLabel || `${item.label} has active work`);
    }
    if (state.dirty) {
      reasons.push(`${item.label} has unsaved changes`);
    }
    return reasons;
  }), [pageStates]);

  useEffect(() => {
    if (isTauri()) {
      return;
    }

    if (closeReasons.length === 0) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [closeReasons]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let isDisposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (allowWindowCloseRef.current) {
          return;
        }

        if (closeReasons.length === 0) {
          return;
        }

        event.preventDefault();
        setCloseDialogOpen(true);
      })
      .then((cleanup) => {
        if (isDisposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => {
        return;
      });

    return () => {
      isDisposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [closeReasons]);

  async function handleConfirmClose() {
    setCloseDialogOpen(false);
    allowWindowCloseRef.current = true;
    if (isTauri()) {
      await getCurrentWindow().destroy();
      return;
    }
    window.close();
  }

  async function handleRestartService() {
    if (transcriptionPage.run.state.batchIsActive) {
      const batchId = transcriptionPage.run.state.liveBatch?.batch_id;
      if (!batchId || restartConfirmation || isRestartingService) return;
      setRestartConfirmation({
        id: `restart-service-${batchId}`,
        batchId,
        title: "Restart Local Service?",
        description: "The current transcription run will be marked interrupted and will not restart automatically. Restart the local service?",
        confirmLabel: "Restart Service",
        destructive: true
      });
      return;
    }
    await restartService();
  }

  async function restartService() {
    if (isRestartingService) return;
    setIsRestartingService(true);
    setServiceActionError(null);
    try {
      await restartSidecar();
      hardwareDetection.refresh();
      transcriptionPage.run.actions.retryPolling();
    } catch (error) {
      setServiceActionError(error instanceof Error ? error.message : "The local service could not be restarted.");
    } finally {
      setIsRestartingService(false);
    }
  }

  function confirmServiceRestart(intent: RestartConfirmationIntent) {
    if (
      restartConfirmation?.id !== intent.id
      || transcriptionPage.run.state.liveBatch?.batch_id !== intent.batchId
      || !transcriptionPage.run.state.batchIsActive
      || isRestartingService
    ) {
      setRestartConfirmation(null);
      return;
    }
    setRestartConfirmation(null);
    void restartService();
  }

  async function handleOpenStartupLog() {
    setServiceActionError(null);
    try {
      await openStartupLog();
    } catch (error) {
      setServiceActionError(error instanceof Error ? error.message : "The startup log could not be opened.");
    }
  }

  const recommendationHardware = useMemo(
    () => hardwareDetection.snapshot.hardware ?? (
      hardwareDetection.snapshot.status === "failed"
        ? {
            cpu_model: hardwareDetection.snapshot.system?.cpu_model ?? "Unknown CPU",
            physical_cores: hardwareDetection.snapshot.system?.physical_cores ?? 1,
            logical_cores: hardwareDetection.snapshot.system?.logical_cores ?? 1,
            total_ram_gb: hardwareDetection.snapshot.system?.total_ram_gb ?? 0,
            gpu_model: hardwareDetection.snapshot.system?.gpu_model ?? "GPU not verified",
            vram_gb: hardwareDetection.snapshot.system?.vram_gb ?? null,
            has_supported_nvidia_gpu: false,
            runtime_variant: hardwareDetection.snapshot.system?.runtime_variant ?? "unknown",
            cuda_available: false,
            asr_cuda_available: false,
            pyannote_available: false,
            pyannote_cuda_available: false,
            acceleration_path: "CPU"
          }
        : null
    ),
    [
      hardwareDetection.snapshot.hardware,
      hardwareDetection.snapshot.status,
      hardwareDetection.snapshot.system
    ]
  );
  const transcriptionRecommendations = useMemo(
    () => {
      const recommendation = buildTranscriptionRecommendations(recommendationHardware);
      return hardwareDetection.snapshot.status === "failed"
        ? {
            ...recommendation,
            intro: "Hardware acceleration could not be verified. CPU transcription remains available.",
            note: "Retry the hardware scan before relying on GPU acceleration guidance."
          }
        : recommendation;
    },
    [hardwareDetection.snapshot.status, recommendationHardware]
  );
  const promptingRecommendations = useMemo(
    () => {
      const recommendation = buildPromptingRecommendations(recommendationHardware);
      return hardwareDetection.snapshot.status === "failed"
        ? {
            ...recommendation,
            intro: "Hardware acceleration could not be verified. Local providers remain available independently.",
            note: "Provider-specific GPU use is managed by Ollama or LM Studio."
          }
        : recommendation;
    },
    [hardwareDetection.snapshot.status, recommendationHardware]
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? "nav-item active" : "nav-item"}
              onClick={() => navigateTo(item.id)}
              aria-current={activePage === item.id ? "page" : undefined}
            >
              <NavIcon pageId={item.id} />
              <span>{item.label}</span>
              {pageStates[item.id].dirty || pageStates[item.id].activeJob ? (
                <span
                  className={`nav-status-badge${pageStates[item.id].activeJob ? " active-job" : " dirty"}`}
                  aria-label={pageStates[item.id].activeJob ? "Active work" : "Unsaved changes"}
                  title={pageStates[item.id].activityLabel || (pageStates[item.id].dirty ? "Unsaved changes" : "Active work")}
                />
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-theme-card bare">
            <span className="sidebar-theme-title">Dark mode</span>
            <button
              type="button"
              className={resolvedTheme === "light" ? "theme-toggle active-light" : "theme-toggle active-dark"}
              onClick={() => void handleSetTheme(resolvedTheme === "light" ? "dark" : "light")}
              disabled={settingsLoading || isSavingTheme}
              aria-label={`Switch to ${resolvedTheme === "light" ? "dark" : "light"} theme`}
            >
              <span className="theme-toggle-thumb" aria-hidden="true" />
            </button>
            {settingsError ? <small className="sidebar-theme-error">{settingsError}</small> : null}
          </div>
        </div>
      </aside>

      <main className="content-panel">
        {pollingState.error || pollingState.compatibilityError || serviceActionError ? (
          <section className="service-recovery-banner" role="alert">
            <div>
              <strong>Local service connection needs attention</strong>
              <p>{serviceActionError ?? pollingState.error ?? pollingState.compatibilityError}</p>
              {pollingState.lastUpdatedAt ? (
                <small>Last successful update: {new Date(pollingState.lastUpdatedAt).toLocaleTimeString()}</small>
              ) : null}
            </div>
            <div className="action-row">
              <button type="button" className="secondary-button" onClick={transcriptionPage.run.actions.retryPolling}>
                Retry
              </button>
              {isTauri() ? (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleRestartService()}
                    disabled={isRestartingService}
                  >
                    {isRestartingService ? "Restarting..." : "Restart service"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handleOpenStartupLog()}>
                    Open startup log
                  </button>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        <WorkbenchPageHost pageId="home">
          <HomePage
            hardwareSnapshot={hardwareDetection.snapshot}
            hardwareRequestError={hardwareDetection.requestError}
            onRetryHardwareScan={hardwareDetection.retry}
            providersLoading={providersLoading}
            providersError={providersError}
            providerStatuses={providerStatuses}
            transcriptionServiceStatus={
              pollingState.checking
                ? "checking"
                : pollingState.error
                  ? "unavailable"
                  : "running"
            }
            transcriptionRecommendations={transcriptionRecommendations}
            promptingRecommendations={promptingRecommendations}
          />
        </WorkbenchPageHost>

        <WorkbenchPageHost pageId="transcription">
          <Suspense fallback={<PageLoadingFallback pageLabel="Transcription" />}>
            <TranscriptionPage {...transcriptionPage} />
          </Suspense>
        </WorkbenchPageHost>

        <WorkbenchPageHost pageId="editor">
          <Suspense fallback={<PageLoadingFallback pageLabel="Editor" />}>
            <TranscriptEditorPage />
          </Suspense>
        </WorkbenchPageHost>
        <WorkbenchPageHost pageId="codes">
          <Suspense fallback={<PageLoadingFallback pageLabel="Codes" />}>
            <CodesPage
              providers={providerStatuses}
              providersLoading={providersLoading}
              providerError={providersError}
              onRefreshProviders={() => refreshProviders()}
            />
          </Suspense>
        </WorkbenchPageHost>
        <WorkbenchPageHost pageId="models">
          <Suspense fallback={<PageLoadingFallback pageLabel="Models" />}>
            <ModelsPage workspace={modelsWorkspace.page} />
          </Suspense>
        </WorkbenchPageHost>
        <WorkbenchPageHost pageId="prompting">
          <Suspense fallback={<PageLoadingFallback pageLabel="Transcript Analysis" />}>
            <PromptingPage
              providers={providerStatuses}
              providersLoading={providersLoading}
              providerError={providersError}
              onRefreshProviders={() => refreshProviders()}
              promptOutputFolder={promptOutputFolder}
              suggestedSourceFile={transcriptionShell.suggestedPromptSourceFile}
              browseHomeFolder={transcriptionShell.browseHomeFolder}
              onPromptOutputFolderChange={setPromptOutputFolder}
            />
          </Suspense>
        </WorkbenchPageHost>
        <WorkbenchPageHost pageId="help">
          <Suspense fallback={<PageLoadingFallback pageLabel="Help" />}>
            <HelpPage />
          </Suspense>
        </WorkbenchPageHost>
      </main>
      <CloseGuardDialog
        open={closeDialogOpen}
        reasons={closeReasons}
        onCancel={() => setCloseDialogOpen(false)}
        onConfirm={() => void handleConfirmClose()}
      />
      <ConfirmationDialog
        intent={restartConfirmation}
        busy={isRestartingService}
        onCancel={() => setRestartConfirmation(null)}
        onConfirm={(intent) => confirmServiceRestart(intent as RestartConfirmationIntent)}
      />
    </div>
  );
}
