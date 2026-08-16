import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CodeDialogValue,
  CodesCodeDialogTarget
} from "../components/codes/CodesCodeDialog";
import {
  type CodeForm,
  type ThemeForm
} from "../components/codes/codesPageUtils";
import {
  BUILT_IN_CODES_AI_PROMPTS,
  effectiveCodesAiPrompt,
  type ContextualAiTask
} from "../components/codes/codesAiPrompts";
import type { EvidenceAiScope } from "../components/codes/CodesAiEvidenceDialog";
import type {
  CodesAiRunSnapshot,
  CodesAiRunStartPayload,
  CodesAiRunTask,
  CodesProject,
  PromptingProviderStatus
} from "../lib/api";
import { CODES_AI_ACTIVE_STATUSES, useCodesAiRunLifecycle } from "./useCodesAiRunLifecycle";
import {
  codesProjectSessionIdentity,
  type CodesCodebookWorkspaceBridge,
  type CodesEvidenceWorkspaceBridge,
  type ContextualAiRunRequest
} from "./codesContextualAiContracts";
import { useCodesAiSuggestionWorkspace } from "./useCodesAiSuggestionWorkspace";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "./useCodesProjectSession";
import { useProviderModelCatalog } from "./useProviderModelCatalog";

type CodesContextualAiWorkspaceOptions = {
  desktopAvailable: boolean;
  project: CodesProject | null;
  projectFile: string | null;
  providers: PromptingProviderStatus[];
  providersLoading: boolean;
  providerError: string | null;
  onRefreshProviders: () => void | Promise<void>;
  getCurrentSession: () => CodesProjectSessionSnapshot;
  persistProjectSettings: () => Promise<PersistedProjectSettings | null>;
  applyPersistedProject: (payload: PersistedProjectSettings) => boolean;
  updateProjectAiSettingsLocally: (update: Partial<CodesProject["ai_settings"]>) => void;
  isExternallyLocked: () => boolean;
  getEvidenceWorkspace: () => CodesEvidenceWorkspaceBridge | null;
  getCodebookWorkspace: () => CodesCodebookWorkspaceBridge | null;
  clearDecisionError: (task: CodesAiRunTask, suggestionId?: string) => void;
  onStatusMessage: (message: string) => void;
};

type RunContext = {
  identity: string;
  generation: number;
  request: ContextualAiRunRequest;
  runId?: string;
};

function sessionIdentity(session: CodesProjectSessionSnapshot) {
  return codesProjectSessionIdentity(session.project, session.projectFile);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)])
    );
  }
  return value;
}

function cloneRecord(value?: Record<string, unknown>) {
  return value ? cloneValue(value) as Record<string, unknown> : undefined;
}

function cloneRequest(request: ContextualAiRunRequest): ContextualAiRunRequest {
  return {
    ...request,
    scope: cloneRecord(request.scope),
    segmentIds: request.segmentIds ? [...request.segmentIds] : undefined,
    codeIds: request.codeIds ? [...request.codeIds] : undefined,
    selectedCodeIds: request.selectedCodeIds ? [...request.selectedCodeIds] : undefined,
    codeDraft: cloneRecord(request.codeDraft),
    themeDraft: cloneRecord(request.themeDraft),
    codeDialogTarget: request.codeDialogTarget ? { ...request.codeDialogTarget } : undefined
  };
}

