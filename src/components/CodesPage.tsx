import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CodesProjectConflictError,
  type CodesProject,
  type PromptingProviderStatus
} from "../lib/api";
import { useCodesAiDecisionLifecycle } from "../hooks/useCodesAiDecisionLifecycle";
import { useCodesContextualAiWorkspace } from "../hooks/useCodesContextualAiWorkspace";
import { useCodesProjectExport } from "../hooks/useCodesProjectExport";
import { useCodesProjectSession } from "../hooks/useCodesProjectSession";
import { useCodesCodebookWorkspace } from "../hooks/useCodesCodebookWorkspace";
import { useCodesTranscriptImport } from "../hooks/useCodesTranscriptImport";
import { useCodesEvidenceWorkspace } from "../hooks/useCodesEvidenceWorkspace";
import { useCodesDraftGuard } from "../hooks/useCodesDraftGuard";
import { useCodesProjectFileLifecycle } from "../hooks/useCodesProjectFileLifecycle";
import { fileName } from "../lib/codesProjectPaths";
import { CodesInspector } from "./codes/CodesInspector";
import { CodesAiSettings } from "./codes/CodesAiSettings";
import { CodesAiActionButton } from "./codes/CodesAiActionButton";
import { CodesAiProgress } from "./codes/CodesAiProgress";
import { CodesCodebookPanel } from "./codes/CodesCodebookPanel";
import { CodesCodeRefinementReview, CodesThemeRefinementReview, CodesThemeSuggestionReviews } from "./codes/CodesCodebookAiReviews";
import { CodesCodeDialog } from "./codes/CodesCodeDialog";
import { CodesDeleteEntityDialog } from "./codes/CodesDeleteEntityDialog";
import { CodesEvidenceDeleteDialog } from "./codes/CodesEvidenceDeleteDialog";
import { CodesMergeCodeDialog } from "./codes/CodesMergeCodeDialog";
import { CodesDraftDialog } from "./codes/CodesDraftDialog";
import { CodesExportPanel } from "./codes/CodesExportPanel";
import { CodesImportPanel } from "./codes/CodesImportPanel";
import { CodesProjectSidebar } from "./codes/CodesProjectSidebar";
import { CodesSetupPanel } from "./codes/CodesSetupPanel";
import { CodesThemeDialog } from "./codes/CodesThemeDialog";
import { CodesTranscriptReader } from "./codes/CodesTranscriptReader";
import { CodesTranscriptToolbar } from "./codes/CodesTranscriptToolbar";
import { CodesTranscriptActionDialog } from "./codes/CodesTranscriptActionDialog";
import { CodesWorkspaceHeader } from "./codes/CodesWorkspaceHeader";
import { CodesWorkspaceTabs, type CodesWorkspaceTab } from "./codes/CodesWorkspaceTabs";
import { useWorkbenchPageLifecycle } from "./workbench/WorkbenchLifecycle";
import { evidenceSelectionFromDom } from "./codes/codesEvidenceSelection";

type CodesPageProps = {
  providers: PromptingProviderStatus[];
  providersLoading: boolean;
  providerError: string | null;
  onRefreshProviders: () => void | Promise<void>;
};

