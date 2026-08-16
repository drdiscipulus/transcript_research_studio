import { useCallback, useEffect, useRef, useState } from "react";
import {
  CodesProjectConflictError,
  createCodesEvidenceItem,
  recordCodesContextualAiDecision,
  type CodesAiEvidenceSuggestion,
  type CodesAiRunTask,
  type CodesEvidencePayload,
  type CodesProject,
  type CodesProjectHandle,
  type CodesProjectPayload
} from "../lib/api";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "./useCodesProjectSession";

export type CodesAiDecisionActionKind = "accept" | "reject" | "clear";

export type CodesAiDecisionActiveAction = {
  kind: CodesAiDecisionActionKind;
  task: CodesAiRunTask;
  suggestionId: string | null;
  completed: number;
  total: number;
};

export type CodesAiDecisionError = {
  kind: CodesAiDecisionActionKind;
  task: CodesAiRunTask;
  suggestionId: string;
  message: string;
};

export type CodesAiSuggestionRejection = {
  task: CodesAiRunTask;
  suggestionId: string;
  runId: string;
};

export type CodesAiEvidenceAcceptance = {
  suggestion: CodesAiEvidenceSuggestion;
  payload: CodesEvidencePayload;
};

export type CodesAiBulkRejectionResult = {
  rejectedSuggestionIds: string[];
  failedSuggestionId: string | null;
};

type CodesAiDecisionLifecycleOptions = {
  getCurrentSession: () => CodesProjectSessionSnapshot;
  persistProjectSettings: () => Promise<PersistedProjectSettings | null>;
  applyPersistedProject: (payload: PersistedProjectSettings) => boolean;
  isExternallyLocked?: () => boolean;
  onProjectConflict?: (conflict: CodesProjectConflictError) => void;
  onEvidenceAccepted?: (result: CodesAiEvidenceAcceptance) => void;
  onSuggestionRejected?: (result: CodesAiSuggestionRejection) => void;
};

type SessionIdentity = {
  projectId: string;
  projectFile: string;
  revision: string;
};

type ActiveOperation = {
  id: number;
  generation: number;
};

type MutationSnapshot = {
  project: CodesProject;
  handle: CodesProjectHandle;
  identity: SessionIdentity;
};

function identityFromSession(session: CodesProjectSessionSnapshot): SessionIdentity | null {
  if (!session.project || !session.projectFile || !session.projectHandle) return null;
  if (
    session.project.project_id !== session.projectHandle.project_id
    || session.projectFile !== session.projectHandle.project_file
    || !session.projectHandle.revision
  ) return null;
  return {
    projectId: session.project.project_id,
    projectFile: session.projectFile,
    revision: session.projectHandle.revision
  };
}

function identityFromPersisted(payload: PersistedProjectSettings): SessionIdentity | null {
  if (
    payload.project.project_id !== payload.handle.project_id
    || !payload.handle.project_file
    || !payload.handle.revision
  ) return null;
  return {
    projectId: payload.project.project_id,
    projectFile: payload.handle.project_file,
    revision: payload.handle.revision
  };
}

function responseIdentity(payload: CodesProjectPayload): SessionIdentity | null {
  const identity = identityFromPersisted(payload);
  if (
    !identity
    || payload.project_id !== identity.projectId
    || payload.project_file !== identity.projectFile
    || payload.revision !== identity.revision
  ) return null;
  return identity;
}

function sameLogicalSession(left: SessionIdentity, right: SessionIdentity | null) {
  return Boolean(
    right
    && left.projectId === right.projectId
    && left.projectFile === right.projectFile
  );
}

function sameExactSession(left: SessionIdentity, right: SessionIdentity | null) {
  return Boolean(sameLogicalSession(left, right) && left.revision === right?.revision);
}

function logicalSessionKey(identity: SessionIdentity | null) {
  return identity ? `${identity.projectId}\u0000${identity.projectFile}` : "";
}

function decisionErrorKey(task: CodesAiRunTask, suggestionId: string) {
  return `${task}\u0000${suggestionId}`;
}

function cloneMutationSnapshot(payload: PersistedProjectSettings): MutationSnapshot | null {
  const identity = identityFromPersisted(payload);
  if (!identity) return null;
  return {
    project: payload.project,
    handle: { ...payload.handle },
    identity
  };
}

function cloneEvidenceSuggestion(suggestion: CodesAiEvidenceSuggestion): CodesAiEvidenceSuggestion {
  return {
    ...suggestion,
    segment_ids: [...suggestion.segment_ids],
    segment_ranges: Object.fromEntries(Object.entries(suggestion.segment_ranges).map(([segmentId, range]) => [
      segmentId,
      { ...range }
    ]))
  };
}

