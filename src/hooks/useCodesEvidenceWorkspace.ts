import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CodesProjectConflictError,
  createCodesEvidenceItem,
  deleteCodesEvidenceItem,
  removeCodesProjectTranscript,
  updateCodesEvidenceItem,
  type CodesAiDecisionInput,
  type CodesEvidenceItem,
  type CodesProject,
  type CodesProjectHandle,
  type CodesProjectPayload,
  type CodesTranscript,
  type TranscriptImportResult
} from "../lib/api";
import type { CodeDialogValue } from "../components/codes/CodesCodeDialog";
import {
  defaultCodesHighlightSettings,
  pruneCodesHighlightSettings,
  type CodesHighlightSettings
} from "../components/codes/CodesHighlightControls";
import {
  evidenceEditDraftFromEvidence,
  evidenceEditDraftHasChanges,
  provisionalCodeInput,
  replaceEvidenceDraftSelection,
  type EvidenceDraft,
  type EvidenceDraftSelection,
  type EvidenceEditDraft,
  type ProvisionalEvidenceCode
} from "../components/codes/codesPageUtils";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "./useCodesProjectSession";

type SessionIdentity = {
  projectId: string;
  projectFile: string;
  revision: string;
};

type EvidenceScope = "active" | "all";

type ActiveOperation = {
  id: number;
  generation: number;
};

type MutationSnapshot = {
  project: CodesProject;
  handle: CodesProjectHandle;
  identity: SessionIdentity;
};

export type EvidenceTranscriptActionDialogState = {
  kind: "remove";
  transcript: CodesTranscript;
  evidenceCount: number;
} | null;

type CodesEvidenceWorkspaceOptions = {
  getCurrentSession: () => CodesProjectSessionSnapshot;
  applyPersistedProject: (payload: PersistedProjectSettings) => boolean;
  persistProjectSettings: () => Promise<PersistedProjectSettings | null>;
  isExternallyLocked: () => boolean;
  onBusyChange?: (busy: boolean) => void;
  onProjectConflict?: (conflict: CodesProjectConflictError) => void;
  onOperationStarted?: () => void;
  onStatusMessage?: (message: string) => void;
  onError?: (error: unknown, fallback: string) => void;
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

function mutationSnapshot(payload: PersistedProjectSettings): MutationSnapshot | null {
  const identity = identityFromPersisted(payload);
  if (!identity) return null;
  return {
    project: payload.project,
    handle: { ...payload.handle },
    identity
  };
}

function cloneDecision(decision: CodesAiDecisionInput): CodesAiDecisionInput {
  return {
    ...decision,
    result_ids: decision.result_ids ? [...decision.result_ids] : undefined
  };
}

function cloneProvisionalCode(code: ProvisionalEvidenceCode): ProvisionalEvidenceCode {
  return {
    ...code,
    exampleEvidenceIds: [...code.exampleEvidenceIds],
    aiDecisions: code.aiDecisions.map(cloneDecision)
  };
}

function cloneEvidenceDraft(draft: EvidenceDraft): EvidenceDraft {
  return {
    ...draft,
    segmentIds: [...draft.segmentIds],
    segmentRanges: Object.fromEntries(Object.entries(draft.segmentRanges).map(([segmentId, range]) => [
      segmentId,
      { ...range }
    ])),
    codeIds: [...draft.codeIds],
    newCodes: draft.newCodes.map(cloneProvisionalCode),
    aiDecisions: draft.aiDecisions.map(cloneDecision)
  };
}

function cloneEvidenceEditDraft(draft: EvidenceEditDraft): EvidenceEditDraft {
  return {
    ...draft,
    codeIds: [...draft.codeIds],
    newCodes: draft.newCodes.map(cloneProvisionalCode),
    aiDecisions: draft.aiDecisions.map(cloneDecision)
  };
}

function createDraftCode(value: CodeDialogValue): ProvisionalEvidenceCode {
  const randomPart = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    clientId: `draft-code-${randomPart}`,
    name: value.name.trim(),
    color: value.color,
    description: value.description,
    inclusionNote: value.inclusionNote,
    exclusionNote: value.exclusionNote,
    exampleEvidenceIds: [...value.exampleEvidenceIds],
    memo: value.memo,
    aiDecisions: value.aiDecisions.map(cloneDecision),
    useCurrentEvidenceAsExample: value.useCurrentEvidenceAsExample
  };
}

