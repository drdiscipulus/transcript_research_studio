import type { MutableRefObject } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CodesInspector } from "../../src/components/codes/CodesInspector";
import { CodesAiSettings } from "../../src/components/codes/CodesAiSettings";
import { CodesAiProgress } from "../../src/components/codes/CodesAiProgress";
import {
  CodesCodeDialog,
  type CodesCodeDialogTarget
} from "../../src/components/codes/CodesCodeDialog";
import {
  CodesCodeRefinementReview,
  CodesThemeRefinementReview,
  CodesThemeSuggestionReviews
} from "../../src/components/codes/CodesCodebookAiReviews";
import {
  CodesHighlightControls,
  defaultCodesHighlightSettings,
  pruneCodesHighlightSettings
} from "../../src/components/codes/CodesHighlightControls";
import { CodesProjectSidebar } from "../../src/components/codes/CodesProjectSidebar";
import { buildSegmentHighlightRuns, CodesTranscriptReader } from "../../src/components/codes/CodesTranscriptReader";
import { CodesTranscriptToolbar } from "../../src/components/codes/CodesTranscriptToolbar";
import { evidenceEditDraftFromEvidence } from "../../src/components/codes/codesPageUtils";
import type {
  CodesAiCodeDetailsSuggestion,
  CodesAiEvidenceSuggestion,
  CodesAiRunSnapshot,
  CodesEvidenceItem,
  CodesProject,
  CodesTranscript
} from "../../src/lib/api";

function makeTranscript(id: string, label: string, count = 3): CodesTranscript {
  return {
    transcript_id: id,
    label,
    source_file: `D:\\transcripts\\${label}.json`,
    source_document_id: "doc_000001",
    imported_at: "2026-07-19T00:00:00Z",
    refreshed_at: null,
    language: "en",
    speakers: [{ id: "SPEAKER_00", name: "Founder" }],
    segments: Array.from({ length: count }, (_, index) => ({
      segment_id: `seg_${String(index + 1).padStart(6, "0")}`,
      start: index,
      end: index + 1,
      speaker: "SPEAKER_00",
      text: index === count - 1 ? `Closing exact anchor ${index + 1}` : `Segment text ${index + 1}`
    })),
    metadata: {},
    validation_issues: []
  };
}

function makeEvidence(index: number, transcriptId = "T000001"): CodesEvidenceItem {
  return {
    evidence_id: `E${String(index).padStart(6, "0")}`,
    transcript_id: transcriptId,
    source_file: "D:\\transcripts\\Interview A.json",
    source_document_id: "doc_000001",
    segment_ids: ["seg_000001"],
    speaker: "SPEAKER_00",
    start: 0,
    end: 1,
    selected_text: `Evidence excerpt ${index}`,
    segment_ranges: {
      seg_000001: { start_offset: 0, end_offset: 14, excerpt: "Segment text 1" }
    },
    code_ids: index === 1 ? ["C000001"] : [],
    memo: "",
    created_at: "2026-07-19T00:00:00Z",
    updated_at: "2026-07-19T00:00:00Z"
  };
}

function makeProject(): CodesProject {
  return {
    schema_version: "1.1",
    project_id: "project_test",
    name: "Study",
    created_at: "2026-07-19T00:00:00Z",
    updated_at: "2026-07-19T00:00:00Z",
    research_focus: "",
    ai_settings: { provider_id: "", model_id: "", temperature: 0, timeout_seconds: 180, suggestion_language: "auto" },
    transcripts: [makeTranscript("T000001", "Interview A"), makeTranscript("T000002", "Interview B")],
    evidence_items: [makeEvidence(1)],
    codes: [{
      code_id: "C000001", name: "Opportunity", description: "", inclusion_note: "", exclusion_note: "",
      example_evidence_ids: [], color: "#123456", memo: "", created_at: "2026-07-19T00:00:00Z", updated_at: "2026-07-19T00:00:00Z"
    }],
    themes: [],
    report_drafts: [],
    suggestion_decisions: [],
    settings: { case_definition: "transcript", theme_assignment: "multiple", memo_format: "plain_text", transcript_folder_import: "non_recursive", ai_audit: "decisions_only" },
    id_counters: {}
  };
}

