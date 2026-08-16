import type { ComponentProps, MutableRefObject } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodesDraftDialog } from "../../src/components/codes/CodesDraftDialog";
import { CodesCodebookPanel } from "../../src/components/codes/CodesCodebookPanel";
import { CodesDeleteEntityDialog } from "../../src/components/codes/CodesDeleteEntityDialog";
import { CodesMergeCodeDialog } from "../../src/components/codes/CodesMergeCodeDialog";
import { defaultCodesHighlightSettings } from "../../src/components/codes/CodesHighlightControls";
import { CodesImportPanel } from "../../src/components/codes/CodesImportPanel";
import { CodesTranscriptReader } from "../../src/components/codes/CodesTranscriptReader";
import { CodesWorkspaceHeader } from "../../src/components/codes/CodesWorkspaceHeader";
import { CodesWorkspaceTabs } from "../../src/components/codes/CodesWorkspaceTabs";
import {
  areOrderedIdArraysEqual,
  codeFormFromCode,
  codeFormHasChanges,
  emptyCodeForm,
  emptyThemeForm,
  replaceEvidenceDraftSelection,
  themeFormFromTheme,
  themeFormHasChanges
} from "../../src/components/codes/codesPageUtils";
import type { CodesCode, CodesProject, CodesTheme, CodesTranscript, TranscriptImportPreview } from "../../src/lib/api";

function makeHeaderProps(): ComponentProps<typeof CodesWorkspaceHeader> {
  return {
    projectName: "Founder Interviews",
    researchFocus: "How founders describe uncertainty",
    projectFileLabel: "founders.evidence.json",
    saveState: "saved",
    statusLabel: "",
    hasError: false,
    busy: false,
    canUseProjectFiles: true,
    canSaveProject: false,
    counts: { transcripts: 2, evidence: 7, codes: 3, themes: 1 },
    onProjectNameChange: vi.fn(),
    onResearchFocusChange: vi.fn(),
    onSaveSettings: vi.fn(),
    onRetrySettings: vi.fn(),
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onSaveProject: vi.fn(),
    onSaveProjectAs: vi.fn(),
    onCloseProject: vi.fn()
  };
}

