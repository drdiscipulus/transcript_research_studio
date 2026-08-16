import { useCallback, useEffect, useRef, useState } from "react";
import {
  importCodesTranscriptCandidates,
  pickFolder,
  pickTranscriptFile,
  previewCodesTranscriptImport,
  type CodesProject,
  type CodesProjectHandle,
  type TranscriptImportCandidate,
  type TranscriptImportPreview,
  type TranscriptImportResult
} from "../lib/api";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "./useCodesProjectSession";

export type CodesTranscriptImportResult = Pick<
  TranscriptImportResult,
  "imported" | "skipped" | "failed"
>;

type ImportSessionIdentity = {
  projectId: string;
  projectFile: string;
  revision: string;
};

type VisibleImportPreview = {
  preview: TranscriptImportPreview;
  session: ImportSessionIdentity;
};

type CodesTranscriptImportOptions = {
  desktopAvailable: boolean;
  getCurrentSession: () => CodesProjectSessionSnapshot;
  applyPersistedProject: (payload: PersistedProjectSettings) => boolean;
  persistProjectSettings: () => Promise<PersistedProjectSettings | null>;
  onOperationStarted?: () => void;
  onPreviewReady?: () => void;
  onImportApplied?: (payload: {
    project: CodesProject;
    handle: CodesProjectHandle;
    result: CodesTranscriptImportResult;
  }) => void;
  onError?: (error: unknown, fallback: string) => void;
};

function sessionIdentity(session: CodesProjectSessionSnapshot): ImportSessionIdentity | null {
  const project = session.project;
  const handle = session.projectHandle;
  if (!project || !handle || !session.projectFile) return null;
  return {
    projectId: project.project_id,
    projectFile: session.projectFile,
    revision: handle.revision
  };
}

function sameLogicalProject(left: ImportSessionIdentity, right: ImportSessionIdentity | null) {
  return Boolean(
    right
    && left.projectId === right.projectId
  );
}

function sameProjectFile(left: ImportSessionIdentity, right: ImportSessionIdentity | null) {
  return Boolean(
    right
    && left.projectId === right.projectId
    && left.projectFile === right.projectFile
  );
}

function sameExactSession(left: ImportSessionIdentity, right: ImportSessionIdentity | null) {
  return sameProjectFile(left, right) && left.revision === right?.revision;
}

