import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCodesProject,
  loadCodesProject,
  pickEvidenceProjectFile,
  pickEvidenceProjectSaveFile,
  saveCodesProject,
  type CodesProject,
  type CodesProjectHandle
} from "../lib/api";
import { fileName, projectNameFromPath, projectSaveName } from "../lib/codesProjectPaths";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "./useCodesProjectSession";

type SessionIdentity = {
  projectId: string;
  projectFile: string;
  revision: string;
} | null;

type CoherentSession = CodesProjectSessionSnapshot & {
  project: CodesProject;
  projectFile: string;
  projectHandle: CodesProjectHandle;
};

type ActiveProjectOperation = {
  generation: number;
  identity: SessionIdentity;
};

type CodesProjectFileLifecycleOptions = {
  desktopAvailable: boolean;
  getCurrentSession: () => CodesProjectSessionSnapshot;
  activateProjectSession: (payload: PersistedProjectSettings) => void;
  clearProjectSession: () => void;
  isExternallyLocked: () => boolean;
  resetAiDecisions: () => void;
  invalidateDraftGuard: () => void;
  resetEvidenceForNewProject: () => void;
  resetEvidenceForOpenProject: (project: CodesProject) => void;
  resetEvidenceForReload: (project: CodesProject) => void;
  resetEvidenceForClose: () => void;
  reconcileEvidenceAfterSaveAs: (project: CodesProject) => void;
  resetCodebook: () => void;
  resetTranscriptImport: () => void;
  showEvidenceWorkspace: () => void;
  onOperationStarted?: () => void;
  onStatusMessage?: (message: string) => void;
  onError?: (error: unknown, fallback: string) => void;
  onClose?: () => void;
};

function identityFromSession(session: CodesProjectSessionSnapshot): SessionIdentity {
  if (!session.project || !session.projectFile || !session.projectHandle) return null;
  return {
    projectId: session.project.project_id,
    projectFile: session.projectFile,
    revision: session.projectHandle.revision
  };
}

function isCoherentSession(session: CodesProjectSessionSnapshot): session is CoherentSession {
  return Boolean(
    session.project
    && session.projectFile
    && session.projectHandle
    && session.project.project_id === session.projectHandle.project_id
    && session.projectFile === session.projectHandle.project_file
  );
}

function sameIdentity(left: SessionIdentity, right: SessionIdentity) {
  if (!left || !right) return left === right;
  return left.projectId === right.projectId
    && left.projectFile === right.projectFile
    && left.revision === right.revision;
}

