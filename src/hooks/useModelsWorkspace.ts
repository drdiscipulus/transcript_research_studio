import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteFasterWhisperModel,
  deletePyannoteModel,
  downloadFasterWhisperModel,
  downloadPyannoteModel,
  fetchModelDownloadProgress,
  fetchModelsStatus,
  openExternalUrl,
  testHfToken,
  type FasterWhisperModelStatus,
  type HfTokenTestResult,
  type ModelsStatus,
  type PyannoteModelStatus
} from "../lib/api";
import { modelAvailability } from "../lib/modelsAvailability";
import type {
  ModelsOperationKind,
  ModelsTarget,
  ModelsTokenTestResult,
  ModelsWorkspaceContract
} from "../lib/modelsWorkspaceContracts";

type ActiveOperation = {
  token: number;
  session: number;
  kind: ModelsOperationKind;
  target: ModelsTarget | null;
};

type DeleteDialogState = {
  requestKey: string;
  target: ModelsTarget;
  operationToken: number;
};

type OperationView = {
  kind: ModelsOperationKind;
  targetId: string | null;
} | null;

function replaceFasterWhisperModel(
  catalog: ModelsStatus | null,
  model: FasterWhisperModelStatus
): ModelsStatus | null {
  if (!catalog || !catalog.faster_whisper.some((candidate) => candidate.value === model.value)) {
    return catalog;
  }
  return {
    ...catalog,
    faster_whisper: catalog.faster_whisper.map((candidate) => (
      candidate.value === model.value ? model : candidate
    ))
  };
}

function replacePyannoteModel(
  catalog: ModelsStatus | null,
  pyannote: PyannoteModelStatus
): ModelsStatus | null {
  return catalog ? { ...catalog, pyannote } : catalog;
}

function tokenPresentationResult(result: HfTokenTestResult, token: string): ModelsTokenTestResult {
  const message = token && result.message.includes(token)
    ? result.message.split(token).join("[redacted-token]")
    : result.message;
  return {
    ok: result.ok,
    status: result.status === "restricted" ? "restricted" : result.ok ? "ok" : "error",
    message
  };
}

