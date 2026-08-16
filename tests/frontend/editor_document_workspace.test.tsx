import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useEditorDocumentWorkspace } from "../../src/hooks/useEditorDocumentWorkspace";
import type { EditorTranscript } from "../../src/lib/api";
import { MAX_HISTORY_STATES } from "../../src/components/editor/editorConstants";

function makeTranscript(segmentCount = 2): EditorTranscript {
  return {
    source_transcript_file: "C:\\research\\interview.json",
    source_document_id: "interview",
    media_file: "C:\\research\\interview.mp4",
    language: "en",
    speakers: [{ id: "SPEAKER_00", name: "Speaker" }],
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      id: `seg_${String(index + 1).padStart(6, "0")}`,
      start: index * 10,
      end: (index + 1) * 10,
      speaker: "SPEAKER_00",
      text: `Segment ${index + 1}`
    })),
    metadata: {},
    validation_issues: []
  };
}

function setup(locked = false) {
  const lock = { current: locked };
  const publishStatus = vi.fn();
  const hook = renderHook(() => useEditorDocumentWorkspace({
    isOperationLocked: () => lock.current,
    publishStatus
  }));
  act(() => hook.result.current.applyLoadedDocument(makeTranscript()));
  return { ...hook, lock, publishStatus };
}

describe("useEditorDocumentWorkspace", () => {
  it("composes same-render mutations from the authoritative document and records each history state", () => {
    const { result } = setup();

    act(() => {
      expect(result.current.updateSegment(0, { text: "First edit" })).toBe(true);
      expect(result.current.updateSegment(1, { speaker: "" })).toBe(true);
      expect(result.current.updateSpeaker("SPEAKER_00", "Interviewer")).toBe(true);
    });

    expect(result.current.transcript?.segments[0].text).toBe("First edit");
    expect(result.current.transcript?.segments[1].speaker).toBe("");
    expect(result.current.transcript?.speakers[0].name).toBe("Interviewer");
    expect(result.current.historyPast).toHaveLength(3);
    expect(result.current.dirty).toBe(true);
  });

  it("uses ref-backed Undo and Redo exactly once and clears Redo after a new edit", () => {
    const { result } = setup();
    act(() => {
      result.current.updateSegment(0, { text: "One" });
      result.current.updateSegment(0, { text: "Two" });
      expect(result.current.undo()).toBe(true);
      expect(result.current.undo()).toBe(true);
    });
    expect(result.current.transcript?.segments[0].text).toBe("Segment 1");

    act(() => expect(result.current.redo()).toBe(true));
    expect(result.current.transcript?.segments[0].text).toBe("One");
    act(() => result.current.updateSegment(0, { text: "Replacement" }));
    expect(result.current.historyFuture).toHaveLength(0);
    expect(result.current.redo()).toBe(false);
  });

  it("bounds history and makes a successful Save snapshot the new baseline without erasing Undo", () => {
    const { result } = setup();
    act(() => {
      for (let index = 0; index < MAX_HISTORY_STATES + 8; index += 1) {
        result.current.updateSegment(0, { text: `Edit ${index}` });
      }
    });
    expect(result.current.historyPast).toHaveLength(MAX_HISTORY_STATES);

    const snapshot = result.current.getSnapshot();
    act(() => expect(result.current.applySuccessfulSave(snapshot, [])).toBe(true));
    expect(result.current.dirty).toBe(false);
    expect(result.current.historyPast).toHaveLength(MAX_HISTORY_STATES);
    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.dirty).toBe(true);
  });

  it("supports Reset followed by Undo and returns to the exact baseline", () => {
    const { result } = setup();
    act(() => result.current.updateSegment(0, { text: "Discarded draft" }));
    act(() => expect(result.current.resetToBaseline(false)).toBe(true));
    expect(result.current.transcript).toBe(result.current.baselineTranscript);
    expect(result.current.dirty).toBe(false);
    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.transcript?.segments[0].text).toBe("Discarded draft");
    expect(result.current.dirty).toBe(true);
  });

  it("rejects programmatic mutations while a file operation owns the workspace", () => {
    const { result, lock } = setup();
    lock.current = true;
    act(() => {
      expect(result.current.updateSegment(0, { text: "Blocked" })).toBe(false);
      expect(result.current.addSpeaker()).toBe(false);
      expect(result.current.undo()).toBe(false);
      expect(result.current.deleteSegment(0)).toBe(false);
    });
    expect(result.current.transcript?.segments[0].text).toBe("Segment 1");
    expect(result.current.historyPast).toHaveLength(0);
  });

  it("invalidates cursor and playback state for structural edits and uses monotonic playback IDs", () => {
    const { result } = setup();
    act(() => {
      result.current.rememberCursorPosition("seg_000001", 4);
      expect(result.current.toggleSegmentPlayback(0)).toBe(true);
      result.current.handlePlaybackStateChange({
        requestId: result.current.playRequest?.id ?? -1,
        segmentId: "seg_000001",
        status: "playing"
      });
    });
    const firstRequest = result.current.playRequest?.id ?? 0;
    act(() => expect(result.current.deleteSegment(0)).toBe(true));
    expect(result.current.cursorPositions).toEqual({});
    expect(result.current.playbackState).toBeNull();
    expect(result.current.playRequest?.action).toBe("stop");
    expect(result.current.playRequest?.start).toBe(0);
    expect(result.current.playRequest?.id).toBeGreaterThan(firstRequest);
    expect(result.current.activeSegmentIndex).toBe(0);
    expect(result.current.transcript?.segments[0].id).toBe("seg_000001");
  });

  it("rejects stale playback callbacks even when consecutive requests target the same segment", () => {
    const { result } = setup();
    act(() => expect(result.current.toggleSegmentPlayback(0)).toBe(true));
    const firstRequestId = result.current.playRequest?.id ?? -1;
    act(() => expect(result.current.toggleSegmentPlayback(0)).toBe(true));
    const secondRequestId = result.current.playRequest?.id ?? -1;
    act(() => {
      result.current.handlePlaybackStateChange({
        requestId: firstRequestId,
        segmentId: "seg_000001",
        status: "playing"
      });
    });

    expect(secondRequestId).toBeGreaterThan(firstRequestId);
    expect(result.current.playbackState).toBeNull();

    act(() => result.current.handlePlaybackStateChange({
      requestId: secondRequestId,
      segmentId: "seg_000001",
      status: "paused"
    }));
    expect(result.current.playbackState).toEqual({
      requestId: secondRequestId,
      segmentId: "seg_000001",
      status: "paused"
    });
  });

  it("stops pending playback from the pre-change transcript when media is replaced or cleared", () => {
    const { result } = setup();
    act(() => expect(result.current.toggleSegmentPlayback(0)).toBe(true));
    const obsoleteRequestId = result.current.playRequest?.id ?? -1;
    act(() => {
      result.current.handlePlaybackStateChange({
        requestId: obsoleteRequestId,
        segmentId: "seg_000001",
        status: "playing"
      });
    });

    const beforeReplacement = result.current.getSnapshot();
    act(() => expect(result.current.applyMediaFromLifecycle(
      beforeReplacement,
      "C:\\research\\replacement.mp4"
    )).toBe(true));
    expect(result.current.transcript?.media_file).toBe("C:\\research\\replacement.mp4");
    expect(result.current.playbackState).toBeNull();
    expect(result.current.playRequest).toMatchObject({
      action: "stop",
      segmentId: "seg_000001",
      start: 0,
      end: 10
    });
    expect(result.current.playRequest?.id).toBeGreaterThan(obsoleteRequestId);

    act(() => result.current.handlePlaybackStateChange({
      requestId: obsoleteRequestId,
      segmentId: "seg_000001",
      status: "playing"
    }));
    expect(result.current.playbackState).toBeNull();

    const beforeClear = result.current.getSnapshot();
    act(() => expect(result.current.applyMediaFromLifecycle(beforeClear, "")).toBe(true));
    expect(result.current.transcript?.media_file).toBe("");
    expect(result.current.playRequest).toBeNull();
    expect(result.current.historyPast).toHaveLength(2);

    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.transcript?.media_file).toBe("C:\\research\\replacement.mp4");
  });

  it("invalidates positional state for split, merge, Undo, Redo, Reset, and replacement", () => {
    const { result } = setup();
    act(() => {
      result.current.rememberCursorPosition("seg_000001", 4);
      expect(result.current.splitSegment(0)).toBe(true);
    });
    expect(result.current.cursorPositions).toEqual({});
    expect(result.current.activeSegmentIndex).toBe(1);
    act(() => {
      result.current.rememberCursorPosition("seg_000002", 1);
      expect(result.current.mergeWithNext(0)).toBe(true);
    });
    expect(result.current.cursorPositions).toEqual({});
    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.cursorPositions).toEqual({});
    act(() => expect(result.current.redo()).toBe(true));
    expect(result.current.cursorPositions).toEqual({});
    act(() => {
      result.current.rememberCursorPosition("seg_000001", 2);
      expect(result.current.resetToBaseline(false)).toBe(true);
    });
    expect(result.current.cursorPositions).toEqual({});
    act(() => result.current.applyLoadedDocument(makeTranscript(1)));
    expect(result.current.cursorPositions).toEqual({});
    expect(result.current.activeSegmentIndex).toBe(0);
  });

  it("protects the final segment and clamps page and active segment after deletion", () => {
    const { result } = setup();
    act(() => {
      result.current.setSegmentsPerPage(1);
      result.current.activateSegment(1);
      expect(result.current.deleteSegment(1)).toBe(true);
    });
    expect(result.current.activeSegmentIndex).toBe(0);
    expect(result.current.currentPage).toBe(0);
    act(() => expect(result.current.deleteSegment(0)).toBe(false));
    expect(result.current.transcript?.segments).toHaveLength(1);
  });

  it("rejects retained mutation and playback callbacks after unmount", () => {
    const { result, unmount } = setup();
    const updateSegment = result.current.updateSegment;
    const undo = result.current.undo;
    const togglePlayback = result.current.toggleSegmentPlayback;
    unmount();

    expect(updateSegment(0, { text: "Too late" })).toBe(false);
    expect(undo()).toBe(false);
    expect(togglePlayback(0)).toBe(false);
  });
});