describe("Codes workspace stabilization", () => {
  it("preserves ordered code and theme form transformations and dirty checks", () => {
    const code: CodesCode = {
      code_id: "C000001",
      name: "Experimentation",
      description: "Testing assumptions",
      inclusion_note: "Include tests",
      exclusion_note: "Exclude plans",
      example_evidence_ids: ["E000001", "E000002"],
      color: "#0f766e",
      memo: "Analytical note",
      created_at: "",
      updated_at: ""
    };
    const theme: CodesTheme = {
      theme_id: "TH000001",
      name: "Learning",
      description: "Learning processes",
      color: "#164e63",
      code_ids: ["C000001", "C000002"],
      memo: "Theme note",
      created_at: "",
      updated_at: ""
    };

    const codeForm = codeFormFromCode(code);
    const themeForm = themeFormFromTheme(theme);
    expect(codeForm).toEqual(expect.objectContaining({
      codeId: code.code_id,
      inclusionNote: code.inclusion_note,
      exclusionNote: code.exclusion_note,
      exampleEvidenceIds: code.example_evidence_ids,
      aiDecisions: []
    }));
    expect(themeForm).toEqual(expect.objectContaining({
      themeId: theme.theme_id,
      codeIds: theme.code_ids,
      aiDecisions: []
    }));
    expect(codeFormHasChanges(codeForm, code)).toBe(false);
    expect(themeFormHasChanges(themeForm, theme)).toBe(false);
    expect(areOrderedIdArraysEqual(["one", "two"], ["two", "one"])).toBe(false);
    expect(codeFormHasChanges({ ...codeForm, exampleEvidenceIds: [...codeForm.exampleEvidenceIds].reverse() }, code)).toBe(true);
    expect(themeFormHasChanges({ ...themeForm, codeIds: [...themeForm.codeIds].reverse() }, theme)).toBe(true);
    expect(codeFormHasChanges({
      ...codeForm,
      aiDecisions: [{ run_id: "run_1", suggestion_id: "suggestion_1", task: "code_refinement", decision: "accepted" }]
    }, code)).toBe(true);
  });

  it("uses an accessible impact dialog for destructive code deletion", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CodesDeleteEntityDialog open entityType="code" entityName="Experimentation" primaryImpact="4 evidence assignments will be removed." secondaryImpact="2 theme memberships will be removed." onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByRole("alertdialog", { name: "Delete Code" })).toHaveTextContent("4 evidence assignments");
    await user.click(screen.getByRole("button", { name: "Delete Code" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("reviews descriptive content before merging codes", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const source = { code_id: "C000001", name: "Source", description: "Source definition", inclusion_note: "Source inclusion", exclusion_note: "", example_evidence_ids: ["E000001"], color: "#0f766e", memo: "Source note", created_at: "", updated_at: "" };
    const target = { code_id: "C000002", name: "Target", description: "Target definition", inclusion_note: "", exclusion_note: "Target exclusion", example_evidence_ids: [], color: "#164e63", memo: "Target note", created_at: "", updated_at: "" };

    render(<CodesMergeCodeDialog open source={source} codes={[source, target]} evidenceAssignments={3} themesAffected={1} onSubmit={onSubmit} onClose={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Target Code"), "C000002");
    expect(screen.getByText("3 Evidence Assignments")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge Codes" }));

    expect(onSubmit).toHaveBeenCalledWith("C000002", expect.objectContaining({
      description: "Target definition\n\nSource definition",
      inclusion_note: "Source inclusion",
      exclusion_note: "Target exclusion",
      memo: "Target note\n\nSource note"
    }));
  });

  it("unifies codes and themes in one searchable catalog without row-level destructive actions", async () => {
    const user = userEvent.setup();
    const project = {
      schema_version: "1.1", project_id: "project_codebook", name: "Study",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", research_focus: "",
      ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
      transcripts: [],
      evidence_items: [{ evidence_id: "E000001", transcript_id: "T000001", source_file: "", source_document_id: "", segment_ids: ["seg_1"], segment_ranges: {}, speaker: "", start: null, end: null, selected_text: "A coded passage", code_ids: ["C000001"], memo: "", created_at: "", updated_at: "" }],
      codes: [{ code_id: "C000001", name: "Experimentation", description: "Testing assumptions", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#0f766e", memo: "", created_at: "", updated_at: "" }],
      themes: [{ theme_id: "TH000001", name: "Learning", description: "Learning processes", color: "#164e63", code_ids: ["C000001"], memo: "", created_at: "", updated_at: "" }],
      report_drafts: [], suggestion_decisions: [], settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" }, id_counters: {}
    } as CodesProject;
    const onViewChange = vi.fn();
    const onOpenEvidence = vi.fn();
    const props: ComponentProps<typeof CodesCodebookPanel> = {
      project, activeView: "codes", codeForm: { ...emptyCodeForm, codeId: "C000001", name: "Experimentation", description: "Testing assumptions" }, themeForm: emptyThemeForm,
      busy: false, canEditProject: true, codeFormDirty: false, themeFormDirty: false,
      onViewChange, onCodeFormChange: vi.fn(), onThemeFormChange: vi.fn(), onToggleThemeCode: vi.fn(), onSaveCode: vi.fn(), onSaveTheme: vi.fn(), onCancelCode: vi.fn(), onCancelTheme: vi.fn(), onEditCode: vi.fn(), onEditTheme: vi.fn(), onNewCode: vi.fn(), onNewTheme: vi.fn(), onDeleteCode: vi.fn(), onDeleteTheme: vi.fn(), onOpenMergeCode: vi.fn(), onOpenEvidence
    };
    render(<CodesCodebookPanel {...props} />);

    expect(screen.getByRole("tab", { name: "Codes (1)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("1 Evidence Item · 1 Theme").length).toBeGreaterThan(0);
    expect(screen.getByText("Coded Evidence (1)")).toBeInTheDocument();
    expect(screen.getByText("Example Evidence (0)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /A coded passage/ }));
    expect(onOpenEvidence).toHaveBeenCalledWith(project.evidence_items[0]);
    expect(screen.queryByRole("button", { name: "Delete Code" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Themes (1)" }));
    expect(onViewChange).toHaveBeenCalledWith("themes");
  });

  it("renders one truthful project shell with conventional Save and Save As actions", async () => {
    const user = userEvent.setup();
    const props = { ...makeHeaderProps(), saveState: "draft" as const, canSaveProject: true };
    render(<CodesWorkspaceHeader {...props} statusLabel="Opened founders.evidence.json." />);

    expect(screen.getByRole("heading", { name: "Codes" })).toBeInTheDocument();
    expect(screen.getByText("Founder Interviews")).toBeInTheDocument();
    expect(screen.getByText("founders.evidence.json")).toBeInTheDocument();
    expect(screen.getByText("Unsaved Draft")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSaveProject).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeEnabled();
    expect(screen.getByText((_, element) => element?.textContent === "7 Evidence Items")).toBeInTheDocument();
    expect(screen.queryByText("Opened founders.evidence.json.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps project errors visible after normal status messages are removed", () => {
    render(<CodesWorkspaceHeader {...makeHeaderProps()} statusLabel="The coding project could not be opened." hasError />);

    expect(screen.getByRole("alert")).toHaveTextContent("The coding project could not be opened.");
  });

  it("provides semantic tabs with arrow-key navigation", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<CodesWorkspaceTabs activeTab="evidence" onTabChange={onTabChange} />);

    const codingTab = screen.getByRole("tab", { name: "Transcript Coding" });
    expect(codingTab).toHaveAttribute("aria-selected", "true");
    codingTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenCalledWith("codebook");
  });

  it("shows preferred, alternate, duplicate, and problem import candidates", async () => {
    const user = userEvent.setup();
    const onToggleCandidate = vi.fn();
    const preview: TranscriptImportPreview = {
      project_file: "C:\\study.evidence.json",
      project_id: "project_1",
      revision: "a".repeat(64),
      non_recursive: true,
      counts: { ready: 1, already_imported: 1, alternate_format: 1, problem: 1 },
      candidates: [
        { candidate_id: "json", source_path: "C:\\out\\a.json", source_document_id: "doc_1", document_index: 0, format: "json", logical_fingerprint: "one", logical_group: "a", title: "Interview A", segment_count: 10, status: "ready", preferred: true, reason: "Ready to import." },
        { candidate_id: "xlsx", source_path: "C:\\out\\a.xlsx", source_document_id: "doc_1", document_index: 0, format: "xlsx", logical_fingerprint: "one", logical_group: "a", title: "Interview A", segment_count: 10, status: "alternate_format", preferred: false, reason: "Equivalent JSON exists." },
        { candidate_id: "old", source_path: "C:\\out\\old.json", source_document_id: "doc_1", document_index: 0, format: "json", logical_fingerprint: "old", logical_group: "old", title: "Old", segment_count: 5, status: "already_imported", preferred: false, reason: "Already imported." },
        { candidate_id: "bad", source_path: "C:\\out\\bad.docx", source_document_id: "", document_index: 0, format: "docx", logical_fingerprint: "", logical_group: "bad", title: "bad.docx", segment_count: 0, status: "problem", preferred: false, reason: "Invalid document." }
      ]
    };
    const panelProps: ComponentProps<typeof CodesImportPanel> = {
      preview,
      selectedCandidateIds: ["json"],
      result: null,
      busy: false,
      canEditProject: true,
      onChooseFolder: vi.fn(),
      onChooseFile: vi.fn(),
      onToggleCandidate,
      onConfirm: vi.fn(),
      onCancel: vi.fn()
    };
    const { rerender } = render(
      <CodesImportPanel
        {...panelProps}
      />
    );

    expect(screen.getByLabelText("Help: Import Transcripts")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Import JSON, XLSX, CSV, or DOCX transcript exports. Folder scanning is nonrecursive; JSON is preferred when equivalent formats are found."
    );
    const folderButton = screen.getByRole("button", { name: "Add Transcript Folder" });
    const fileButton = screen.getByRole("button", { name: "Add Transcript File" });
    expect(folderButton).toHaveClass("secondary-button", "codes-import-action-button");
    expect(fileButton).toHaveClass("secondary-button", "codes-import-action-button");
    expect(folderButton).toBeDisabled();
    expect(fileButton).toBeDisabled();

    const previewDetails = screen.getByText("Import Preview (4 Candidates)").closest("details");
    expect(previewDetails).not.toHaveAttribute("open");
    expect(screen.getByText("1 Ready")).toBeInTheDocument();
    expect(screen.getByText("1 Alternate")).toBeInTheDocument();
    expect(screen.getByText("1 Already Imported")).toBeInTheDocument();
    expect(screen.getByText("1 Problems")).toBeInTheDocument();

    await user.click(screen.getByText("Import Preview (4 Candidates)"));
    expect(previewDetails).toHaveAttribute("open");
    expect(screen.getByText("Alternate Format")).toBeInTheDocument();
    expect(screen.getByText("Problem")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[2]).toBeDisabled();
    expect(checkboxes[3]).toBeDisabled();
    await user.click(checkboxes[1]);
    expect(onToggleCandidate).toHaveBeenCalledWith(preview.candidates[1]);

    rerender(<CodesImportPanel {...panelProps} preview={null} />);
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeEnabled();
  });

  it("uses resolved speaker names, paginates long transcripts, and exposes continuous Coding Mode", async () => {
    const user = userEvent.setup();
    const transcript: CodesTranscript = {
      transcript_id: "T000001",
      label: "Interview A",
      source_file: "C:\\out\\a.json",
      source_document_id: "doc_1",
      imported_at: "2026-01-01T00:00:00Z",
      refreshed_at: null,
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "Founder" }],
      segments: Array.from({ length: 101 }, (_, index) => ({
        segment_id: `seg_${String(index + 1).padStart(6, "0")}`,
        start: index,
        end: index + 1,
        speaker: "SPEAKER_00",
        text: `Segment ${index + 1}`
      })),
      metadata: {},
      validation_issues: []
    };
    const project: CodesProject = {
      schema_version: "1.1", project_id: "project_reader", name: "Study",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", research_focus: "",
      ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
      transcripts: [transcript], evidence_items: [], codes: [], themes: [], report_drafts: [], suggestion_decisions: [],
      settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" },
      id_counters: {}
    };
    render(
      <CodesTranscriptReader
        project={project}
        activeTranscript={transcript}
        selectedEvidence={null}
        evidenceDraft={null}
        highlightSettings={defaultCodesHighlightSettings}
        canEditProject
        segmentRefs={{ current: {} } as MutableRefObject<Record<string, HTMLElement | null>>}
        onCaptureEvidenceSelection={vi.fn()}
        onClearEvidenceSelection={vi.fn()}
        onHighlightSettingsChange={vi.fn()}
        onSelectEvidence={vi.fn()}
      />
    );

    expect(screen.getAllByText("Founder").length).toBeGreaterThan(0);
    expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();
    expect(screen.queryByText("101 segment(s)")).not.toBeInTheDocument();
    expect(screen.getByText("Start Coding, then select transcript text to create evidence.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Coding" }));
    expect(screen.getByRole("button", { name: "Finish Coding" })).toHaveAttribute("aria-pressed", "true");
  });

  it("captures selections only in Coding Mode and keeps the mode active across a draft", async () => {
    const user = userEvent.setup();
    const transcript: CodesTranscript = {
      transcript_id: "T000001",
      label: "Interview A",
      source_file: "C:\\out\\a.json",
      source_document_id: "doc_1",
      imported_at: "2026-01-01T00:00:00Z",
      refreshed_at: null,
      language: "en",
      speakers: [{ id: "SPEAKER_00", name: "Founder" }],
      segments: [{ segment_id: "seg_000001", start: 0, end: 1, speaker: "SPEAKER_00", text: "A passage to mark" }],
      metadata: {},
      validation_issues: []
    };
    const onCaptureEvidenceSelection = vi.fn();
    const project: CodesProject = {
      schema_version: "1.1",
      project_id: "project_test",
      name: "Study",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      research_focus: "",
      ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
      transcripts: [transcript], evidence_items: [], codes: [], themes: [], report_drafts: [], suggestion_decisions: [],
      settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" },
      id_counters: {}
    };
    const readerProps: ComponentProps<typeof CodesTranscriptReader> = {
      project,
      activeTranscript: transcript,
      selectedEvidence: null,
      evidenceDraft: null,
      highlightSettings: defaultCodesHighlightSettings,
      canEditProject: true,
      segmentRefs: { current: {} } as MutableRefObject<Record<string, HTMLElement | null>>,
      onCaptureEvidenceSelection,
      onClearEvidenceSelection: vi.fn(),
      onHighlightSettingsChange: vi.fn(),
      onSelectEvidence: vi.fn()
    };
    const { rerender } = render(
      <CodesTranscriptReader
        {...readerProps}
      />
    );

    const passage = screen.getByText("A passage to mark");
    fireEvent.mouseUp(passage);
    expect(onCaptureEvidenceSelection).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start Coding" }));
    expect(screen.getByRole("button", { name: "Finish Coding" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.mouseUp(passage);
    expect(onCaptureEvidenceSelection).toHaveBeenCalledOnce();

    rerender(
      <CodesTranscriptReader
        {...readerProps}
        evidenceDraft={{
          transcriptId: transcript.transcript_id,
          segmentIds: ["seg_000001"],
          selectedText: "A passage",
          segmentRanges: { seg_000001: { start_offset: 0, end_offset: 9, excerpt: "A passage" } },
          codeIds: [],
          newCodes: [],
          memo: ""
        }}
      />
    );
    expect(screen.getByRole("button", { name: "Finish Coding" })).toBeDisabled();
    expect(screen.getByText("Select another passage to adjust this evidence draft, or save or cancel it in the Evidence panel.")).toBeInTheDocument();
    const draftPassage = document.querySelector<HTMLElement>("[data-codes-segment-text]");
    expect(draftPassage).not.toBeNull();
    fireEvent.mouseUp(draftPassage!);
    fireEvent.keyUp(draftPassage!, { key: "ArrowRight" });
    expect(onCaptureEvidenceSelection).toHaveBeenCalledTimes(3);

    rerender(<CodesTranscriptReader {...readerProps} evidenceDraft={null} />);
    expect(screen.getByRole("button", { name: "Finish Coding" })).toBeEnabled();
    expect(screen.getByText("Select a passage in the transcript. Each selection opens an evidence draft.")).toBeInTheDocument();
  });

  it("replaces draft anchors while preserving codes, provisional codes, and memo", () => {
    const updated = replaceEvidenceDraftSelection({
      transcriptId: "T000001",
      segmentIds: ["seg_000001"],
      selectedText: "Old passage",
      segmentRanges: { seg_000001: { start_offset: 0, end_offset: 11, excerpt: "Old passage" } },
      codeIds: ["C000001"],
      newCodes: [{ clientId: "draft-code", name: "Emerging Code", color: "#123456" }],
      memo: "Keep this analytical memo."
    }, {
      transcriptId: "T000001",
      segmentIds: ["seg_000002", "seg_000003"],
      selectedText: "Replacement passage",
      segmentRanges: {
        seg_000002: { start_offset: 4, end_offset: 15, excerpt: "Replacement" },
        seg_000003: { start_offset: 0, end_offset: 7, excerpt: "passage" }
      }
    });

    expect(updated.segmentIds).toEqual(["seg_000002", "seg_000003"]);
    expect(updated.selectedText).toBe("Replacement passage");
    expect(updated.segmentRanges).toEqual({
      seg_000002: { start_offset: 4, end_offset: 15, excerpt: "Replacement" },
      seg_000003: { start_offset: 0, end_offset: 7, excerpt: "passage" }
    });
    expect(updated.codeIds).toEqual(["C000001"]);
    expect(updated.newCodes).toEqual([{ clientId: "draft-code", name: "Emerging Code", color: "#123456" }]);
    expect(updated.memo).toBe("Keep this analytical memo.");
  });

  it("provides Save Draft, Discard Draft, and Cancel safeguards", () => {
    render(
      <CodesDraftDialog
        open
        draftLabel="The code form"
        canSave
        busy={false}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard Draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
