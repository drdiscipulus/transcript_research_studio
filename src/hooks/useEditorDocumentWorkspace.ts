import { useCallback, useEffect, useRef, useState } from "react";

import type { EditorTranscript, EditorValidationIssue } from "../lib/api";
import type { EditorPlaybackState, EditorPlayRequest } from "../lib/editorContracts";
import {
  addSpeakerToTranscript,
  deleteSegmentAt,
  mergeAdjacentSameSpeakerSegments,
  mergeSegmentWithNext,
  removeSpeakerFromTranscript,
  renumberSegments,
  segmentHasPlayableTimestamps,
  splitSegmentAtCursor,
  updateSegmentAt,
  updateSpeakerName
} from "../lib/editorState";
import {
  DEFAULT_SEGMENTS_PER_PAGE,
  MAX_HISTORY_STATES
} from "../components/editor/editorConstants";

export type EditorDocumentSnapshot = {
  transcript: EditorTranscript | null;
  baselineTranscript: EditorTranscript | null;
  dirty: boolean;
  editRevision: number;
  documentGeneration: number;
};

type EditorDocumentWorkspaceOptions = {
  isOperationLocked: () => boolean;
  publishStatus: (message: string) => void;
};

type MutationOptions = {
  structural?: boolean;
  activeIndex?: number;
  status?: string;
};

function clampIndex(index: number, transcript: EditorTranscript | null): number {
  return transcript ? Math.min(Math.max(0, index), Math.max(0, transcript.segments.length - 1)) : 0;
}

