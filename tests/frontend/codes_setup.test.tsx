import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodesSetupPanel } from "../../src/components/codes/CodesSetupPanel";
import { CodesTranscriptToolbar } from "../../src/components/codes/CodesTranscriptToolbar";
import type { CodesProject } from "../../src/lib/api";

function makeSetupProps(): ComponentProps<typeof CodesSetupPanel> {
  return {
    desktopAvailable: true,
    busy: false,
    statusLabel: "No Coding Project Open",
    hasError: false,
    onNewProject: vi.fn(),
    onOpenProject: vi.fn()
  };
}

describe("Codes project entry screen", () => {
  it("explains the project workflow and keeps transcript import out of the landing screen", async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    const onOpenProject = vi.fn();

    render(
      <CodesSetupPanel
        {...makeSetupProps()}
        onNewProject={onNewProject}
        onOpenProject={onOpenProject}
      />
    );

    const codesHeading = screen.getByRole("heading", { name: "Codes" });
    const header = codesHeading.closest("section");
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("No Coding Project Open")).not.toBeInTheDocument();
    expect(screen.getByText("Create a new coding project or open an existing project.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Coding Project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Transcript/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create New Project" }));
    await user.click(screen.getByRole("button", { name: "Open Existing Project" }));
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it("renders errors accessibly and disables project actions when unavailable", () => {
    render(
      <CodesSetupPanel
        {...makeSetupProps()}
        desktopAvailable={false}
        statusLabel="Coding project files are available in the desktop app."
        hasError
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Coding project files are available in the desktop app.");
    expect(screen.getByRole("button", { name: "Create New Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Existing Project" })).toBeDisabled();
    expect(screen.getByText("Coding project files can be created and opened in the desktop app.")).toBeInTheDocument();
  });

  it("shows explicit transcript import actions in the opened-project toolbar", async () => {
    const user = userEvent.setup();
    const project: CodesProject = {
      schema_version: "1.1",
      project_id: "project_test",
      name: "Study",
      created_at: "2026-07-19T00:00:00Z",
      updated_at: "2026-07-19T00:00:00Z",
      research_focus: "",
      ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
      transcripts: [],
      evidence_items: [],
      codes: [],
      themes: [],
      report_drafts: [],
      suggestion_decisions: [],
      settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" },
      id_counters: {}
    };
    render(
      <CodesTranscriptToolbar
        project={project}
        activeTranscript={null}
        activeTranscriptId=""
        importResult={null}
        importPreviewPending={false}
        busy={false}
        canEditProject
        onSelectTranscript={vi.fn()}
        onAddTranscriptFolder={vi.fn()}
        onAddTranscriptFile={vi.fn()}
        onRemoveTranscript={vi.fn()}
        onDismissImportResult={vi.fn()}
      />
    );

    await user.click(screen.getByText("Add Transcripts"));
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeEnabled();
  });
});
