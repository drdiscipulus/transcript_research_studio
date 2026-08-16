import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranscriptEditorPage } from "../../src/components/TranscriptEditorPage";
import { EditorMediaPlayer } from "../../src/components/EditorMediaPlayer";
import {
  WorkbenchLifecycleProvider,
  useWorkbenchLifecycle
} from "../../src/components/workbench/WorkbenchLifecycle";

const apiMocks = vi.hoisted(() => ({
  exportEditorTranscript: vi.fn(),
  inspectEditorTranscript: vi.fn(),
  loadEditorTranscript: vi.fn(),
  localMediaUrl: vi.fn(() => ""),
  openPath: vi.fn(),
  pickEditorExportFile: vi.fn(),
  pickFolder: vi.fn(),
  pickMediaFile: vi.fn(),
  pickSaveFile: vi.fn(),
  pickTranscriptFile: vi.fn(),
  saveEditorTranscript: vi.fn()
}));

vi.mock("../../src/lib/api", () => apiMocks);

function ActiveEditor() {
  const { navigateTo, pageStates } = useWorkbenchLifecycle();
  useEffect(() => navigateTo("editor"), [navigateTo]);
  return (
    <>
      <div data-testid="editor-lifecycle-state">{JSON.stringify(pageStates.editor)}</div>
      <TranscriptEditorPage />
    </>
  );
}

function renderEditor() {
  return render(
    <WorkbenchLifecycleProvider>
      <ActiveEditor />
    </WorkbenchLifecycleProvider>
  );
}

function EditorNavigationHarness() {
  const { navigateTo } = useWorkbenchLifecycle();
  useEffect(() => navigateTo("editor"), [navigateTo]);
  return (
    <>
      <button type="button" onClick={() => navigateTo("home")}>Hide Editor</button>
      <button type="button" onClick={() => navigateTo("editor")}>Show Editor</button>
      <TranscriptEditorPage />
    </>
  );
}

function renderEditorWithNavigation() {
  return render(
    <WorkbenchLifecycleProvider>
      <EditorNavigationHarness />
    </WorkbenchLifecycleProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadFixture(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "Browse" })[0]);
  await user.click(screen.getByRole("button", { name: "Load Transcript" }));
  await screen.findByRole("button", { name: "Save As…" });
}