function validSelection(project: CodesProject, selection: EvidenceDraftSelection) {
  const transcript = project.transcripts.find((item) => item.transcript_id === selection.transcriptId);
  if (!transcript || !selection.segmentIds.length || !selection.selectedText.trim()) return false;
  const indexes = selection.segmentIds.map((segmentId) =>
    transcript.segments.findIndex((segment) => segment.segment_id === segmentId)
  );
  if (indexes.some((index) => index < 0)) return false;
  if (indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) return false;
  const excerpts: string[] = [];
  for (const segmentId of selection.segmentIds) {
    const segment = transcript.segments.find((item) => item.segment_id === segmentId);
    const range = selection.segmentRanges[segmentId];
    if (
      !segment
      || !range
      || range.start_offset < 0
      || range.end_offset <= range.start_offset
      || range.end_offset > segment.text.length
      || segment.text.slice(range.start_offset, range.end_offset) !== range.excerpt
      || !range.excerpt.trim()
    ) return false;
    excerpts.push(range.excerpt);
  }
  return excerpts.join(" ") === selection.selectedText;
}

export function useCodesEvidenceWorkspace(options: CodesEvidenceWorkspaceOptions) {
  const [activeTranscriptId, setActiveTranscriptId] = useState("");
  const [selectedEvidenceId, setSelectedEvidenceId] = useState("");
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft | null>(null);
  const [evidenceEditDraft, setEvidenceEditDraft] = useState<EvidenceEditDraft | null>(null);
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [evidenceScope, setEvidenceScope] = useState<EvidenceScope>("active");
  const [evidenceFilterCodeId, setEvidenceFilterCodeId] = useState("");
  const [evidenceFilterThemeId, setEvidenceFilterThemeId] = useState("");
  const [highlightSettings, setHighlightSettings] = useState<CodesHighlightSettings>(defaultCodesHighlightSettings);
  const [transcriptActionDialog, setTranscriptActionDialog] = useState<EvidenceTranscriptActionDialogState>(null);
  const [deleteEvidenceId, setDeleteEvidenceId] = useState("");
  const [deleteEvidenceError, setDeleteEvidenceError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const evidenceDraftRef = useRef<EvidenceDraft | null>(null);
  const evidenceEditDraftRef = useRef<EvidenceEditDraft | null>(null);
  const activeTranscriptIdRef = useRef("");
  const selectedEvidenceIdRef = useRef("");
  const transcriptActionDialogRef = useRef<EvidenceTranscriptActionDialogState>(null);
  const deleteEvidenceIdRef = useRef("");
  optionsRef.current = options;
  evidenceDraftRef.current = evidenceDraft;
  evidenceEditDraftRef.current = evidenceEditDraft;
  activeTranscriptIdRef.current = activeTranscriptId;
  selectedEvidenceIdRef.current = selectedEvidenceId;
  transcriptActionDialogRef.current = transcriptActionDialog;
  deleteEvidenceIdRef.current = deleteEvidenceId;

  const project = options.getCurrentSession().project;
  const activeTranscript = useMemo(
    () => project?.transcripts.find((transcript) => transcript.transcript_id === activeTranscriptId) ?? null,
    [activeTranscriptId, project]
  );
  const selectedEvidence = useMemo(
    () => project?.evidence_items.find((evidence) => evidence.evidence_id === selectedEvidenceId) ?? null,
    [project, selectedEvidenceId]
  );
  const evidenceEditDirty = evidenceEditDraftHasChanges(evidenceEditDraft, selectedEvidence);
  const evidenceToDelete = useMemo(
    () => project?.evidence_items.find((evidence) => evidence.evidence_id === deleteEvidenceId) ?? null,
    [deleteEvidenceId, project]
  );

  const operationIsActive = useCallback((operation: ActiveOperation) => Boolean(
    mountedRef.current
    && activeOperationRef.current === operation
    && operation.generation === generationRef.current
  ), []);

  const isLocked = useCallback(() => Boolean(
    activeOperationRef.current || optionsRef.current.isExternallyLocked()
  ), []);

  const beginOperation = useCallback(() => {
    if (isLocked()) return null;
    const operation = { id: ++operationSequenceRef.current, generation: generationRef.current };
    activeOperationRef.current = operation;
    optionsRef.current.onBusyChange?.(true);
    setBusy(true);
    return operation;
  }, [isLocked]);

  const finishOperation = useCallback((operation: ActiveOperation) => {
    if (!operationIsActive(operation)) return;
    activeOperationRef.current = null;
    optionsRef.current.onBusyChange?.(false);
    setBusy(false);
  }, [operationIsActive]);

  const invalidateOperations = useCallback(() => {
    generationRef.current += 1;
    operationSequenceRef.current += 1;
    activeOperationRef.current = null;
    optionsRef.current.onBusyChange?.(false);
    setBusy(false);
  }, []);

  const currentSnapshot = useCallback((): MutationSnapshot | null => {
    const session = optionsRef.current.getCurrentSession();
    const identity = identityFromSession(session);
    if (!identity || session.projectConflict || !session.project || !session.projectHandle) return null;
    return {
      project: session.project,
      handle: { ...session.projectHandle },
      identity
    };
  }, []);

  const publishFailure = useCallback((
    operation: ActiveOperation,
    expectedIdentity: SessionIdentity,
    error: unknown,
    fallback: string,
    publish: (message: string) => void
  ) => {
    if (
      !operationIsActive(operation)
      || !sameExactSession(expectedIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return false;
    if (error instanceof CodesProjectConflictError) optionsRef.current.onProjectConflict?.(error);
    const message = error instanceof Error ? error.message : fallback;
    publish(message);
    optionsRef.current.onError?.(error, fallback);
    return true;
  }, [operationIsActive]);

  const prepareMutation = useCallback(async (
    operation: ActiveOperation,
    initial: MutationSnapshot,
    fallback: string,
    publish: (message: string) => void
  ): Promise<MutationSnapshot | null> => {
    let persisted: PersistedProjectSettings | null;
    try {
      persisted = await optionsRef.current.persistProjectSettings();
    } catch (error) {
      publishFailure(operation, initial.identity, error, fallback, publish);
      return null;
    }
    if (!operationIsActive(operation)) return null;
    if (!persisted) {
      const current = optionsRef.current.getCurrentSession();
      if (current.projectConflict) publishFailure(operation, initial.identity, current.projectConflict, fallback, publish);
      else if (sameExactSession(initial.identity, identityFromSession(current))) {
        publish(fallback);
        optionsRef.current.onError?.(new Error(fallback), fallback);
      }
      return null;
    }
    const snapshot = mutationSnapshot(persisted);
    if (
      !snapshot
      || snapshot.identity.projectId !== initial.identity.projectId
      || snapshot.identity.projectFile !== initial.identity.projectFile
      || !sameExactSession(snapshot.identity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return null;
    return snapshot;
  }, [operationIsActive, publishFailure]);

  const applyResponse = useCallback((
    operation: ActiveOperation,
    expectedIdentity: SessionIdentity,
    payload: CodesProjectPayload,
    fallback: string,
    publish: (message: string) => void
  ) => {
    if (
      !operationIsActive(operation)
      || !sameExactSession(expectedIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) return false;
    const nextIdentity = responseIdentity(payload);
    if (
      !nextIdentity
      || !sameLogicalSession(expectedIdentity, nextIdentity)
      || nextIdentity.revision === expectedIdentity.revision
      || !optionsRef.current.applyPersistedProject({ project: payload.project, handle: payload.handle })
      || !sameExactSession(nextIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) {
      publish(fallback);
      optionsRef.current.onError?.(new Error(fallback), fallback);
      return false;
    }
    return true;
  }, [operationIsActive]);

  const clearFilters = useCallback(() => {
    setEvidenceSearch("");
    setEvidenceScope("active");
    setEvidenceFilterCodeId("");
    setEvidenceFilterThemeId("");
  }, []);

  const clearDraftsAndDialogs = useCallback(() => {
    setEvidenceDraft(null);
    setEvidenceEditDraft(null);
    setTranscriptActionDialog(null);
    setDeleteEvidenceId("");
    setDeleteEvidenceError(null);
    setEvidenceError(null);
    setTranscriptError(null);
  }, []);

  const reset = useCallback((nextProject: CodesProject | null = null) => {
    invalidateOperations();
    setActiveTranscriptId(nextProject?.transcripts[0]?.transcript_id ?? "");
    setSelectedEvidenceId("");
    clearDraftsAndDialogs();
    clearFilters();
    setHighlightSettings(defaultCodesHighlightSettings);
  }, [clearDraftsAndDialogs, clearFilters, invalidateOperations]);

  const resetForNewProject = useCallback(() => reset(null), [reset]);
  const resetForOpenProject = useCallback((nextProject: CodesProject) => reset(nextProject), [reset]);
  const resetForClose = useCallback(() => reset(null), [reset]);

  const resetForReload = useCallback((nextProject: CodesProject) => {
    invalidateOperations();
    clearDraftsAndDialogs();
    setActiveTranscriptId((current) => nextProject.transcripts.some((item) => item.transcript_id === current)
      ? current
      : nextProject.transcripts[0]?.transcript_id ?? "");
    setSelectedEvidenceId((current) => nextProject.evidence_items.some((item) => item.evidence_id === current)
      ? current
      : "");
  }, [clearDraftsAndDialogs, invalidateOperations]);

  const reconcileProject = useCallback((nextProject: CodesProject) => {
    setActiveTranscriptId((current) => nextProject.transcripts.some((item) => item.transcript_id === current)
      ? current
      : nextProject.transcripts[0]?.transcript_id ?? "");
    setSelectedEvidenceId((current) => {
      if (nextProject.evidence_items.some((item) => item.evidence_id === current)) return current;
      setEvidenceEditDraft(null);
      return "";
    });
    setEvidenceDraft((current) => current && nextProject.transcripts.some((item) => item.transcript_id === current.transcriptId)
      ? current
      : null);
  }, []);

  const reconcileAfterSaveAs = useCallback((nextProject: CodesProject) => {
    invalidateOperations();
    reconcileProject(nextProject);
    setTranscriptActionDialog(null);
    setDeleteEvidenceId("");
    setDeleteEvidenceError(null);
    setEvidenceError(null);
    setTranscriptError(null);
  }, [invalidateOperations, reconcileProject]);

  const reconcileAfterImport = useCallback((nextProject: CodesProject, result: Pick<TranscriptImportResult, "imported">) => {
    const previousActive = activeTranscriptIdRef.current;
    setActiveTranscriptId(nextProject.transcripts.some((item) => item.transcript_id === previousActive)
      ? previousActive
      : result.imported[0]?.transcript_id ?? nextProject.transcripts[0]?.transcript_id ?? "");
    setSelectedEvidenceId((current) => {
      if (nextProject.evidence_items.some((item) => item.evidence_id === current)) return current;
      setEvidenceEditDraft(null);
      return "";
    });
    setEvidenceDraft((current) => current && nextProject.transcripts.some((item) => item.transcript_id === current.transcriptId)
      ? current
      : null);
  }, []);

  const removeDeletedCode = useCallback((codeId: string) => {
    setEvidenceDraft((current) => current ? {
      ...current,
      codeIds: current.codeIds.filter((currentCodeId) => currentCodeId !== codeId)
    } : current);
    setEvidenceEditDraft((current) => current ? {
      ...current,
      codeIds: current.codeIds.filter((currentCodeId) => currentCodeId !== codeId)
    } : current);
  }, []);

  useEffect(() => {
    setEvidenceEditDraft((current) => {
      if (!selectedEvidence) return null;
      return current?.evidenceId === selectedEvidence.evidence_id
        ? current
        : evidenceEditDraftFromEvidence(selectedEvidence);
    });
  }, [selectedEvidence]);

  const currentProjectId = project?.project_id ?? "";
  useEffect(() => {
    setHighlightSettings(defaultCodesHighlightSettings);
  }, [currentProjectId]);

  const codeIds = useMemo(() => project?.codes.map((code) => code.code_id) ?? [], [project?.codes]);
  const themeIds = useMemo(() => project?.themes.map((theme) => theme.theme_id) ?? [], [project?.themes]);
  useEffect(() => {
    setHighlightSettings((current) => pruneCodesHighlightSettings(current, codeIds, themeIds));
  }, [codeIds, themeIds]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeOperationRef.current = null;
      optionsRef.current.onBusyChange?.(false);
    };
  }, []);

  const captureSelection = useCallback((selection: EvidenceDraftSelection) => {
    if (isLocked()) return false;
    const currentProject = optionsRef.current.getCurrentSession().project;
    if (!currentProject || !validSelection(currentProject, selection)) return false;
    const currentDraft = evidenceDraftRef.current;
    setEvidenceDraft((current) => replaceEvidenceDraftSelection(current, {
      ...selection,
      segmentIds: [...selection.segmentIds],
      segmentRanges: Object.fromEntries(Object.entries(selection.segmentRanges).map(([segmentId, range]) => [segmentId, { ...range }]))
    }));
    setSelectedEvidenceId("");
    setEvidenceError(null);
    optionsRef.current.onStatusMessage?.(currentDraft
      ? "Evidence selection updated."
      : "Evidence draft opened from the selected passage.");
    return true;
  }, [isLocked]);

  const selectTranscript = useCallback((transcriptId: string) => {
    if (isLocked()) return false;
    const currentProject = optionsRef.current.getCurrentSession().project;
    if (!currentProject?.transcripts.some((item) => item.transcript_id === transcriptId)) return false;
    setActiveTranscriptId(transcriptId);
    setSelectedEvidenceId("");
    setEvidenceScope("active");
    return true;
  }, [isLocked]);

  const navigateToTranscript = useCallback((transcriptId: string) => {
    if (isLocked()) return false;
    const currentProject = optionsRef.current.getCurrentSession().project;
    if (!currentProject?.transcripts.some((item) => item.transcript_id === transcriptId)) return false;
    setActiveTranscriptId(transcriptId);
    return true;
  }, [isLocked]);

  const selectEvidence = useCallback((evidence: CodesEvidenceItem) => {
    if (isLocked()) return false;
    const currentProject = optionsRef.current.getCurrentSession().project;
    const authoritative = currentProject?.evidence_items.find((item) => item.evidence_id === evidence.evidence_id);
    if (!authoritative) return false;
    setSelectedEvidenceId(authoritative.evidence_id);
    setEvidenceDraft(null);
    setEvidenceEditDraft(evidenceEditDraftFromEvidence(authoritative));
    setActiveTranscriptId(authoritative.transcript_id);
    setEvidenceError(null);
    optionsRef.current.onStatusMessage?.(`Selected evidence item ${authoritative.evidence_id}.`);
    return true;
  }, [isLocked]);

  const discardEvidenceDraft = useCallback(() => {
    if (isLocked()) return;
    setEvidenceDraft(null);
    window.getSelection()?.removeAllRanges();
  }, [isLocked]);

  const restoreEvidenceEditDraft = useCallback(() => {
    if (isLocked()) return;
    const currentProject = optionsRef.current.getCurrentSession().project;
    const evidence = currentProject?.evidence_items.find((item) => item.evidence_id === selectedEvidenceIdRef.current) ?? null;
    setEvidenceEditDraft(evidence ? evidenceEditDraftFromEvidence(evidence) : null);
  }, [isLocked]);

  const toggleInspectorCode = useCallback((codeId: string) => {
    if (isLocked()) return;
    const update = (codeIds: string[]) => codeIds.includes(codeId)
      ? codeIds.filter((id) => id !== codeId)
      : [...codeIds, codeId];
    if (evidenceDraftRef.current) {
      setEvidenceDraft((current) => current ? { ...current, codeIds: update(current.codeIds) } : current);
    } else {
      setEvidenceEditDraft((current) => current ? { ...current, codeIds: update(current.codeIds) } : current);
    }
  }, [isLocked]);

  const stageExistingCode = useCallback((codeId: string, decision?: CodesAiDecisionInput) => {
    if (isLocked()) return false;
    const currentProject = optionsRef.current.getCurrentSession().project;
    if (!currentProject?.codes.some((code) => code.code_id === codeId)) return false;
    const append = <T extends EvidenceDraft | EvidenceEditDraft>(current: T): T => ({
      ...current,
      codeIds: [...current.codeIds, codeId],
      aiDecisions: decision ? [...current.aiDecisions, cloneDecision(decision)] : current.aiDecisions
    });
    if (evidenceDraftRef.current) {
      const current = evidenceDraftRef.current;
      if (
        current.codeIds.includes(codeId)
        || (decision && current.aiDecisions.some((item) => item.suggestion_id === decision.suggestion_id))
      ) return false;
      const next = append(current);
      evidenceDraftRef.current = next;
      setEvidenceDraft(next);
      return true;
    }
    if (evidenceEditDraftRef.current) {
      const current = evidenceEditDraftRef.current;
      if (
        current.codeIds.includes(codeId)
        || (decision && current.aiDecisions.some((item) => item.suggestion_id === decision.suggestion_id))
      ) return false;
      const next = append(current);
      evidenceEditDraftRef.current = next;
      setEvidenceEditDraft(next);
      return true;
    }
    return false;
  }, [isLocked]);

  const updateInspectorMemo = useCallback((memo: string) => {
    if (isLocked()) return;
    if (evidenceDraftRef.current) setEvidenceDraft((current) => current ? { ...current, memo } : current);
    else setEvidenceEditDraft((current) => current ? { ...current, memo } : current);
  }, [isLocked]);

  const addInspectorCode = useCallback((value: CodeDialogValue) => {
    if (isLocked()) return "";
    if (!evidenceDraftRef.current && !evidenceEditDraftRef.current) return "";
    const current = evidenceDraftRef.current ?? evidenceEditDraftRef.current;
    if (!current) return "";
    const incomingSuggestionIds = value.aiDecisions.map((decision) => decision.suggestion_id);
    if (
      incomingSuggestionIds.length > 0
      && (
        new Set(incomingSuggestionIds).size !== incomingSuggestionIds.length
        || incomingSuggestionIds.some((suggestionId) => current.aiDecisions.some((decision) => decision.suggestion_id === suggestionId))
      )
    ) return "";
    const draftCode = createDraftCode(value);
    const next = {
      ...current,
      newCodes: [...current.newCodes, draftCode],
      aiDecisions: [...current.aiDecisions, ...value.aiDecisions.map(cloneDecision)]
    } as typeof current;
    if (evidenceDraftRef.current) {
      evidenceDraftRef.current = next as EvidenceDraft;
      setEvidenceDraft(next as EvidenceDraft);
    } else {
      evidenceEditDraftRef.current = next as EvidenceEditDraft;
      setEvidenceEditDraft(next as EvidenceEditDraft);
    }
    return draftCode.clientId;
  }, [isLocked]);

  const removeInspectorCode = useCallback((clientId: string) => {
    if (isLocked()) return;
    const remove = <T extends EvidenceDraft | EvidenceEditDraft>(current: T): T => {
      const removedIds = new Set(
        current.newCodes.find((code) => code.clientId === clientId)?.aiDecisions.map((item) => item.suggestion_id) ?? []
      );
      return {
        ...current,
        newCodes: current.newCodes.filter((code) => code.clientId !== clientId),
        aiDecisions: current.aiDecisions.filter((decision) => !removedIds.has(decision.suggestion_id))
      };
    };
    if (evidenceDraftRef.current) setEvidenceDraft((current) => current ? remove(current) : current);
    else setEvidenceEditDraft((current) => current ? remove(current) : current);
  }, [isLocked]);

  const applyAiNote = useCallback((note: string, mode: "use" | "replace" | "append", decision: CodesAiDecisionInput) => {
    if (isLocked()) return false;
    const nextMemo = (currentMemo: string) => mode === "append" && currentMemo.trim()
      ? `${currentMemo.trim()}\n\n${note}`
      : note;
    const update = <T extends EvidenceDraft | EvidenceEditDraft>(current: T): T => ({
      ...current,
      memo: nextMemo(current.memo),
      aiDecisions: [...current.aiDecisions, cloneDecision(decision)]
    });
    if (evidenceDraftRef.current) {
      const current = evidenceDraftRef.current;
      if (
        nextMemo(current.memo) === current.memo
        || current.aiDecisions.some((item) => item.suggestion_id === decision.suggestion_id)
      ) return false;
      const next = update(current);
      evidenceDraftRef.current = next;
      setEvidenceDraft(next);
      return true;
    }
    if (evidenceEditDraftRef.current) {
      const current = evidenceEditDraftRef.current;
      if (
        nextMemo(current.memo) === current.memo
        || current.aiDecisions.some((item) => item.suggestion_id === decision.suggestion_id)
      ) return false;
      const next = update(current);
      evidenceEditDraftRef.current = next;
      setEvidenceEditDraft(next);
      return true;
    }
    return false;
  }, [isLocked]);

  const saveEvidenceDraft = useCallback(async () => {
    const draft = evidenceDraftRef.current ? cloneEvidenceDraft(evidenceDraftRef.current) : null;
    if (!draft) return false;
    const operation = beginOperation();
    if (!operation) return false;
    setEvidenceError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      optionsRef.current.onOperationStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Evidence item could not be saved.", setEvidenceError);
      if (!snapshot) return false;
      let payload;
      try {
        payload = await createCodesEvidenceItem({
          project: snapshot.project,
          handle: snapshot.handle,
          transcript_id: draft.transcriptId,
          segment_ids: [...draft.segmentIds],
          segment_ranges: Object.fromEntries(Object.entries(draft.segmentRanges).map(([segmentId, range]) => [segmentId, { ...range }])),
          selected_text: draft.selectedText,
          code_ids: [...draft.codeIds],
          new_codes: draft.newCodes.map(provisionalCodeInput),
          memo: draft.memo,
          ai_decisions: draft.aiDecisions.map(cloneDecision)
        });
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Evidence item could not be saved.", setEvidenceError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Evidence item could not be saved.", setEvidenceError)) return false;
      setActiveTranscriptId(payload.evidence.transcript_id);
      setSelectedEvidenceId(payload.evidence.evidence_id);
      setEvidenceDraft(null);
      setEvidenceEditDraft(evidenceEditDraftFromEvidence(payload.evidence));
      setEvidenceError(null);
      optionsRef.current.onStatusMessage?.(`Saved evidence item ${payload.evidence.evidence_id}.`);
      window.getSelection()?.removeAllRanges();
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure]);

  const saveSelectedEvidence = useCallback(async () => {
    const selectedId = selectedEvidenceIdRef.current;
    const draft = evidenceEditDraftRef.current ? cloneEvidenceEditDraft(evidenceEditDraftRef.current) : null;
    if (!selectedId || !draft || draft.evidenceId !== selectedId) return false;
    const operation = beginOperation();
    if (!operation) return false;
    setEvidenceError(null);
    try {
      const initial = currentSnapshot();
      if (!initial || !initial.project.evidence_items.some((item) => item.evidence_id === selectedId)) return false;
      optionsRef.current.onOperationStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Evidence changes could not be saved.", setEvidenceError);
      if (!snapshot) return false;
      let payload;
      try {
        payload = await updateCodesEvidenceItem({
          project: snapshot.project,
          handle: snapshot.handle,
          evidence_id: selectedId,
          memo: draft.memo,
          code_ids: [...draft.codeIds],
          new_codes: draft.newCodes.map(provisionalCodeInput),
          ai_decisions: draft.aiDecisions.map(cloneDecision)
        });
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Evidence changes could not be saved.", setEvidenceError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Evidence changes could not be saved.", setEvidenceError)) return false;
      setSelectedEvidenceId(payload.evidence.evidence_id);
      setEvidenceEditDraft(evidenceEditDraftFromEvidence(payload.evidence));
      setEvidenceError(null);
      optionsRef.current.onStatusMessage?.(`Saved ${payload.evidence.evidence_id}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure]);

  const openEvidenceDelete = useCallback(() => {
    const currentProject = optionsRef.current.getCurrentSession().project;
    const selected = currentProject?.evidence_items.find((item) => item.evidence_id === selectedEvidenceIdRef.current);
    if (!selected || activeOperationRef.current || optionsRef.current.isExternallyLocked()) return false;
    setDeleteEvidenceError(null);
    setDeleteEvidenceId(selected.evidence_id);
    return true;
  }, []);

  const closeEvidenceDelete = useCallback(() => {
    if (activeOperationRef.current) return;
    setDeleteEvidenceId("");
    setDeleteEvidenceError(null);
  }, []);

  const confirmEvidenceDelete = useCallback(async () => {
    const evidenceId = deleteEvidenceIdRef.current;
    if (!evidenceId) return false;
    const operation = beginOperation();
    if (!operation) return false;
    setDeleteEvidenceError(null);
    try {
      const initial = currentSnapshot();
      if (!initial || !initial.project.evidence_items.some((item) => item.evidence_id === evidenceId)) return false;
      optionsRef.current.onOperationStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Evidence item could not be deleted.", setDeleteEvidenceError);
      if (!snapshot) return false;
      let payload;
      try {
        payload = await deleteCodesEvidenceItem(snapshot.project, snapshot.handle, evidenceId);
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Evidence item could not be deleted.", setDeleteEvidenceError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Evidence item could not be deleted.", setDeleteEvidenceError)) return false;
      setSelectedEvidenceId("");
      setEvidenceEditDraft(null);
      setDeleteEvidenceId("");
      setDeleteEvidenceError(null);
      window.getSelection()?.removeAllRanges();
      optionsRef.current.onStatusMessage?.(`Deleted evidence item ${payload.evidence_id}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure]);

  const openTranscriptRemoval = useCallback((transcript: CodesTranscript) => {
    const currentProject = optionsRef.current.getCurrentSession().project;
    const authoritative = currentProject?.transcripts.find((item) => item.transcript_id === transcript.transcript_id);
    if (!currentProject || !authoritative || activeOperationRef.current || optionsRef.current.isExternallyLocked()) return false;
    const evidenceCount = currentProject.evidence_items.filter((item) => item.transcript_id === authoritative.transcript_id).length;
    setTranscriptError(null);
    setTranscriptActionDialog({ kind: "remove", transcript: authoritative, evidenceCount });
    return true;
  }, []);

  const closeTranscriptRemoval = useCallback(() => {
    if (activeOperationRef.current) return;
    setTranscriptActionDialog(null);
    setTranscriptError(null);
  }, []);

  const showTranscriptEvidence = useCallback(() => {
    const dialog = transcriptActionDialogRef.current;
    if (!dialog) return;
    setActiveTranscriptId(dialog.transcript.transcript_id);
    setSelectedEvidenceId("");
    clearFilters();
    setTranscriptActionDialog(null);
    setTranscriptError(null);
  }, [clearFilters]);

  const confirmTranscriptRemoval = useCallback(async () => {
    const dialog = transcriptActionDialogRef.current;
    if (!dialog || dialog.evidenceCount) return false;
    const operation = beginOperation();
    if (!operation) return false;
    const transcriptId = dialog.transcript.transcript_id;
    setTranscriptError(null);
    try {
      const initial = currentSnapshot();
      if (!initial || !initial.project.transcripts.some((item) => item.transcript_id === transcriptId)) return false;
      optionsRef.current.onOperationStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Transcript could not be removed.", setTranscriptError);
      if (!snapshot) return false;
      let payload;
      try {
        payload = await removeCodesProjectTranscript(snapshot.project, snapshot.handle, transcriptId);
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Transcript could not be removed.", setTranscriptError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Transcript could not be removed.", setTranscriptError)) return false;
      const nextTranscriptId = payload.project.transcripts.some((item) => item.transcript_id === activeTranscriptIdRef.current)
        ? activeTranscriptIdRef.current
        : payload.project.transcripts[0]?.transcript_id ?? "";
      setActiveTranscriptId(nextTranscriptId);
      setSelectedEvidenceId("");
      setEvidenceDraft(null);
      setEvidenceEditDraft(null);
      setTranscriptActionDialog(null);
      setTranscriptError(null);
      optionsRef.current.onStatusMessage?.(`Removed ${payload.label}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure]);

  const acceptPersistedEvidence = useCallback((evidence: CodesEvidenceItem) => {
    setActiveTranscriptId(evidence.transcript_id);
    setSelectedEvidenceId(evidence.evidence_id);
    setEvidenceDraft(null);
    setEvidenceEditDraft(evidenceEditDraftFromEvidence(evidence));
  }, []);

  const getDraftState = useCallback(() => {
    const currentProject = optionsRef.current.getCurrentSession().project;
    const currentEvidence = currentProject?.evidence_items.find(
      (evidence) => evidence.evidence_id === selectedEvidenceIdRef.current
    ) ?? null;
    return {
      evidenceDraft: evidenceDraftRef.current,
      evidenceEditDirty: evidenceEditDraftHasChanges(evidenceEditDraftRef.current, currentEvidence)
    };
  }, []);

  return {
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
    transcriptActionDialog,
    evidenceToDelete,
    deleteEvidenceError,
    evidenceError,
    transcriptError,
    busy,
    isLocked,
    getDraftState,
    captureSelection,
    selectTranscript,
    navigateToTranscript,
    selectEvidence,
    discardEvidenceDraft,
    restoreEvidenceEditDraft,
    toggleInspectorCode,
    stageExistingCode,
    updateInspectorMemo,
    addInspectorCode,
    removeInspectorCode,
    applyAiNote,
    saveEvidenceDraft,
    saveSelectedEvidence,
    openEvidenceDelete,
    closeEvidenceDelete,
    confirmEvidenceDelete,
    openTranscriptRemoval,
    closeTranscriptRemoval,
    showTranscriptEvidence,
    confirmTranscriptRemoval,
    setEvidenceSearch,
    setEvidenceScope,
    setEvidenceFilterCodeId,
    setEvidenceFilterThemeId,
    clearFilters,
    setHighlightSettings,
    resetForNewProject,
    resetForOpenProject,
    resetForReload,
    resetForClose,
    reconcileAfterSaveAs,
    reconcileAfterImport,
    removeDeletedCode,
    acceptPersistedEvidence
  };
}
