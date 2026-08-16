import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CodesProjectConflictError,
  createCodesCode,
  createCodesTheme,
  deleteCodesCode,
  deleteCodesTheme,
  mergeCodesCode,
  updateCodesCode,
  updateCodesTheme,
  type CodesCode,
  type CodesCodePayload,
  type CodesDeleteCodePayload,
  type CodesDeleteThemePayload,
  type CodesMergeCodePayload,
  type CodesProject,
  type CodesProjectHandle,
  type CodesProjectPayload,
  type CodesTheme,
  type CodesThemePayload
} from "../lib/api";
import type { CodesMergeFields } from "../components/codes/CodesMergeCodeDialog";
import type { CodebookEntityView } from "../components/codes/CodesCodebookPanel";
import type { CodeDialogValue } from "../components/codes/CodesCodeDialog";
import {
  codeFormFromCode,
  codeFormHasChanges,
  emptyCodeForm,
  emptyThemeForm,
  themeFormFromTheme,
  themeFormHasChanges,
  type CodeForm,
  type ThemeForm
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

type ActiveOperation = {
  id: number;
  generation: number;
};

type MutationSnapshot = {
  project: CodesProject;
  handle: CodesProjectHandle;
  identity: SessionIdentity;
};

type CodesCodebookWorkspaceOptions = {
  getCurrentSession: () => CodesProjectSessionSnapshot;
  applyPersistedProject: (payload: PersistedProjectSettings) => boolean;
  persistProjectSettings: () => Promise<PersistedProjectSettings | null>;
  isExternallyLocked: () => boolean;
  onBusyChange?: (busy: boolean) => void;
  onProjectConflict?: (conflict: CodesProjectConflictError) => void;
  onSaveStarted?: () => void;
  onStatusMessage?: (message: string) => void;
  onSaveError?: (error: unknown, fallback: string) => void;
  onCodeDeleted?: (codeId: string) => void;
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

function cloneCodeForm(form: CodeForm): CodeForm {
  return {
    ...form,
    exampleEvidenceIds: [...form.exampleEvidenceIds],
    aiDecisions: form.aiDecisions.map((decision) => ({ ...decision }))
  };
}

function cloneThemeForm(form: ThemeForm): ThemeForm {
  return {
    ...form,
    codeIds: [...form.codeIds],
    aiDecisions: form.aiDecisions.map((decision) => ({ ...decision }))
  };
}

function cloneCodeDialogValue(value: CodeDialogValue): CodeDialogValue {
  return {
    ...cloneCodeForm(value),
    useCurrentEvidenceAsExample: value.useCurrentEvidenceAsExample
  };
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

export function useCodesCodebookWorkspace(options: CodesCodebookWorkspaceOptions) {
  const [activeView, setActiveView] = useState<CodebookEntityView>("codes");
  const [codeForm, setCodeForm] = useState<CodeForm>(emptyCodeForm);
  const [themeForm, setThemeForm] = useState<ThemeForm>(emptyThemeForm);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const [codeDialogInitialValue, setCodeDialogInitialValue] = useState<CodeDialogValue | null>(null);
  const [themeDialogInitialValue, setThemeDialogInitialValue] = useState<ThemeForm | null>(null);
  const [entityDialogError, setEntityDialogError] = useState<string | null>(null);
  const [entityEditorError, setEntityEditorError] = useState<string | null>(null);
  const [mergeSourceCodeId, setMergeSourceCodeId] = useState("");
  const [mergeDialogError, setMergeDialogError] = useState<string | null>(null);
  const [deleteCodeId, setDeleteCodeId] = useState("");
  const [deleteThemeId, setDeleteThemeId] = useState("");
  const [deleteEntityError, setDeleteEntityError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const optionsRef = useRef(options);
  const activeViewRef = useRef(activeView);
  const codeFormRef = useRef(codeForm);
  const themeFormRef = useRef(themeForm);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const renderedProjectIdRef = useRef<string | null>(options.getCurrentSession().project?.project_id ?? null);
  optionsRef.current = options;
  activeViewRef.current = activeView;

  const selectedCode = useMemo(() => {
    const project = options.getCurrentSession().project;
    return project?.codes.find((code) => code.code_id === codeForm.codeId) ?? null;
  }, [codeForm.codeId, options]);
  const selectedTheme = useMemo(() => {
    const project = options.getCurrentSession().project;
    return project?.themes.find((theme) => theme.theme_id === themeForm.themeId) ?? null;
  }, [themeForm.themeId, options]);
  const codeDraftDirty = codeFormHasChanges(codeForm, selectedCode);
  const themeDraftDirty = themeFormHasChanges(themeForm, selectedTheme);

  const currentProjectId = options.getCurrentSession().project?.project_id ?? null;
  if (renderedProjectIdRef.current !== currentProjectId) {
    renderedProjectIdRef.current = currentProjectId;
    generationRef.current += 1;
    activeOperationRef.current = null;
    codeFormRef.current = emptyCodeForm;
    themeFormRef.current = emptyThemeForm;
  }

  const replaceCodeForm = useCallback((next: CodeForm) => {
    codeFormRef.current = next;
    setCodeForm(next);
  }, []);
  const replaceThemeForm = useCallback((next: ThemeForm) => {
    themeFormRef.current = next;
    setThemeForm(next);
  }, []);
  const mutateCodeForm = useCallback((updater: (current: CodeForm) => CodeForm) => {
    const next = updater(codeFormRef.current);
    replaceCodeForm(next);
    return next;
  }, [replaceCodeForm]);
  const mutateThemeForm = useCallback((updater: (current: ThemeForm) => ThemeForm) => {
    const next = updater(themeFormRef.current);
    replaceThemeForm(next);
    return next;
  }, [replaceThemeForm]);

  const operationIsActive = useCallback((operation: ActiveOperation) => Boolean(
    mountedRef.current
    && activeOperationRef.current === operation
    && operation.generation === generationRef.current
  ), []);

  const beginOperation = useCallback(() => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked()) return null;
    const operation = { id: ++operationSequenceRef.current, generation: generationRef.current };
    activeOperationRef.current = operation;
    optionsRef.current.onBusyChange?.(true);
    setBusy(true);
    return operation;
  }, []);

  const finishOperation = useCallback((operation: ActiveOperation) => {
    if (!operationIsActive(operation)) return;
    activeOperationRef.current = null;
    optionsRef.current.onBusyChange?.(false);
    setBusy(false);
  }, [operationIsActive]);

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
    if (error instanceof CodesProjectConflictError) {
      optionsRef.current.onProjectConflict?.(error);
    }
    publish(error instanceof Error ? error.message : fallback);
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
      const conflict = optionsRef.current.getCurrentSession().projectConflict;
      if (conflict) publishFailure(operation, initial.identity, conflict, fallback, publish);
      else if (sameExactSession(initial.identity, identityFromSession(optionsRef.current.getCurrentSession()))) publish(fallback);
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
      || !optionsRef.current.applyPersistedProject({ project: payload.project, handle: payload.handle })
      || !sameExactSession(nextIdentity, identityFromSession(optionsRef.current.getCurrentSession()))
    ) {
      publish(fallback);
      return null;
    }
    return mutationSnapshot(payload);
  }, [operationIsActive]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    operationSequenceRef.current += 1;
    activeOperationRef.current = null;
    optionsRef.current.onBusyChange?.(false);
    setBusy(false);
    setActiveView("codes");
    replaceCodeForm(emptyCodeForm);
    replaceThemeForm(emptyThemeForm);
    setCodeDialogOpen(false);
    setThemeDialogOpen(false);
    setCodeDialogInitialValue(null);
    setThemeDialogInitialValue(null);
    setEntityDialogError(null);
    setEntityEditorError(null);
    setMergeSourceCodeId("");
    setMergeDialogError(null);
    setDeleteCodeId("");
    setDeleteThemeId("");
    setDeleteEntityError(null);
  }, [replaceCodeForm, replaceThemeForm]);

  useEffect(() => {
    reset();
  }, [currentProjectId, reset]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeOperationRef.current = null;
      optionsRef.current.onBusyChange?.(false);
    };
  }, []);

  const updateCodeForm = useCallback((updater: (current: CodeForm) => CodeForm) => {
    mutateCodeForm(updater);
  }, [mutateCodeForm]);
  const updateThemeForm = useCallback((updater: (current: ThemeForm) => ThemeForm) => {
    mutateThemeForm(updater);
  }, [mutateThemeForm]);
  const tryUpdateCodeForm = useCallback((expectedCodeId: string, updater: (current: CodeForm) => CodeForm) => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked()) return false;
    if (!expectedCodeId || codeFormRef.current.codeId !== expectedCodeId) return false;
    mutateCodeForm(updater);
    return true;
  }, [mutateCodeForm]);
  const tryUpdateThemeForm = useCallback((expectedThemeId: string, updater: (current: ThemeForm) => ThemeForm) => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked()) return false;
    if (!expectedThemeId || themeFormRef.current.themeId !== expectedThemeId) return false;
    mutateThemeForm(updater);
    return true;
  }, [mutateThemeForm]);

  const selectCode = useCallback((code: CodesCode) => {
    setEntityEditorError(null);
    setActiveView("codes");
    replaceCodeForm(codeFormFromCode(code));
    setMergeSourceCodeId("");
  }, [replaceCodeForm]);
  const selectTheme = useCallback((theme: CodesTheme) => {
    setEntityEditorError(null);
    setActiveView("themes");
    replaceThemeForm(themeFormFromTheme(theme));
  }, [replaceThemeForm]);
  const changeView = useCallback((view: CodebookEntityView) => {
    setEntityEditorError(null);
    activeViewRef.current = view;
    setActiveView(view);
    setMergeSourceCodeId("");
  }, []);
  const cancelCodeForm = useCallback(() => {
    const current = optionsRef.current.getCurrentSession().project;
    const selected = current?.codes.find((code) => code.code_id === codeFormRef.current.codeId) ?? null;
    setEntityEditorError(null);
    replaceCodeForm(selected ? codeFormFromCode(selected) : emptyCodeForm);
    setMergeSourceCodeId("");
  }, [replaceCodeForm]);
  const cancelThemeForm = useCallback(() => {
    const current = optionsRef.current.getCurrentSession().project;
    const selected = current?.themes.find((theme) => theme.theme_id === themeFormRef.current.themeId) ?? null;
    setEntityEditorError(null);
    replaceThemeForm(selected ? themeFormFromTheme(selected) : emptyThemeForm);
  }, [replaceThemeForm]);
  const toggleThemeCode = useCallback((codeId: string) => {
    mutateThemeForm((current) => ({
      ...current,
      codeIds: current.codeIds.includes(codeId)
        ? current.codeIds.filter((id) => id !== codeId)
        : [...current.codeIds, codeId]
    }));
  }, [mutateThemeForm]);

  const openNewCode = useCallback((initialValue: CodeDialogValue | null = null) => {
    setEntityDialogError(null);
    setCodeDialogInitialValue(initialValue ? cloneCodeDialogValue(initialValue) : null);
    setCodeDialogOpen(true);
    setMergeSourceCodeId("");
  }, []);
  const closeCodeDialog = useCallback(() => {
    if (activeOperationRef.current) return;
    setCodeDialogOpen(false);
    setCodeDialogInitialValue(null);
    setEntityDialogError(null);
  }, []);
  const openNewTheme = useCallback((initialValue: ThemeForm | null = null) => {
    setEntityDialogError(null);
    setThemeDialogInitialValue(initialValue ? cloneThemeForm(initialValue) : null);
    setThemeDialogOpen(true);
  }, []);
  const tryOpenNewTheme = useCallback((initialValue: ThemeForm | null = null) => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked()) return false;
    setEntityDialogError(null);
    setThemeDialogInitialValue(initialValue ? cloneThemeForm(initialValue) : null);
    setThemeDialogOpen(true);
    return true;
  }, []);
  const closeThemeDialog = useCallback(() => {
    if (activeOperationRef.current) return;
    setThemeDialogOpen(false);
    setThemeDialogInitialValue(null);
    setEntityDialogError(null);
  }, []);

  const saveCode = useCallback(async (): Promise<boolean> => {
    const capturedForm = cloneCodeForm(codeForm);
    const operation = beginOperation();
    if (!operation) return false;
    setEntityEditorError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      optionsRef.current.onSaveStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Code could not be saved.", setEntityEditorError);
      if (!snapshot) return false;
      let payload: CodesCodePayload;
      try {
        payload = capturedForm.codeId
          ? await updateCodesCode({
              project: snapshot.project,
              handle: snapshot.handle,
              code_id: capturedForm.codeId,
              name: capturedForm.name,
              description: capturedForm.description,
              inclusion_note: capturedForm.inclusionNote,
              exclusion_note: capturedForm.exclusionNote,
              example_evidence_ids: capturedForm.exampleEvidenceIds,
              color: capturedForm.color,
              memo: capturedForm.memo,
              ai_decisions: capturedForm.aiDecisions
            })
          : await createCodesCode({
              project: snapshot.project,
              handle: snapshot.handle,
              name: capturedForm.name,
              description: capturedForm.description,
              inclusion_note: capturedForm.inclusionNote,
              exclusion_note: capturedForm.exclusionNote,
              example_evidence_ids: capturedForm.exampleEvidenceIds,
              color: capturedForm.color,
              memo: capturedForm.memo,
              ai_decisions: capturedForm.aiDecisions
            });
      } catch (error) {
        const published = publishFailure(operation, snapshot.identity, error, "Code could not be saved.", setEntityEditorError);
        if (published) optionsRef.current.onSaveError?.(error, "Code could not be saved.");
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Code could not be saved.", setEntityEditorError)) return false;
      setEntityEditorError(null);
      replaceCodeForm(codeFormFromCode(payload.code));
      optionsRef.current.onStatusMessage?.(`${payload.code.code_id} saved.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, codeForm, currentSnapshot, finishOperation, prepareMutation, publishFailure, replaceCodeForm]);

  const createCode = useCallback(async (value: CodeDialogValue) => {
    const captured = cloneCodeDialogValue(value);
    const operation = beginOperation();
    if (!operation) return false;
    setEntityDialogError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      const snapshot = await prepareMutation(operation, initial, "Code could not be created.", setEntityDialogError);
      if (!snapshot) return false;
      let payload: CodesCodePayload;
      try {
        payload = await createCodesCode({
          project: snapshot.project,
          handle: snapshot.handle,
          name: captured.name,
          description: captured.description,
          inclusion_note: captured.inclusionNote,
          exclusion_note: captured.exclusionNote,
          example_evidence_ids: captured.exampleEvidenceIds,
          color: captured.color,
          memo: captured.memo,
          ai_decisions: captured.aiDecisions
        });
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Code could not be created.", setEntityDialogError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Code could not be created.", setEntityDialogError)) return false;
      replaceCodeForm(codeFormFromCode(payload.code));
      setActiveView("codes");
      setCodeDialogOpen(false);
      setCodeDialogInitialValue(null);
      optionsRef.current.onStatusMessage?.(`Created code ${payload.code.name}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure, replaceCodeForm]);

  const deleteCode = useCallback(async (code: CodesCode) => {
    const codeId = code.code_id;
    const operation = beginOperation();
    if (!operation) return false;
    setDeleteEntityError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      const snapshot = await prepareMutation(operation, initial, "Code could not be deleted.", setDeleteEntityError);
      if (!snapshot) return false;
      let payload: CodesDeleteCodePayload;
      try {
        payload = await deleteCodesCode(snapshot.project, snapshot.handle, codeId);
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Code could not be deleted.", setDeleteEntityError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Code could not be deleted.", setDeleteEntityError)) return false;
      optionsRef.current.onCodeDeleted?.(codeId);
      mutateCodeForm((current) => current.codeId === codeId ? emptyCodeForm : current);
      mutateThemeForm((current) => ({ ...current, codeIds: current.codeIds.filter((id) => id !== codeId) }));
      setMergeSourceCodeId((current) => current === codeId ? "" : current);
      setDeleteCodeId("");
      optionsRef.current.onStatusMessage?.(`Deleted code ${payload.code_id}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, mutateCodeForm, mutateThemeForm, prepareMutation, publishFailure]);

  const openDeleteCode = useCallback((codeId: string) => {
    setDeleteEntityError(null);
    setDeleteCodeId(codeId);
  }, []);
  const closeDeleteCode = useCallback(() => {
    if (activeOperationRef.current) return;
    setDeleteCodeId("");
    setDeleteEntityError(null);
  }, []);

  const openMergeCode = useCallback((codeId: string) => {
    setMergeDialogError(null);
    setMergeSourceCodeId(codeId);
  }, []);
  const closeMergeCode = useCallback(() => {
    if (activeOperationRef.current) return;
    setMergeSourceCodeId("");
    setMergeDialogError(null);
  }, []);
  const mergeCode = useCallback(async (targetCodeId: string, fields: CodesMergeFields) => {
    const sourceCodeId = mergeSourceCodeId;
    const capturedFields = { ...fields };
    if (!sourceCodeId || !targetCodeId) return false;
    const operation = beginOperation();
    if (!operation) return false;
    setMergeDialogError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      const snapshot = await prepareMutation(operation, initial, "Codes could not be merged.", setMergeDialogError);
      if (!snapshot) return false;
      let payload: CodesMergeCodePayload;
      try {
        payload = await mergeCodesCode(snapshot.project, snapshot.handle, sourceCodeId, targetCodeId, capturedFields);
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Codes could not be merged.", setMergeDialogError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Codes could not be merged.", setMergeDialogError)) return false;
      replaceCodeForm(codeFormFromCode(payload.target_code));
      setMergeSourceCodeId("");
      optionsRef.current.onStatusMessage?.(`Merged ${payload.source_code_id} into ${payload.target_code.code_id}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, mergeSourceCodeId, prepareMutation, publishFailure, replaceCodeForm]);

  const saveTheme = useCallback(async (): Promise<boolean> => {
    const capturedForm = cloneThemeForm(themeForm);
    const operation = beginOperation();
    if (!operation) return false;
    setEntityEditorError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      optionsRef.current.onSaveStarted?.();
      const snapshot = await prepareMutation(operation, initial, "Theme could not be saved.", setEntityEditorError);
      if (!snapshot) return false;
      let payload: CodesThemePayload;
      try {
        payload = capturedForm.themeId
          ? await updateCodesTheme({
              project: snapshot.project,
              handle: snapshot.handle,
              theme_id: capturedForm.themeId,
              name: capturedForm.name,
              description: capturedForm.description,
              color: capturedForm.color,
              code_ids: capturedForm.codeIds,
              memo: capturedForm.memo,
              ai_decisions: capturedForm.aiDecisions
            })
          : await createCodesTheme({
              project: snapshot.project,
              handle: snapshot.handle,
              name: capturedForm.name,
              description: capturedForm.description,
              color: capturedForm.color,
              code_ids: capturedForm.codeIds,
              memo: capturedForm.memo,
              ai_decisions: capturedForm.aiDecisions
            });
      } catch (error) {
        const published = publishFailure(operation, snapshot.identity, error, "Theme could not be saved.", setEntityEditorError);
        if (published) optionsRef.current.onSaveError?.(error, "Theme could not be saved.");
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Theme could not be saved.", setEntityEditorError)) return false;
      setEntityEditorError(null);
      replaceThemeForm(themeFormFromTheme(payload.theme));
      optionsRef.current.onStatusMessage?.(`${payload.theme.theme_id} saved.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure, replaceThemeForm, themeForm]);

  const createTheme = useCallback(async (value: ThemeForm) => {
    const captured = cloneThemeForm(value);
    const operation = beginOperation();
    if (!operation) return false;
    setEntityDialogError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      const snapshot = await prepareMutation(operation, initial, "Theme could not be created.", setEntityDialogError);
      if (!snapshot) return false;
      let payload: CodesThemePayload;
      try {
        payload = await createCodesTheme({
          project: snapshot.project,
          handle: snapshot.handle,
          name: captured.name,
          description: captured.description,
          color: captured.color,
          code_ids: captured.codeIds,
          memo: captured.memo,
          ai_decisions: captured.aiDecisions
        });
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Theme could not be created.", setEntityDialogError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Theme could not be created.", setEntityDialogError)) return false;
      replaceThemeForm(themeFormFromTheme(payload.theme));
      setActiveView("themes");
      setThemeDialogOpen(false);
      setThemeDialogInitialValue(null);
      optionsRef.current.onStatusMessage?.(`Created theme ${payload.theme.name}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, prepareMutation, publishFailure, replaceThemeForm]);

  const deleteTheme = useCallback(async (theme: CodesTheme) => {
    const themeId = theme.theme_id;
    const operation = beginOperation();
    if (!operation) return false;
    setDeleteEntityError(null);
    try {
      const initial = currentSnapshot();
      if (!initial) return false;
      const snapshot = await prepareMutation(operation, initial, "Theme could not be deleted.", setDeleteEntityError);
      if (!snapshot) return false;
      let payload: CodesDeleteThemePayload;
      try {
        payload = await deleteCodesTheme(snapshot.project, snapshot.handle, themeId);
      } catch (error) {
        publishFailure(operation, snapshot.identity, error, "Theme could not be deleted.", setDeleteEntityError);
        return false;
      }
      if (!applyResponse(operation, snapshot.identity, payload, "Theme could not be deleted.", setDeleteEntityError)) return false;
      mutateThemeForm((current) => current.themeId === themeId ? emptyThemeForm : current);
      setDeleteThemeId("");
      optionsRef.current.onStatusMessage?.(`Deleted theme ${payload.theme_id}.`);
      return true;
    } finally {
      finishOperation(operation);
    }
  }, [applyResponse, beginOperation, currentSnapshot, finishOperation, mutateThemeForm, prepareMutation, publishFailure]);

  const openDeleteTheme = useCallback((themeId: string) => {
    setDeleteEntityError(null);
    setDeleteThemeId(themeId);
  }, []);
  const closeDeleteTheme = useCallback(() => {
    if (activeOperationRef.current) return;
    setDeleteThemeId("");
    setDeleteEntityError(null);
  }, []);

  const getDraftState = useCallback(() => {
    const currentProject = optionsRef.current.getCurrentSession().project;
    const currentCode = currentProject?.codes.find((code) => code.code_id === codeFormRef.current.codeId) ?? null;
    const currentTheme = currentProject?.themes.find((theme) => theme.theme_id === themeFormRef.current.themeId) ?? null;
    return {
      activeView: activeViewRef.current,
      codeForm: codeFormRef.current,
      themeForm: themeFormRef.current,
      codeDraftDirty: codeFormHasChanges(codeFormRef.current, currentCode),
      themeDraftDirty: themeFormHasChanges(themeFormRef.current, currentTheme)
    };
  }, []);

  return {
    activeView,
    codeForm,
    themeForm,
    selectedCode,
    selectedTheme,
    codeDraftDirty,
    themeDraftDirty,
    codeDialogOpen,
    themeDialogOpen,
    codeDialogInitialValue,
    themeDialogInitialValue,
    entityDialogError,
    entityEditorError,
    mergeSourceCodeId,
    mergeDialogError,
    deleteCodeId,
    deleteThemeId,
    deleteEntityError,
    busy,
    isLocked: () => Boolean(activeOperationRef.current),
    getDraftState,
    currentCodeTargetId: () => codeFormRef.current.codeId,
    currentThemeTargetId: () => themeFormRef.current.themeId,
    reset,
    changeView,
    selectCode,
    selectTheme,
    updateCodeForm,
    updateThemeForm,
    tryUpdateCodeForm,
    tryUpdateThemeForm,
    toggleThemeCode,
    cancelCodeForm,
    cancelThemeForm,
    openNewCode,
    closeCodeDialog,
    openNewTheme,
    tryOpenNewTheme,
    closeThemeDialog,
    saveCode,
    createCode,
    deleteCode,
    openDeleteCode,
    closeDeleteCode,
    openMergeCode,
    closeMergeCode,
    mergeCode,
    saveTheme,
    createTheme,
    deleteTheme,
    openDeleteTheme,
    closeDeleteTheme
  };
}