export function useCodesTranscriptImport(options: CodesTranscriptImportOptions) {
  const [preview, setPreview] = useState<TranscriptImportPreview | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [result, setResult] = useState<CodesTranscriptImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const nextRequestIdRef = useRef(0);
  const activeRequestIdRef = useRef<number | null>(null);
  const visiblePreviewRef = useRef<VisibleImportPreview | null>(null);
  const selectedCandidateIdsRef = useRef<string[]>([]);
  optionsRef.current = options;

  const currentIdentity = useCallback(
    () => sessionIdentity(optionsRef.current.getCurrentSession()),
    []
  );

  const requestIsActive = useCallback((requestId: number) => Boolean(
    mountedRef.current && activeRequestIdRef.current === requestId
  ), []);

  const startRequest = useCallback(() => {
    const requestId = ++nextRequestIdRef.current;
    activeRequestIdRef.current = requestId;
    setBusy(true);
    optionsRef.current.onOperationStarted?.();
    return requestId;
  }, []);

  const finishRequest = useCallback((requestId: number) => {
    if (!requestIsActive(requestId)) return;
    activeRequestIdRef.current = null;
    setBusy(false);
  }, [requestIsActive]);

  const invalidateRequests = useCallback(() => {
    nextRequestIdRef.current += 1;
    activeRequestIdRef.current = null;
    setBusy(false);
  }, []);

  const publishSelection = useCallback((candidateIds: string[]) => {
    selectedCandidateIdsRef.current = candidateIds;
    setSelectedCandidateIds(candidateIds);
  }, []);

  const chooseSource = useCallback(async (kind: "file" | "folder") => {
    const session = optionsRef.current.getCurrentSession();
    const identity = sessionIdentity(session);
    if (!optionsRef.current.desktopAvailable || !identity || !session.projectHandle) return;

    const requestId = startRequest();
    let selectedPath: string | null;
    try {
      selectedPath = kind === "file"
        ? await pickTranscriptFile(session.projectFile ?? undefined)
        : await pickFolder(session.projectFile ?? undefined);
    } catch (error) {
      if (requestIsActive(requestId) && sameExactSession(identity, currentIdentity())) {
        optionsRef.current.onError?.(
          error,
          kind === "file"
            ? "Transcript file could not be imported."
            : "Transcript folder could not be imported."
        );
      }
      finishRequest(requestId);
      return;
    }

    if (
      !requestIsActive(requestId)
      || !sameExactSession(identity, currentIdentity())
      || !selectedPath
    ) {
      finishRequest(requestId);
      return;
    }

    try {
      const nextPreview = await previewCodesTranscriptImport({
        handle: session.projectHandle,
        ...(kind === "file"
          ? { transcript_file: selectedPath }
          : { transcript_folder: selectedPath })
      });
      if (!requestIsActive(requestId) || !sameExactSession(identity, currentIdentity())) return;

      visiblePreviewRef.current = { preview: nextPreview, session: identity };
      setPreview(nextPreview);
      publishSelection(
        nextPreview.candidates
          .filter((candidate) => candidate.status === "ready" && candidate.preferred)
          .map((candidate) => candidate.candidate_id)
      );
      setResult(null);
      optionsRef.current.onPreviewReady?.();
    } catch (error) {
      if (requestIsActive(requestId) && sameExactSession(identity, currentIdentity())) {
        optionsRef.current.onError?.(error, "Transcript import could not be previewed.");
      }
    } finally {
      finishRequest(requestId);
    }
  }, [currentIdentity, finishRequest, publishSelection, requestIsActive, startRequest]);

  const chooseFile = useCallback(
    () => chooseSource("file"),
    [chooseSource]
  );

  const chooseFolder = useCallback(
    () => chooseSource("folder"),
    [chooseSource]
  );

  const toggleCandidate = useCallback((candidate: TranscriptImportCandidate) => {
    const visibleCandidate = visiblePreviewRef.current?.preview.candidates.find(
      (item) => item.candidate_id === candidate.candidate_id
    );
    if (
      !visibleCandidate
      || (visibleCandidate.status !== "ready" && visibleCandidate.status !== "alternate_format")
    ) return;

    const nextIds = selectedCandidateIdsRef.current.includes(visibleCandidate.candidate_id)
      ? selectedCandidateIdsRef.current.filter((candidateId) => candidateId !== visibleCandidate.candidate_id)
      : [...selectedCandidateIdsRef.current, visibleCandidate.candidate_id];
    publishSelection(nextIds);
  }, [publishSelection]);

  const confirmImport = useCallback(async () => {
    const visible = visiblePreviewRef.current;
    if (!visible) return;

    const selectedIds = new Set(selectedCandidateIdsRef.current);
    const selectedCandidates = visible.preview.candidates.filter(
      (candidate) => selectedIds.has(candidate.candidate_id)
    );
    if (!selectedCandidates.length) return;

    const confirmationIdentity = sessionIdentity(optionsRef.current.getCurrentSession());
    if (!confirmationIdentity || !sameLogicalProject(visible.session, confirmationIdentity)) return;

    const requestId = startRequest();
    let mutationIdentity: ImportSessionIdentity | null = null;
    try {
      const persisted = await optionsRef.current.persistProjectSettings();
      if (!requestIsActive(requestId) || !persisted) return;

      mutationIdentity = {
        projectId: persisted.project.project_id,
        projectFile: persisted.handle.project_file,
        revision: persisted.handle.revision
      };
      if (
        visiblePreviewRef.current !== visible
        || !sameLogicalProject(visible.session, mutationIdentity)
        || !sameExactSession(mutationIdentity, currentIdentity())
      ) return;

      const payload = await importCodesTranscriptCandidates({
        project: persisted.project,
        handle: persisted.handle,
        candidates: selectedCandidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          source_path: candidate.source_path,
          source_document_id: candidate.source_document_id,
          allow_duplicate: candidate.status === "alternate_format"
        }))
      });
      if (
        !requestIsActive(requestId)
        || visiblePreviewRef.current !== visible
        || !sameExactSession(mutationIdentity, currentIdentity())
      ) return;

      if (!optionsRef.current.applyPersistedProject({ project: payload.project, handle: payload.handle })) return;

      const summary = {
        imported: payload.imported,
        skipped: payload.skipped,
        failed: payload.failed
      };
      visiblePreviewRef.current = null;
      setPreview(null);
      publishSelection([]);
      setResult(summary);
      optionsRef.current.onImportApplied?.({
        project: payload.project,
        handle: payload.handle,
        result: summary
      });
    } catch (error) {
      const authoritativeIdentity = mutationIdentity ?? confirmationIdentity;
      if (
        requestIsActive(requestId)
        && visiblePreviewRef.current === visible
        && sameExactSession(authoritativeIdentity, currentIdentity())
      ) {
        optionsRef.current.onError?.(error, "Transcripts could not be imported.");
      }
    } finally {
      finishRequest(requestId);
    }
  }, [currentIdentity, finishRequest, publishSelection, requestIsActive, startRequest]);

  const cancelPreview = useCallback(() => {
    invalidateRequests();
    visiblePreviewRef.current = null;
    setPreview(null);
    publishSelection([]);
  }, [invalidateRequests, publishSelection]);

  const dismissResult = useCallback(() => {
    setResult(null);
  }, []);

  const reset = useCallback(() => {
    invalidateRequests();
    visiblePreviewRef.current = null;
    setPreview(null);
    publishSelection([]);
    setResult(null);
  }, [invalidateRequests, publishSelection]);

  const isLocked = useCallback(() => activeRequestIdRef.current !== null, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      nextRequestIdRef.current += 1;
      activeRequestIdRef.current = null;
      visiblePreviewRef.current = null;
    };
  }, []);

  return {
    preview,
    selectedCandidateIds,
    result,
    busy,
    isLocked,
    chooseFile,
    chooseFolder,
    toggleCandidate,
    confirmImport,
    cancelPreview,
    dismissResult,
    reset
  };
}