export function useCodesContextualAiWorkspace(options: CodesContextualAiWorkspaceOptions) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocusRequest, setSettingsFocusRequest] = useState(0);
  const [configurationRequested, setConfigurationRequested] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<CodesAiRunTask, string>>>({});
  const [warnings, setWarnings] = useState<Partial<Record<CodesAiRunTask, string>>>({});
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const currentIdentity = codesProjectSessionIdentity(options.project, options.projectFile);
  const identityRef = useRef(currentIdentity);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingStartRef = useRef<RunContext | null>(null);
  const activeRunRef = useRef<RunContext | null>(null);
  const pendingTerminalRef = useRef<CodesAiRunSnapshot | null>(null);
  const processedRunIdsRef = useRef(new Set<string>());
  const lastRequestsRef = useRef<Partial<Record<CodesAiRunTask, ContextualAiRunRequest>>>({});

  if (identityRef.current !== currentIdentity) {
    identityRef.current = currentIdentity;
    generationRef.current += 1;
    pendingStartRef.current = null;
    activeRunRef.current = null;
    pendingTerminalRef.current = null;
    lastRequestsRef.current = {};
  }

  const clearTaskFeedback = useCallback((task: CodesAiRunTask, suggestionId?: string) => {
    setErrors((current) => ({ ...current, [task]: undefined }));
    setWarnings((current) => ({ ...current, [task]: undefined }));
    optionsRef.current.clearDecisionError(task, suggestionId);
  }, []);

  const runLockRef = useRef<() => boolean>(() => false);
  const suggestionWorkspace = useCodesAiSuggestionWorkspace({
    project: options.project,
    projectFile: options.projectFile,
    getCurrentSession: options.getCurrentSession,
    getEvidenceWorkspace: options.getEvidenceWorkspace,
    getCodebookWorkspace: options.getCodebookWorkspace,
    isRunLocked: () => runLockRef.current(),
    isExternallyLocked: options.isExternallyLocked,
    clearTaskFeedback,
    clearDecisionError: options.clearDecisionError,
    onStatusMessage: options.onStatusMessage
  });
  const {
    requestTargetIsCurrent,
    routeCompletedRun: routeSuggestionRun,
    registerRunId,
    captureInspectorContext,
    captureThemeSuggestionScope
  } = suggestionWorkspace.coordinator;

  const runMatchesCurrentSession = useCallback((snapshot: CodesAiRunSnapshot) => {
    const context = activeRunRef.current ?? pendingStartRef.current;
    return Boolean(
      mountedRef.current
      && context
      && context.generation === generationRef.current
      && context.identity === identityRef.current
      && snapshot.project_id === optionsRef.current.project?.project_id
      && snapshot.task === context.request.task
      && (!context.runId || snapshot.run_id === context.runId)
    );
  }, []);

  const routeCompletedRun = useCallback((snapshot: CodesAiRunSnapshot) => {
    if (!runMatchesCurrentSession(snapshot) || processedRunIdsRef.current.has(snapshot.run_id)) return false;
    const context = activeRunRef.current ?? pendingStartRef.current;
    if (!context || !requestTargetIsCurrent(context.request)) {
      processedRunIdsRef.current.add(snapshot.run_id);
      clearTaskFeedback(snapshot.task);
      return false;
    }
    processedRunIdsRef.current.add(snapshot.run_id);
    if (!routeSuggestionRun(snapshot, context.request)) {
      clearTaskFeedback(snapshot.task);
      return false;
    }
    setErrors((current) => ({ ...current, [snapshot.task]: undefined }));
    setWarnings((current) => ({
      ...current,
      [snapshot.task]: snapshot.omitted.length
        ? `${snapshot.omitted.length} invalid suggestion(s) were omitted. Valid suggestions remain available.`
        : undefined
    }));
    return true;
  }, [
    clearTaskFeedback,
    runMatchesCurrentSession,
    requestTargetIsCurrent,
    routeSuggestionRun
  ]);

  const routeFailedRun = useCallback((snapshot: CodesAiRunSnapshot) => {
    if (!runMatchesCurrentSession(snapshot) || processedRunIdsRef.current.has(snapshot.run_id)) return false;
    const context = activeRunRef.current ?? pendingStartRef.current;
    if (!context || !requestTargetIsCurrent(context.request)) {
      processedRunIdsRef.current.add(snapshot.run_id);
      clearTaskFeedback(snapshot.task);
      return false;
    }
    processedRunIdsRef.current.add(snapshot.run_id);
    setErrors((current) => ({
      ...current,
      [snapshot.task]: snapshot.error || snapshot.message || "AI assistance failed."
    }));
    return true;
  }, [clearTaskFeedback, requestTargetIsCurrent, runMatchesCurrentSession]);

  const receiveTerminalRun = useCallback((snapshot: CodesAiRunSnapshot) => {
    const active = activeRunRef.current;
    if (active?.runId === snapshot.run_id) {
      if (snapshot.status === "completed") routeCompletedRun(snapshot);
      else routeFailedRun(snapshot);
      return;
    }
    const pending = pendingStartRef.current;
    if (
      pending
      && pending.generation === generationRef.current
      && pending.identity === identityRef.current
      && pending.request.task === snapshot.task
      && snapshot.project_id === optionsRef.current.project?.project_id
    ) {
      pendingTerminalRef.current = snapshot;
    }
  }, [routeCompletedRun, routeFailedRun]);

  const lifecycle = useCodesAiRunLifecycle({
    projectId: options.project?.project_id ?? "",
    sessionKey: currentIdentity,
    onCompleted: receiveTerminalRun,
    onFailed: receiveTerminalRun
  });
  runLockRef.current = lifecycle.isLocked;

  const selectedProviderId = options.project?.ai_settings.provider_id ?? "";
  const selectedModelId = options.project?.ai_settings.model_id ?? "";
  const selectedProvider = options.providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const providerAvailable = Boolean(selectedProvider?.available);
  const {
    models,
    modelsLoading,
    modelError,
    hasTrustworthySnapshot: hasModelSnapshot,
    hasModel,
    refreshModels
  } = useProviderModelCatalog(
    selectedProviderId,
    options.desktopAvailable && settingsOpen && providerAvailable
  );
  const configuredModelMissing = Boolean(selectedModelId && hasModelSnapshot && !hasModel(selectedModelId));
  const configuredProviderUnavailable = Boolean(
    selectedProviderId && !options.providersLoading && !providerAvailable
  );
  const configurationProblem = !selectedProviderId
    ? options.providersLoading
      ? "Local provider status is still being checked."
      : "Choose a local AI provider before running assistance."
    : options.providersLoading && !providerAvailable
      ? "Local provider status is still being checked."
      : configuredProviderUnavailable
        ? `${selectedProvider?.name ?? selectedProviderId} is not currently available. Start the local provider or choose another one.`
        : !selectedModelId
          ? "Choose a local model before running assistance."
          : configuredModelMissing
            ? `${selectedModelId} is not available from ${selectedProvider?.name ?? selectedProviderId}. Choose another local model.`
            : null;
  const configurationError = configuredProviderUnavailable || configuredModelMissing || configurationRequested
    ? configurationProblem
    : null;
  const ready = Boolean(selectedProviderId && selectedModelId && providerAvailable && !configuredModelMissing);
  const activeRun = lifecycle.run;
  const activeBusyTask = lifecycle.startingTask
    ?? (activeRun && CODES_AI_ACTIVE_STATUSES.has(activeRun.status) ? activeRun.task : null);

  const taskBusy = useCallback((task: CodesAiRunTask) => lifecycle.startingTask === task
    || Boolean(activeRun?.task === task && CODES_AI_ACTIVE_STATUSES.has(activeRun.status)), [activeRun, lifecycle.startingTask]);
  const taskError = useCallback((task: CodesAiRunTask) => lifecycle.lostRunError?.task === task
    ? lifecycle.lostRunError.message
    : errors[task] ?? null, [errors, lifecycle.lostRunError]);
  const taskWarning = useCallback((task: CodesAiRunTask) => warnings[task] ?? null, [warnings]);

  const resetProjectState = useCallback(() => {
    setConfigurationRequested(false);
    setErrors({});
    setWarnings({});
    lastRequestsRef.current = {};
    pendingStartRef.current = null;
    activeRunRef.current = null;
    pendingTerminalRef.current = null;
    processedRunIdsRef.current.clear();
  }, []);

  useEffect(() => {
    resetProjectState();
  }, [currentIdentity, resetProjectState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      pendingStartRef.current = null;
      activeRunRef.current = null;
      pendingTerminalRef.current = null;
    };
  }, []);

  const requireConfiguration = useCallback(() => {
    setSettingsOpen(true);
    setSettingsFocusRequest((current) => current + 1);
    setConfigurationRequested(true);
  }, []);

  const setSettingsVisibility = useCallback((open: boolean) => {
    setSettingsOpen(open);
  }, []);

  const updateSettings = useCallback((update: Partial<CodesProject["ai_settings"]>) => {
    if (lifecycle.isLocked() || optionsRef.current.isExternallyLocked()) return false;
    if ("provider_id" in update || "model_id" in update) setConfigurationRequested(false);
    optionsRef.current.updateProjectAiSettingsLocally(update);
    return true;
  }, [lifecycle]);

  const updatePrompt = useCallback((task: ContextualAiTask, prompt: string) => {
    const project = optionsRef.current.getCurrentSession().project;
    if (!project) return false;
    return updateSettings({
      prompt_overrides: {
        evidence: project.ai_settings.prompt_overrides?.evidence ?? "",
        codes: project.ai_settings.prompt_overrides?.codes ?? "",
        note: project.ai_settings.prompt_overrides?.note ?? "",
        codebook: project.ai_settings.prompt_overrides?.codebook ?? "",
        themes: project.ai_settings.prompt_overrides?.themes ?? "",
        [task]: prompt.trim()
      }
    });
  }, [updateSettings]);

  const restorePrompt = useCallback((task: ContextualAiTask) => {
    const updated = updatePrompt(task, "");
    return updated ? BUILT_IN_CODES_AI_PROMPTS[task] : null;
  }, [updatePrompt]);

  const promptFor = useCallback((task: ContextualAiTask) => effectiveCodesAiPrompt(
    optionsRef.current.project?.ai_settings.prompt_overrides,
    task
  ), []);

  const refreshProviders = useCallback(async () => {
    if (
      lifecycle.isLocked()
      || optionsRef.current.isExternallyLocked()
      || optionsRef.current.providersLoading
      || modelsLoading
    ) return false;
    await optionsRef.current.onRefreshProviders();
    if (selectedProviderId && settingsOpen) await refreshModels();
    return true;
  }, [lifecycle, modelsLoading, refreshModels, selectedProviderId, settingsOpen]);

  const start = useCallback(async (incoming: ContextualAiRunRequest) => {
    const request = cloneRequest(incoming);
    const session = optionsRef.current.getCurrentSession();
    const identity = sessionIdentity(session);
    if (!session.project || !session.projectHandle || !identity) return false;
    if (!ready) {
      requireConfiguration();
      return false;
    }
    if (!requestTargetIsCurrent(request)) return false;
    if (optionsRef.current.isExternallyLocked()) {
      setErrors((current) => ({
        ...current,
        [request.task]: "Another Codes operation is already active for this project."
      }));
      return false;
    }
    if (lifecycle.isLocked()) {
      setErrors((current) => ({
        ...current,
        [request.task]: "Another AI run is already active for this project."
      }));
      return false;
    }

    const context: RunContext = {
      identity,
      generation: generationRef.current,
      request
    };
    pendingStartRef.current = context;
    pendingTerminalRef.current = null;
    lastRequestsRef.current = { ...lastRequestsRef.current, [request.task]: cloneRequest(request) };
    setErrors((current) => ({ ...current, [request.task]: undefined }));
    setWarnings((current) => ({ ...current, [request.task]: undefined }));
    try {
      const payload = await lifecycle.start(request.task, async () => {
        const persisted = await optionsRef.current.persistProjectSettings();
        if (!persisted) return null;
        if (
          context.generation !== generationRef.current
          || context.identity !== identityRef.current
          || sessionIdentity(optionsRef.current.getCurrentSession()) !== context.identity
          || codesProjectSessionIdentity(persisted.project, persisted.handle.project_file) !== context.identity
          || !requestTargetIsCurrent(request)
        ) return null;
        return {
          project: persisted.project,
          handle: { ...persisted.handle },
          task: request.task,
          researcher_prompt: request.researcherPrompt,
          maximum_suggestions: request.maximumSuggestions,
          scope: cloneRecord(request.scope),
          transcript_id: request.transcriptId,
          segment_ids: request.segmentIds ? [...request.segmentIds] : undefined,
          evidence_id: request.evidenceId,
          selected_text: request.selectedText,
          code_ids: request.codeIds ? [...request.codeIds] : undefined,
          code_id: request.codeId,
          theme_id: request.themeId,
          selected_code_ids: request.selectedCodeIds ? [...request.selectedCodeIds] : undefined,
          code_draft: cloneRecord(request.codeDraft),
          theme_draft: cloneRecord(request.themeDraft)
        } satisfies CodesAiRunStartPayload;
      });
      if (!payload) return false;
      if (
        !mountedRef.current
        || context.generation !== generationRef.current
        || context.identity !== identityRef.current
        || sessionIdentity(optionsRef.current.getCurrentSession()) !== context.identity
        || payload.run.project_id !== session.project.project_id
        || payload.run.task !== request.task
        || !optionsRef.current.applyPersistedProject(payload)
      ) return false;
      const activeContext = { ...context, runId: payload.run.run_id };
      activeRunRef.current = activeContext;
      registerRunId(request.task, payload.run.run_id);
      const terminal = pendingTerminalRef.current as CodesAiRunSnapshot | null;
      if (terminal?.run_id === payload.run.run_id) {
        pendingTerminalRef.current = null;
        if (terminal.status === "completed") routeCompletedRun(terminal);
        else routeFailedRun(terminal);
      }
      return true;
    } catch (error) {
      if (
        mountedRef.current
        && context.generation === generationRef.current
        && context.identity === identityRef.current
        && pendingStartRef.current === context
      ) {
        setErrors((current) => ({
          ...current,
          [request.task]: error instanceof Error ? error.message : "AI assistance could not start."
        }));
      }
      return false;
    } finally {
      if (pendingStartRef.current === context) pendingStartRef.current = null;
    }
  }, [lifecycle, ready, registerRunId, requestTargetIsCurrent, requireConfiguration, routeCompletedRun, routeFailedRun]);

  const retry = useCallback((task: CodesAiRunTask) => {
    const request = lastRequestsRef.current[task];
    return request ? start(cloneRequest(request)) : Promise.resolve(false);
  }, [start]);

  const runEvidence = useCallback((request: {
    transcriptId: string;
    scope: EvidenceAiScope;
    researcherPrompt: string;
    maximumSuggestions: number;
  }) => start({
    task: "evidence",
    transcriptId: request.transcriptId,
    scope: cloneRecord(request.scope) ?? {},
    researcherPrompt: request.researcherPrompt,
    maximumSuggestions: request.maximumSuggestions
  }), [start]);

  const runInspector = useCallback((task: "codes" | "note", researcherPrompt: string) => {
    const context = captureInspectorContext();
    if (!context) {
      setErrors((current) => ({ ...current, [task]: "Select or draft one evidence passage first." }));
      return Promise.resolve(false);
    }
    return start({ task, researcherPrompt, ...context });
  }, [captureInspectorContext, start]);

  const runCodeDetails = useCallback((
    value: CodeDialogValue,
    target: CodesCodeDialogTarget,
    selectedText = ""
  ) => start({
    task: "code_details",
    codeDialogTarget: { ...target },
    researcherPrompt: effectiveCodesAiPrompt(optionsRef.current.project?.ai_settings.prompt_overrides, "codebook"),
    selectedText,
    codeDraft: {
      name: value.name,
      description: value.description,
      inclusion_note: value.inclusionNote,
      exclusion_note: value.exclusionNote,
      memo: value.memo
    }
  }), [start]);

  const runCodeRefinement = useCallback((form: CodeForm) => {
    if (!form.codeId) return Promise.resolve(false);
    return start({
      task: "code_refinement",
      researcherPrompt: effectiveCodesAiPrompt(optionsRef.current.project?.ai_settings.prompt_overrides, "codebook"),
      codeId: form.codeId,
      codeDraft: {
        name: form.name,
        description: form.description,
        inclusion_note: form.inclusionNote,
        exclusion_note: form.exclusionNote,
        memo: form.memo
      }
    });
  }, [start]);

  const runThemeSuggestions = useCallback(() => {
    const { selectedCodeIds, error } = captureThemeSuggestionScope();
    if (error) {
      setErrors((current) => ({
        ...current,
        theme_suggestions: error
      }));
      return Promise.resolve(false);
    }
    return start({
      task: "theme_suggestions",
      researcherPrompt: effectiveCodesAiPrompt(optionsRef.current.project?.ai_settings.prompt_overrides, "themes"),
      selectedCodeIds,
      maximumSuggestions: 5
    });
  }, [captureThemeSuggestionScope, start]);

  const runThemeRefinement = useCallback((form: ThemeForm) => {
    if (!form.themeId) return Promise.resolve(false);
    return start({
      task: "theme_refinement",
      researcherPrompt: effectiveCodesAiPrompt(optionsRef.current.project?.ai_settings.prompt_overrides, "themes"),
      themeId: form.themeId,
      themeDraft: {
        name: form.name,
        description: form.description,
        memo: form.memo,
        code_ids: [...form.codeIds]
      }
    });
  }, [start]);

  const cancel = useCallback(async () => {
    const run = lifecycle.run;
    if (!run) return false;
    const context = activeRunRef.current;
    setErrors((current) => ({ ...current, [run.task]: undefined }));
    try {
      const accepted = await lifecycle.cancel();
      if (
        accepted
        && context
        && context.generation === generationRef.current
        && context.identity === identityRef.current
      ) setErrors((current) => ({ ...current, [run.task]: undefined }));
      return accepted;
    } catch (error) {
      if (
        context
        && context.generation === generationRef.current
        && context.identity === identityRef.current
      ) {
        setErrors((current) => ({
          ...current,
          [run.task]: error instanceof Error ? error.message : "AI cancellation failed."
        }));
      }
      return false;
    }
  }, [lifecycle]);

  const suggestionState = suggestionWorkspace.state;
  const suggestionActions = suggestionWorkspace.actions;

  return {
    settingsOpen,
    settingsFocusRequest,
    configurationError,
    models,
    modelsLoading,
    modelError,
    hasModelSnapshot,
    ready,
    activeRun,
    activeWork: lifecycle.activeWork,
    activeBusyTask,
    cancellationPending: lifecycle.cancellationPending,
    reconnectingMessage: lifecycle.reconnectingMessage,
    evidenceSuggestions: suggestionState.evidenceSuggestions,
    selectedEvidenceSuggestionId: suggestionState.selectedEvidenceSuggestionId,
    codeSuggestions: suggestionState.codeSuggestions,
    noteSuggestion: suggestionState.noteSuggestion,
    resultRunIds: suggestionState.resultRunIds,
    codeDetailsSuggestion: suggestionState.codeDetailsSuggestion,
    codeDetailsSuggestionTarget: suggestionState.codeDetailsSuggestionTarget,
    codeRefinementSuggestion: suggestionState.codeRefinementSuggestion,
    themeSuggestions: suggestionState.themeSuggestions,
    themeRefinementSuggestion: suggestionState.themeRefinementSuggestion,
    themeScope: suggestionState.themeScope,
    themeSelectedCodeIds: suggestionState.themeSelectedCodeIds,
    isLocked: lifecycle.isLocked,
    taskBusy,
    taskError,
    taskWarning,
    setSettingsVisibility,
    requireConfiguration,
    updateSettings,
    updatePrompt,
    restorePrompt,
    promptFor,
    refreshProviders,
    retry,
    runEvidence,
    runInspector,
    runCodeDetails,
    runCodeRefinement,
    runThemeSuggestions,
    runThemeRefinement,
    cancel,
    ...suggestionActions
  };
}