describe("TranscriptEditorPage document workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\interview.json");
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.json",
      format: "json",
      documents: [{
        id: "interview",
        label: "Interview",
        file_name: "interview.json",
        segment_count: 2,
        duration: 20
      }],
      requires_document_selection: false
    });
    apiMocks.loadEditorTranscript.mockResolvedValue({
      source_transcript_file: "C:\\research\\interview.json",
      source_document_id: "interview",
      media_file: "",
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "SPEAKER_00" }],
      segments: [
        { id: "seg_000001", start: 0, end: 10, speaker: "SPEAKER_00", text: "Original first segment" },
        { id: "seg_000002", start: 10, end: 20, speaker: "SPEAKER_00", text: "Original second segment" }
      ],
      metadata: {},
      validation_issues: []
    });
    apiMocks.pickSaveFile.mockResolvedValue("C:\\research\\interview.editing.json");
    apiMocks.pickEditorExportFile.mockResolvedValue("C:\\research\\interview_edited.xlsx");
    apiMocks.saveEditorTranscript.mockResolvedValue({
      output_file: "C:\\research\\interview.editing.json",
      validation_issues: []
    });
    apiMocks.exportEditorTranscript.mockResolvedValue({
      output_files: [{ format: "xlsx", path: "C:\\research\\interview_edited.xlsx", exists: true }],
      validation_issues: []
    });
  });

  it("saves, resets to the saved baseline, supports undo, and preserves work when closing", async () => {
    const user = userEvent.setup();
    renderEditor();
    await loadFixture(user);

    expect(screen.getByText("In Memory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();

    const firstSegment = screen.getByDisplayValue("Original first segment");
    await user.clear(firstSegment);
    await user.type(firstSegment, "Saved baseline text");
    await user.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalledOnce());
    expect(apiMocks.saveEditorTranscript).toHaveBeenCalledWith(
      "C:\\research\\interview.editing.json",
      expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ text: "Saved baseline text" })])
      })
    );
    expect(screen.getByText("Saved", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const savedSegment = screen.getByDisplayValue("Saved baseline text");
    await user.clear(savedSegment);
    await user.type(savedSegment, "Mistaken replacement");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    const resetDialog = screen.getByRole("alertdialog", { name: "Reset Changes?" });
    expect(resetDialog).toHaveTextContent("Reset all editor changes and restore the last saved editing copy?");
    await user.click(screen.getByRole("button", { name: "Reset Changes" }));
    expect(screen.getByDisplayValue("Saved baseline text")).toBeInTheDocument();
    expect(screen.getByText("Saved", { selector: "strong" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByDisplayValue("Mistaken replacement")).toBeInTheDocument();
    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Editor" }));
    expect(screen.getByRole("button", { name: "Load Transcript" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load Transcript" }));
    expect(screen.getByDisplayValue("Mistaken replacement")).toBeInTheDocument();
  });

  it("uses the active path for Ctrl+S and keeps unsaved state after exporting", async () => {
    const user = userEvent.setup();
    renderEditor();
    await loadFixture(user);

    const firstSegment = screen.getByDisplayValue("Original first segment");
    await user.clear(firstSegment);
    await user.type(firstSegment, "First saved version");
    await user.click(screen.getByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalledOnce());

    apiMocks.pickSaveFile.mockClear();
    apiMocks.saveEditorTranscript.mockClear();
    const savedSegment = screen.getByDisplayValue("First saved version");
    await user.clear(savedSegment);
    await user.type(savedSegment, "Saved by shortcut");
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalledOnce());
    expect(apiMocks.pickSaveFile).not.toHaveBeenCalled();
    expect(apiMocks.saveEditorTranscript).toHaveBeenCalledWith(
      "C:\\research\\interview.editing.json",
      expect.any(Object)
    );

    const shortcutSegment = screen.getByDisplayValue("Saved by shortcut");
    await user.clear(shortcutSegment);
    await user.type(shortcutSegment, "Unsaved exported version");
    await user.click(screen.getByRole("checkbox", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: "Export Transcript" }));

    await waitFor(() => expect(apiMocks.exportEditorTranscript).toHaveBeenCalledOnce());
    expect(apiMocks.pickEditorExportFile).toHaveBeenCalledWith(
      "interview_edited.xlsx",
      "C:\\research",
      ["xlsx", "csv"]
    );
    expect(apiMocks.exportEditorTranscript).toHaveBeenCalledWith(expect.objectContaining({
      output_folder: "C:\\research",
      output_name: "interview_edited",
      export_formats: ["xlsx", "csv"]
    }));
    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();
    expect(screen.getByText("Created XLSX.").closest('[role="status"]')).toHaveTextContent("Created XLSX.");
    await user.click(screen.getByRole("button", { name: "Open Output Folder" }));
    expect(apiMocks.openPath).toHaveBeenCalledWith({
      path: "C:\\research",
      expect_directory: true,
      create_if_missing: false
    });
  });

  it("uses the latest history once per shortcut and disables shortcuts while hidden", async () => {
    const user = userEvent.setup();
    renderEditorWithNavigation();
    await loadFixture(user);

    fireEvent.change(screen.getByDisplayValue("Original first segment"), { target: { value: "First edit" } });
    fireEvent.change(screen.getByDisplayValue("First edit"), { target: { value: "Second edit" } });

    await user.click(screen.getByRole("button", { name: "Hide Editor" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByDisplayValue("Second edit")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Editor" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByDisplayValue("First edit")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Original first segment")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(screen.getByDisplayValue("Second edit")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(screen.getByDisplayValue("Second edit")).toBeInTheDocument();
  });

  it("uses the current active segment for navigation and playback shortcuts", async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    apiMocks.localMediaUrl.mockReturnValue("http://localhost/interview.mp4");
    apiMocks.loadEditorTranscript.mockResolvedValue({
      source_transcript_file: "C:\\research\\interview.json",
      source_document_id: "interview",
      media_file: "C:\\research\\interview.mp4",
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "SPEAKER_00" }],
      segments: [
        { id: "seg_000001", start: 0, end: 10, speaker: "SPEAKER_00", text: "First playable segment" },
        { id: "seg_000002", start: 10, end: 20, speaker: "SPEAKER_00", text: "Second playable segment" }
      ],
      metadata: {},
      validation_issues: []
    });
    renderEditor();
    await loadFixture(user);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByDisplayValue("Second playable segment").closest(".segment-card")).toHaveClass("active");
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Pause segment 2" })).toBeInTheDocument();

    play.mockRestore();
  });

  it("ignores stale media play completions after Stop, source replacement, and unmount", async () => {
    const firstPlay = deferred<void>();
    const replacedSourcePlay = deferred<void>();
    const unmountedPlay = deferred<void>();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockReturnValueOnce(firstPlay.promise)
      .mockReturnValueOnce(replacedSourcePlay.promise)
      .mockReturnValueOnce(unmountedPlay.promise);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const onPlaybackStateChange = vi.fn();
    const toggleRequest = {
      id: 1,
      action: "toggle" as const,
      segmentId: "seg_000001",
      start: 0,
      end: 10
    };
    const view = render(
      <EditorMediaPlayer
        mediaPath="C:\\research\\first.m4a"
        mediaUrl="http://localhost/first.m4a"
        playRequest={toggleRequest}
        onPlaybackStateChange={onPlaybackStateChange}
      />
    );
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    view.rerender(
      <EditorMediaPlayer
        mediaPath="C:\\research\\first.m4a"
        mediaUrl="http://localhost/first.m4a"
        playRequest={{ ...toggleRequest, id: 2, action: "stop" }}
        onPlaybackStateChange={onPlaybackStateChange}
      />
    );
    expect(onPlaybackStateChange).toHaveBeenCalledWith({
      requestId: 2,
      segmentId: "seg_000001",
      status: "stopped"
    });
    await act(async () => {
      firstPlay.resolve();
      await firstPlay.promise;
    });
    expect(onPlaybackStateChange).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 1,
      status: "playing"
    }));

    const replacementRequest = { ...toggleRequest, id: 3 };
    view.rerender(
      <EditorMediaPlayer
        mediaPath="C:\\research\\first.m4a"
        mediaUrl="http://localhost/first.m4a"
        playRequest={replacementRequest}
        onPlaybackStateChange={onPlaybackStateChange}
      />
    );
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    view.rerender(
      <EditorMediaPlayer
        mediaPath="C:\\research\\replacement.m4a"
        mediaUrl="http://localhost/replacement.m4a"
        playRequest={replacementRequest}
        onPlaybackStateChange={onPlaybackStateChange}
      />
    );
    await act(async () => {
      replacedSourcePlay.reject(new Error("obsolete source"));
      await replacedSourcePlay.promise.catch(() => undefined);
    });
    expect(onPlaybackStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 3 }));
    expect(play).toHaveBeenCalledTimes(2);

    view.rerender(
      <EditorMediaPlayer
        mediaPath="C:\\research\\replacement.m4a"
        mediaUrl="http://localhost/replacement.m4a"
        playRequest={{ ...toggleRequest, id: 4 }}
        onPlaybackStateChange={onPlaybackStateChange}
      />
    );
    await waitFor(() => expect(play).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(async () => {
      unmountedPlay.resolve();
      await unmountedPlay.promise;
    });
    expect(onPlaybackStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 4 }));

    play.mockRestore();
    pause.mockRestore();
  });

  it("remembers the selected export location and basename for the next Save As dialog", async () => {
    const user = userEvent.setup();
    apiMocks.pickEditorExportFile.mockResolvedValue("D:\\exports\\custom_name.xlsx");
    renderEditor();
    await loadFixture(user);

    await user.click(screen.getByRole("button", { name: "Export Transcript" }));
    await waitFor(() => expect(apiMocks.exportEditorTranscript).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Export Transcript" }));

    await waitFor(() => expect(apiMocks.pickEditorExportFile).toHaveBeenCalledTimes(2));
    expect(apiMocks.pickEditorExportFile).toHaveBeenLastCalledWith(
      "custom_name.xlsx",
      "D:\\exports",
      ["xlsx"]
    );
  });

  it("keeps the document dirty when Save As is cancelled", async () => {
    const user = userEvent.setup();
    apiMocks.pickSaveFile.mockResolvedValue(null);
    renderEditor();
    await loadFixture(user);

    const firstSegment = screen.getByDisplayValue("Original first segment");
    await user.clear(firstSegment);
    await user.type(firstSegment, "Unsaved text");
    await user.click(screen.getByRole("button", { name: "Save As…" }));

    await waitFor(() => expect(apiMocks.pickSaveFile).toHaveBeenCalledOnce());
    expect(apiMocks.saveEditorTranscript).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("treats a reopened editing-copy JSON as the active save file", async () => {
    const user = userEvent.setup();
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\interview.editing.json",
      format: "edited-json",
      documents: [{
        id: "interview",
        label: "Interview",
        file_name: "interview.editing.json",
        segment_count: 2,
        duration: 20
      }],
      requires_document_selection: false
    });
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\interview.editing.json");
    renderEditor();
    await loadFixture(user);

    expect(screen.getByText("Saved", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const firstSegment = screen.getByDisplayValue("Original first segment");
    await user.clear(firstSegment);
    await user.type(firstSegment, "Updated reopened copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalledOnce());
    expect(apiMocks.pickSaveFile).not.toHaveBeenCalled();
    expect(apiMocks.saveEditorTranscript).toHaveBeenCalledWith(
      "C:\\research\\interview.editing.json",
      expect.any(Object)
    );
  });

  it("deletes a segment as one undoable change and protects the final segment", async () => {
    const user = userEvent.setup();
    renderEditor();
    await loadFixture(user);

    const deleteButtons = screen.getAllByRole("button", { name: "Delete Segment" });
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons[0]).toHaveClass("editor-delete-segment-button");
    expect(deleteButtons[0]).toHaveAttribute("title", "Delete this segment. You can restore it with Undo.");

    await user.click(deleteButtons[0]);

    expect(screen.queryByDisplayValue("Original first segment")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Original second segment").closest(".segment-card")).toHaveClass("active");
    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Segment Deleted.");
    expect(screen.getAllByRole("button", { name: "Delete Segment" })[0]).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByDisplayValue("Original first segment")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete Segment" })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.queryByDisplayValue("Original first segment")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Segment" })).toBeDisabled();
  });

  it("returns to the preceding page when deleting its only segment", async () => {
    const user = userEvent.setup();
    apiMocks.loadEditorTranscript.mockResolvedValue({
      source_transcript_file: "C:\\research\\interview.json",
      source_document_id: "interview",
      media_file: "",
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "SPEAKER_00" }],
      segments: Array.from({ length: 6 }, (_, index) => ({
        id: `seg_${String(index + 1).padStart(6, "0")}`,
        start: index * 10,
        end: (index + 1) * 10,
        speaker: "SPEAKER_00",
        text: `Original segment ${index + 1}`
      })),
      metadata: {},
      validation_issues: []
    });
    renderEditor();
    await loadFixture(user);

    await user.selectOptions(screen.getByLabelText("Segments Per Page"), "5");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Showing 6-6 of 6")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Segment" }));

    expect(screen.getByText("Showing 1-5 of 5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Original segment 5")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Original segment 6")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("stops segment playback before deleting and activates the neighboring segment", async () => {
    const user = userEvent.setup();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    apiMocks.localMediaUrl.mockReturnValue("http://localhost/interview.mp4");
    apiMocks.loadEditorTranscript.mockResolvedValue({
      source_transcript_file: "C:\\research\\interview.json",
      source_document_id: "interview",
      media_file: "C:\\research\\interview.mp4",
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "SPEAKER_00" }],
      segments: [
        { id: "seg_000001", start: 0, end: 10, speaker: "SPEAKER_00", text: "Playing segment" },
        { id: "seg_000002", start: 10, end: 20, speaker: "SPEAKER_00", text: "Neighbor segment" }
      ],
      metadata: {},
      validation_issues: []
    });
    renderEditor();
    await loadFixture(user);

    await user.click(screen.getByRole("button", { name: "Play segment 1" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Pause segment 1" });
    await user.click(screen.getAllByRole("button", { name: "Delete Segment" })[0]);

    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(screen.getByDisplayValue("Neighbor segment").closest(".segment-card")).toHaveClass("active");

    play.mockRestore();
    pause.mockRestore();
  });

  it("requires explicit selection for a multi-document file and loads the selected document", async () => {
    const user = userEvent.setup();
    apiMocks.inspectEditorTranscript.mockResolvedValue({
      transcript_file: "C:\\research\\combined.json",
      format: "json",
      documents: [
        { id: "first", label: "First interview", file_name: "first.m4a", segment_count: 3, duration: 30 },
        { id: "second", label: "Second interview", file_name: "second.m4a", segment_count: 4, duration: 40 }
      ],
      requires_document_selection: true
    });
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\combined.json");
    apiMocks.loadEditorTranscript.mockImplementation(async (_path: string, documentId: string) => ({
      source_transcript_file: "C:\\research\\combined.json",
      source_document_id: documentId,
      media_file: "",
      language: "en",
      speakers: [],
      segments: [{ id: "seg_000001", start: 0, end: 10, speaker: "", text: `Loaded ${documentId}` }],
      metadata: {},
      validation_issues: []
    }));
    renderEditor();

    await user.click(screen.getAllByRole("button", { name: "Browse" })[0]);
    await user.click(screen.getByRole("button", { name: "Load Transcript" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose Transcript" });
    expect(dialog).toBeInTheDocument();
    expect(apiMocks.loadEditorTranscript).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /Second interview/ }));
    await user.click(within(dialog).getByRole("button", { name: "Load Transcript" }));

    await screen.findByDisplayValue("Loaded second");
    expect(apiMocks.loadEditorTranscript).toHaveBeenCalledWith("C:\\research\\combined.json", "second");
  });

  it("locks visible mutations and keyboard shortcuts while Save owns the workspace", async () => {
    const user = userEvent.setup();
    const save = deferred<{ output_file: string; validation_issues: [] }>();
    apiMocks.saveEditorTranscript.mockReturnValue(save.promise);
    renderEditor();
    await loadFixture(user);

    fireEvent.change(screen.getByDisplayValue("Original first segment"), { target: { value: "Unsaved" } });
    await user.click(screen.getByRole("button", { name: "Save As…" }));
    await waitFor(() => expect(apiMocks.saveEditorTranscript).toHaveBeenCalledOnce());

    expect(screen.getByDisplayValue("Unsaved")).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Delete Segment" })[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByDisplayValue("Unsaved")).toBeInTheDocument();

    await act(async () => {
      save.resolve({ output_file: "C:\\research\\interview.editing.json", validation_issues: [] });
      await save.promise;
    });
    await waitFor(() => expect(screen.getByDisplayValue("Unsaved")).toBeEnabled());
  });

  it("uses accessible confirmations for used-speaker deletion and unsaved source replacement", async () => {
    const user = userEvent.setup();
    renderEditor();
    await loadFixture(user);

    await user.click(screen.getByRole("button", { name: "Delete SPEAKER_00" }));
    expect(screen.getByRole("alertdialog", { name: "Delete Speaker?" })).toHaveTextContent(
      "This speaker is used by segments. Remove it and clear those segment labels?"
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Display name for SPEAKER_00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete SPEAKER_00" }));
    const speakerDialog = screen.getByRole("alertdialog", { name: "Delete Speaker?" });
    await user.click(within(speakerDialog).getByRole("button", { name: "Delete Speaker" }));
    expect(screen.queryByLabelText("Display name for SPEAKER_00")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog", { name: "Delete Speaker?" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Original first segment"), { target: { value: "Unsaved" } });
    await user.click(screen.getByRole("button", { name: "Close Editor" }));
    apiMocks.pickTranscriptFile.mockResolvedValue("C:\\research\\replacement.json");
    await user.click(screen.getAllByRole("button", { name: "Browse" })[0]);
    expect(screen.getByRole("alertdialog", { name: "Replace Transcript?" })).toHaveTextContent(
      "You have unsaved edits. Load another transcript and replace the current editor state?"
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();
  });

  it("uses one authoritative lock for Reset and used-speaker confirmations", async () => {
    const user = userEvent.setup();
    renderEditor();
    await loadFixture(user);

    fireEvent.change(screen.getByDisplayValue("Original first segment"), { target: { value: "First draft" } });
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Reset Changes?" })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByDisplayValue("First draft")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByDisplayValue("First draft")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Editor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export Transcript" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(apiMocks.saveEditorTranscript).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("First draft")).toBeInTheDocument();

    await user.click(within(screen.getByRole("alertdialog", { name: "Reset Changes?" })).getByRole("button", { name: "Reset Changes" }));
    expect(screen.getByDisplayValue("Original first segment")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeEnabled();
    expect(screen.queryByRole("alertdialog", { name: "Reset Changes?" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByDisplayValue("First draft")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete SPEAKER_00" }));
    expect(screen.getByLabelText("Display name for SPEAKER_00")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeDisabled();
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete Speaker?" })).getByRole("button", { name: "Delete Speaker" }));
    expect(screen.queryByLabelText("Display name for SPEAKER_00")).not.toBeInTheDocument();
  });

  it("reports active Editor work while a native picker is pending", async () => {
    const picker = deferred<string | null>();
    apiMocks.pickTranscriptFile.mockReturnValue(picker.promise);
    renderEditor();

    fireEvent.click(screen.getAllByRole("button", { name: "Browse" })[0]);
    await waitFor(() => expect(screen.getByTestId("editor-lifecycle-state")).toHaveTextContent(
      '"activeJob":true'
    ));
    expect(screen.getByTestId("editor-lifecycle-state")).toHaveTextContent("Choosing transcript");

    await act(async () => {
      picker.resolve(null);
      await picker.promise;
    });
    await waitFor(() => expect(screen.getByTestId("editor-lifecycle-state")).toHaveTextContent(
      '"activeJob":false'
    ));
  });
});