export function useCodesProjectFileLifecycle(options: CodesProjectFileLifecycleOptions) {
  const [busy, setBusy] = useState(false);
  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeOperationRef = useRef<ActiveProjectOperation | null>(null);
  optionsRef.current = options;

  const operationIsCurrent = useCallback((operation: ActiveProjectOperation, validateIdentity = true) => Boolean(
    mountedRef.current
    && activeOperationRef.current === operation
    && generationRef.current === operation.generation
    && (!validateIdentity || sameIdentity(
      operation.identity,
      identityFromSession(optionsRef.current.getCurrentSession())
    ))
  ), []);

  const beginOperation = useCallback(() => {
    if (activeOperationRef.current || optionsRef.current.isExternallyLocked()) return null;
    const operation: ActiveProjectOperation = {
      generation: generationRef.current,
      identity: identityFromSession(optionsRef.current.getCurrentSession())
    };
    activeOperationRef.current = operation;
    setBusy(true);
    optionsRef.current.onOperationStarted?.();
    return operation;
  }, []);

  const finishOperation = useCallback((operation: ActiveProjectOperation) => {
    if (!operationIsCurrent(operation, false)) return;
    activeOperationRef.current = null;
    setBusy(false);
  }, [operationIsCurrent]);

  const publishFailure = useCallback((
    operation: ActiveProjectOperation,
    error: unknown,
    fallback: string
  ) => {
    if (operationIsCurrent(operation)) optionsRef.current.onError?.(error, fallback);
  }, [operationIsCurrent]);

  const newProject = useCallback(async () => {
    if (!optionsRef.current.desktopAvailable) return false;
    const operation = beginOperation();
    if (!operation) return false;
    try {
      const currentFile = optionsRef.current.getCurrentSession().projectFile;
      const savePath = await pickEvidenceProjectSaveFile("untitled.evidence.json", currentFile ?? undefined);
      if (!operationIsCurrent(operation) || !savePath) return false;
      const payload = await createCodesProject({
        project_file: savePath,
        name: projectNameFromPath(savePath)
      });
      if (!operationIsCurrent(operation)) return false;
      optionsRef.current.resetAiDecisions();
      optionsRef.current.invalidateDraftGuard();
      optionsRef.current.activateProjectSession(payload);
      optionsRef.current.resetEvidenceForNewProject();
      optionsRef.current.showEvidenceWorkspace();
      optionsRef.current.resetCodebook();
      optionsRef.current.resetTranscriptImport();
      optionsRef.current.onStatusMessage?.("Created new coding project.");
      return true;
    } catch (error) {
      publishFailure(operation, error, "Coding project could not be created.");
      return false;
    } finally {
      finishOperation(operation);
    }
  }, [beginOperation, finishOperation, operationIsCurrent, publishFailure]);

  const openProject = useCallback(async () => {
    if (!optionsRef.current.desktopAvailable) return false;
    const operation = beginOperation();
    if (!operation) return false;
    try {
      const currentFile = optionsRef.current.getCurrentSession().projectFile;
      const selectedPath = await pickEvidenceProjectFile(currentFile ?? undefined);
      if (!operationIsCurrent(operation) || !selectedPath) return false;
      const payload = await loadCodesProject(selectedPath);
      if (!operationIsCurrent(operation)) return false;
      optionsRef.current.resetAiDecisions();
      optionsRef.current.invalidateDraftGuard();
      optionsRef.current.activateProjectSession(payload);
      optionsRef.current.resetEvidenceForOpenProject(payload.project);
      optionsRef.current.showEvidenceWorkspace();
      optionsRef.current.resetCodebook();
      optionsRef.current.resetTranscriptImport();
      optionsRef.current.onStatusMessage?.(`Opened ${fileName(payload.handle.project_file)}.`);
      return true;
    } catch (error) {
      publishFailure(operation, error, "Coding project could not be opened.");
      return false;
    } finally {
      finishOperation(operation);
    }
  }, [beginOperation, finishOperation, operationIsCurrent, publishFailure]);

  const saveAs = useCallback(async () => {
    if (!optionsRef.current.desktopAvailable) return false;
    const session = optionsRef.current.getCurrentSession();
    if (!isCoherentSession(session)) return false;
    const operation = beginOperation();
    if (!operation) return false;
    const projectSnapshot = session.project;
    const handleSnapshot = session.projectHandle;
    try {
      const savePath = await pickEvidenceProjectSaveFile(
        projectSaveName(projectSnapshot),
        session.projectFile
      );
      if (!operationIsCurrent(operation) || !savePath) return false;
      const payload = await saveCodesProject(savePath, projectSnapshot, handleSnapshot);
      if (!operationIsCurrent(operation)) return false;
      optionsRef.current.resetAiDecisions();
      optionsRef.current.activateProjectSession(payload);
      optionsRef.current.reconcileEvidenceAfterSaveAs(payload.project);
      optionsRef.current.onStatusMessage?.(`Saved ${fileName(payload.handle.project_file)}.`);
      return true;
    } catch (error) {
      publishFailure(operation, error, "Coding project could not be saved.");
      return false;
    } finally {
      finishOperation(operation);
    }
  }, [beginOperation, finishOperation, operationIsCurrent, publishFailure]);

  const reload = useCallback(async () => {
    const session = optionsRef.current.getCurrentSession();
    if (!isCoherentSession(session)) return false;
    const operation = beginOperation();
    if (!operation) return false;
    try {
      const payload = await loadCodesProject(session.projectFile);
      if (!operationIsCurrent(operation)) return false;
      optionsRef.current.resetAiDecisions();
      optionsRef.current.invalidateDraftGuard();
      optionsRef.current.activateProjectSession(payload);
      optionsRef.current.resetEvidenceForReload(payload.project);
      optionsRef.current.resetCodebook();
      optionsRef.current.onStatusMessage?.(`Reloaded ${fileName(payload.handle.project_file)}.`);
      return true;
    } catch (error) {
      publishFailure(operation, error, "Coding project could not be reloaded.");
      return false;
    } finally {
      finishOperation(operation);
    }
  }, [beginOperation, finishOperation, operationIsCurrent, publishFailure]);

  const close = useCallback(() => {
    if (!isCoherentSession(optionsRef.current.getCurrentSession())) return false;
    const operation = beginOperation();
    if (!operation) return false;
    optionsRef.current.resetAiDecisions();
    optionsRef.current.invalidateDraftGuard();
    optionsRef.current.clearProjectSession();
    optionsRef.current.resetEvidenceForClose();
    optionsRef.current.resetCodebook();
    optionsRef.current.resetTranscriptImport();
    optionsRef.current.onClose?.();
    optionsRef.current.onStatusMessage?.("No Coding Project Open");
    finishOperation(operation);
    return true;
  }, [beginOperation, finishOperation]);

  const isLocked = useCallback(() => Boolean(activeOperationRef.current), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeOperationRef.current = null;
    };
  }, []);

  return {
    busy,
    isLocked,
    newProject,
    openProject,
    saveAs,
    reload,
    close
  };
}