export function useEditorDocumentWorkspace({
  isOperationLocked,
  publishStatus
}: EditorDocumentWorkspaceOptions) {
  const [transcript, setTranscript] = useState<EditorTranscript | null>(null);
  const [baselineTranscript, setBaselineTranscript] = useState<EditorTranscript | null>(null);
  const [historyPast, setHistoryPast] = useState<EditorTranscript[]>([]);
  const [historyFuture, setHistoryFuture] = useState<EditorTranscript[]>([]);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [segmentsPerPage, setSegmentsPerPageState] = useState(DEFAULT_SEGMENTS_PER_PAGE);
  const [cursorPositions, setCursorPositions] = useState<Record<string, number>>({});
  const [playRequest, setPlayRequest] = useState<EditorPlayRequest | null>(null);
  const [playbackState, setPlaybackState] = useState<EditorPlaybackState>(null);

  const transcriptRef = useRef<EditorTranscript | null>(null);
  const baselineRef = useRef<EditorTranscript | null>(null);
  const pastRef = useRef<EditorTranscript[]>([]);
  const futureRef = useRef<EditorTranscript[]>([]);
  const activeIndexRef = useRef(0);
  const currentPageRef = useRef(0);
  const pageSizeRef = useRef(DEFAULT_SEGMENTS_PER_PAGE);
  const cursorPositionsRef = useRef<Record<string, number>>({});
  const playbackStateRef = useRef<EditorPlaybackState>(null);
  const playRequestRef = useRef<EditorPlayRequest | null>(null);
  const playRequestSequenceRef = useRef(0);
  const editRevisionRef = useRef(0);
  const documentGenerationRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const syncTranscript = useCallback((next: EditorTranscript | null) => {
    transcriptRef.current = next;
    setTranscript(next);
  }, []);

  const syncBaseline = useCallback((next: EditorTranscript | null) => {
    baselineRef.current = next;
    setBaselineTranscript(next);
  }, []);

  const syncPast = useCallback((next: EditorTranscript[]) => {
    pastRef.current = next;
    setHistoryPast(next);
  }, []);

  const syncFuture = useCallback((next: EditorTranscript[]) => {
    futureRef.current = next;
    setHistoryFuture(next);
  }, []);

  const syncActiveIndex = useCallback((next: number, activeTranscript = transcriptRef.current) => {
    const clamped = clampIndex(next, activeTranscript);
    activeIndexRef.current = clamped;
    setActiveSegmentIndex(clamped);
    const page = Math.floor(clamped / pageSizeRef.current);
    currentPageRef.current = page;
    setCurrentPage(page);
  }, []);

  const syncPlayRequest = useCallback((next: EditorPlayRequest | null) => {
    playRequestRef.current = next;
    setPlayRequest(next);
  }, []);

  const invalidatePlaybackState = useCallback((playbackTranscript: EditorTranscript | null) => {
    const activePlayback = playbackStateRef.current;
    const pendingRequest = playRequestRef.current;
    const segmentId = activePlayback && activePlayback.status !== "stopped"
      ? activePlayback.segmentId
      : pendingRequest?.action === "toggle"
        ? pendingRequest.segmentId
        : "";
    const segment = playbackTranscript?.segments.find((item) => item.id === segmentId);
    if (segment && segmentHasPlayableTimestamps(segment)) {
      playRequestSequenceRef.current += 1;
      syncPlayRequest({
        id: playRequestSequenceRef.current,
        action: "stop",
        segmentId: segment.id,
        start: segment.start as number,
        end: segment.end as number
      });
    } else {
      syncPlayRequest(null);
    }
    playbackStateRef.current = null;
    setPlaybackState(null);
  }, [syncPlayRequest]);

  const invalidatePositionalState = useCallback((
    activeTranscript: EditorTranscript | null,
    playbackTranscript = transcriptRef.current
  ) => {
    cursorPositionsRef.current = {};
    setCursorPositions({});
    invalidatePlaybackState(playbackTranscript);
    syncActiveIndex(activeIndexRef.current, activeTranscript);
  }, [invalidatePlaybackState, syncActiveIndex]);

  const commitMutation = useCallback((
    transform: (current: EditorTranscript) => EditorTranscript,
    options: MutationOptions = {}
  ): boolean => {
    if (!mountedRef.current || isOperationLocked()) {
      return false;
    }
    const current = transcriptRef.current;
    if (!current) {
      return false;
    }
    const next = transform(current);
    if (next === current) {
      return false;
    }
    const nextPast = [...pastRef.current.slice(-(MAX_HISTORY_STATES - 1)), current];
    syncPast(nextPast);
    syncFuture([]);
    syncTranscript(next);
    editRevisionRef.current += 1;
    if (options.structural) {
      if (typeof options.activeIndex === "number") {
        activeIndexRef.current = clampIndex(options.activeIndex, next);
      }
      invalidatePositionalState(next, current);
    } else if (typeof options.activeIndex === "number") {
      syncActiveIndex(options.activeIndex, next);
    }
    if (options.status) {
      publishStatus(options.status);
    }
    return true;
  }, [invalidatePositionalState, isOperationLocked, publishStatus, syncActiveIndex, syncFuture, syncPast, syncTranscript]);

  const applyLoadedDocument = useCallback((loaded: EditorTranscript, proposedMediaFile = "") => {
    const next = renumberSegments({
      ...loaded,
      media_file: loaded.media_file || proposedMediaFile
    });
    if (!mountedRef.current) {
      return next;
    }
    invalidatePositionalState(next, transcriptRef.current);
    documentGenerationRef.current += 1;
    editRevisionRef.current += 1;
    syncTranscript(next);
    syncBaseline(next);
    syncPast([]);
    syncFuture([]);
    activeIndexRef.current = 0;
    currentPageRef.current = 0;
    setActiveSegmentIndex(0);
    setCurrentPage(0);
    return next;
  }, [invalidatePositionalState, syncBaseline, syncFuture, syncPast, syncTranscript]);

  const clearDocument = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }
    invalidatePositionalState(null, transcriptRef.current);
    documentGenerationRef.current += 1;
    editRevisionRef.current += 1;
    syncTranscript(null);
    syncBaseline(null);
    syncPast([]);
    syncFuture([]);
    activeIndexRef.current = 0;
    currentPageRef.current = 0;
    setActiveSegmentIndex(0);
    setCurrentPage(0);
  }, [invalidatePositionalState, syncBaseline, syncFuture, syncPast, syncTranscript]);

  const getSnapshot = useCallback((): EditorDocumentSnapshot => ({
    transcript: transcriptRef.current,
    baselineTranscript: baselineRef.current,
    dirty: Boolean(transcriptRef.current && transcriptRef.current !== baselineRef.current),
    editRevision: editRevisionRef.current,
    documentGeneration: documentGenerationRef.current
  }), []);

  const snapshotIsCurrent = useCallback((snapshot: EditorDocumentSnapshot) => (
    snapshot.documentGeneration === documentGenerationRef.current
    && snapshot.editRevision === editRevisionRef.current
    && snapshot.transcript === transcriptRef.current
  ), []);

  const applySuccessfulSave = useCallback((
    snapshot: EditorDocumentSnapshot,
    validationIssues: EditorValidationIssue[]
  ): boolean => {
    if (!mountedRef.current || !snapshot.transcript || !snapshotIsCurrent(snapshot)) {
      return false;
    }
    const saved = { ...snapshot.transcript, validation_issues: validationIssues };
    editRevisionRef.current += 1;
    syncTranscript(saved);
    syncBaseline(saved);
    return true;
  }, [snapshotIsCurrent, syncBaseline, syncTranscript]);

  const applyExportValidation = useCallback((
    snapshot: EditorDocumentSnapshot,
    validationIssues: EditorValidationIssue[]
  ): boolean => {
    if (!mountedRef.current || !snapshot.transcript || !snapshotIsCurrent(snapshot)) {
      return false;
    }
    const next = { ...snapshot.transcript, validation_issues: validationIssues };
    const wasClean = snapshot.transcript === baselineRef.current;
    editRevisionRef.current += 1;
    syncTranscript(next);
    if (wasClean) {
      syncBaseline(next);
    }
    return true;
  }, [snapshotIsCurrent, syncBaseline, syncTranscript]);

  const applyMediaFromLifecycle = useCallback((
    snapshot: EditorDocumentSnapshot,
    mediaFile: string
  ): boolean => {
    if (!mountedRef.current || !snapshot.transcript || !snapshotIsCurrent(snapshot)) {
      return false;
    }
    const current = snapshot.transcript;
    if (current.media_file === mediaFile) {
      return true;
    }
    invalidatePlaybackState(current);
    const next = { ...current, media_file: mediaFile };
    syncPast([...pastRef.current.slice(-(MAX_HISTORY_STATES - 1)), current]);
    syncFuture([]);
    syncTranscript(next);
    editRevisionRef.current += 1;
    return true;
  }, [invalidatePlaybackState, snapshotIsCurrent, syncFuture, syncPast, syncTranscript]);

  const undo = useCallback((): boolean => {
    if (!mountedRef.current || isOperationLocked()) {
      return false;
    }
    const current = transcriptRef.current;
    const previous = pastRef.current[pastRef.current.length - 1];
    if (!current || !previous) {
      return false;
    }
    syncPast(pastRef.current.slice(0, -1));
    syncFuture([current, ...futureRef.current].slice(0, MAX_HISTORY_STATES));
    syncTranscript(previous);
    editRevisionRef.current += 1;
    invalidatePositionalState(previous, current);
    return true;
  }, [invalidatePositionalState, isOperationLocked, syncFuture, syncPast, syncTranscript]);

  const redo = useCallback((): boolean => {
    if (!mountedRef.current || isOperationLocked()) {
      return false;
    }
    const current = transcriptRef.current;
    const next = futureRef.current[0];
    if (!current || !next) {
      return false;
    }
    syncFuture(futureRef.current.slice(1));
    syncPast([...pastRef.current.slice(-(MAX_HISTORY_STATES - 1)), current]);
    syncTranscript(next);
    editRevisionRef.current += 1;
    invalidatePositionalState(next, current);
    return true;
  }, [invalidatePositionalState, isOperationLocked, syncFuture, syncPast, syncTranscript]);

  const resetToBaseline = useCallback((hasSavePath: boolean): boolean => {
    if (!mountedRef.current || isOperationLocked()) {
      return false;
    }
    const current = transcriptRef.current;
    const baseline = baselineRef.current;
    if (!current || !baseline || current === baseline) {
      return false;
    }
    syncPast([...pastRef.current.slice(-(MAX_HISTORY_STATES - 1)), current]);
    syncFuture([]);
    syncTranscript(baseline);
    editRevisionRef.current += 1;
    invalidatePositionalState(baseline, current);
    publishStatus(hasSavePath
      ? "Reset changes to the last saved editing copy."
      : "Reset changes to the originally loaded transcript.");
    return true;
  }, [invalidatePositionalState, isOperationLocked, publishStatus, syncFuture, syncPast, syncTranscript]);

  const updateSegment = useCallback((index: number, patch: Partial<EditorTranscript["segments"][number]>) => (
    commitMutation((current) => updateSegmentAt(current, index, patch))
  ), [commitMutation]);

  const updateSpeaker = useCallback((speakerId: string, name: string) => (
    commitMutation((current) => updateSpeakerName(current, speakerId, name))
  ), [commitMutation]);

  const addSpeaker = useCallback(() => commitMutation(addSpeakerToTranscript), [commitMutation]);

  const removeSpeaker = useCallback((speakerId: string) => (
    commitMutation((current) => removeSpeakerFromTranscript(current, speakerId))
  ), [commitMutation]);

  const speakerIsUsed = useCallback((speakerId: string) => (
    transcriptRef.current?.segments.some((segment) => segment.speaker === speakerId) ?? false
  ), []);

  const mergeWithNext = useCallback((index: number) => commitMutation(
    (current) => mergeSegmentWithNext(current, index),
    { structural: true, activeIndex: index }
  ), [commitMutation]);

  const deleteSegment = useCallback((index: number): boolean => {
    const current = transcriptRef.current;
    if (!current || current.segments.length <= 1 || index < 0 || index >= current.segments.length) {
      return false;
    }
    return commitMutation(
      (active) => deleteSegmentAt(active, index),
      { structural: true, activeIndex: Math.min(index, current.segments.length - 2), status: "Segment Deleted." }
    );
  }, [commitMutation]);

  const mergeAdjacent = useCallback((): boolean => {
    const current = transcriptRef.current;
    if (!mountedRef.current || !current || current.segments.length < 2 || isOperationLocked()) {
      return false;
    }
    const result = mergeAdjacentSameSpeakerSegments(current);
    if (result.mergeCount === 0) {
      publishStatus("No adjacent same-speaker segments to merge.");
      return false;
    }
    return commitMutation(() => result.transcript, {
      structural: true,
      activeIndex: Math.min(activeIndexRef.current, result.transcript.segments.length - 1),
      status: `Merged ${result.mergeCount} adjacent segment(s).`
    });
  }, [commitMutation, isOperationLocked, publishStatus]);

  const splitSegment = useCallback((index: number): boolean => {
    const current = transcriptRef.current;
    if (!mountedRef.current || !current || isOperationLocked()) {
      return false;
    }
    const segment = current.segments[index];
    if (!segment) {
      return false;
    }
    const result = splitSegmentAtCursor(current, index, cursorPositionsRef.current[segment.id] ?? -1);
    if ("error" in result) {
      publishStatus(result.error);
      return false;
    }
    return commitMutation(() => result.transcript, {
      structural: true,
      activeIndex: index + 1,
      status: "Segment split at cursor position."
    });
  }, [commitMutation, isOperationLocked, publishStatus]);

  const activateSegment = useCallback((index: number) => {
    if (!mountedRef.current) {
      return;
    }
    syncActiveIndex(index);
  }, [syncActiveIndex]);

  const rememberCursorPosition = useCallback((segmentId: string, selectionStart: number | null) => {
    if (!mountedRef.current || isOperationLocked()) {
      return;
    }
    const next = { ...cursorPositionsRef.current, [segmentId]: selectionStart ?? -1 };
    cursorPositionsRef.current = next;
    setCursorPositions(next);
  }, [isOperationLocked]);

  const setSegmentsPerPage = useCallback((pageSize: number) => {
    if (!mountedRef.current) {
      return;
    }
    pageSizeRef.current = pageSize;
    setSegmentsPerPageState(pageSize);
    const page = Math.floor(activeIndexRef.current / pageSize);
    currentPageRef.current = page;
    setCurrentPage(page);
  }, []);

  const setPage = useCallback((page: number) => {
    if (!mountedRef.current) {
      return;
    }
    const total = Math.max(1, Math.ceil((transcriptRef.current?.segments.length ?? 0) / pageSizeRef.current));
    const next = Math.min(Math.max(0, page), total - 1);
    currentPageRef.current = next;
    setCurrentPage(next);
  }, []);

  const activatePage = useCallback((page: number) => {
    if (!mountedRef.current) {
      return;
    }
    setPage(page);
    syncActiveIndex(page * pageSizeRef.current);
  }, [setPage, syncActiveIndex]);

  const toggleSegmentPlayback = useCallback((index: number): boolean => {
    if (!mountedRef.current) {
      return false;
    }
    const current = transcriptRef.current;
    const segment = current?.segments[index];
    if (!segment || !segmentHasPlayableTimestamps(segment)) {
      publishStatus("Segment playback requires both start and end timestamps.");
      return false;
    }
    syncActiveIndex(index, current);
    playRequestSequenceRef.current += 1;
    syncPlayRequest({
      id: playRequestSequenceRef.current,
      action: "toggle",
      segmentId: segment.id,
      start: segment.start as number,
      end: segment.end as number
    });
    return true;
  }, [publishStatus, syncActiveIndex, syncPlayRequest]);

  const stopSegmentPlayback = useCallback((index: number): boolean => {
    if (!mountedRef.current) {
      return false;
    }
    const segment = transcriptRef.current?.segments[index];
    if (!segment || !segmentHasPlayableTimestamps(segment)) {
      return false;
    }
    playRequestSequenceRef.current += 1;
    syncPlayRequest({
      id: playRequestSequenceRef.current,
      action: "stop",
      segmentId: segment.id,
      start: segment.start as number,
      end: segment.end as number
    });
    return true;
  }, [syncPlayRequest]);

  const handlePlaybackStateChange = useCallback((next: EditorPlaybackState) => {
    if (!mountedRef.current || !next) {
      return;
    }
    const request = playRequestRef.current;
    if (!request || next.requestId !== request.id || next.segmentId !== request.segmentId) {
      return;
    }
    playbackStateRef.current = next;
    setPlaybackState(next);
  }, []);

  const totalSegments = transcript?.segments.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalSegments / segmentsPerPage));
  const clampedPage = Math.min(currentPage, totalPages - 1);
  if (clampedPage !== currentPageRef.current) {
    currentPageRef.current = clampedPage;
  }
  const pageStart = clampedPage * segmentsPerPage;
  const pageEnd = Math.min(pageStart + segmentsPerPage, totalSegments);
  const visibleSegments = transcript?.segments.slice(pageStart, pageEnd) ?? [];

  return {
    transcript,
    baselineTranscript,
    dirty: Boolean(transcript && transcript !== baselineTranscript),
    historyPast,
    historyFuture,
    activeSegmentIndex,
    currentPage: clampedPage,
    segmentsPerPage,
    cursorPositions,
    playRequest,
    playbackState,
    totalSegments,
    totalPages,
    pageStart,
    pageEnd,
    visibleSegments,
    getSnapshot,
    snapshotIsCurrent,
    applyLoadedDocument,
    applySuccessfulSave,
    applyExportValidation,
    applyMediaFromLifecycle,
    clearDocument,
    activateSegment,
    activatePage,
    setPage,
    setSegmentsPerPage,
    rememberCursorPosition,
    updateSegment,
    updateSpeaker,
    addSpeaker,
    removeSpeaker,
    speakerIsUsed,
    splitSegment,
    mergeWithNext,
    mergeAdjacent,
    deleteSegment,
    undo,
    redo,
    resetToBaseline,
    toggleSegmentPlayback,
    stopSegmentPlayback,
    handlePlaybackStateChange
  };
}