export function useModelsWorkspace(): ModelsWorkspaceContract {
  const [modelsStatus, setModelsStatusState] = useState<ModelsStatus | null>(null);
  const [modelsStatusLoading, setModelsStatusLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [tokenInput, setTokenInputState] = useState("");
  const [tokenResult, setTokenResult] = useState<ModelsTokenTestResult | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [operationView, setOperationView] = useState<OperationView>(null);
  const [downloadProgress, setDownloadProgress] = useState<Awaited<ReturnType<typeof fetchModelDownloadProgress>>["downloads"][string] | null>(null);
  const [progressWarning, setProgressWarning] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const [externalLinkError, setExternalLinkError] = useState<string | null>(null);
  const [deleteDialogView, setDeleteDialogView] = useState<{
    requestKey: string;
    target: ModelsTarget;
  } | null>(null);

  const lifecycleSequenceRef = useRef(0);
  const activeLifecycleSessionRef = useRef<number | null>(null);
  const catalogRef = useRef<ModelsStatus | null>(null);
  const catalogGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const tokenInputRef = useRef("");
  const tokenInputGenerationRef = useRef(0);
  const deleteDialogSequenceRef = useRef(0);
  const deleteDialogRef = useRef<DeleteDialogState | null>(null);
  const progressGenerationRef = useRef(0);
  const progressTimerRef = useRef<number | null>(null);

  const isSessionActive = useCallback((session: number | null) => (
    session !== null && activeLifecycleSessionRef.current === session
  ), []);

  const isOperationActive = useCallback((operation: ActiveOperation) => (
    isSessionActive(operation.session)
    && activeOperationRef.current?.token === operation.token
  ), [isSessionActive]);

  const publishCatalog = useCallback((status: ModelsStatus) => {
    catalogRef.current = status;
    catalogGenerationRef.current += 1;
    setModelsStatusState(status);
  }, []);

  const acquireOperation = useCallback((
    kind: ModelsOperationKind,
    target: ModelsTarget | null = null
  ): ActiveOperation | null => {
    const session = activeLifecycleSessionRef.current;
    if (session === null || activeOperationRef.current !== null) return null;
    const operation: ActiveOperation = {
      token: operationSequenceRef.current + 1,
      session,
      kind,
      target
    };
    operationSequenceRef.current = operation.token;
    activeOperationRef.current = operation;
    setOperationView({ kind, targetId: target?.id ?? null });
    return operation;
  }, []);

  const releaseOperation = useCallback((operation: ActiveOperation) => {
    if (activeOperationRef.current?.token !== operation.token) return;
    activeOperationRef.current = null;
    if (isSessionActive(operation.session)) setOperationView(null);
  }, [isSessionActive]);

  const reportUnexpectedModelResponse = useCallback((operation: ActiveOperation) => {
    if (!isOperationActive(operation)) return false;
    setMutationError("The local service returned an unexpected model response. Try again.");
    setMutationMessage(null);
    return true;
  }, [isOperationActive]);

  const stopProgressPolling = useCallback((operation: ActiveOperation) => {
    progressGenerationRef.current += 1;
    if (progressTimerRef.current !== null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (isOperationActive(operation)) {
      setDownloadProgress(null);
      setProgressWarning(null);
    }
  }, [isOperationActive]);

  const startProgressPolling = useCallback((operation: ActiveOperation, downloadId: string) => {
    const pollGeneration = progressGenerationRef.current + 1;
    progressGenerationRef.current = pollGeneration;
    let failures = 0;

    const poll = async (): Promise<void> => {
      let delay = 1_000;
      try {
        const payload = await fetchModelDownloadProgress();
        if (!isOperationActive(operation) || progressGenerationRef.current !== pollGeneration) return;
        const progress = payload.downloads[downloadId];
        if (progress?.id !== downloadId) return;
        failures = 0;
        setDownloadProgress(progress);
        setProgressWarning(null);
      } catch {
        if (!isOperationActive(operation) || progressGenerationRef.current !== pollGeneration) return;
        failures += 1;
        delay = Math.min(10_000, 1_000 * (2 ** Math.min(failures - 1, 4)));
        setProgressWarning("Download status is stale because the local service could not be reached.");
      } finally {
        if (isOperationActive(operation) && progressGenerationRef.current === pollGeneration) {
          progressTimerRef.current = window.setTimeout(() => void poll(), delay);
        }
      }
    };

    void poll();
  }, [isOperationActive]);

  const runCatalogRequest = useCallback(async (
    operation: ActiveOperation,
    followUpMutation: boolean
  ): Promise<boolean> => {
    const request = refreshRequestRef.current + 1;
    refreshRequestRef.current = request;
    const catalogGeneration = catalogGenerationRef.current;
    try {
      const status = await fetchModelsStatus();
      if (
        !isOperationActive(operation)
        || refreshRequestRef.current !== request
        || catalogGenerationRef.current !== catalogGeneration
      ) return false;
      publishCatalog(status);
      setCatalogError(null);
      return true;
    } catch {
      if (!isOperationActive(operation) || refreshRequestRef.current !== request) return false;
      setCatalogError(
        followUpMutation
          ? "The model changed successfully, but the latest full model status could not be refreshed."
          : "Model status could not be loaded. Try Refresh again."
      );
      return false;
    }
  }, [isOperationActive, publishCatalog]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const operation = acquireOperation("refresh");
    if (!operation) return false;
    setModelsStatusLoading(true);
    setCatalogError(null);
    try {
      return await runCatalogRequest(operation, false);
    } finally {
      if (isOperationActive(operation)) setModelsStatusLoading(false);
      releaseOperation(operation);
    }
  }, [acquireOperation, isOperationActive, releaseOperation, runCatalogRequest]);

  useEffect(() => {
    const session = lifecycleSequenceRef.current + 1;
    lifecycleSequenceRef.current = session;
    activeLifecycleSessionRef.current = session;
    const operation = acquireOperation("refresh");
    if (operation) {
      setModelsStatusLoading(true);
      void runCatalogRequest(operation, false).finally(() => {
        if (isOperationActive(operation)) setModelsStatusLoading(false);
        releaseOperation(operation);
      });
    }
    return () => {
      if (activeLifecycleSessionRef.current === session) activeLifecycleSessionRef.current = null;
      refreshRequestRef.current += 1;
      progressGenerationRef.current += 1;
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      activeOperationRef.current = null;
      deleteDialogRef.current = null;
      tokenInputRef.current = "";
      tokenInputGenerationRef.current += 1;
    };
  }, [acquireOperation, isOperationActive, releaseOperation, runCatalogRequest]);

  const setTokenInput = useCallback((value: string): boolean => {
    if (activeLifecycleSessionRef.current === null) return false;
    const operation = activeOperationRef.current;
    if (operation?.kind === "download" || operation?.kind === "delete" || operation?.kind === "delete-confirmation") {
      return false;
    }
    if (value === tokenInputRef.current) return true;
    tokenInputRef.current = value;
    tokenInputGenerationRef.current += 1;
    setTokenInputState(value);
    setTokenResult(null);
    setTokenError(null);
    return true;
  }, []);

  const testToken = useCallback(async (): Promise<boolean> => {
    const tokenSnapshot = tokenInputRef.current.trim();
    if (!tokenSnapshot) return false;
    const operation = acquireOperation("token-test");
    if (!operation) return false;
    const inputGeneration = tokenInputGenerationRef.current;
    setTokenResult(null);
    setTokenError(null);
    try {
      const result = await testHfToken(tokenSnapshot);
      if (!isOperationActive(operation) || inputGeneration !== tokenInputGenerationRef.current) return false;
      setTokenResult(tokenPresentationResult(result, tokenSnapshot));
      return true;
    } catch {
      if (isOperationActive(operation) && inputGeneration === tokenInputGenerationRef.current) {
        setTokenError("Token test could not be completed.");
      }
      return false;
    } finally {
      releaseOperation(operation);
    }
  }, [acquireOperation, isOperationActive, releaseOperation]);

  const reconcileFasterWhisper = useCallback((model: FasterWhisperModelStatus) => {
    const next = replaceFasterWhisperModel(catalogRef.current, model);
    if (next && next !== catalogRef.current) publishCatalog(next);
  }, [publishCatalog]);

  const reconcilePyannote = useCallback((pyannote: PyannoteModelStatus) => {
    const next = replacePyannoteModel(catalogRef.current, pyannote);
    if (next && next !== catalogRef.current) publishCatalog(next);
  }, [publishCatalog]);

  const downloadFasterWhisper = useCallback(async (modelId: string): Promise<boolean> => {
    const model = catalogRef.current?.faster_whisper.find((candidate) => candidate.value === modelId);
    if (!model || modelAvailability(model) === "ready") return false;
    const target: ModelsTarget = { kind: "faster-whisper", id: model.value, label: model.label };
    const operation = acquireOperation("download", target);
    if (!operation) return false;
    setMutationError(null);
    setMutationMessage(null);
    setDownloadProgress(null);
    setProgressWarning(null);
    startProgressPolling(operation, `fw:${target.id}`);
    try {
      const result = await downloadFasterWhisperModel(target.id);
      if (!isOperationActive(operation)) return false;
      if (result.model.value !== target.id) {
        reportUnexpectedModelResponse(operation);
        return false;
      }
      stopProgressPolling(operation);
      reconcileFasterWhisper(result.model);
      setMutationMessage(`${target.label} model downloaded locally.`);
      await runCatalogRequest(operation, true);
      return true;
    } catch {
      if (isOperationActive(operation)) setMutationError("Model could not be downloaded.");
      return false;
    } finally {
      stopProgressPolling(operation);
      releaseOperation(operation);
    }
  }, [
    acquireOperation,
    isOperationActive,
    reconcileFasterWhisper,
    reportUnexpectedModelResponse,
    releaseOperation,
    runCatalogRequest,
    startProgressPolling,
    stopProgressPolling
  ]);

  const downloadPyannote = useCallback(async (): Promise<boolean> => {
    const pyannote = catalogRef.current?.pyannote;
    const tokenSnapshot = tokenInputRef.current.trim();
    if (!pyannote || modelAvailability(pyannote) === "ready" || !tokenSnapshot) return false;
    const expectedModelId = pyannote.model_id;
    const operation = acquireOperation("download", {
      kind: "pyannote",
      id: "pyannote",
      label: "Pyannote Model"
    });
    if (!operation) return false;
    setMutationError(null);
    setMutationMessage(null);
    setDownloadProgress(null);
    setProgressWarning(null);
    startProgressPolling(operation, "pyannote");
    try {
      const result = await downloadPyannoteModel(tokenSnapshot);
      if (!isOperationActive(operation)) return false;
      if (result.model_id !== expectedModelId) {
        reportUnexpectedModelResponse(operation);
        return false;
      }
      stopProgressPolling(operation);
      reconcilePyannote(result);
      tokenInputRef.current = "";
      tokenInputGenerationRef.current += 1;
      setTokenInputState("");
      setTokenResult(null);
      setTokenError(null);
      setMutationMessage("Speaker recognition model installed locally. The token was not stored.");
      await runCatalogRequest(operation, true);
      return true;
    } catch {
      if (isOperationActive(operation)) setMutationError("Speaker model could not be downloaded.");
      return false;
    } finally {
      stopProgressPolling(operation);
      releaseOperation(operation);
    }
  }, [
    acquireOperation,
    isOperationActive,
    reconcilePyannote,
    reportUnexpectedModelResponse,
    releaseOperation,
    runCatalogRequest,
    startProgressPolling,
    stopProgressPolling
  ]);

  const currentTarget = useCallback((target: ModelsTarget): ModelsTarget | null => {
    const catalog = catalogRef.current;
    if (!catalog) return null;
    if (target.kind === "pyannote") {
      return modelAvailability(catalog.pyannote) === "ready"
        ? { kind: "pyannote", id: "pyannote", label: "Pyannote Model" }
        : null;
    }
    const model = catalog.faster_whisper.find((candidate) => candidate.value === target.id);
    return model && modelAvailability(model) === "ready"
      ? { kind: "faster-whisper", id: model.value, label: model.label }
      : null;
  }, []);

  const requestDelete = useCallback((target: ModelsTarget): boolean => {
    const validatedTarget = currentTarget(target);
    if (!validatedTarget) return false;
    const operation = acquireOperation("delete-confirmation", validatedTarget);
    if (!operation) return false;
    const requestKey = `${operation.session}:${deleteDialogSequenceRef.current + 1}:${operation.token}`;
    deleteDialogSequenceRef.current += 1;
    deleteDialogRef.current = {
      requestKey,
      target: validatedTarget,
      operationToken: operation.token
    };
    setDeleteDialogView({ requestKey, target: validatedTarget });
    return true;
  }, [acquireOperation, currentTarget]);

  const cancelDelete = useCallback((requestKey: string | null): boolean => {
    const dialog = deleteDialogRef.current;
    const operation = activeOperationRef.current;
    if (
      !dialog
      || !requestKey
      || dialog.requestKey !== requestKey
      || operation?.token !== dialog.operationToken
      || operation.kind !== "delete-confirmation"
      || !isSessionActive(operation.session)
    ) return false;
    deleteDialogRef.current = null;
    setDeleteDialogView(null);
    releaseOperation(operation);
    return true;
  }, [isSessionActive, releaseOperation]);

  const confirmDelete = useCallback(async (requestKey: string | null): Promise<boolean> => {
    const dialog = deleteDialogRef.current;
    const operation = activeOperationRef.current;
    if (
      !dialog
      || !requestKey
      || dialog.requestKey !== requestKey
      || operation?.token !== dialog.operationToken
      || operation.kind !== "delete-confirmation"
      || !isSessionActive(operation.session)
    ) return false;

    const target = currentTarget(dialog.target);
    deleteDialogRef.current = null;
    setDeleteDialogView(null);
    if (!target) {
      setMutationError("The selected model is no longer available for deletion.");
      releaseOperation(operation);
      return false;
    }

    const deleteOperation: ActiveOperation = { ...operation, kind: "delete", target };
    activeOperationRef.current = deleteOperation;
    setOperationView({ kind: "delete", targetId: target.id });
    setMutationError(null);
    setMutationMessage(null);
    try {
      if (target.kind === "pyannote") {
        const expectedModelId = catalogRef.current?.pyannote.model_id;
        if (!expectedModelId) return false;
        const result = await deletePyannoteModel();
        if (!isOperationActive(deleteOperation)) return false;
        if (result.model_id !== expectedModelId) {
          reportUnexpectedModelResponse(deleteOperation);
          return false;
        }
        reconcilePyannote(result);
        setMutationMessage("Pyannote speaker recognition model deleted locally.");
      } else {
        const result = await deleteFasterWhisperModel(target.id);
        if (!isOperationActive(deleteOperation)) return false;
        if (result.model.value !== target.id) {
          reportUnexpectedModelResponse(deleteOperation);
          return false;
        }
        reconcileFasterWhisper(result.model);
        setMutationMessage(`${target.label} model deleted locally.`);
      }
      await runCatalogRequest(deleteOperation, true);
      return true;
    } catch {
      if (isOperationActive(deleteOperation)) {
        setMutationError(
          target.kind === "pyannote"
            ? "Pyannote model could not be deleted."
            : "Model could not be deleted."
        );
      }
      return false;
    } finally {
      releaseOperation(deleteOperation);
    }
  }, [
    currentTarget,
    isOperationActive,
    isSessionActive,
    reconcileFasterWhisper,
    reconcilePyannote,
    reportUnexpectedModelResponse,
    releaseOperation,
    runCatalogRequest
  ]);

  const requestDeleteFasterWhisper = useCallback((modelId: string) => {
    const model = catalogRef.current?.faster_whisper.find((candidate) => candidate.value === modelId);
    return model
      ? requestDelete({ kind: "faster-whisper", id: model.value, label: model.label })
      : false;
  }, [requestDelete]);

  const requestDeletePyannote = useCallback(() => requestDelete({
    kind: "pyannote",
    id: "pyannote",
    label: "Pyannote Model"
  }), [requestDelete]);

  const openTrustedLink = useCallback(async (kind: "model" | "token"): Promise<boolean> => {
    const catalog = catalogRef.current;
    const url = kind === "model" ? catalog?.pyannote.model_url : catalog?.pyannote.token_url;
    if (!catalog || !url) return false;
    const operation = acquireOperation("external-link");
    if (!operation) return false;
    const catalogGeneration = catalogGenerationRef.current;
    setExternalLinkError(null);
    try {
      await openExternalUrl(url);
      return isOperationActive(operation) && catalogGenerationRef.current === catalogGeneration;
    } catch {
      if (isOperationActive(operation) && catalogGenerationRef.current === catalogGeneration) {
        setExternalLinkError("The Hugging Face link could not be opened.");
      }
      return false;
    } finally {
      releaseOperation(operation);
    }
  }, [acquireOperation, isOperationActive, releaseOperation]);

  const operationKind = operationView?.kind ?? null;
  const activeJob = operationKind === "download" || operationKind === "delete";
  const sharedError = modelsStatus ? null : catalogError;
  const shared = useMemo(() => ({
    modelsStatus,
    modelsStatusLoading,
    modelsStatusError: sharedError
  }), [modelsStatus, modelsStatusLoading, sharedError]);

  const page = useMemo(() => ({
    catalog: {
      status: modelsStatus,
      loading: modelsStatusLoading,
      error: catalogError
    },
    token: {
      input: tokenInput,
      result: tokenResult,
      error: tokenError,
      testing: operationKind === "token-test",
      inputDisabled: operationKind === "download" || operationKind === "delete" || operationKind === "delete-confirmation",
      setInput: setTokenInput,
      test: testToken
    },
    operation: {
      kind: operationKind,
      targetId: operationView?.targetId ?? null,
      busy: operationView !== null,
      progress: downloadProgress,
      progressWarning,
      error: mutationError,
      message: mutationMessage
    },
    deletion: {
      open: deleteDialogView !== null,
      requestKey: deleteDialogView?.requestKey ?? null,
      target: deleteDialogView?.target ?? null,
      confirm: confirmDelete,
      cancel: cancelDelete
    },
    externalLinkError,
    actions: {
      refresh,
      downloadFasterWhisper,
      downloadPyannote,
      requestDeleteFasterWhisper,
      requestDeletePyannote,
      openPyannoteModelPage: () => openTrustedLink("model"),
      openHuggingFaceTokenPage: () => openTrustedLink("token")
    }
  }), [
    cancelDelete,
    catalogError,
    confirmDelete,
    deleteDialogView,
    downloadFasterWhisper,
    downloadProgress,
    downloadPyannote,
    externalLinkError,
    modelsStatus,
    modelsStatusLoading,
    mutationError,
    mutationMessage,
    openTrustedLink,
    operationKind,
    operationView,
    progressWarning,
    refresh,
    requestDeleteFasterWhisper,
    requestDeletePyannote,
    setTokenInput,
    testToken,
    tokenError,
    tokenInput,
    tokenResult
  ]);

  const shell = useMemo(() => ({
    activeJob,
    activityLabel: operationKind === "download"
      ? "Model download in progress"
      : operationKind === "delete"
        ? "Local model deletion in progress"
        : ""
  }), [activeJob, operationKind]);

  return { shared, page, shell };
}