describe("Transcript Coding workspace redesign", () => {
  it("keeps a prompt draft when restoring the built-in prompt cannot persist", async () => {
    const user = userEvent.setup();
    const baseProject = makeProject();
    const project = {
      ...baseProject,
      ai_settings: {
        ...baseProject.ai_settings,
        prompt_overrides: { evidence: "Custom prompt" }
      }
    };
    const onUpdate = vi.fn(() => false);
    render(
      <CodesAiSettings
        project={project}
        open
        focusRequest={0}
        providers={[]}
        models={[]}
        providersLoading={false}
        modelsLoading={false}
        hasModelSnapshot
        providerError={null}
        modelError={null}
        configurationError={null}
        busy={false}
        onOpenChange={vi.fn()}
        onRefreshProviders={vi.fn()}
        onUpdate={onUpdate}
      />
    );
    await user.click(screen.getByText("Project Prompt Templates"));
    const prompt = screen.getByDisplayValue("Custom prompt");
    await user.click(screen.getAllByRole("button", { name: "Restore Built-in Default" })[0]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveValue("Custom prompt");
  });

  it("navigates transcripts from the toolbar and blocks replacing a pending import preview", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const onSelectTranscript = vi.fn();
    render(
      <CodesTranscriptToolbar
        project={project}
        activeTranscript={project.transcripts[0]}
        activeTranscriptId="T000001"
        importResult={null}
        importPreviewPending
        busy={false}
        canEditProject
        onSelectTranscript={onSelectTranscript}
        onAddTranscriptFolder={vi.fn()}
        onAddTranscriptFile={vi.fn()}
        onRemoveTranscript={vi.fn()}
        onDismissImportResult={vi.fn()}
      />
    );

    await user.selectOptions(screen.getByRole("combobox", { name: /Transcript/ }), "T000002");
    expect(onSelectTranscript).toHaveBeenCalledWith("T000002");
    await user.click(screen.getByText("Add Transcripts"));
    expect(screen.getByRole("button", { name: "Add Transcript Folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Transcript File" })).toBeDisabled();
    expect(screen.queryByText("Transcript Actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Source for Updates…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Transcript" })).toBeEnabled();
  });

  it("paginates evidence and defaults the list to the active transcript", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    project.evidence_items = [
      ...Array.from({ length: 26 }, (_, index) => makeEvidence(index + 1)),
      makeEvidence(27, "T000002")
    ];
    const onSelectEvidence = vi.fn();
    render(
      <CodesProjectSidebar
        project={project}
        activeTranscriptId="T000001"
        selectedEvidenceId=""
        evidenceSearch=""
        evidenceScope="active"
        evidenceFilterCodeId=""
        evidenceFilterThemeId=""
        onSelectEvidence={onSelectEvidence}
        onEvidenceSearchChange={vi.fn()}
        onEvidenceScopeChange={vi.fn()}
        onEvidenceFilterCodeChange={vi.fn()}
        onEvidenceFilterThemeChange={vi.fn()}
        onClearEvidenceFilters={vi.fn()}
        aiSuggestions={[]}
        selectedAiSuggestionId=""
        aiDecisionAction={null}
        aiDecisionErrorFor={() => null}
        onSelectAiSuggestion={vi.fn()}
        onAcceptAiSuggestion={vi.fn()}
        onRejectAiSuggestion={vi.fn()}
        onClearAiSuggestions={vi.fn()}
      />
    );

    const evidenceHeading = screen.getByText("Evidence (26)");
    expect(screen.getAllByText("Evidence (26)")).toHaveLength(1);
    expect(evidenceHeading.closest("details")).toBeNull();
    const evidenceListSummary = screen.getByText("Evidence List");
    const evidenceDetails = evidenceListSummary.closest("details");
    expect(evidenceDetails).toHaveAttribute("open");
    await user.click(evidenceListSummary);
    expect(evidenceDetails).not.toHaveAttribute("open");
    await user.click(evidenceListSummary);
    expect(evidenceDetails).toHaveAttribute("open");
    const resizeHandle = screen.getByRole("separator", { name: "Resize Evidence List" });
    expect(resizeHandle).toHaveAttribute("aria-orientation", "horizontal");
    const resizer = resizeHandle.closest(".codes-evidence-list-resizer");
    resizeHandle.focus();
    await user.keyboard("{ArrowDown}");
    expect(resizer).toHaveStyle({ height: "424px" });
    expect(screen.queryByText("Evidence excerpt 27")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    const finalRow = screen.getByRole("button", { name: /Evidence excerpt 26/ });
    expect(finalRow).toHaveTextContent("Interview A · Founder · 0:00 - 0:01");
    expect(finalRow).not.toHaveTextContent("E000026");
    expect(finalRow).toHaveAttribute("title", "Evidence E000026");
    await user.click(finalRow);
    expect(onSelectEvidence).toHaveBeenCalledWith(project.evidence_items[25]);
  });

  it("presents evidence-only AI decisions with per-suggestion progress and retry", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const suggestion: CodesAiEvidenceSuggestion = {
      suggestion_id: "suggestion_1",
      run_id: "run_1",
      kind: "evidence",
      transcript_id: "T000001",
      segment_ids: ["seg_000001"],
      segment_ranges: { seg_000001: { start_offset: 0, end_offset: 14, excerpt: "Segment text 1" } },
      selected_text: "Segment text 1",
      speaker: "SPEAKER_00",
      start: 0,
      end: 1,
      rationale: "Relevant to the research focus."
    };
    const onAcceptAiSuggestion = vi.fn();
    const onRejectAiSuggestion = vi.fn();
    const onClearAiSuggestions = vi.fn();
    const commonProps = {
      project,
      activeTranscriptId: "T000001",
      selectedEvidenceId: "",
      evidenceSearch: "",
      evidenceScope: "active" as const,
      evidenceFilterCodeId: "",
      evidenceFilterThemeId: "",
      onSelectEvidence: vi.fn(),
      onEvidenceSearchChange: vi.fn(),
      onEvidenceScopeChange: vi.fn(),
      onEvidenceFilterCodeChange: vi.fn(),
      onEvidenceFilterThemeChange: vi.fn(),
      onClearEvidenceFilters: vi.fn(),
      aiSuggestions: [suggestion],
      selectedAiSuggestionId: "suggestion_1",
      aiDecisionAction: null,
      aiDecisionErrorFor: () => null,
      onSelectAiSuggestion: vi.fn(),
      onAcceptAiSuggestion,
      onRejectAiSuggestion,
      onClearAiSuggestions
    };
    const view = render(<CodesProjectSidebar {...commonProps} />);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAcceptAiSuggestion).toHaveBeenCalledWith(suggestion);
    expect(screen.queryByText(/New:/)).not.toBeInTheDocument();

    view.rerender(<CodesProjectSidebar {...commonProps} aiDecisionAction={{ kind: "accept", task: "evidence", suggestionId: "suggestion_1", completed: 0, total: 1 }} />);
    expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();

    view.rerender(<CodesProjectSidebar {...commonProps} aiDecisionAction={{ kind: "reject", task: "evidence", suggestionId: "suggestion_1", completed: 0, total: 1 }} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismissing…" })).toBeDisabled();

    view.rerender(<CodesProjectSidebar {...commonProps} aiLocked />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Suggestions" })).toBeDisabled();

    view.rerender(<CodesProjectSidebar
      {...commonProps}
      aiLocked
      aiDecisionErrorFor={(_task, suggestionId) => suggestionId === "suggestion_1"
        ? { kind: "accept", task: "evidence", suggestionId, message: "Could not save evidence." }
        : null}
    />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save evidence.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    view.rerender(<CodesProjectSidebar
      {...commonProps}
      aiDecisionErrorFor={(_task, suggestionId) => suggestionId === "suggestion_1"
        ? { kind: "accept", task: "evidence", suggestionId, message: "Could not save evidence." }
        : null}
    />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAcceptAiSuggestion).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Clear Suggestions" }));
    expect(screen.getByRole("alertdialog", { name: "Clear AI Evidence Suggestions?" })).toBeInTheDocument();
    expect(onClearAiSuggestions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reject and Clear" }));
    expect(onClearAiSuggestions).toHaveBeenCalledWith([suggestion]);

    view.rerender(<CodesProjectSidebar {...commonProps} aiDecisionAction={{ kind: "clear", task: "evidence", suggestionId: "suggestion_1", completed: 0, total: 1 }} />);
    expect(screen.getByRole("button", { name: "Clearing… 0 / 1" })).toBeDisabled();
  });

  it("renders compact staged evidence editing and validates provisional code names", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    project.codes.push({
      code_id: "C000002", name: "Customer Need", description: "", inclusion_note: "", exclusion_note: "",
      example_evidence_ids: [], color: "#654321", memo: "", created_at: "2026-07-19T00:00:00Z", updated_at: "2026-07-19T00:00:00Z"
    });
    const evidence = project.evidence_items[0];
    const onToggleInspectorCode = vi.fn();
    const onAddInspectorCode = vi.fn();
    render(
      <CodesInspector
        project={project}
        selectedEvidence={evidence}
        evidenceEditDraft={evidenceEditDraftFromEvidence(evidence)}
        evidenceEditDirty={false}
        evidenceDraft={null}
        busy={false}
        canEditProject
        onInspectorMemoChange={vi.fn()}
        onDeleteSelectedEvidence={vi.fn()}
        onSaveSelectedEvidence={vi.fn()}
        onSaveEvidenceDraft={vi.fn()}
        onCancelEvidenceDraft={vi.fn()}
        onCancelSelectedEvidenceChanges={vi.fn()}
        onToggleInspectorCode={onToggleInspectorCode}
        onAddInspectorCode={onAddInspectorCode}
        onRemoveInspectorCode={vi.fn()}
      />
    );

    expect(screen.getByText("Founder · 0:00 - 0:01 · E000001")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Codes")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suggest Codes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft Memo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    const removeAssignment = screen.getByRole("button", { name: "Remove Opportunity from evidence" });
    expect(removeAssignment).toHaveTextContent("×");
    expect(removeAssignment).toHaveAttribute("title", "Remove Assignment");
    const aiSuggestCodesButton = screen.getByRole("button", { name: "AI: Suggest Codes" });
    expect(removeAssignment.compareDocumentPosition(aiSuggestCodesButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(removeAssignment);
    expect(onToggleInspectorCode).toHaveBeenCalledWith("C000001");

    const assignExistingButton = screen.getByRole("button", { name: "Assign Existing Code" });
    expect(assignExistingButton).toHaveAttribute("aria-expanded", "false");
    expect(assignExistingButton).toHaveTextContent("Assign Code");
    await user.click(assignExistingButton);
    expect(screen.getByRole("button", { name: "Close Existing Code List" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Close Existing Code List" })).toHaveTextContent("Close List");
    const availableCodeButton = screen.getByRole("button", { name: /Customer Need/ });
    expect(availableCodeButton.compareDocumentPosition(aiSuggestCodesButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(availableCodeButton);
    expect(onToggleInspectorCode).toHaveBeenCalledWith("C000002");

    const createCodeButton = screen.getByRole("button", { name: "Create New Code" });
    expect(createCodeButton).toHaveTextContent("New Code");
    await user.click(createCodeButton);
    expect(screen.queryByRole("button", { name: "Close Existing Code List" })).not.toBeInTheDocument();
    const codeDialog = screen.getByRole("dialog", { name: "Create Code" });
    expect(codeDialog).toBeInTheDocument();
    expect(within(codeDialog).getByRole("textbox", { name: "Definition" })).toBeInTheDocument();
    expect(within(codeDialog).getByRole("textbox", { name: "Inclusion Criteria" })).toBeInTheDocument();
    expect(within(codeDialog).getByRole("textbox", { name: "Exclusion Criteria" })).toBeInTheDocument();
    expect(within(codeDialog).getByRole("textbox", { name: "Note" })).toBeInTheDocument();
    expect(within(codeDialog).getByRole("checkbox", { name: "Use Current Evidence as Example" })).not.toBeChecked();
    const nameInput = within(codeDialog).getByRole("textbox", { name: "Code Name" });
    await user.type(nameInput, "opportunity");
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    expect(onAddInspectorCode).not.toHaveBeenCalled();

    await user.clear(nameInput);
    await user.type(nameInput, "Experimentation");
    await user.click(screen.getByRole("button", { name: "Add Code" }));
    await waitFor(() => expect(onAddInspectorCode).toHaveBeenCalledWith(expect.objectContaining({
      name: "Experimentation",
      color: "#0f766e",
      description: "",
      inclusionNote: "",
      exclusionNote: "",
      memo: ""
    }), undefined, ""));
  });

  it("shows Save and Cancel without Delete for new evidence", () => {
    const project = makeProject();
    project.codes = [];
    render(
      <CodesInspector
        project={project}
        selectedEvidence={null}
        evidenceEditDraft={null}
        evidenceEditDirty={false}
        evidenceDraft={{
          transcriptId: "T000001",
          segmentIds: ["seg_000001"],
          selectedText: "Segment text 1",
          segmentRanges: { seg_000001: { start_offset: 0, end_offset: 14, excerpt: "Segment text 1" } },
          codeIds: [],
          newCodes: [],
          memo: ""
        }}
        busy={false}
        canEditProject
        onInspectorMemoChange={vi.fn()}
        onDeleteSelectedEvidence={vi.fn()}
        onSaveSelectedEvidence={vi.fn()}
        onSaveEvidenceDraft={vi.fn()}
        onCancelEvidenceDraft={vi.fn()}
        onCancelSelectedEvidenceChanges={vi.fn()}
        onToggleInspectorCode={vi.fn()}
        onAddInspectorCode={vi.fn()}
        onRemoveInspectorCode={vi.fn()}
      />
    );

    expect(screen.getByText("Founder · 0:00 - 0:01 · New Evidence")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    const assignExistingButton = screen.getByRole("button", { name: "Assign Existing Code" });
    expect(assignExistingButton).toBeDisabled();
    expect(assignExistingButton).toHaveAttribute("title", "No Existing Codes");
  });

  it("changes reader pages before scrolling and highlights an exact saved excerpt", async () => {
    const transcript = makeTranscript("T000001", "Interview A", 101);
    const evidence: CodesEvidenceItem = {
      ...makeEvidence(1),
      segment_ids: ["seg_000101"],
      selected_text: "exact anchor",
      segment_ranges: { seg_000101: { start_offset: 8, end_offset: 20, excerpt: "exact anchor" } },
      start: 100,
      end: 101
    };
    render(
      <CodesTranscriptReader
        project={{ ...makeProject(), transcripts: [transcript], evidence_items: [evidence] }}
        activeTranscript={transcript}
        selectedEvidence={evidence}
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

    expect(await screen.findByText("Page 3 / 3")).toBeInTheDocument();
    const selectedRun = await screen.findByRole("button", { name: "Open Evidence E000001" });
    expect(selectedRun).toHaveClass("selected");
    expect(selectedRun).toHaveTextContent("exact anchor");
  });

  it("uses exact offsets when identical excerpts occur more than once", () => {
    const text = "repeat exact repeat exact";
    const evidenceItems: CodesEvidenceItem[] = [
      { ...makeEvidence(1), selected_text: "exact", segment_ranges: { seg_000001: { start_offset: 7, end_offset: 12, excerpt: "exact" } } },
      { ...makeEvidence(2), selected_text: "exact", segment_ranges: { seg_000001: { start_offset: 20, end_offset: 25, excerpt: "exact" } } }
    ];
    const runs = buildSegmentHighlightRuns({
      text,
      segmentId: "seg_000001",
      evidenceItems,
      selectedEvidenceId: "",
      codeIds: [],
      themes: [],
      settings: { ...defaultCodesHighlightSettings, show: true },
      search: ""
    });

    expect(runs.filter((run) => run.evidenceLayer).map((run) => [run.start, run.end])).toEqual([[7, 12], [20, 25]]);
  });

  it("combines independent custom code and theme layers without blending their identities", () => {
    const first = { ...makeEvidence(1), code_ids: ["C000001"], segment_ranges: { seg_000001: { start_offset: 0, end_offset: 5, excerpt: "Segme" } } };
    const second = { ...makeEvidence(2), code_ids: ["C000002"], segment_ranges: { seg_000001: { start_offset: 3, end_offset: 8, excerpt: "ment " } } };
    const runs = buildSegmentHighlightRuns({
      text: "Segment text 1",
      segmentId: "seg_000001",
      evidenceItems: [first, second],
      selectedEvidenceId: "",
      codeIds: ["C000001", "C000002"],
      themes: [
        { theme_id: "TH000001", name: "First", description: "", color: "#aa0000", code_ids: ["C000001"], memo: "", created_at: "", updated_at: "" },
        { theme_id: "TH000002", name: "Second", description: "", color: "#0000aa", code_ids: ["C000002"], memo: "", created_at: "", updated_at: "" }
      ],
      settings: {
        ...defaultCodesHighlightSettings,
        show: true,
        evidence: false,
        codes: true,
        themes: true,
        codeScope: "selected",
        themeScope: "selected",
        selectedCodeIds: ["C000001"],
        selectedThemeIds: ["TH000002"]
      },
      search: ""
    });
    const overlap = runs.find((run) => run.start === 3 && run.end === 5);

    expect(overlap).toMatchObject({ evidenceLayer: false, codeIds: ["C000001"], themeIds: ["TH000002"] });
  });

  it("opens an accessible chooser for overlapping highlighted evidence", async () => {
    const user = userEvent.setup();
    const transcript = makeTranscript("T000001", "Interview A", 1);
    const evidenceItems: CodesEvidenceItem[] = [
      { ...makeEvidence(1), selected_text: "Segment", segment_ranges: { seg_000001: { start_offset: 0, end_offset: 7, excerpt: "Segment" } } },
      { ...makeEvidence(2), selected_text: "Segment text", segment_ranges: { seg_000001: { start_offset: 0, end_offset: 12, excerpt: "Segment text" } } }
    ];
    const project = {
      ...makeProject(),
      transcripts: [transcript],
      evidence_items: evidenceItems,
      themes: [{
        theme_id: "TH000001", name: "Findings", description: "", color: "#654321", code_ids: ["C000001"], memo: "", created_at: "", updated_at: ""
      }]
    };
    const onSelectEvidence = vi.fn();
    render(
      <CodesTranscriptReader
        project={project}
        activeTranscript={transcript}
        selectedEvidence={null}
        evidenceDraft={null}
        highlightSettings={{ ...defaultCodesHighlightSettings, show: true }}
        canEditProject
        segmentRefs={{ current: {} } as MutableRefObject<Record<string, HTMLElement | null>>}
        onCaptureEvidenceSelection={vi.fn()}
        onClearEvidenceSelection={vi.fn()}
        onHighlightSettingsChange={vi.fn()}
        onSelectEvidence={onSelectEvidence}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open 2 Overlapping Evidence Items" }));
    expect(screen.getByRole("dialog", { name: "Choose Evidence" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "Choose Evidence" })).getByText("Themes: Findings")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Choose Evidence" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open 2 Overlapping Evidence Items" }));
    await user.click(screen.getByRole("button", { name: /Segment text/ }));
    expect(onSelectEvidence).toHaveBeenCalledWith(evidenceItems[1]);
  });

  it("renders a visible code ribbon and an assignment tooltip for highlighted evidence", () => {
    const project = makeProject();
    project.themes = [{
      theme_id: "TH000001", name: "Market Theme", description: "", color: "#654321", code_ids: ["C000001"], memo: "", created_at: "", updated_at: ""
    }];
    const { container } = render(
      <CodesTranscriptReader
        project={project}
        activeTranscript={project.transcripts[0]}
        selectedEvidence={null}
        evidenceDraft={null}
        highlightSettings={{ ...defaultCodesHighlightSettings, show: true, codes: true, themes: true }}
        canEditProject
        segmentRefs={{ current: {} } as MutableRefObject<Record<string, HTMLElement | null>>}
        onCaptureEvidenceSelection={vi.fn()}
        onClearEvidenceSelection={vi.fn()}
        onHighlightSettingsChange={vi.fn()}
        onSelectEvidence={vi.fn()}
      />
    );

    const highlightedRun = screen.getByRole("button", { name: "Open Evidence E000001" });
    expect(highlightedRun).toHaveClass("code-layer", "theme-layer");
    expect(highlightedRun.querySelector(".codes-highlight-code-ribbon")).toBeInTheDocument();
    expect(highlightedRun.querySelector(".codes-highlight-theme-ribbon")).toBeInTheDocument();
    expect(highlightedRun.getAttribute("style")).toContain("#123456");
    const tooltip = highlightedRun.querySelector<HTMLElement>(".codes-highlight-tooltip");
    expect(tooltip).not.toBeNull();
    if (!tooltip) throw new Error("Expected highlight tooltip.");
    expect(highlightedRun).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("Evidence E000001");
    expect(tooltip).toHaveTextContent("Evidence excerpt 1");
    expect(tooltip).toHaveTextContent("Codes: Opportunity");
    expect(tooltip).toHaveTextContent("Themes: Market Theme");
    expect(container.querySelector("[title*='Codes:']")).not.toBeInTheDocument();
  });

  it("exposes independent layer toggles and custom selections", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const project = makeProject();
    render(<CodesHighlightControls codes={project.codes} themes={project.themes} settings={defaultCodesHighlightSettings} onChange={onChange} />);

    await user.click(screen.getByText("Highlights"));
    expect(screen.getByRole("dialog", { name: "Highlight Settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Show Highlights" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ show: true }));
    await user.click(screen.getByRole("checkbox", { name: "Codes" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ codes: true }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Highlight Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Highlight Settings" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Highlight Settings" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Highlight Settings" })).not.toBeInTheDocument();
  });

  it("preserves valid highlight selections and prunes only deleted entities", () => {
    const settings = {
      ...defaultCodesHighlightSettings,
      selectedCodeIds: ["C000001", "C000002"],
      selectedThemeIds: ["TH000001", "TH000002"]
    };

    expect(pruneCodesHighlightSettings(
      settings,
      ["C000001", "C000002"],
      ["TH000001", "TH000002"]
    )).toBe(settings);

    expect(pruneCodesHighlightSettings(
      settings,
      ["C000002"],
      ["TH000001"]
    )).toEqual({
      ...settings,
      selectedCodeIds: ["C000002"],
      selectedThemeIds: ["TH000001"]
    });
  });

  it("opens the clearly labeled AI evidence dialog with a current-page scope", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const transcript = project.transcripts[0];
    const onRunEvidenceAi = vi.fn();
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
        aiConfigured
        aiPrompt="Find statements about uncertainty."
        aiRun={null}
        aiError={null}
        aiSuggestions={[]}
        selectedAiSuggestionId=""
        onRequireAiConfiguration={vi.fn()}
        onSaveAiPrompt={vi.fn()}
        onRestoreAiPrompt={() => "Built-in prompt"}
        onRunEvidenceAi={onRunEvidenceAi}
        onCancelAiRun={vi.fn()}
        onSelectAiSuggestion={vi.fn()}
      />
    );

    const aiButton = screen.getByRole("button", { name: "AI: Suggest Evidence" });
    expect(aiButton).toHaveTextContent(/✦\s*AI Suggestions/);
    await user.click(aiButton);
    const dialog = screen.getByRole("dialog", { name: /Suggest Evidence/ });
    expect(within(dialog).getByRole("radio", { name: "Current Page" })).toBeChecked();
    expect(within(dialog).getByText("3 segments included")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Researcher Prompt")).toHaveValue("Find statements about uncertainty.");
    await user.click(within(dialog).getByRole("button", { name: "Run" }));
    expect(onRunEvidenceAi).toHaveBeenCalledWith({
      transcriptId: "T000001",
      scope: { type: "current_page", segment_ids: ["seg_000001", "seg_000002", "seg_000003"] },
      researcherPrompt: "Find statements about uncertainty.",
      maximumSuggestions: 10
    });
  });

  it("keeps Coding Mode active while a manual evidence draft is open", async () => {
    const project = makeProject();
    render(
      <CodesTranscriptReader
        project={project}
        activeTranscript={project.transcripts[0]}
        selectedEvidence={null}
        evidenceDraft={{
          transcriptId: "T000001",
          segmentIds: ["seg_000001"],
          selectedText: "Segment text 1",
          segmentRanges: { seg_000001: { start_offset: 0, end_offset: 14, excerpt: "Segment text 1" } },
          codeIds: [],
          newCodes: [],
          memo: "",
          aiDecisions: []
        }}
        highlightSettings={defaultCodesHighlightSettings}
        canEditProject
        segmentRefs={{ current: {} } as MutableRefObject<Record<string, HTMLElement | null>>}
        onCaptureEvidenceSelection={vi.fn()}
        onClearEvidenceSelection={vi.fn()}
        onHighlightSettingsChange={vi.fn()}
        onSelectEvidence={vi.fn()}
      />
    );

    expect(await screen.findByRole("button", { name: "Finish Coding" })).toBeDisabled();
    expect(screen.getByText(/Select another passage to adjust this evidence draft/)).toBeInTheDocument();
  });

  it("stages contextual AI code and note suggestions through ordinary inspector drafts", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const evidence = project.evidence_items[0];
    const onStageAiCode = vi.fn();
    const onApplyAiNote = vi.fn();
    const onAddInspectorCode = vi.fn();
    const onRunAi = vi.fn(() => Promise.resolve(false));
    const codeSuggestion = {
      suggestion_id: "suggestion_code",
      kind: "existing_code" as const,
      code_id: "C000001",
      name: "Opportunity",
      description: "",
      rationale: "The passage describes an opportunity."
    };
    const newCodeSuggestion = {
      suggestion_id: "suggestion_new_code",
      kind: "new_code" as const,
      name: "Emergent Opportunity",
      description: "A newly recognized opportunity.",
      rationale: "No existing code fully captures the passage."
    };
    const noteSuggestion = {
      suggestion_id: "suggestion_note",
      kind: "note" as const,
      note: "The participant frames uncertainty as an opportunity."
    };
    render(
      <CodesInspector
        project={project}
        selectedEvidence={evidence}
        evidenceEditDraft={evidenceEditDraftFromEvidence(evidence)}
        evidenceEditDirty={false}
        evidenceDraft={null}
        busy={false}
        canEditProject
        onInspectorMemoChange={vi.fn()}
        onDeleteSelectedEvidence={vi.fn()}
        onSaveSelectedEvidence={vi.fn()}
        onSaveEvidenceDraft={vi.fn()}
        onCancelEvidenceDraft={vi.fn()}
        onCancelSelectedEvidenceChanges={vi.fn()}
        onToggleInspectorCode={vi.fn()}
        onAddInspectorCode={onAddInspectorCode}
        onRemoveInspectorCode={vi.fn()}
        aiConfigured
        aiRun={null}
        aiError={null}
        aiCodeSuggestions={[codeSuggestion, newCodeSuggestion]}
        aiNoteSuggestion={noteSuggestion}
        aiResultRunIds={{ codes: "run_codes_authoritative", note: "run_note_authoritative" }}
        aiPrompts={{ codes: "Suggest a fitting code.", note: "Draft a note." }}
        onRequireAiConfiguration={vi.fn()}
        onSaveAiPrompt={vi.fn()}
        onRestoreAiPrompt={() => "Built-in prompt"}
        onRunAi={onRunAi}
        onCancelAiRun={vi.fn()}
        onStageAiCode={onStageAiCode}
        onApplyAiNote={onApplyAiNote}
        onRejectAiSuggestion={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "AI: Suggest Codes" })).toHaveTextContent("✦ AI");
    expect(screen.getByRole("button", { name: "AI: Draft Note" })).toHaveTextContent("✦ AI");
    const codeResults = screen.getByLabelText("AI Code Suggestions");
    await user.click(within(codeResults).getByRole("button", { name: "Add" }));
    expect(onStageAiCode).toHaveBeenCalledWith(codeSuggestion, "run_codes_authoritative");
    await user.click(screen.getByRole("button", { name: "Use Draft" }));
    expect(onApplyAiNote).toHaveBeenCalledWith(noteSuggestion, "run_note_authoritative", "use");

    await user.click(within(codeResults).getByRole("button", { name: "Review" }));
    const codeDialog = screen.getByRole("dialog", { name: "Create Code" });
    expect(within(codeDialog).getByRole("textbox", { name: "Code Name" })).toHaveValue("Emergent Opportunity");
    expect(onAddInspectorCode).not.toHaveBeenCalled();
    await user.click(within(codeDialog).getByRole("button", { name: "Add Code" }));
    expect(onAddInspectorCode).toHaveBeenCalledWith(expect.objectContaining({
      name: "Emergent Opportunity",
      description: "A newly recognized opportunity.",
      aiDecisions: []
    }), newCodeSuggestion, "run_codes_authoritative");

    await user.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    const aiDialog = screen.getByRole("dialog", { name: /Suggest Codes/ });
    await user.click(within(aiDialog).getByRole("button", { name: "Run" }));
    expect(onRunAi).toHaveBeenCalledWith("codes", "Suggest a fitting code.");
    expect(screen.getByRole("dialog", { name: /Suggest Codes/ })).toBeInTheDocument();
  });

  it("keeps Inspector AI dialog controls truthful while a run lock is acquired", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const evidence = project.evidence_items[0];
    const onRunAi = vi.fn(() => Promise.resolve(false));
    const props = {
      project,
      selectedEvidence: evidence,
      evidenceEditDraft: evidenceEditDraftFromEvidence(evidence),
      evidenceEditDirty: false,
      evidenceDraft: null,
      busy: false,
      canEditProject: true,
      onInspectorMemoChange: vi.fn(),
      onDeleteSelectedEvidence: vi.fn(),
      onSaveSelectedEvidence: vi.fn(),
      onSaveEvidenceDraft: vi.fn(),
      onCancelEvidenceDraft: vi.fn(),
      onCancelSelectedEvidenceChanges: vi.fn(),
      onToggleInspectorCode: vi.fn(),
      onAddInspectorCode: vi.fn(() => ""),
      onRemoveInspectorCode: vi.fn(),
      aiConfigured: true,
      aiRun: null,
      aiError: null,
      aiCodeSuggestions: [],
      aiCodeDetailsSuggestion: null,
      aiCodeDetailsSuggestionTarget: null,
      aiNoteSuggestion: null,
      aiPrompts: { codes: "Suggest a fitting code.", note: "Draft a note." },
      onRequireAiConfiguration: vi.fn(),
      onSaveAiPrompt: vi.fn(),
      onRestoreAiPrompt: () => "Built-in prompt",
      onRunAi,
      onRunCodeDetailsAi: vi.fn(),
      onAuthorizeCodeDetailsAi: vi.fn(() => null),
      onActivateCodeDialogAiTarget: vi.fn(),
      onInvalidateCodeDialogAiTarget: vi.fn(),
      onCancelAiRun: vi.fn(),
      onStageAiCode: vi.fn(),
      onApplyAiNote: vi.fn(),
      onRejectAiSuggestion: vi.fn()
    };
    const view = render(<CodesInspector {...props} />);
    await user.click(screen.getByRole("button", { name: "AI: Suggest Codes" }));
    const dialog = screen.getByRole("dialog", { name: /Suggest Codes/ });

    view.rerender(<CodesInspector {...props} aiLocked />);
    expect(within(dialog).getByRole("button", { name: "Save as Project Default" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Restore Built-in Default" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Run" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close AI Assistance Dialog" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();

    view.rerender(<CodesInspector {...props} />);
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(onRunAi).toHaveBeenCalledWith("codes", "Suggest a fitting code.");
    expect(screen.getByRole("dialog", { name: /Suggest Codes/ })).toBeInTheDocument();
  });

  it("keeps inspector suggestions visible while decisions persist and retries local decision errors", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const evidence = project.evidence_items[0];
    const onRejectAiSuggestion = vi.fn();
    const existingCodeSuggestion = {
      suggestion_id: "suggestion_code_pending",
      kind: "existing_code" as const,
      code_id: "C000001",
      name: "Opportunity",
      description: "",
      rationale: "The passage describes an opportunity."
    };
    const newCodeSuggestion = {
      suggestion_id: "suggestion_code_review",
      kind: "new_code" as const,
      name: "Emergent Opportunity",
      description: "A newly recognized opportunity.",
      rationale: "No existing code fully captures the passage."
    };
    const noteSuggestion = {
      suggestion_id: "suggestion_note_retry",
      kind: "note" as const,
      note: "The participant frames uncertainty as an opportunity."
    };
    const commonProps = {
      project,
      selectedEvidence: evidence,
      evidenceEditDraft: evidenceEditDraftFromEvidence(evidence),
      evidenceEditDirty: false,
      evidenceDraft: null,
      busy: false,
      canEditProject: true,
      onInspectorMemoChange: vi.fn(),
      onDeleteSelectedEvidence: vi.fn(),
      onSaveSelectedEvidence: vi.fn(),
      onSaveEvidenceDraft: vi.fn(),
      onCancelEvidenceDraft: vi.fn(),
      onCancelSelectedEvidenceChanges: vi.fn(),
      onToggleInspectorCode: vi.fn(),
      onAddInspectorCode: vi.fn(),
      onRemoveInspectorCode: vi.fn(),
      aiConfigured: true,
      aiRun: null,
      aiError: null,
      aiCodeSuggestions: [existingCodeSuggestion, newCodeSuggestion],
      aiCodeDetailsSuggestion: null,
      aiNoteSuggestion: noteSuggestion,
      aiPrompts: { codes: "Suggest a fitting code.", note: "Draft a note." },
      onRequireAiConfiguration: vi.fn(),
      onSaveAiPrompt: vi.fn(),
      onRestoreAiPrompt: () => "Built-in prompt",
      onRunAi: vi.fn(),
      onCancelAiRun: vi.fn(),
      onStageAiCode: vi.fn(),
      onApplyAiNote: vi.fn(),
      aiResultRunIds: { codes: "run_codes", note: "run_note" },
      onRejectAiSuggestion
    };
    const view = render(
      <CodesInspector
        {...commonProps}
        aiDecisionAction={{ kind: "reject", task: "codes", suggestionId: existingCodeSuggestion.suggestion_id, completed: 0, total: 1 }}
      />
    );

    const codeResults = screen.getByLabelText("AI Code Suggestions");
    const pendingCodeCard = within(codeResults).getByText("Opportunity").closest("article");
    expect(pendingCodeCard).not.toBeNull();
    expect(within(pendingCodeCard!).getByRole("button", { name: "Dismissing…" })).toBeDisabled();
    expect(within(codeResults).getByRole("button", { name: "Add" })).toBeDisabled();
    expect(within(codeResults).getByRole("button", { name: "Review" })).toBeDisabled();
    const notePreview = screen.getByText("AI Note Draft").closest(".codes-ai-note-preview");
    expect(notePreview).not.toBeNull();
    expect(within(notePreview!).getByRole("button", { name: "Use Draft" })).toBeDisabled();
    expect(within(notePreview!).getByRole("button", { name: "Cancel" })).toBeDisabled();

    view.rerender(<CodesInspector {...commonProps} aiLocked />);
    expect(within(codeResults).getByRole("button", { name: "Add" })).toBeDisabled();
    expect(within(codeResults).getByRole("button", { name: "Review" })).toBeDisabled();
    expect(within(codeResults).getAllByRole("button", { name: "Dismiss" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(within(notePreview!).getByRole("button", { name: "Use Draft" })).toBeDisabled();
    expect(within(notePreview!).getByRole("button", { name: "Cancel" })).toBeDisabled();

    view.rerender(
      <CodesInspector
        {...commonProps}
        aiDecisionErrorFor={(task, suggestionId) => task === "note" && suggestionId === noteSuggestion.suggestion_id
          ? { kind: "reject", task, suggestionId, message: "The dismissal could not be saved." }
          : null}
      />
    );
    expect(screen.getByText("AI Note Draft")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The dismissal could not be saved.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRejectAiSuggestion).toHaveBeenCalledWith({
      task: "note",
      suggestionId: noteSuggestion.suggestion_id,
      runId: "run_note"
    });
  });

  it("keeps code-detail application draft-only and exposes retryable dismissal state", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const onAuthorizeAiSuggestion = vi.fn((
      _target: CodesCodeDialogTarget,
      currentSuggestion: CodesAiCodeDetailsSuggestion
    ) => currentSuggestion);
    const onActivateAiTarget = vi.fn();
    const onInvalidateAiTarget = vi.fn();
    const onRejectAiSuggestion = vi.fn();
    const suggestion = {
      suggestion_id: "suggestion_code_details",
      run_id: "run_code_details",
      kind: "code_details" as const,
      name: "Opportunity Recognition",
      description: "Identifies a perceived opportunity.",
      inclusion_note: "Include explicit opportunity recognition.",
      exclusion_note: "Exclude general optimism without an opportunity.",
      memo: "Review boundaries after additional coding."
    };
    const commonProps = {
      open: true,
      project,
      busy: false,
      aiConfigured: true,
      aiSuggestion: suggestion,
      aiSuggestionTarget: null,
      aiSurface: "codebook" as const,
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      onRunAi: vi.fn(),
      onAuthorizeAiSuggestion,
      onActivateAiTarget,
      onInvalidateAiTarget,
      onRejectAiSuggestion
    };
    const view = render(<CodesCodeDialog {...commonProps} />);
    await waitFor(() => expect(onActivateAiTarget).toHaveBeenCalledTimes(1));
    const target = onActivateAiTarget.mock.calls[0][0];
    view.rerender(<CodesCodeDialog {...commonProps} aiSuggestionTarget={target} />);

    await user.click(screen.getByRole("button", { name: "Apply to Draft" }));
    expect(onAuthorizeAiSuggestion).toHaveBeenCalledWith(target, suggestion);
    expect(screen.getByRole("textbox", { name: "Code Name" })).toHaveValue("Opportunity Recognition");
    expect(screen.getByRole("textbox", { name: "Definition" })).toHaveValue("Identifies a perceived opportunity.");
    expect(commonProps.onSubmit).not.toHaveBeenCalled();

    view.rerender(
      <CodesCodeDialog
        {...commonProps}
        aiSuggestionTarget={target}
        aiDecisionAction={{ kind: "reject", task: "code_details", suggestionId: suggestion.suggestion_id, completed: 0, total: 1 }}
      />
    );
    expect(screen.getByRole("button", { name: "Apply to Draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismissing…" })).toBeDisabled();

    view.rerender(<CodesCodeDialog {...commonProps} aiSuggestionTarget={target} aiLocked />);
    expect(screen.getByRole("button", { name: "Apply to Draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();

    view.rerender(
      <CodesCodeDialog
        {...commonProps}
        aiSuggestionTarget={target}
        aiDecisionErrorFor={(_task, suggestionId) => ({
          kind: "reject",
          task: "code_details",
          suggestionId,
          message: "The dismissal could not be saved."
        })}
      />
    );
    expect(screen.getByText("Opportunity Recognition")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The dismissal could not be saved.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRejectAiSuggestion).toHaveBeenCalledWith({
      task: "code_details",
      suggestionId: suggestion.suggestion_id,
      runId: suggestion.run_id
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commonProps.onClose).toHaveBeenCalledTimes(1);
    view.rerender(<CodesCodeDialog {...commonProps} open={false} />);
    expect(onInvalidateAiTarget).toHaveBeenCalledWith(target);
  });

  it("authorizes code details before changing the dialog draft and consumes them once per instance", async () => {
    const user = userEvent.setup();
    const suggestion = {
      suggestion_id: "details_authoritative",
      run_id: "run_details_authoritative",
      kind: "code_details" as const,
      name: "Authoritative Name",
      description: "Authoritative definition.",
      inclusion_note: "Include this.",
      exclusion_note: "Exclude that.",
      memo: "Authoritative note."
    };
    const onActivateAiTarget = vi.fn();
    const onInvalidateAiTarget = vi.fn();
    const onSubmit = vi.fn();
    let allowAuthorization = false;
    let consumed = false;
    const onAuthorizeAiSuggestion = vi.fn((
      _target: CodesCodeDialogTarget,
      currentSuggestion: CodesAiCodeDetailsSuggestion
    ) => {
      if (!allowAuthorization || consumed) return null;
      consumed = true;
      return currentSuggestion;
    });
    const props = {
      open: true,
      project: makeProject(),
      aiConfigured: true,
      aiSurface: "inspector" as const,
      aiSuggestion: suggestion,
      aiSuggestionTarget: null,
      onSubmit,
      onClose: vi.fn(),
      onRunAi: vi.fn(),
      onAuthorizeAiSuggestion,
      onActivateAiTarget,
      onInvalidateAiTarget
    };
    const view = render(<CodesCodeDialog {...props} />);
    await waitFor(() => expect(onActivateAiTarget).toHaveBeenCalledTimes(1));
    const firstTarget = onActivateAiTarget.mock.calls[0][0];
    view.rerender(<CodesCodeDialog {...props} aiSuggestionTarget={firstTarget} />);

    const nameInput = screen.getByRole("textbox", { name: "Code Name" });
    await user.type(nameInput, "Researcher Draft");
    await user.click(screen.getByRole("button", { name: "Apply to Draft" }));
    expect(nameInput).toHaveValue("Researcher Draft");

    allowAuthorization = true;
    await user.click(screen.getByRole("button", { name: "Apply to Draft" }));
    await user.click(screen.getByRole("button", { name: "Apply to Draft" }));
    expect(nameInput).toHaveValue("Authoritative Name");
    await user.click(screen.getByRole("button", { name: "Create Code" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "Authoritative Name",
      aiDecisions: [expect.objectContaining({
        run_id: suggestion.run_id,
        suggestion_id: suggestion.suggestion_id,
        task: "code_details"
      })]
    }));

    view.rerender(<CodesCodeDialog {...props} open={false} />);
    view.rerender(<CodesCodeDialog {...props} />);
    await waitFor(() => expect(onActivateAiTarget).toHaveBeenCalledTimes(2));
    const secondTarget = onActivateAiTarget.mock.calls[1][0];
    expect(secondTarget).not.toEqual(firstTarget);
    expect(onInvalidateAiTarget).toHaveBeenCalledWith(firstTarget);
  });

  it("does not expose a code-detail suggestion to another dialog surface", async () => {
    const onActivateAiTarget = vi.fn();
    const suggestion = {
      suggestion_id: "details_inspector",
      run_id: "run_details_inspector",
      kind: "code_details" as const,
      name: "Inspector Result",
      description: "Definition",
      inclusion_note: "",
      exclusion_note: "",
      memo: ""
    };
    render(
      <CodesCodeDialog
        open
        project={makeProject()}
        aiConfigured
        aiSurface="codebook"
        aiSuggestion={suggestion}
        aiSuggestionTarget={{ surface: "inspector", instanceId: "inspector-1" }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        onRunAi={vi.fn()}
        onAuthorizeAiSuggestion={vi.fn(() => suggestion)}
        onActivateAiTarget={onActivateAiTarget}
      />
    );
    await waitFor(() => expect(onActivateAiTarget).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Apply to Draft" })).not.toBeInTheDocument();
  });

  it("keeps code refinement application draft-only and persists only explicit dismissal", async () => {
    const user = userEvent.setup();
    const onApplyAll = vi.fn();
    const onReject = vi.fn();
    const suggestion = {
      suggestion_id: "suggestion_code_refinement",
      run_id: "run_code_refinement",
      kind: "code_refinement" as const,
      name: "Refined Opportunity",
      description: "A more precise definition.",
      inclusion_note: "Include explicit opportunity recognition.",
      exclusion_note: "Exclude general optimism.",
      memo: "Review after more interviews."
    };
    const current = {
      codeId: "C000001",
      name: "Opportunity",
      description: "Current definition.",
      inclusionNote: "",
      exclusionNote: "",
      memo: "",
      color: "#123456",
      exampleEvidenceIds: [],
      aiDecisions: []
    };
    const view = render(
      <CodesCodeRefinementReview
        suggestion={suggestion}
        current={current}
        onApplyField={vi.fn()}
        onApplyAll={onApplyAll}
        onReject={onReject}
      />
    );

    await user.click(screen.getByRole("button", { name: "Apply All" }));
    expect(onApplyAll).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();

    view.rerender(
      <CodesCodeRefinementReview
        suggestion={suggestion}
        current={current}
        decisionAction={{ kind: "reject", task: "code_refinement", suggestionId: suggestion.suggestion_id, completed: 0, total: 1 }}
        onApplyField={vi.fn()}
        onApplyAll={onApplyAll}
        onReject={onReject}
      />
    );
    expect(screen.getByRole("button", { name: "Dismissing…" })).toBeDisabled();

    view.rerender(
      <CodesCodeRefinementReview
        suggestion={suggestion}
        current={current}
        aiLocked
        onApplyField={vi.fn()}
        onApplyAll={onApplyAll}
        onReject={onReject}
      />
    );
    expect(screen.getByRole("button", { name: "Apply All" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();

    view.rerender(
      <CodesCodeRefinementReview
        suggestion={suggestion}
        current={current}
        decisionError="The dismissal could not be saved."
        onApplyField={vi.fn()}
        onApplyAll={onApplyAll}
        onReject={onReject}
      />
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onReject).toHaveBeenCalledWith({
      task: "code_refinement",
      suggestionId: suggestion.suggestion_id,
      runId: suggestion.run_id
    });
  });

  it("keeps theme review and refinement local until save while persisting explicit dismissals", async () => {
    const user = userEvent.setup();
    const project = makeProject();
    const onAccept = vi.fn();
    const onApply = vi.fn();
    const onReject = vi.fn();
    const themeSuggestion = {
      suggestion_id: "suggestion_theme",
      run_id: "run_theme_suggestions",
      kind: "theme_suggestion" as const,
      name: "Opportunity Framing",
      description: "Groups opportunity-related codes.",
      memo: "Review boundaries.",
      rationale: "The codes share a framing pattern.",
      code_ids: ["C000001"]
    };
    const refinementSuggestion = {
      ...themeSuggestion,
      suggestion_id: "suggestion_theme_refinement",
      run_id: "run_theme_refinement",
      kind: "theme_refinement" as const
    };

    const view = render(
      <>
        <CodesThemeSuggestionReviews
          suggestions={[themeSuggestion]}
          project={project}
          onAccept={onAccept}
          onReject={onReject}
        />
        <CodesThemeRefinementReview
          suggestion={refinementSuggestion}
          project={project}
          onApply={onApply}
          onReject={onReject}
        />
      </>
    );

    await user.click(screen.getByRole("button", { name: "Review Theme" }));
    await user.click(screen.getByRole("button", { name: "Apply to Draft" }));
    expect(onAccept).toHaveBeenCalledWith(themeSuggestion);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();

    const suggestionSection = screen.getByLabelText("AI Theme Suggestions");
    await user.click(within(suggestionSection).getByRole("button", { name: "Dismiss" }));
    const refinementSection = screen.getByText("AI Theme Refinement").closest("section");
    expect(refinementSection).not.toBeNull();
    await user.click(within(refinementSection!).getByRole("button", { name: "Dismiss" }));
    expect(onReject).toHaveBeenNthCalledWith(1, {
      task: "theme_suggestions",
      suggestionId: themeSuggestion.suggestion_id,
      runId: themeSuggestion.run_id
    });
    expect(onReject).toHaveBeenNthCalledWith(2, {
      task: "theme_refinement",
      suggestionId: refinementSuggestion.suggestion_id,
      runId: refinementSuggestion.run_id
    });

    view.rerender(
      <CodesThemeSuggestionReviews
        suggestions={[themeSuggestion]}
        project={project}
        decisionAction={{ kind: "reject", task: "theme_suggestions", suggestionId: themeSuggestion.suggestion_id, completed: 0, total: 1 }}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    expect(screen.getByRole("button", { name: "Dismissing…" })).toBeDisabled();

    view.rerender(
      <>
        <CodesThemeSuggestionReviews
          suggestions={[themeSuggestion]}
          project={project}
          aiLocked
          onAccept={onAccept}
          onReject={onReject}
        />
        <CodesThemeRefinementReview
          suggestion={refinementSuggestion}
          project={project}
          aiLocked
          onApply={onApply}
          onReject={onReject}
        />
      </>
    );
    expect(screen.getByRole("button", { name: "Review Theme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply to Draft" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Dismiss" }).every((button) => button.hasAttribute("disabled"))).toBe(true);

    view.rerender(
      <CodesThemeSuggestionReviews
        suggestions={[themeSuggestion]}
        project={project}
        decisionErrorFor={(_task, suggestionId) => ({
          kind: "reject",
          task: "theme_suggestions",
          suggestionId,
          message: "The dismissal could not be saved."
        })}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onReject).toHaveBeenLastCalledWith({
      task: "theme_suggestions",
      suggestionId: themeSuggestion.suggestion_id,
      runId: themeSuggestion.run_id
    });
  });

  it("shows truthful determinate and indeterminate AI progress with cancellation", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const baseRun: CodesAiRunSnapshot = {
      run_id: "ai_run_test",
      project_id: "P000001",
      task: "evidence",
      status: "running",
      phase: "requesting",
      progress_kind: "determinate",
      progress_label: "Analyzing segments 51–100 of 300 · Batch 2 of 6",
      message: "Analyzing segments 51–100 of 300 · Batch 2 of 6",
      progress_completed: 1,
      progress_total: 6,
      results: [],
      omitted: [],
      error: "",
      started_at: new Date().toISOString(),
      finished_at: null
    };

    const { rerender } = render(<CodesAiProgress run={baseRun} timeoutSeconds={180} onCancel={onCancel} />);
    const progress = screen.getByRole("progressbar", { name: "AI progress" });
    expect(progress).toHaveAttribute("value", "1");
    expect(progress).toHaveAttribute("max", "6");
    expect(screen.getByText("1 of 6 batches completed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <CodesAiProgress
        run={{
          ...baseRun,
          task: "note",
          progress_kind: "indeterminate",
          progress_label: "Waiting for LM Studio.",
          message: "Waiting for LM Studio.",
          progress_completed: 0,
          progress_total: 1
        }}
        timeoutSeconds={180}
        onCancel={onCancel}
      />
    );
    expect(screen.queryByRole("progressbar", { name: "AI progress" })).not.toBeInTheDocument();
    expect(screen.getByText("Local model request in progress")).toBeInTheDocument();
    expect(screen.getByText(/180s timeout/)).toBeInTheDocument();
  });
});
