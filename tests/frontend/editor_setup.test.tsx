import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditorSetupPanel } from "../../src/components/editor/EditorSetupPanel";

function makeEditorSetupProps(): ComponentProps<typeof EditorSetupPanel> {
  return {
    transcriptFile: "C:\\research\\interview.xlsx",
    activeMediaFile: "",
    transcript: null,
    dirty: false,
    savePath: "",
    busy: false,
    errorMessage: null,
    statusLabel: "Transcript selected.",
    canInspectOrEdit: true,
    onPickTranscript: vi.fn(),
    onResetTranscript: vi.fn(),
    onOpenTranscript: vi.fn(),
    onPickMedia: vi.fn(),
    onResetMedia: vi.fn(),
    onOpenMedia: vi.fn(),
    onOpenEditor: vi.fn()
  };
}

describe("Editor setup", () => {
  it("uses compact path actions, plain format checkboxes, and an inline status", async () => {
    const user = userEvent.setup();
    const onOpenTranscript = vi.fn();

    render(<EditorSetupPanel {...makeEditorSetupProps()} onOpenTranscript={onOpenTranscript} />);

    expect(screen.getByLabelText("Transcript or Editing Copy")).toHaveValue("C:\\research\\interview.xlsx");
    expect(screen.getByLabelText("Media File (Optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load Transcript" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Open Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Transcript selected.");

    await user.click(screen.getAllByRole("button", { name: "Open" })[0]);
    expect(onOpenTranscript).toHaveBeenCalledOnce();

    expect(screen.queryByRole("heading", { name: /Output/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Output Folder")).not.toBeInTheDocument();
  });

  it("keeps export controls out of setup after a transcript is loaded", () => {
    render(
      <EditorSetupPanel
        {...makeEditorSetupProps()}
        transcript={{
          source_transcript_file: "C:\\research\\interview.xlsx",
          source_document_id: "interview",
          media_file: "",
          language: "en",
          speakers: [],
          segments: [],
          metadata: {}
        }}
      />
    );

    expect(screen.queryByText("Output Folder")).not.toBeInTheDocument();
    expect(screen.queryByText(/Output Filename/)).not.toBeInTheDocument();
    expect(screen.queryByText("Export Formats")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export Transcript" })).not.toBeInTheDocument();
  });
});