export function CodesPage({
  providers,
  providersLoading,
  providerError,
  onRefreshProviders
}: CodesPageProps) {
  const desktopAvailable = isTauri();
  const [statusMessage, setStatusMessage] = useState(
    desktopAvailable ? "No Coding Project Open" : "Coding project files are available in the desktop app."
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const {
    project,
    projectFile,
    projectHandle,
    projectConflict,
    settingsDirty,
    settingsSaveState,
    getCurrentSession,
    activateProjectSession,
    applyPersistedProject,
    clearProjectSession,
    setProjectConflict,
    updateProjectSettingsLocally,
    updateProjectAiSettingsLocally,
    scheduleSettingsPersistence,
    persistSettingsImmediately: persistProjectSettings,
    isSettingsPersistenceLocked
  } = useCodesProjectSession({
    onSettingsSaveStarted: () => setErrorMessage(null),
    onSettingsSaveError: (error, fallback) => {
      setErrorMessage(error instanceof Error ? error.message : fallback);
    },
    onSettingsSaved: () => setStatusMessage("Project settings saved.")
  });
  const projectLifecycleRef = useRef<ReturnType<typeof useCodesProjectFileLifecycle> | null>(null);
  const draftGuardRef = useRef<ReturnType<typeof useCodesDraftGuard> | null>(null);
  const codebookBusyRef = useRef(false);
  const evidenceBusyRef = useRef(false);
  const evidenceWorkspaceRef = useRef<ReturnType<typeof useCodesEvidenceWorkspace> | null>(null);
  const codebookWorkspaceRef = useRef<ReturnType<typeof useCodesCodebookWorkspace> | null>(null);
  const aiDecisionLifecycleRef = useRef<ReturnType<typeof useCodesAiDecisionLifecycle> | null>(null);
  const [activeTab, setActiveTab] = useState<CodesWorkspaceTab>("evidence");
  const activeTabRef = useRef<CodesWorkspaceTab>("evidence");
  activeTabRef.current = activeTab;
  const segmentRefs = useRef<Record<string, HTMLElement | null>>({});

  const {
    preview: importPreview,
    selectedCandidateIds: selectedImportCandidateIds,
    result: importResult,
    busy: importBusy,
    isLocked: importIsLocked,
    chooseFile: handleAddTranscriptFile,
    chooseFolder: handleAddTranscriptFolder,
    toggleCandidate: toggleImportCandidate,
    confirmImport: handleConfirmTranscriptImport,
    cancelPreview: cancelImportPreview,
    dismissResult: dismissImportResult,
    reset: resetTranscriptImport
  } = useCodesTranscriptImport({
    desktopAvailable,
    getCurrentSession,
    applyPersistedProject,
    persistProjectSettings,
    onOperationStarted: () => setErrorMessage(null),
    onPreviewReady: () => setStatusMessage(""),
    onImportApplied: ({ project: nextProject, result }) => {
      evidenceWorkspaceRef.current?.reconcileAfterImport(nextProject, result);
      const importedLabel = result.imported.length === 1 ? "1 transcript" : `${result.imported.length} transcripts`;
      setStatusMessage(`Imported ${importedLabel}; ${result.skipped.length} skipped; ${result.failed.length} failed.`);
    },
    onError: reportCodesError
  });
  const {
    products: exportProducts,
    docxMode: exportDocxMode,
    includeLocalPaths: exportIncludeLocalPaths,
    includeAiAudit: exportIncludeAiAudit,
    bundlePath: exportBundlePath,
    artifacts: exportArtifacts,
    warnings: exportWarnings,
    status: exportStatus,
    error: exportError,
    busy: exportBusy,
    isLocked: exportIsLocked,
    toggleProduct: toggleExportProduct,
    setDocxMode: setExportDocxMode,
    setIncludeLocalPaths: setExportIncludeLocalPaths,
    setIncludeAiAudit: setExportIncludeAiAudit,
    exportProject: handleExportProject,
    openOutputFolder: handleOpenExportFolder
  } = useCodesProjectExport({
    desktopAvailable,
    getCurrentSession
  });

  const contextualAi = useCodesContextualAiWorkspace({
    desktopAvailable,
    project,
    projectFile,
    providers,
    providersLoading,
    providerError,
    onRefreshProviders,
    getCurrentSession,
    persistProjectSettings,
    applyPersistedProject,
    updateProjectAiSettingsLocally,
    isExternallyLocked: () => Boolean(
      aiDecisionLifecycleRef.current?.isLocked()
      || codebookWorkspaceRef.current?.isLocked()
      || evidenceWorkspaceRef.current?.isLocked()
      || projectLifecycleRef.current?.isLocked()
      || importIsLocked()
      || exportIsLocked()
      || isSettingsPersistenceLocked()
      || getCurrentSession().projectConflict
    ),
    getEvidenceWorkspace: () => evidenceWorkspaceRef.current,
    getCodebookWorkspace: () => codebookWorkspaceRef.current,
    clearDecisionError: (task, suggestionId) => aiDecisionLifecycleRef.current?.clearError(task, suggestionId),
    onStatusMessage: setStatusMessage
  });
  const decisionExternalLockRef = useRef(false);
  decisionExternalLockRef.current = Boolean(
    contextualAi.isLocked()
    || codebookBusyRef.current
    || evidenceBusyRef.current
    || projectLifecycleRef.current?.isLocked()
    || importIsLocked()
    || exportIsLocked()
    || isSettingsPersistenceLocked()
    || getCurrentSession().projectConflict
  );
  const aiDecisionLifecycle = useCodesAiDecisionLifecycle({
    getCurrentSession,
    applyPersistedProject,
    persistProjectSettings,
    isExternallyLocked: () => decisionExternalLockRef.current,
    onProjectConflict: setProjectConflict,
    onEvidenceAccepted: contextualAi.handleEvidenceAccepted,
    onSuggestionRejected: contextualAi.handleSuggestionRejected
  });
  aiDecisionLifecycleRef.current = aiDecisionLifecycle;
  const codebookExternalLockRef = useRef(false);
  codebookExternalLockRef.current = Boolean(
    contextualAi.isLocked()
    || aiDecisionLifecycle.isLocked()
    || evidenceBusyRef.current
    || projectLifecycleRef.current?.isLocked()
    || importIsLocked()
    || exportIsLocked()
    || isSettingsPersistenceLocked()
    || getCurrentSession().projectConflict
  );
  const codebookWorkspace = useCodesCodebookWorkspace({
    getCurrentSession,
    applyPersistedProject,
    persistProjectSettings,
    isExternallyLocked: () => codebookExternalLockRef.current,
    onBusyChange: (value) => {
      codebookBusyRef.current = value;
    },
    onProjectConflict: setProjectConflict,
    onStatusMessage: setStatusMessage,
    onSaveStarted: () => setErrorMessage(null),
    onSaveError: (error, fallback) => setErrorMessage(error instanceof Error ? error.message : fallback),
    onCodeDeleted: (codeId) => evidenceWorkspaceRef.current?.removeDeletedCode(codeId)
  });
  codebookWorkspaceRef.current = codebookWorkspace;
  const evidenceExternalLockRef = useRef(false);
  evidenceExternalLockRef.current = Boolean(
    contextualAi.isLocked()
    || aiDecisionLifecycle.isLocked()
    || codebookBusyRef.current
    || projectLifecycleRef.current?.isLocked()
    || importIsLocked()
    || exportIsLocked()
    || isSettingsPersistenceLocked()
    || getCurrentSession().projectConflict
  );
  const evidenceWorkspace = useCodesEvidenceWorkspace({
    getCurrentSession,
    applyPersistedProject,
    persistProjectSettings,
    isExternallyLocked: () => Boolean(
      contextualAi.isLocked()
      || aiDecisionLifecycleRef.current?.isLocked()
      || codebookBusyRef.current
      || projectLifecycleRef.current?.isLocked()
      || importIsLocked()
      || exportIsLocked()
      || isSettingsPersistenceLocked()
      || getCurrentSession().projectConflict
    ),
    onBusyChange: (value) => {
      evidenceBusyRef.current = value;
    },
    onProjectConflict: setProjectConflict,
    onOperationStarted: () => setErrorMessage(null),
    onStatusMessage: setStatusMessage,
    onError: (error, fallback) => setErrorMessage(error instanceof Error ? error.message : fallback)
  });
  evidenceWorkspaceRef.current = evidenceWorkspace;
  const decisionBusy = aiDecisionLifecycle.busy;
  const decisionControlsLocked = decisionExternalLockRef.current;
  const codebookControlsLocked = codebookExternalLockRef.current;
  const evidenceControlsLocked = evidenceExternalLockRef.current;
  const activeAiRun = contextualAi.activeRun;
  const aiReady = contextualAi.ready;
  const aiTaskBusy = contextualAi.taskBusy;
  const aiTaskError = contextualAi.taskError;
  const aiTaskWarning = contextualAi.taskWarning;
  const activeAiBusyTask = contextualAi.activeBusyTask;
  const setAiInspectorTarget = contextualAi.setInspectorTarget;
  const setAiCodebookTargets = contextualAi.setCodebookTargets;

  const projectFileLabel = fileName(projectFile);
  const {
    activeTranscriptId,
    selectedEvidenceId,
    evidenceDraft,
    evidenceEditDraft,
    activeTranscript,
    selectedEvidence,
    evidenceEditDirty,
    evidenceSearch,
    evidenceScope,
    evidenceFilterCodeId,
    evidenceFilterThemeId,
    highlightSettings,
    transcriptActionDialog
  } = evidenceWorkspace;
  const {
    activeView: codebookView,
    codeForm,
    themeForm,
    codeDraftDirty,
    themeDraftDirty
  } = codebookWorkspace;
  const draftGuard = useCodesDraftGuard({
    getDraftState: () => {
      const evidenceState = evidenceWorkspaceRef.current?.getDraftState();
      const codebookState = codebookWorkspaceRef.current?.getDraftState();
      return {
        activeTab: activeTabRef.current,
        codebookView: codebookState?.activeView ?? "codes",
        evidenceDraft: Boolean(evidenceState?.evidenceDraft),
        evidenceEditDirty: Boolean(evidenceState?.evidenceEditDirty),
        codeDraftDirty: Boolean(codebookState?.codeDraftDirty),
        codeName: codebookState?.codeForm.name ?? "",
        themeDraftDirty: Boolean(codebookState?.themeDraftDirty),
        themeName: codebookState?.themeForm.name ?? "",
        settingsDirty: getCurrentSession().settingsDirty
      };
    },
    isExternallyLocked: () => Boolean(
      projectLifecycleRef.current?.isLocked()
      || contextualAi.isLocked()
      || aiDecisionLifecycleRef.current?.isLocked()
      || codebookWorkspaceRef.current?.isLocked()
      || evidenceWorkspaceRef.current?.isLocked()
      || importIsLocked()
      || exportIsLocked()
      || isSettingsPersistenceLocked()
    ),
    saveEvidenceDraft: () => evidenceWorkspaceRef.current?.saveEvidenceDraft() ?? Promise.resolve(false),
    saveEvidenceEditDraft: () => evidenceWorkspaceRef.current?.saveSelectedEvidence() ?? Promise.resolve(false),
    saveCodeDraft: () => codebookWorkspaceRef.current?.saveCode() ?? Promise.resolve(false),
    saveThemeDraft: () => codebookWorkspaceRef.current?.saveTheme() ?? Promise.resolve(false),
    discardEvidenceDraft: () => evidenceWorkspaceRef.current?.discardEvidenceDraft(),
    discardEvidenceEditDraft: () => evidenceWorkspaceRef.current?.restoreEvidenceEditDraft(),
    discardCodeDraft: () => codebookWorkspaceRef.current?.cancelCodeForm(),
    discardThemeDraft: () => codebookWorkspaceRef.current?.cancelThemeForm(),
    persistProjectSettings
  });
  draftGuardRef.current = draftGuard;
  const projectLifecycle = useCodesProjectFileLifecycle({
    desktopAvailable,
    getCurrentSession,
    activateProjectSession,
    clearProjectSession,
    isExternallyLocked: () => Boolean(
      draftGuardRef.current?.isLocked()
      || contextualAi.isLocked()
      || aiDecisionLifecycleRef.current?.isLocked()
      || codebookWorkspaceRef.current?.isLocked()
      || evidenceWorkspaceRef.current?.isLocked()
      || importIsLocked()
      || exportIsLocked()
      || isSettingsPersistenceLocked()
    ),
    resetAiDecisions: aiDecisionLifecycle.reset,
    invalidateDraftGuard: draftGuard.invalidate,
    resetEvidenceForNewProject: evidenceWorkspace.resetForNewProject,
    resetEvidenceForOpenProject: evidenceWorkspace.resetForOpenProject,
    resetEvidenceForReload: evidenceWorkspace.resetForReload,
    resetEvidenceForClose: evidenceWorkspace.resetForClose,
    reconcileEvidenceAfterSaveAs: evidenceWorkspace.reconcileAfterSaveAs,
    resetCodebook: codebookWorkspace.reset,
    resetTranscriptImport,
    showEvidenceWorkspace: () => {
      activeTabRef.current = "evidence";
      setActiveTab("evidence");
    },
    onOperationStarted: () => setErrorMessage(null),
    onStatusMessage: setStatusMessage,
    onError: reportCodesError,
    onClose: () => setErrorMessage(null)
  });
  projectLifecycleRef.current = projectLifecycle;
  const busy = projectLifecycle.busy
    || importBusy
    || exportBusy
    || decisionBusy
    || codebookWorkspace.busy
    || evidenceWorkspace.busy;
  const canUseProjectFiles = desktopAvailable && !busy && settingsSaveState !== "saving";
  const canEditProject = Boolean(project && projectHandle) && canUseProjectFiles;
  const hasUnsavedDraft = Boolean(evidenceDraft)
    || evidenceEditDirty
    || codeDraftDirty
    || themeDraftDirty;
  const hasUnsavedChanges = settingsDirty || hasUnsavedDraft;
  const projectStatus = errorMessage ?? statusMessage;
  const contextualAiBusy = contextualAi.activeWork;
  const aiWorkLocked = contextualAiBusy || decisionBusy;
  useWorkbenchPageLifecycle("codes", {
    dirty: hasUnsavedChanges,
    activeJob: busy || contextualAiBusy,
    activityLabel: decisionBusy
      ? "Saving a Codes AI decision"
      : contextualAiBusy
      ? "Codes AI assistance in progress"
      : hasUnsavedChanges
        ? "Codes has an unsaved draft"
        : busy
        ? "Codes operation in progress"
        : ""
  });
  const projectCounts = useMemo(
    () => ({
      transcripts: project?.transcripts.length ?? 0,
      evidence: project?.evidence_items.length ?? 0,
      codes: project?.codes.length ?? 0,
      themes: project?.themes.length ?? 0
    }),
    [project]
  );
  const projectSaveState = settingsSaveState === "saving"
    ? "saving" as const
    : settingsSaveState === "failed"
      ? "failed" as const
      : hasUnsavedChanges
        ? "draft" as const
        : "saved" as const;
  const inspectorTargetKey = evidenceDraft
    ? `draft:${evidenceDraft.transcriptId}:${evidenceDraft.segmentIds.join(",")}`
    : selectedEvidence
      ? `evidence:${selectedEvidence.evidence_id}`
      : "";

  useEffect(() => {
    setAiInspectorTarget(inspectorTargetKey);
  }, [inspectorTargetKey, setAiInspectorTarget]);

  useEffect(() => {
    setAiCodebookTargets(codeForm.codeId, themeForm.themeId);
  }, [codeForm.codeId, setAiCodebookTargets, themeForm.themeId]);

  useEffect(() => {
    if (!project || !statusMessage) return;
    const timeout = window.setTimeout(() => setStatusMessage(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [project, statusMessage]);

  function persistAiEvidenceAcceptance(suggestion: Parameters<typeof contextualAi.authorizeEvidenceSuggestion>[0]) {
    const authoritative = contextualAi.authorizeEvidenceSuggestion(suggestion);
    if (authoritative) void aiDecisionLifecycle.acceptEvidenceSuggestion(authoritative);
  }

  function persistAiSuggestionRejection(rejection: Parameters<typeof contextualAi.authorizeSuggestionRejection>[0]) {
    const authoritative = contextualAi.authorizeSuggestionRejection(rejection);
    if (authoritative) void aiDecisionLifecycle.rejectSuggestion(authoritative);
  }

  function persistAiEvidenceClear(suggestions: Parameters<typeof contextualAi.authorizeEvidenceSuggestions>[0]) {
    const authoritative = contextualAi.authorizeEvidenceSuggestions(suggestions);
    if (authoritative.length) void aiDecisionLifecycle.rejectEvidenceSuggestions(authoritative);
  }

  function reportCodesError(error: unknown, fallback: string) {
    if (error instanceof CodesProjectConflictError) {
      setProjectConflict(error);
    }
    setErrorMessage(error instanceof Error ? error.message : fallback);
  }

  function runIfDecisionUnlocked(action: () => void) {
    if (
      !contextualAi.isLocked()
      && !aiDecisionLifecycle.isLocked()
      && !codebookWorkspace.isLocked()
      && !evidenceWorkspace.isLocked()
      && !projectLifecycleRef.current?.isLocked()
      && !importIsLocked()
      && !exportIsLocked()
      && !isSettingsPersistenceLocked()
      && !getCurrentSession().projectConflict
    ) action();
  }

  function showWorkspace(tab: CodesWorkspaceTab) {
    activeTabRef.current = tab;
    setActiveTab(tab);
  }

  async function runAfterSettingsPersistence(action: () => unknown) {
    if (aiDecisionLifecycle.isLocked() || codebookWorkspace.isLocked() || evidenceWorkspace.isLocked()) return;
    if (getCurrentSession().settingsDirty && !await persistProjectSettings()) return;
    if (aiDecisionLifecycle.isLocked() || codebookWorkspace.isLocked() || evidenceWorkspace.isLocked()) return;
    await action();
  }

  function updateProjectLocally(updater: (current: CodesProject) => CodesProject) {
    if (contextualAi.isLocked() || aiDecisionLifecycle.isLocked() || codebookWorkspace.isLocked() || evidenceWorkspace.isLocked()) return;
    updateProjectSettingsLocally(updater);
  }

  function scheduleProjectSettingsSave() {
    if (contextualAi.isLocked() || aiDecisionLifecycle.isLocked() || codebookWorkspace.isLocked() || evidenceWorkspace.isLocked()) return;
    scheduleSettingsPersistence();
  }

  function handleCaptureEvidenceSelection() {
    if (!activeTranscript) {
      return;
    }
    const draftSelection = evidenceSelectionFromDom(window.getSelection(), activeTranscript);
    if (draftSelection) evidenceWorkspace.captureSelection(draftSelection);
  }
  function handleSelectEvidence(evidence: Parameters<typeof evidenceWorkspace.selectEvidence>[0]) {
    if (evidence.evidence_id === selectedEvidenceId && !evidenceDraft) return;
    draftGuard.guardAction(() => {
      evidenceWorkspace.selectEvidence(evidence);
    }, "evidence", { allowLockedNavigation: true });
  }

  if (!project) {
    return (
      <CodesSetupPanel
        desktopAvailable={desktopAvailable}
        busy={busy || settingsSaveState === "saving" || aiWorkLocked}
        statusLabel={projectStatus}
        hasError={Boolean(errorMessage)}
        onNewProject={() => void projectLifecycle.newProject()}
        onOpenProject={() => void projectLifecycle.openProject()}
      />
    );
  }

  return (
    <div className="page-stack codes-page">
      <CodesWorkspaceHeader
        projectName={project.name}
        researchFocus={project.research_focus}
        projectFileLabel={projectFileLabel}
        saveState={projectSaveState}
        statusLabel={projectStatus}
        hasError={Boolean(errorMessage)}
        busy={busy || settingsSaveState === "saving" || aiWorkLocked}
        canUseProjectFiles={canUseProjectFiles}
        canSaveProject={hasUnsavedChanges && canEditProject}
        counts={projectCounts}
        aiSettings={(
          <CodesAiSettings
            project={project}
            open={contextualAi.settingsOpen}
            focusRequest={contextualAi.settingsFocusRequest}
            providers={providers}
            models={contextualAi.models}
            providersLoading={providersLoading}
            modelsLoading={contextualAi.modelsLoading}
            hasModelSnapshot={contextualAi.hasModelSnapshot}
            providerError={providerError}
            modelError={contextualAi.modelError}
            configurationError={contextualAi.configurationError}
            busy={busy || settingsSaveState === "saving" || aiWorkLocked}
            onOpenChange={contextualAi.setSettingsVisibility}
            onRefreshProviders={() => void contextualAi.refreshProviders()}
            onUpdate={contextualAi.updateSettings}
          />
        )}
        onProjectNameChange={(name) => updateProjectLocally((current) => ({ ...current, name }))}
        onResearchFocusChange={(research_focus) => updateProjectLocally((current) => ({ ...current, research_focus }))}
        onSaveSettings={scheduleProjectSettingsSave}
        onRetrySettings={() => runIfDecisionUnlocked(() => void persistProjectSettings())}
        onNewProject={() => draftGuard.guardAction(() => void runAfterSettingsPersistence(projectLifecycle.newProject))}
        onOpenProject={() => draftGuard.guardAction(() => void runAfterSettingsPersistence(projectLifecycle.openProject))}
        onSaveProject={() => void draftGuard.saveProject()}
        onSaveProjectAs={() => draftGuard.guardAction(() => void projectLifecycle.saveAs())}
        onCloseProject={() => draftGuard.guardAction(() => void runAfterSettingsPersistence(projectLifecycle.close))}
      />

      {projectConflict ? (
        <section className="section-card" role="alert" aria-live="assertive">
          <div className="section-heading">
            <div>
              <h3 className="home-section-title">Project changed outside the app</h3>
              <p>{projectConflict.message}</p>
            </div>
            <div className="action-row">
              <button type="button" className="secondary-button" disabled={busy || aiWorkLocked} onClick={() => draftGuard.guardAction(() => void projectLifecycle.reload())}>
                Reload
              </button>
              <button type="button" className="secondary-button" disabled={busy || aiWorkLocked} onClick={() => draftGuard.guardAction(() => void projectLifecycle.saveAs())}>
                Save Copy
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <CodesWorkspaceTabs
        activeTab={activeTab}
        onTabChange={(tab) => draftGuard.guardAction(
          () => showWorkspace(tab),
          "all",
          { allowLockedNavigation: true }
        )}
      />

      {activeTab === "evidence" ? (
        <div id="codes-panel-evidence" role="tabpanel" aria-labelledby="codes-tab-evidence" className="page-stack">
          {project.transcripts.length ? (
            <CodesTranscriptToolbar
              project={project}
              activeTranscript={activeTranscript}
              activeTranscriptId={activeTranscriptId}
              importResult={importResult}
              importPreviewPending={Boolean(importPreview)}
              busy={busy || evidenceControlsLocked}
              canEditProject={canEditProject}
              onSelectTranscript={(transcriptId) => draftGuard.guardAction(() => {
                evidenceWorkspace.selectTranscript(transcriptId);
              }, "evidence", { allowLockedNavigation: true })}
              onAddTranscriptFolder={() => runIfDecisionUnlocked(() => void handleAddTranscriptFolder())}
              onAddTranscriptFile={() => runIfDecisionUnlocked(() => void handleAddTranscriptFile())}
              onRemoveTranscript={(transcript) => draftGuard.guardAction(() => evidenceWorkspace.openTranscriptRemoval(transcript), "evidence")}
              onDismissImportResult={dismissImportResult}
            />
          ) : null}

          {!project.transcripts.length || importPreview ? (
            <CodesImportPanel
              preview={importPreview}
              selectedCandidateIds={selectedImportCandidateIds}
              result={project.transcripts.length ? null : importResult}
              busy={busy || evidenceControlsLocked}
              canEditProject={canEditProject}
              compact={project.transcripts.length > 0}
              onChooseFolder={() => runIfDecisionUnlocked(() => void handleAddTranscriptFolder())}
              onChooseFile={() => runIfDecisionUnlocked(() => void handleAddTranscriptFile())}
              onToggleCandidate={toggleImportCandidate}
              onConfirm={() => runIfDecisionUnlocked(() => void handleConfirmTranscriptImport())}
              onCancel={cancelImportPreview}
            />
          ) : null}

          {project.transcripts.length ? (
            <div className="codes-workspace">
              <CodesTranscriptReader
                project={project}
                activeTranscript={activeTranscript}
                selectedEvidence={selectedEvidence}
                evidenceDraft={evidenceDraft}
                highlightSettings={highlightSettings}
                canEditProject={canEditProject && !evidenceControlsLocked}
                segmentRefs={segmentRefs}
                onCaptureEvidenceSelection={handleCaptureEvidenceSelection}
                onClearEvidenceSelection={() => window.getSelection()?.removeAllRanges()}
                onHighlightSettingsChange={evidenceWorkspace.setHighlightSettings}
                onSelectEvidence={handleSelectEvidence}
                aiConfigured={aiReady}
                aiPrompt={contextualAi.promptFor("evidence")}
                aiRun={activeAiRun}
                aiBusy={aiTaskBusy("evidence")}
                aiLocked={aiWorkLocked}
                aiCancellationPending={contextualAi.cancellationPending}
                aiConnectionMessage={activeAiRun?.task === "evidence" ? contextualAi.reconnectingMessage : ""}
                aiError={aiTaskError("evidence")}
                aiWarning={aiTaskWarning("evidence")}
                aiSuggestions={contextualAi.evidenceSuggestions}
                selectedAiSuggestionId={contextualAi.selectedEvidenceSuggestionId}
                onRequireAiConfiguration={contextualAi.requireConfiguration}
                onSaveAiPrompt={(prompt) => contextualAi.updatePrompt("evidence", prompt)}
                onRestoreAiPrompt={() => contextualAi.restorePrompt("evidence")}
                onRunEvidenceAi={(request) => void contextualAi.runEvidence(request)}
                onCancelAiRun={() => void contextualAi.cancel()}
                onRetryAiRun={() => void contextualAi.retry("evidence")}
                onSelectAiSuggestion={contextualAi.selectEvidenceSuggestion}
              />

              <div className="codes-evidence-workspace">
                <CodesProjectSidebar
                  project={project}
                  activeTranscriptId={activeTranscriptId}
                  selectedEvidenceId={selectedEvidenceId}
                  evidenceSearch={evidenceSearch}
                  evidenceScope={evidenceScope}
                  evidenceFilterCodeId={evidenceFilterCodeId}
                  evidenceFilterThemeId={evidenceFilterThemeId}
                  onSelectEvidence={handleSelectEvidence}
                  onEvidenceSearchChange={evidenceWorkspace.setEvidenceSearch}
                  onEvidenceScopeChange={evidenceWorkspace.setEvidenceScope}
                  onEvidenceFilterCodeChange={evidenceWorkspace.setEvidenceFilterCodeId}
                  onEvidenceFilterThemeChange={evidenceWorkspace.setEvidenceFilterThemeId}
                  onClearEvidenceFilters={evidenceWorkspace.clearFilters}
                  aiSuggestions={contextualAi.evidenceSuggestions}
                  selectedAiSuggestionId={contextualAi.selectedEvidenceSuggestionId}
                  aiLocked={decisionControlsLocked}
                  aiDecisionAction={aiDecisionLifecycle.activeAction}
                  aiDecisionErrorFor={aiDecisionLifecycle.errorFor}
                  onSelectAiSuggestion={contextualAi.selectEvidenceSuggestion}
                  onAcceptAiSuggestion={persistAiEvidenceAcceptance}
                  onRejectAiSuggestion={persistAiSuggestionRejection}
                  onClearAiSuggestions={persistAiEvidenceClear}
                />
                <CodesInspector
                  project={project}
                  selectedEvidence={selectedEvidence}
                  evidenceEditDraft={evidenceEditDraft}
                  evidenceEditDirty={evidenceEditDirty}
                  evidenceDraft={evidenceDraft}
                  busy={busy || evidenceControlsLocked}
                  canEditProject={canEditProject && !evidenceControlsLocked}
                  onInspectorMemoChange={evidenceWorkspace.updateInspectorMemo}
                  onDeleteSelectedEvidence={evidenceWorkspace.openEvidenceDelete}
                  onSaveSelectedEvidence={() => void evidenceWorkspace.saveSelectedEvidence()}
                  onSaveEvidenceDraft={() => void evidenceWorkspace.saveEvidenceDraft()}
                  onCancelEvidenceDraft={evidenceWorkspace.discardEvidenceDraft}
                  onCancelSelectedEvidenceChanges={evidenceWorkspace.restoreEvidenceEditDraft}
                  onToggleInspectorCode={evidenceWorkspace.toggleInspectorCode}
                  onAddInspectorCode={contextualAi.addInspectorCode}
                  onRemoveInspectorCode={evidenceWorkspace.removeInspectorCode}
                  aiConfigured={aiReady}
                  aiRun={activeAiRun}
                  aiBusyTask={activeAiBusyTask}
                  aiLocked={decisionControlsLocked}
                  aiDecisionAction={aiDecisionLifecycle.activeAction}
                  aiDecisionErrorFor={aiDecisionLifecycle.errorFor}
                  aiResultRunIds={contextualAi.resultRunIds}
                  aiCancellationPending={contextualAi.cancellationPending}
                  aiConnectionMessage={contextualAi.reconnectingMessage}
                  aiError={activeAiBusyTask === "codes" ? aiTaskError("codes") : activeAiBusyTask === "note" ? aiTaskError("note") : aiTaskError("codes") ?? aiTaskError("note")}
                  aiCodeDetailsError={aiTaskError("code_details")}
                  aiWarning={activeAiBusyTask === "codes" ? aiTaskWarning("codes") : activeAiBusyTask === "note" ? aiTaskWarning("note") : aiTaskWarning("codes") ?? aiTaskWarning("note")}
                  aiCodeSuggestions={contextualAi.codeSuggestions}
                  aiCodeDetailsSuggestion={contextualAi.codeDetailsSuggestion}
                  aiCodeDetailsSuggestionTarget={contextualAi.codeDetailsSuggestionTarget}
                  aiNoteSuggestion={contextualAi.noteSuggestion}
                  aiPrompts={{
                    codes: contextualAi.promptFor("codes"),
                    note: contextualAi.promptFor("note")
                  }}
                  onRequireAiConfiguration={contextualAi.requireConfiguration}
                  onSaveAiPrompt={contextualAi.updatePrompt}
                  onRestoreAiPrompt={contextualAi.restorePrompt}
                  onRunAi={(task, prompt) => contextualAi.runInspector(task, prompt)}
                  onRunCodeDetailsAi={(value, target, text) => void contextualAi.runCodeDetails(value, target, text)}
                  onAuthorizeCodeDetailsAi={contextualAi.authorizeCodeDetailsSuggestion}
                  onActivateCodeDialogAiTarget={contextualAi.activateCodeDialogTarget}
                  onInvalidateCodeDialogAiTarget={contextualAi.invalidateCodeDialogTarget}
                  onCancelAiRun={() => void contextualAi.cancel()}
                  onRetryAiRun={() => void contextualAi.retry(aiTaskError("codes") ? "codes" : "note")}
                  onStageAiCode={contextualAi.stageAiCode}
                  onApplyAiNote={contextualAi.applyAiNote}
                  onRejectAiSuggestion={persistAiSuggestionRejection}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "codebook" ? (
        <div id="codes-panel-codebook" role="tabpanel" aria-labelledby="codes-tab-codebook">
          <CodesCodebookPanel
            project={project}
            activeView={codebookView}
            codeForm={codeForm}
            themeForm={themeForm}
            busy={busy || codebookControlsLocked}
            canEditProject={canEditProject}
            codeFormDirty={codeDraftDirty}
            themeFormDirty={themeDraftDirty}
            editorError={codebookWorkspace.entityEditorError}
            onViewChange={(view) => {
              if (view === codebookView) return;
              draftGuard.guardAction(
                () => codebookWorkspace.changeView(view),
                codebookView === "codes" ? "code" : "theme",
                { allowLockedNavigation: true }
              );
            }}
            onCodeFormChange={codebookWorkspace.updateCodeForm}
            onThemeFormChange={codebookWorkspace.updateThemeForm}
            onToggleThemeCode={codebookWorkspace.toggleThemeCode}
            onSaveCode={() => void codebookWorkspace.saveCode()}
            onSaveTheme={() => void codebookWorkspace.saveTheme()}
            onNewCode={() => draftGuard.guardAction(() => codebookWorkspace.openNewCode(), "code")}
            onNewTheme={() => draftGuard.guardAction(() => codebookWorkspace.openNewTheme(), "theme")}
            onCancelCode={codebookWorkspace.cancelCodeForm}
            onCancelTheme={codebookWorkspace.cancelThemeForm}
            onEditCode={(code) => {
              if (code.code_id === codeForm.codeId) return;
              draftGuard.guardAction(() => {
                evidenceWorkspace.setEvidenceFilterCodeId(code.code_id);
                showWorkspace("codebook");
                codebookWorkspace.selectCode(code);
              }, "code", { allowLockedNavigation: true });
            }}
            onEditTheme={(theme) => {
              if (theme.theme_id === themeForm.themeId) return;
              draftGuard.guardAction(() => {
                evidenceWorkspace.setEvidenceFilterThemeId(theme.theme_id);
                showWorkspace("codebook");
                codebookWorkspace.selectTheme(theme);
              }, "theme", { allowLockedNavigation: true });
            }}
            onDeleteCode={(code) => draftGuard.guardAction(() => codebookWorkspace.openDeleteCode(code.code_id), "code")}
            onDeleteTheme={(theme) => draftGuard.guardAction(() => codebookWorkspace.openDeleteTheme(theme.theme_id), "theme")}
            onOpenMergeCode={(code) => codebookWorkspace.openMergeCode(code.code_id)}
            onOpenEvidence={(evidence) => draftGuard.guardAction(() => {
              evidenceWorkspace.selectEvidence(evidence);
              evidenceWorkspace.setEvidenceScope("active");
              showWorkspace("evidence");
            }, codebookView === "codes" ? "code" : "theme", { allowLockedNavigation: true })}
            codeAiAction={codeForm.codeId ? (
              <CodesAiActionButton
                action="Refine Code"
                busy={aiTaskBusy("code_refinement")}
                disabled={busy || aiWorkLocked}
                onClick={() => aiReady ? void contextualAi.runCodeRefinement(codeForm) : contextualAi.requireConfiguration()}
              />
            ) : null}
            codeAiResults={(
              <>
                {activeAiRun?.task === "code_refinement" ? <CodesAiProgress run={activeAiRun} timeoutSeconds={project.ai_settings.timeout_seconds} onCancel={() => void contextualAi.cancel()} cancellationPending={contextualAi.cancellationPending} connectionMessage={contextualAi.reconnectingMessage} /> : null}
                {aiTaskError("code_refinement") ? <div className="codes-ai-inline-message error" role="alert">{aiTaskError("code_refinement")}</div> : null}
                {contextualAi.codeRefinementSuggestion ? (
                  <CodesCodeRefinementReview
                    suggestion={contextualAi.codeRefinementSuggestion}
                    current={codeForm}
                    aiLocked={decisionControlsLocked}
                    decisionAction={aiDecisionLifecycle.activeAction}
                    decisionError={aiDecisionLifecycle.errorFor("code_refinement", contextualAi.codeRefinementSuggestion.suggestion_id)?.message ?? null}
                    onApplyField={(field) => contextualAi.applyCodeRefinement(contextualAi.codeRefinementSuggestion!, [field])}
                    onApplyAll={() => contextualAi.applyCodeRefinement(contextualAi.codeRefinementSuggestion!)}
                    onReject={persistAiSuggestionRejection}
                  />
                ) : null}
              </>
            )}
            themeAiAction={(
              <div className="codes-theme-ai-scope">
                <select className="text-input compact" value={contextualAi.themeScope} disabled={aiWorkLocked} onChange={(event) => {
                  contextualAi.setThemeScope(event.target.value as "all" | "selected");
                }} aria-label="AI Theme Scope">
                  <option value="all">All Codes</option>
                  <option value="selected">Selected Codes</option>
                </select>
                {contextualAi.themeScope === "selected" ? (
                  <details className="codes-theme-ai-code-picker">
                    <summary>{contextualAi.themeSelectedCodeIds.length} Selected</summary>
                    <div>{project.codes.map((code) => <label key={code.code_id}><input type="checkbox" disabled={aiWorkLocked} checked={contextualAi.themeSelectedCodeIds.includes(code.code_id)} onChange={() => contextualAi.toggleThemeScopeCode(code.code_id)} />{code.name}</label>)}</div>
                  </details>
                ) : null}
                <CodesAiActionButton action="Suggest Themes" busy={aiTaskBusy("theme_suggestions")} disabled={busy || aiWorkLocked} onClick={() => aiReady ? void contextualAi.runThemeSuggestions() : contextualAi.requireConfiguration()} />
              </div>
            )}
            themeRefineAiAction={themeForm.themeId ? <CodesAiActionButton action="Refine Theme" busy={aiTaskBusy("theme_refinement")} disabled={busy || aiWorkLocked} onClick={() => aiReady ? void contextualAi.runThemeRefinement(themeForm) : contextualAi.requireConfiguration()} /> : null}
            themeAiResults={(
              <>
                {activeAiRun && ["theme_suggestions", "theme_refinement"].includes(activeAiRun.task) ? <CodesAiProgress run={activeAiRun} timeoutSeconds={project.ai_settings.timeout_seconds} onCancel={() => void contextualAi.cancel()} cancellationPending={contextualAi.cancellationPending} connectionMessage={contextualAi.reconnectingMessage} /> : null}
                {aiTaskError("theme_suggestions") ? <div className="codes-ai-inline-message error" role="alert">{aiTaskError("theme_suggestions")}</div> : null}
                {aiTaskError("theme_refinement") ? <div className="codes-ai-inline-message error" role="alert">{aiTaskError("theme_refinement")}</div> : null}
                <CodesThemeSuggestionReviews
                  suggestions={contextualAi.themeSuggestions}
                  project={project}
                  aiLocked={decisionControlsLocked}
                  decisionAction={aiDecisionLifecycle.activeAction}
                  decisionErrorFor={aiDecisionLifecycle.errorFor}
                  onAccept={contextualAi.acceptThemeSuggestion}
                  onReject={persistAiSuggestionRejection}
                />
                {contextualAi.themeRefinementSuggestion ? (
                  <CodesThemeRefinementReview
                    suggestion={contextualAi.themeRefinementSuggestion}
                    project={project}
                    aiLocked={decisionControlsLocked}
                    decisionAction={aiDecisionLifecycle.activeAction}
                    decisionError={aiDecisionLifecycle.errorFor("theme_refinement", contextualAi.themeRefinementSuggestion.suggestion_id)?.message ?? null}
                    onApply={() => contextualAi.applyThemeRefinement(contextualAi.themeRefinementSuggestion!)}
                    onReject={persistAiSuggestionRejection}
                  />
                ) : null}
              </>
            )}
          />
        </div>
      ) : null}

      {activeTab === "export" ? (
        <div id="codes-panel-export" role="tabpanel" aria-labelledby="codes-tab-export">
          <CodesExportPanel
            products={exportProducts}
            docxMode={exportDocxMode}
            includeLocalPaths={exportIncludeLocalPaths}
            includeAiAudit={exportIncludeAiAudit}
            bundlePath={exportBundlePath}
            artifacts={exportArtifacts}
            warnings={exportWarnings}
            statusLabel={exportStatus}
            errorLabel={exportError}
            busy={busy || settingsSaveState === "saving" || aiWorkLocked}
            canEditProject={canEditProject}
            onToggleProduct={toggleExportProduct}
            onDocxModeChange={setExportDocxMode}
            onIncludeLocalPathsChange={setExportIncludeLocalPaths}
            onIncludeAiAuditChange={setExportIncludeAiAudit}
            onOpenOutputFolder={() => void handleOpenExportFolder()}
            onExportProject={() => runIfDecisionUnlocked(() => void handleExportProject())}
          />
        </div>
      ) : null}

      <CodesDraftDialog
        open={Boolean(draftGuard.dialogKind)}
        draftLabel={draftGuard.dialogLabel}
        canSave={draftGuard.dialogCanSave}
        busy={busy}
        onSave={() => void draftGuard.saveDialog()}
        onDiscard={draftGuard.discardDialog}
        onCancel={draftGuard.cancelDialog}
      />
      <CodesCodeDialog
        open={codebookWorkspace.codeDialogOpen}
        project={project}
        initialValue={codebookWorkspace.codeDialogInitialValue}
        busy={busy || codebookControlsLocked}
        error={codebookWorkspace.entityDialogError}
        aiConfigured={aiReady}
        aiRun={activeAiRun?.task === "code_details" ? activeAiRun : null}
        aiBusy={aiTaskBusy("code_details")}
        aiLocked={decisionControlsLocked}
        aiDecisionAction={aiDecisionLifecycle.activeAction}
        aiDecisionErrorFor={aiDecisionLifecycle.errorFor}
        aiCancellationPending={contextualAi.cancellationPending}
        aiConnectionMessage={contextualAi.reconnectingMessage}
        aiError={aiTaskError("code_details")}
        aiSuggestion={contextualAi.codeDetailsSuggestion}
        aiSuggestionTarget={contextualAi.codeDetailsSuggestionTarget}
        aiSurface="codebook"
        aiTimeoutSeconds={project.ai_settings.timeout_seconds}
        onRunAi={(value, target) => void contextualAi.runCodeDetails(value, target)}
        onCancelAi={() => void contextualAi.cancel()}
        onRequireAiConfiguration={contextualAi.requireConfiguration}
        onAuthorizeAiSuggestion={contextualAi.authorizeCodeDetailsSuggestion}
        onActivateAiTarget={contextualAi.activateCodeDialogTarget}
        onInvalidateAiTarget={contextualAi.invalidateCodeDialogTarget}
        onRejectAiSuggestion={persistAiSuggestionRejection}
        onSubmit={(value) => void codebookWorkspace.createCode(value)}
        onClose={codebookWorkspace.closeCodeDialog}
      />
      <CodesThemeDialog
        open={codebookWorkspace.themeDialogOpen}
        project={project}
        initialValue={codebookWorkspace.themeDialogInitialValue}
        busy={busy || codebookControlsLocked}
        error={codebookWorkspace.entityDialogError}
        onSubmit={(value) => void codebookWorkspace.createTheme(value)}
        onClose={codebookWorkspace.closeThemeDialog}
      />
      <CodesMergeCodeDialog
        open={Boolean(codebookWorkspace.mergeSourceCodeId)}
        source={project.codes.find((code) => code.code_id === codebookWorkspace.mergeSourceCodeId) ?? null}
        codes={project.codes}
        evidenceAssignments={project.evidence_items.filter((evidence) => evidence.code_ids.includes(codebookWorkspace.mergeSourceCodeId)).length}
        themesAffected={project.themes.filter((theme) => theme.code_ids.includes(codebookWorkspace.mergeSourceCodeId)).length}
        busy={busy || codebookControlsLocked}
        error={codebookWorkspace.mergeDialogError}
        onSubmit={(targetCodeId, fields) => void codebookWorkspace.mergeCode(targetCodeId, fields)}
        onClose={codebookWorkspace.closeMergeCode}
      />
      <CodesDeleteEntityDialog
        open={Boolean(codebookWorkspace.deleteCodeId)}
        entityType="code"
        entityName={project.codes.find((code) => code.code_id === codebookWorkspace.deleteCodeId)?.name ?? codebookWorkspace.deleteCodeId}
        primaryImpact={`${project.evidence_items.filter((evidence) => evidence.code_ids.includes(codebookWorkspace.deleteCodeId)).length} evidence assignment(s) will be removed.`}
        secondaryImpact={`${project.themes.filter((theme) => theme.code_ids.includes(codebookWorkspace.deleteCodeId)).length} theme membership(s) will be removed.`}
        busy={busy || codebookControlsLocked}
        error={codebookWorkspace.deleteEntityError}
        onConfirm={() => {
          const code = project.codes.find((item) => item.code_id === codebookWorkspace.deleteCodeId);
          if (code) void codebookWorkspace.deleteCode(code);
        }}
        onClose={codebookWorkspace.closeDeleteCode}
      />
      <CodesDeleteEntityDialog
        open={Boolean(codebookWorkspace.deleteThemeId)}
        entityType="theme"
        entityName={project.themes.find((theme) => theme.theme_id === codebookWorkspace.deleteThemeId)?.name ?? codebookWorkspace.deleteThemeId}
        primaryImpact={`${project.themes.find((theme) => theme.theme_id === codebookWorkspace.deleteThemeId)?.code_ids.length ?? 0} code membership(s) will be removed.`}
        secondaryImpact={`${new Set(project.evidence_items.filter((evidence) => evidence.code_ids.some((codeId) => project.themes.find((theme) => theme.theme_id === codebookWorkspace.deleteThemeId)?.code_ids.includes(codeId))).map((evidence) => evidence.evidence_id)).size} related evidence item(s) remain unchanged.`}
        busy={busy || codebookControlsLocked}
        error={codebookWorkspace.deleteEntityError}
        onConfirm={() => {
          const theme = project.themes.find((item) => item.theme_id === codebookWorkspace.deleteThemeId);
          if (theme) void codebookWorkspace.deleteTheme(theme);
        }}
        onClose={codebookWorkspace.closeDeleteTheme}
      />
      <CodesTranscriptActionDialog
        state={transcriptActionDialog}
        busy={evidenceWorkspace.busy}
        mutationLocked={evidenceControlsLocked}
        error={evidenceWorkspace.transcriptError}
        onConfirmRemove={() => void evidenceWorkspace.confirmTranscriptRemoval()}
        onShowEvidence={evidenceWorkspace.showTranscriptEvidence}
        onClose={evidenceWorkspace.closeTranscriptRemoval}
      />
      <CodesEvidenceDeleteDialog
        evidence={evidenceWorkspace.evidenceToDelete}
        hasUnsavedChanges={evidenceEditDirty}
        busy={evidenceWorkspace.busy}
        mutationLocked={evidenceControlsLocked}
        error={evidenceWorkspace.deleteEvidenceError}
        onConfirm={() => void evidenceWorkspace.confirmEvidenceDelete()}
        onClose={evidenceWorkspace.closeEvidenceDelete}
      />
    </div>
  );
}