export function useCodesAiDecisionLifecycle(options: CodesAiDecisionLifecycleOptions) {
  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<CodesAiDecisionActiveAction | null>(null);
  const [errors, setErrors] = useState<Record<string, CodesAiDecisionError>>({});

  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const renderedLogicalKeyRef = useRef(logicalSessionKey(identityFromSession(options.getCurrentSession())));
  optionsRef.current = options;

  const renderedLogicalKey = logicalSessionKey(identityFromSession(options.getCurrentSession()));
  if (renderedLogicalKeyRef.current !== renderedLogicalKey) {
    renderedLogicalKeyRef.current = renderedLogicalKey;
    generationRef.current += 1;
    activeOperationRef.current = null;
  }

  const operationIsActive = useCallback((operation: ActiveOperation) => Boolean(
    mountedRef.current
    && activeOperationRef.current === operation
    && operation.generation === generationRef.current
  ), []);

  const clearError = useCallback((task?: CodesAiRunTask, suggestionId?: string) => {
    setErrors((current) => {
      if (!task) return {};
      if (suggestionId) {
        const key = decisionErrorKey(task, suggestionId);
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      const next = Object.fromEntries(Object.entries(current).filter(([, error]) => error.task !== task));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const errorFor = useCallback((task: CodesAiRunTask, suggestionId: string) => (
    errors[decisionErrorKey(task, suggestionId)] ?? null
  ), [errors]);

  const beginOperation = useCallback((action: CodesAiDecisionActiveAction) => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked?.()) return null;
    const operation = {
      id: ++operationSequenceRef.current,
      generation: generationRef.current
    };
    activeOperationRef.current = operation;
    setBusy(true);
    setActiveAction(action);
    return operation;
  }, []);

  const finishOperation = useCallback((operation: ActiveOperation) => {
    if (!operationIsActive(operation)) return;
    activeOperationRef.current = null;
    setBusy(false);
    setActiveAction(null);
  }, [operationIsActive]);

  const publishError = useCallback((
    operation: ActiveOperation,
    expectedIdentity: SessionIdentity,
    error: CodesAiDecisionError
  ) => {
    if (
      !operationIsActive(operation)
      || !sameExactSession(expectedIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return;
    setErrors((current) => ({
      ...current,
      [decisionErrorKey(error.task, error.suggestionId)]: error
    }));
  }, [operationIsActive]);

  const publishFailure = useCallback((
    operation: ActiveOperation,
    expectedIdentity: SessionIdentity,
    error: CodesAiDecisionError,
    cause: unknown
  ) => {
    if (
      !operationIsActive(operation)
      || !sameExactSession(expectedIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return;
    if (cause instanceof CodesProjectConflictError) {
      optionsRef.current.onProjectConflict?.(cause);
    }
    publishError(operation, expectedIdentity, {
      ...error,
      message: cause instanceof Error ? cause.message : error.message
    });
  }, [operationIsActive, publishError]);

  const prepareMutation = useCallback(async (
    operation: ActiveOperation,
    initialIdentity: SessionIdentity,
    error: CodesAiDecisionError
  ): Promise<MutationSnapshot | null> => {
    let persisted: PersistedProjectSettings | null;
    try {
      persisted = await optionsRef.current.persistProjectSettings();
    } catch (cause) {
      publishFailure(operation, initialIdentity, error, cause);
      return null;
    }
    if (!operationIsActive(operation)) return null;
    if (!persisted) {
      const conflict = optionsRef.current.getCurrentSession().projectConflict;
      if (conflict) publishFailure(operation, initialIdentity, error, conflict);
      else publishError(operation, initialIdentity, error);
      return null;
    }
    const snapshot = cloneMutationSnapshot(persisted);
    if (
      !snapshot
      || !sameLogicalSession(initialIdentity, snapshot.identity)
      || !sameExactSession(snapshot.identity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return null;
    return snapshot;
  }, [operationIsActive, publishError, publishFailure]);

  const applyMutationResponse = useCallback((
    operation: ActiveOperation,
    expectedIdentity: SessionIdentity,
    payload: CodesProjectPayload,
    error: CodesAiDecisionError
  ): MutationSnapshot | null => {
    if (
      !operationIsActive(operation)
      || !sameExactSession(expectedIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return null;

    const nextIdentity = responseIdentity(payload);
    if (
      !nextIdentity
      || !sameLogicalSession(expectedIdentity, nextIdentity)
      || nextIdentity.revision === expectedIdentity.revision
    ) {
      publishError(operation, expectedIdentity, error);
      return null;
    }
    if (!optionsRef.current.applyPersistedProject({ project: payload.project, handle: payload.handle })) {
      publishError(operation, expectedIdentity, error);
      return null;
    }
    if (!sameExactSession(nextIdentity, identityFromSession(optionsRef.current.getCurrentSession()))) {
      return null;
    }
    return cloneMutationSnapshot(payload);
  }, [operationIsActive, publishError]);

  const acceptEvidenceSuggestion = useCallback(async (suggestion: CodesAiEvidenceSuggestion) => {
    const captured = cloneEvidenceSuggestion(suggestion);
    const errorTemplate: CodesAiDecisionError = {
      kind: "accept",
      task: "evidence",
      suggestionId: captured.suggestion_id,
      message: "The evidence suggestion could not be saved."
    };
    const operation = beginOperation({
      kind: "accept",
      task: "evidence",
      suggestionId: captured.suggestion_id,
      completed: 0,
      total: 1
    });
    if (!operation) return false;
    clearError("evidence", captured.suggestion_id);

    const initialIdentity = identityFromSession(optionsRef.current.getCurrentSession());
    if (!initialIdentity) {
      finishOperation(operation);
      return false;
    }

    try {
      const snapshot = await prepareMutation(operation, initialIdentity, errorTemplate);
      if (!snapshot) return false;
      let payload: CodesEvidencePayload;
      try {
        payload = await createCodesEvidenceItem({
          project: snapshot.project,
          handle: snapshot.handle,
          transcript_id: captured.transcript_id,
          segment_ids: captured.segment_ids,
          segment_ranges: captured.segment_ranges,
          selected_text: captured.selected_text,
          code_ids: [],
          new_codes: [],
          memo: "",
          ai_decisions: [{
            run_id: captured.run_id,
            suggestion_id: captured.suggestion_id,
            task: "evidence",
            decision: "accepted"
          }]
        });
      } catch (cause) {
        publishFailure(operation, snapshot.identity, errorTemplate, cause);
        return false;
      }

      const applied = applyMutationResponse(operation, snapshot.identity, payload, errorTemplate);
      if (!applied) return false;
      clearError("evidence", captured.suggestion_id);
      const shouldReconcile = operationIsActive(operation);
      finishOperation(operation);
      if (shouldReconcile) {
        try {
          optionsRef.current.onEvidenceAccepted?.({
            suggestion: captured,
            payload
          });
        } catch {
          // Optional UI reconciliation must not turn a persisted decision into a failure.
        }
      }
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyMutationResponse, beginOperation, clearError, finishOperation, operationIsActive, prepareMutation, publishFailure]);

  const rejectSuggestion = useCallback(async (rejection: CodesAiSuggestionRejection) => {
    const captured = { ...rejection };
    const errorTemplate: CodesAiDecisionError = {
      kind: "reject",
      task: captured.task,
      suggestionId: captured.suggestionId,
      message: "The dismissal could not be saved."
    };
    const operation = beginOperation({
      kind: "reject",
      task: captured.task,
      suggestionId: captured.suggestionId,
      completed: 0,
      total: 1
    });
    if (!operation) return false;
    clearError(captured.task, captured.suggestionId);

    const initialIdentity = identityFromSession(optionsRef.current.getCurrentSession());
    if (!initialIdentity) {
      finishOperation(operation);
      return false;
    }

    try {
      const snapshot = await prepareMutation(operation, initialIdentity, errorTemplate);
      if (!snapshot) return false;
      let payload: CodesProjectPayload;
      try {
        payload = await recordCodesContextualAiDecision({
          project: snapshot.project,
          handle: snapshot.handle,
          run_id: captured.runId,
          suggestion_id: captured.suggestionId,
          task: captured.task,
          decision: "rejected"
        });
      } catch (cause) {
        publishFailure(operation, snapshot.identity, errorTemplate, cause);
        return false;
      }

      const applied = applyMutationResponse(operation, snapshot.identity, payload, errorTemplate);
      if (!applied) return false;
      clearError(captured.task, captured.suggestionId);
      const shouldReconcile = operationIsActive(operation);
      finishOperation(operation);
      if (shouldReconcile) {
        try {
          optionsRef.current.onSuggestionRejected?.(captured);
        } catch {
          // Optional UI reconciliation must not turn a persisted decision into a failure.
        }
      }
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyMutationResponse, beginOperation, clearError, finishOperation, operationIsActive, prepareMutation, publishFailure]);

  const rejectEvidenceSuggestions = useCallback(async (
    suggestions: readonly CodesAiEvidenceSuggestion[]
  ): Promise<CodesAiBulkRejectionResult> => {
    const captured = suggestions.map((suggestion) => ({
      task: "evidence" as const,
      suggestionId: suggestion.suggestion_id,
      runId: suggestion.run_id
    }));
    if (!captured.length) return { rejectedSuggestionIds: [], failedSuggestionId: null };
    const operation = beginOperation({
      kind: "clear",
      task: "evidence",
      suggestionId: captured[0].suggestionId,
      completed: 0,
      total: captured.length
    });
    if (!operation) return { rejectedSuggestionIds: [], failedSuggestionId: null };
    captured.forEach((suggestion) => clearError("evidence", suggestion.suggestionId));

    const rejectedSuggestionIds: string[] = [];
    const successfulRejections: CodesAiSuggestionRejection[] = [];
    const initialIdentity = identityFromSession(optionsRef.current.getCurrentSession());
    if (!initialIdentity) {
      finishOperation(operation);
      return { rejectedSuggestionIds, failedSuggestionId: null };
    }
    const initialError: CodesAiDecisionError = {
      kind: "clear",
      task: "evidence",
      suggestionId: captured[0].suggestionId,
      message: "AI decisions could not be saved."
    };
    let latestIdentity = initialIdentity;

    try {
      let snapshot = await prepareMutation(operation, initialIdentity, initialError);
      if (!snapshot) return { rejectedSuggestionIds, failedSuggestionId: null };

      for (let index = 0; index < captured.length; index += 1) {
        const rejection = captured[index];
        const errorTemplate: CodesAiDecisionError = {
          kind: "clear",
          task: "evidence",
          suggestionId: rejection.suggestionId,
          message: "The dismissal could not be saved."
        };
        if (!operationIsActive(operation)) {
          return { rejectedSuggestionIds, failedSuggestionId: null };
        }
        setActiveAction({
          kind: "clear",
          task: "evidence",
          suggestionId: rejection.suggestionId,
          completed: rejectedSuggestionIds.length,
          total: captured.length
        });

        let payload: CodesProjectPayload;
        try {
          payload = await recordCodesContextualAiDecision({
            project: snapshot.project,
            handle: snapshot.handle,
            run_id: rejection.runId,
            suggestion_id: rejection.suggestionId,
            task: "evidence",
            decision: "rejected"
          });
        } catch (cause) {
          publishFailure(operation, snapshot.identity, errorTemplate, cause);
          const failedSuggestionId = sameExactSession(
            snapshot.identity,
            identityFromSession(optionsRef.current.getCurrentSession())
          ) ? rejection.suggestionId : null;
          return { rejectedSuggestionIds, failedSuggestionId };
        }

        const applied = applyMutationResponse(operation, snapshot.identity, payload, errorTemplate);
        if (!applied) {
          const failedSuggestionId = sameExactSession(
            snapshot.identity,
            identityFromSession(optionsRef.current.getCurrentSession())
          ) ? rejection.suggestionId : null;
          return { rejectedSuggestionIds, failedSuggestionId };
        }
        snapshot = applied;
        latestIdentity = applied.identity;
        rejectedSuggestionIds.push(rejection.suggestionId);
        successfulRejections.push(rejection);
        clearError("evidence", rejection.suggestionId);
      }
      return { rejectedSuggestionIds, failedSuggestionId: null };
    } finally {
      const shouldReconcile = successfulRejections.length > 0
        && operationIsActive(operation)
        && sameExactSession(latestIdentity, identityFromSession(optionsRef.current.getCurrentSession()));
      finishOperation(operation);
      if (shouldReconcile) {
        successfulRejections.forEach((rejection) => {
          try {
            optionsRef.current.onSuggestionRejected?.(rejection);
          } catch {
            // Optional UI reconciliation must not turn a persisted decision into a failure.
          }
        });
      }
    }
  }, [applyMutationResponse, beginOperation, clearError, finishOperation, operationIsActive, prepareMutation, publishFailure]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    operationSequenceRef.current += 1;
    activeOperationRef.current = null;
    setBusy(false);
    setActiveAction(null);
    setErrors({});
  }, []);

  useEffect(() => {
    setBusy(false);
    setActiveAction(null);
    setErrors({});
  }, [renderedLogicalKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      operationSequenceRef.current += 1;
      activeOperationRef.current = null;
    };
  }, []);

  const isLocked = useCallback(() => Boolean(activeOperationRef.current), []);

  return {
    busy,
    activeAction,
    errors,
    errorFor,
    clearError,
    reset,
    isLocked,
    acceptEvidenceSuggestion,
    rejectSuggestion,
    rejectEvidenceSuggestions
  };
}
