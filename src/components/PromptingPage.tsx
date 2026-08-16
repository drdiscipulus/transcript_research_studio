import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldLabelWithHelp } from "./FieldLabelWithHelp";
import { WorkflowPathField } from "./WorkflowPathField";
import { PromptingModelSettings } from "./prompting/PromptingModelSettings";
import {
  cancelPromptRun,
  createPromptCustomAnalysis,
  deletePromptCustomAnalysis,
  duplicatePromptCustomAnalysis,
  fetchCurrentPromptRun,
  fetchPromptCustomAnalyses,
  openPath,
  pickFolder,
  pickTranscriptFile,
  startPromptRun,
  updatePromptCustomAnalysis,
  type PromptAdvancedMapping,
  type PromptAnalysisSelection,
  type PromptAnalysisType,
  type PromptCustomAnalysis,
  type PromptInputCandidate,
  type PromptingProviderStatus,
  type PromptRunSnapshot
} from "../lib/api";
import { usePromptingModels } from "../hooks/usePromptingModels";
import { usePromptInputPreview } from "../hooks/usePromptInputPreview";
import { useWorkbenchPageLifecycle } from "./workbench/WorkbenchLifecycle";
import { ModalDialog } from "./workbench/ModalDialog";
import {
  ConfirmationDialog,
  type ConfirmationIntent
} from "./workbench/ConfirmationDialog";

type PromptingPageProps = {
  providers: PromptingProviderStatus[];
  providersLoading: boolean;
  providerError: string | null;
  onRefreshProviders: () => void | Promise<void>;
  promptOutputFolder: string;
  suggestedSourceFile: string | null;
  browseHomeFolder: string;
  onPromptOutputFolderChange: (value: string) => void;
};

type PromptingConfirmationIntent = ConfirmationIntent & (
  | { kind: "change-analysis"; sourceId: string; nextId: string }
  | { kind: "close-custom-draft"; mode: "create" | "edit"; analysisId: string | null }
  | { kind: "delete-custom-analysis"; analysisId: string }
);

const BUILT_IN_ANALYSES: Array<{ id: PromptAnalysisType; name: string; description: string; prompt: string }> = [
  {
    id: "overview",
    name: "Transcript Overview",
    description: "Create a concise orientation with topics, key points, entities, and a chronological outline.",
    prompt: "Create a concise research-oriented overview. Identify the main topics and key points; relevant people, organizations, and places; and a short chronological outline where the sequence is analytically useful."
  },
  {
    id: "research_focus",
    name: "Research Focus Analysis",
    description: "Analyze each transcript against a research question and ground findings in verified source passages.",
    prompt: "Analyze the transcript in relation to the stated research focus. Identify supported findings, explain their relevance, note qualifications or counterpoints, and identify aspects that are absent or weakly covered."
  },
  {
    id: "interview_review",
    name: "Interview Review",
    description: "Flag observable interview-quality and structure issues without judging honesty or factual truth.",
    prompt: "Review the interview for incomplete answers, unclear passages, internal inconsistencies, unanswered questions, off-topic material, and structural interview issues. Describe only observable limitations. Never infer dishonesty or claim that a participant statement is factually false."
  }
];

const OUTPUT_FORMATS = ["xlsx", "csv", "json", "docx"];
const TERMINAL_STATUSES = new Set(["completed", "completed_with_problems", "failed", "cancelled", "interrupted"]);

export function PromptingPage({
  providers,
  providersLoading,
  providerError,
  onRefreshProviders,
  promptOutputFolder,
  suggestedSourceFile,
  browseHomeFolder,
  onPromptOutputFolderChange
}: PromptingPageProps) {
  const [inputMode, setInputMode] = useState<"file" | "folder">("file");
  const [inputPath, setInputPath] = useState("");
  const {
    preview,
    previewLoading,
    previewError,
    previewOpen,
    selectedCandidateIds,
    candidateMappings,
    setPreviewOpen,
    selectCandidate,
    updateCandidateMapping,
    clearPreview
  } = usePromptInputPreview(inputMode, inputPath);

  const [outputFormats, setOutputFormats] = useState<string[]>(["xlsx"]);
  const [temperature, setTemperature] = useState(0);
  const [timeoutSeconds, setTimeoutSeconds] = useState(180);

  const [customAnalyses, setCustomAnalyses] = useState<PromptCustomAnalysis[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string>("overview");
  const [researchFocus, setResearchFocus] = useState("");
  const [promptDraft, setPromptDraft] = useState(BUILT_IN_ANALYSES[0].prompt);
  const [customDialog, setCustomDialog] = useState<{ mode: "create" | "edit"; analysis?: PromptCustomAnalysis } | null>(null);
  const [customName, setCustomName] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  const [customActionsOpen, setCustomActionsOpen] = useState(false);
  const [promptDetailsOpen, setPromptDetailsOpen] = useState(false);
  const [confirmationIntent, setConfirmationIntent] = useState<PromptingConfirmationIntent | null>(null);
  const customActionsRef = useRef<HTMLDivElement>(null);
  const customActionsButtonRef = useRef<HTMLButtonElement>(null);

  const [promptRun, setPromptRun] = useState<PromptRunSnapshot | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const availableProviders = useMemo(() => providers.filter((provider) => provider.available), [providers]);
  const {
    selectedProviderId,
    selectedModelId,
    models,
    modelsLoading,
    modelError,
    modelSelectionValid,
    changeProvider,
    setSelectedModelId
  } = usePromptingModels(availableProviders);
  const selectedProvider = availableProviders.find((provider) => provider.id === selectedProviderId) ?? null;
  const selectedBuiltIn = BUILT_IN_ANALYSES.find((analysis) => analysis.id === selectedAnalysisId);
  const selectedCustom = customAnalyses.find((analysis) => analysis.id === selectedAnalysisId);
  const analysisType: PromptAnalysisType = selectedBuiltIn?.id ?? "custom";
  const activeRun = Boolean(promptRun && ["starting", "running", "cancelling"].includes(promptRun.status));
  const cancellationPending = cancelling || promptRun?.status === "cancelling";
  const configurationLocked = starting || activeRun || cancelling;
  const customDialogDirty = Boolean(customDialog && (customName !== (customDialog.analysis?.name ?? "") || customInstructions !== (customDialog.analysis?.instructions ?? "")));
  const selectedAnalysisHelp = selectedBuiltIn?.description
    ?? (selectedCustom ? selectedCustom.instructions : "Choose one built-in or saved custom analysis for this run.");
  const defaultPrompt = promptForAnalysis(selectedAnalysisId);
  const promptCustomized = promptDraft !== defaultPrompt;

  const isActivePage = useWorkbenchPageLifecycle("prompting", {
    dirty: customDialogDirty,
    activeJob: configurationLocked,
    activityLabel: activeRun ? "Transcript analysis in progress" : customDialogDirty ? "Unsaved custom analysis" : ""
  });

  const runRequestSequenceRef = useRef(0);
  const lastAppliedRunRequestRef = useRef(0);
  const promptRunRef = useRef<PromptRunSnapshot | null>(null);
  const pollingCycleRef = useRef(0);
  const cancellationRequestSequenceRef = useRef(0);
  const lastSuggestedSourceRef = useRef<string | null>(null);
  const providerRefreshedForVisitRef = useRef(false);

  const applyRunSnapshot = useCallback((
    snapshot: PromptRunSnapshot,
    requestSequence: number,
    expectedRunId?: string | null
  ) => {
    if (
      requestSequence < runRequestSequenceRef.current
      || requestSequence < lastAppliedRunRequestRef.current
    ) return false;
    const current = promptRunRef.current;
    if (
      expectedRunId
      && (current?.run_id !== expectedRunId || snapshot.run_id !== expectedRunId)
    ) return false;
    if (
      current?.run_id
      && current.run_id === snapshot.run_id
      && TERMINAL_STATUSES.has(current.status)
      && !TERMINAL_STATUSES.has(snapshot.status)
    ) {
      return false;
    }
    if (
      current?.run_id === snapshot.run_id
      && current.status === "cancelling"
      && ["starting", "running"].includes(snapshot.status)
    ) {
      return false;
    }
    lastAppliedRunRequestRef.current = requestSequence;
    promptRunRef.current = snapshot;
    setPromptRun(snapshot);
    return true;
  }, []);

  useEffect(() => {
    setCustomActionsOpen(false);
  }, [selectedAnalysisId, activeRun]);

  useEffect(() => {
    if (!customActionsOpen) return;

    function closeCustomActions(event: globalThis.KeyboardEvent | MouseEvent) {
      if (event instanceof globalThis.KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setCustomActionsOpen(false);
        window.requestAnimationFrame(() => customActionsButtonRef.current?.focus());
        return;
      }
      if (customActionsRef.current && !customActionsRef.current.contains(event.target as Node)) {
        setCustomActionsOpen(false);
      }
    }

    document.addEventListener("keydown", closeCustomActions);
    document.addEventListener("mousedown", closeCustomActions);
    return () => {
      document.removeEventListener("keydown", closeCustomActions);
      document.removeEventListener("mousedown", closeCustomActions);
    };
  }, [customActionsOpen]);

  useEffect(() => {
    let cancelled = false;
    fetchPromptCustomAnalyses()
      .then((payload) => { if (!cancelled) setCustomAnalyses(payload.analyses); })
      .catch(() => { if (!cancelled) setCustomAnalyses([]); });
    const requestSequence = ++runRequestSequenceRef.current;
    fetchCurrentPromptRun()
      .then((snapshot) => {
        if (cancelled) return;
        setRecoveryError(null);
        if (snapshot.status !== "idle") applyRunSnapshot(snapshot, requestSequence);
      })
      .catch(() => {
        if (!cancelled && requestSequence === runRequestSequenceRef.current) {
          setRecoveryError("Previous analysis status could not be recovered. You can still configure a new analysis.");
        }
      });
    return () => { cancelled = true; };
  }, [applyRunSnapshot]);

  useEffect(() => {
    if (!isActivePage) {
      providerRefreshedForVisitRef.current = false;
      return;
    }
    if (configurationLocked || providerRefreshedForVisitRef.current) return;
    providerRefreshedForVisitRef.current = true;
    void onRefreshProviders();
  }, [configurationLocked, isActivePage, onRefreshProviders]);

  useEffect(() => {
    const suggestion = suggestedSourceFile?.trim() ?? "";
    if (!suggestion || suggestion === lastSuggestedSourceRef.current) return;
    lastSuggestedSourceRef.current = suggestion;
    if (!inputPath) {
      clearPreview();
      setInputMode("file");
      setInputPath(suggestion);
    }
  }, [clearPreview, inputPath, suggestedSourceFile]);

  useEffect(() => {
    if (!activeRun || !promptRun?.run_id || cancelling) return;
    const expectedRunId = promptRun.run_id;
    const pollingCycle = ++pollingCycleRef.current;
    let disposed = false;
    let timer: number | undefined;
    async function poll() {
      const requestSequence = ++runRequestSequenceRef.current;
      try {
        const snapshot = await fetchCurrentPromptRun();
        if (disposed || pollingCycle !== pollingCycleRef.current) return;
        const current = promptRunRef.current;
        if (!current || current.run_id !== expectedRunId) return;
        const nextSnapshot = snapshot.status === "idle" || snapshot.run_id !== expectedRunId
          ? {
            ...current,
            status: "interrupted",
            phase: "failed",
            message: "The local service restarted during this analysis. The run was not resubmitted.",
            finished_at: new Date().toISOString()
          }
          : snapshot;
        if (!applyRunSnapshot(nextSnapshot, requestSequence, expectedRunId)) {
          const retainedSnapshot = promptRunRef.current;
          if (
            retainedSnapshot?.run_id === expectedRunId
            && ["starting", "running", "cancelling"].includes(retainedSnapshot.status)
          ) {
            timer = window.setTimeout(() => void poll(), 1000);
          }
          return;
        }
        setPollingError(null);
        setRecoveryError(null);
        if (["starting", "running", "cancelling"].includes(nextSnapshot.status)) {
          timer = window.setTimeout(() => void poll(), 1000);
        }
      } catch {
        if (
          !disposed
          && pollingCycle === pollingCycleRef.current
          && requestSequence === runRequestSequenceRef.current
          && promptRunRef.current?.run_id === expectedRunId
          && !TERMINAL_STATUSES.has(promptRunRef.current.status)
        ) {
          setPollingError("Connection to the local service was interrupted. Reconnecting…");
          timer = window.setTimeout(() => void poll(), 3000);
        }
      }
    }
    timer = window.setTimeout(() => void poll(), 1000);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [activeRun, applyRunSnapshot, cancelling, promptRun?.run_id]);

  async function pickInput(mode: "file" | "folder") {
    if (configurationLocked) return;
    setPathError(null);
    try {
      const path = mode === "file"
        ? await pickTranscriptFile(inputPath || browseHomeFolder)
        : await pickFolder(inputPath || browseHomeFolder);
      if (!path) return;
      clearPreview();
      setInputMode(mode);
      setInputPath(path);
    } catch (error) {
      setPathError(error instanceof Error ? error.message : "Input picker failed.");
    }
  }

  async function pickOutputFolder() {
    if (configurationLocked) return;
    setPathError(null);
    try {
      const path = await pickFolder(promptOutputFolder || browseHomeFolder);
      if (path) onPromptOutputFolderChange(path);
    } catch (error) {
      setPathError(error instanceof Error ? error.message : "Output-folder picker failed.");
    }
  }

  async function handleOpenPath(path: string, directory = false) {
    setPathError(null);
    try {
      await openPath({ path, expect_directory: directory, create_if_missing: directory });
    } catch (error) {
      setPathError(error instanceof Error ? error.message : "The selected path could not be opened.");
    }
  }

  function changeAnalysis(nextId: string) {
    if (configurationLocked) return;
    const defaultPrompt = promptForAnalysis(selectedAnalysisId);
    if (promptDraft !== defaultPrompt) {
      if (confirmationIntent) return;
      setConfirmationIntent({
        kind: "change-analysis",
        id: `change-analysis-${selectedAnalysisId}-${nextId}`,
        sourceId: selectedAnalysisId,
        nextId,
        title: "Discard Prompt Changes?",
        description: "Discard the run-only prompt changes?",
        confirmLabel: "Discard Changes",
        destructive: true
      });
      return;
    }
    applyAnalysisChange(nextId);
  }

  function applyAnalysisChange(nextId: string) {
    setCustomActionsOpen(false);
    setPromptDetailsOpen(false);
    setSelectedAnalysisId(nextId);
    setPromptDraft(promptForAnalysis(nextId));
    setRunError(null);
  }

  function promptForAnalysis(analysisId: string): string {
    return BUILT_IN_ANALYSES.find((analysis) => analysis.id === analysisId)?.prompt
      ?? customAnalyses.find((analysis) => analysis.id === analysisId)?.instructions
      ?? "";
  }

  function openCustomDialog(mode: "create" | "edit", analysis?: PromptCustomAnalysis) {
    if (configurationLocked) return;
    setCustomDialog({ mode, analysis });
    setCustomName(analysis?.name ?? "");
    setCustomInstructions(analysis?.instructions ?? "");
    setCustomError(null);
  }

  function closeCustomDialog() {
    if (customDialogDirty && customDialog) {
      if (confirmationIntent) return;
      setConfirmationIntent({
        kind: "close-custom-draft",
        id: `close-custom-${customDialog.mode}-${customDialog.analysis?.id ?? "new"}`,
        mode: customDialog.mode,
        analysisId: customDialog.analysis?.id ?? null,
        title: "Discard Custom Analysis Draft?",
        description: "Discard this custom-analysis draft?",
        confirmLabel: "Discard Draft",
        destructive: true
      });
      return;
    }
    setCustomDialog(null);
  }

  async function saveCustomAnalysis() {
    if (!customDialog || configurationLocked) return;
    setCustomBusy(true);
    setCustomError(null);
    try {
      const payload = customDialog.mode === "create"
        ? await createPromptCustomAnalysis({ name: customName, instructions: customInstructions })
        : await updatePromptCustomAnalysis({ id: customDialog.analysis!.id, name: customName, instructions: customInstructions });
      setCustomAnalyses(payload.analyses);
      if (payload.analysis) {
        setSelectedAnalysisId(payload.analysis.id);
        setPromptDraft(payload.analysis.instructions);
      }
      setCustomDialog(null);
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : "Custom analysis could not be saved.");
    } finally {
      setCustomBusy(false);
    }
  }

  async function duplicateSelectedCustom() {
    if (!selectedCustom || configurationLocked) return;
    try {
      const payload = await duplicatePromptCustomAnalysis(selectedCustom.id);
      setCustomAnalyses(payload.analyses);
      if (payload.analysis) {
        setSelectedAnalysisId(payload.analysis.id);
        setPromptDraft(payload.analysis.instructions);
      }
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Custom analysis could not be duplicated.");
    }
  }

  async function deleteSelectedCustom() {
    if (!selectedCustom || configurationLocked || confirmationIntent) return;
    setConfirmationIntent({
      kind: "delete-custom-analysis",
      id: `delete-custom-${selectedCustom.id}`,
      analysisId: selectedCustom.id,
      title: "Delete Custom Analysis?",
      description: `Delete the custom analysis “${selectedCustom.name}”?`,
      confirmLabel: "Delete Analysis",
      destructive: true
    });
  }

  async function confirmPromptingIntent(intent: PromptingConfirmationIntent) {
    if (confirmationIntent?.id !== intent.id || configurationLocked) {
      setConfirmationIntent(null);
      return;
    }
    setConfirmationIntent(null);
    if (intent.kind === "change-analysis") {
      if (selectedAnalysisId !== intent.sourceId) return;
      applyAnalysisChange(intent.nextId);
      return;
    }
    if (intent.kind === "close-custom-draft") {
      if (
        customDialog?.mode !== intent.mode
        || (customDialog.analysis?.id ?? null) !== intent.analysisId
      ) return;
      setCustomDialog(null);
      return;
    }
    if (selectedCustom?.id !== intent.analysisId) return;
    try {
      const payload = await deletePromptCustomAnalysis(intent.analysisId);
      setCustomAnalyses(payload.analyses);
      setSelectedAnalysisId("overview");
      setPromptDraft(BUILT_IN_ANALYSES[0].prompt);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Custom analysis could not be deleted.");
    }
  }

  const equivalentGroupsComplete = useMemo(() => {
    if (!preview) return false;
    const groups = Array.from(new Set(preview.candidates.map((candidate) => candidate.equivalent_group).filter(Boolean)));
    return groups.every((group) => preview.candidates.filter((candidate) => candidate.equivalent_group === group && selectedCandidateIds.includes(candidate.candidate_id)).length === 1);
  }, [preview, selectedCandidateIds]);

  const candidateSelectionValid = useMemo(() => {
    if (!preview || selectedCandidateIds.length === 0) return false;
    const selectableIds = new Set(
      preview.candidates
        .filter((candidate) => candidate.status === "ready" || candidate.status === "equivalent_format")
        .map((candidate) => candidate.candidate_id)
    );
    return selectedCandidateIds.every((candidateId) => selectableIds.has(candidateId));
  }, [preview, selectedCandidateIds]);

  const canStart = Boolean(
    selectedProvider?.available
    && modelSelectionValid
    && inputPath
    && preview
    && !previewLoading
    && !previewError
    && candidateSelectionValid
    && equivalentGroupsComplete
    && preview.counts.mapping_required === 0
    && promptOutputFolder.trim()
    && outputFormats.length > 0
    && promptDraft.trim()
    && (analysisType !== "research_focus" || researchFocus.trim())
    && !configurationLocked
  );

  async function startRun() {
    if (!canStart) return;
    setRunError(null);
    setPollingError(null);
    setRecoveryError(null);
    setStarting(true);
    const requestSequence = ++runRequestSequenceRef.current;
    const analysis: PromptAnalysisSelection = {
      type: analysisType,
      name: selectedBuiltIn?.name ?? selectedCustom?.name,
      prompt: promptDraft,
      research_focus: analysisType === "research_focus" ? researchFocus : undefined,
      custom_analysis_id: selectedCustom?.id
    };
    try {
      const snapshot = await startPromptRun({
        provider_id: selectedProviderId,
        model_id: selectedModelId,
        input_mode: inputMode,
        input_path: inputPath,
        advanced_mapping: {},
        tasks: {},
        temperature,
        timeout_seconds: timeoutSeconds,
        output_folder: promptOutputFolder,
        output_naming_mode: "input",
        output_basename: "",
        output_formats: [...outputFormats],
        selected_candidate_ids: [...selectedCandidateIds],
        candidate_mappings: Object.fromEntries(
          Object.entries(candidateMappings).map(([path, mapping]) => [path, { ...mapping }])
        ),
        analysis
      });
      applyRunSnapshot(snapshot, requestSequence);
    } catch (error) {
      if (requestSequence === runRequestSequenceRef.current) {
        setRunError(error instanceof Error ? error.message : "Transcript analysis could not be started.");
      }
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun() {
    const expectedRunId = promptRunRef.current?.run_id;
    if (!expectedRunId) return;
    const cancellationRequestSequence = ++cancellationRequestSequenceRef.current;
    setRunError(null);
    setCancelling(true);
    const requestSequence = ++runRequestSequenceRef.current;
    try {
      const snapshot = await cancelPromptRun();
      if (cancellationRequestSequence !== cancellationRequestSequenceRef.current) return;
      if (applyRunSnapshot(snapshot, requestSequence, expectedRunId)) {
        setRunError(null);
        setPollingError(null);
        setRecoveryError(null);
      }
    } catch (error) {
      if (
        cancellationRequestSequence === cancellationRequestSequenceRef.current
        && requestSequence === runRequestSequenceRef.current
        && promptRunRef.current?.run_id === expectedRunId
      ) {
        setRunError(error instanceof Error ? error.message : "Cancellation failed.");
      }
    } finally {
      if (cancellationRequestSequence === cancellationRequestSequenceRef.current) {
        setCancelling(false);
      }
    }
  }

  function newRun() {
    runRequestSequenceRef.current += 1;
    lastAppliedRunRequestRef.current = runRequestSequenceRef.current;
    promptRunRef.current = null;
    setInputPath("");
    clearPreview();
    setResearchFocus("");
    setPromptRun(null);
    setRunError(null);
    setPollingError(null);
    setRecoveryError(null);
  }

  const statusText = runError ?? pathError ?? previewError ?? modelError ?? pollingError ?? recoveryError ?? providerError
    ?? promptRun?.message
    ?? (previewLoading ? "Inspecting transcript input…" : !inputPath ? "Choose a transcript file or folder." : "Ready to run transcript analysis.");

  return (
    <div className="page-stack transcript-analysis-page">
      <section className="page-header compact-page-header transcription-page-header">
        <h2 className="home-main-title">Transcript Analysis</h2>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Inputs and Outputs</h3>
          </div>
        </div>
        <div className="transcription-io-columns analysis-io-grid">
          <section className="transcription-io-column" aria-labelledby="analysis-input-heading">
            <h4 id="analysis-input-heading" className="transcription-io-column-title">Input</h4>
            <WorkflowPathField
              label="Transcript Input"
              helpText="Choose one transcript file or a nonrecursive folder containing JSON, XLSX, CSV, or DOCX transcripts."
              value={inputPath}
              placeholder="Choose a transcript file or folder"
              browseLabel="File"
              secondaryBrowseLabel="Folder"
              onBrowse={() => void pickInput("file")}
              onSecondaryBrowse={() => void pickInput("folder")}
              onOpen={() => void handleOpenPath(inputPath, inputMode === "folder")}
              onReset={() => { clearPreview(); setInputPath(""); }}
              inlineBrowse
              resetLabel="Clear"
              disabled={configurationLocked}
            />
          </section>
          <section className="transcription-io-column" aria-labelledby="analysis-output-heading">
            <h4 id="analysis-output-heading" className="transcription-io-column-title">Output</h4>
            <WorkflowPathField
              label="Analysis Output Folder"
              value={promptOutputFolder}
              placeholder="Choose an analysis output folder"
              onBrowse={() => void pickOutputFolder()}
              onOpen={() => void handleOpenPath(promptOutputFolder, true)}
              onReset={() => onPromptOutputFolderChange("")}
              inlineBrowse
              resetLabel="Clear"
              disabled={configurationLocked}
            />
            <div className="field-group transcription-field transcription-field-formats analysis-output-formats">
              <FieldLabelWithHelp
                label="Output Formats"
                helpText="XLSX creates a workbook, CSV creates task tables, JSON preserves structured results, and DOCX creates a readable report. Files are named automatically from the selected input and analysis."
              />
              <div className="transcription-format-grid analysis-format-grid" role="group" aria-label="Output formats">
                {OUTPUT_FORMATS.map((format) => (
                  <label key={format} className="transcription-plain-checkbox analysis-format-checkbox">
                    <input
                      type="checkbox"
                      checked={outputFormats.includes(format)}
                      disabled={configurationLocked}
                      onChange={() => setOutputFormats((current) => current.includes(format) ? current.filter((item) => item !== format) : [...current, format])}
                    />
                    <span>{format.toUpperCase()}</span>
                  </label>
                ))}
              </div>
            </div>
          </section>
        </div>
        {preview ? (
          <details className="analysis-preview" open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary>
              Input Preview · {preview.counts.ready} Ready · {preview.counts.decisions_required} Decisions Required · {preview.counts.problems} Problems
            </summary>
            <div className="analysis-candidate-list">
              {preview.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.candidate_id}
                  candidate={candidate}
                  selected={selectedCandidateIds.includes(candidate.candidate_id)}
                  locked={configurationLocked || previewLoading}
                  onSelect={() => {
                    if (!configurationLocked && !previewLoading) selectCandidate(candidate);
                  }}
                  onMappingChange={(key, value) => {
                    if (!configurationLocked && !previewLoading) updateCandidateMapping(candidate, key, value);
                  }}
                />
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <PromptingModelSettings
        providersLoading={providersLoading}
        providerError={providerError}
        availableProviders={availableProviders}
        selectedProvider={selectedProvider}
        selectedProviderId={selectedProviderId}
        models={models}
        modelsLoading={modelsLoading}
        selectedModelId={selectedModelId}
        temperature={temperature}
        timeoutSeconds={timeoutSeconds}
        providerHelpText="Choose a running local Ollama or LM Studio provider."
        modelHelpText="Choose the local model used for this analysis."
        temperatureHelpText="Lower values are more reproducible; 0 is the recommended default."
        timeoutHelpText="Maximum seconds for each local-model request."
        configurationLocked={configurationLocked}
        onRefreshProviders={() => void onRefreshProviders()}
        onSelectedProviderIdChange={changeProvider}
        onSelectedModelIdChange={setSelectedModelId}
        onTemperatureChange={setTemperature}
        onTimeoutSecondsChange={setTimeoutSeconds}
      />

      <section className="section-card analysis-configuration-card">
        <div className="analysis-section-heading">
          <h3 className="home-section-title">Analysis</h3>
          <FieldLabelWithHelp label="Analysis" helpText={selectedAnalysisHelp} hideLabel />
        </div>
        <div className="analysis-selector-row">
          <select
            className="text-input analysis-selector"
            aria-label="Analysis"
            title={selectedBuiltIn?.name ?? selectedCustom?.name ?? "Analysis"}
            value={selectedAnalysisId}
            disabled={configurationLocked}
            onChange={(event) => changeAnalysis(event.target.value)}
          >
            <optgroup label="Built-in Analyses">
              {BUILT_IN_ANALYSES.map((analysis) => <option key={analysis.id} value={analysis.id} title={analysis.name}>{analysis.name}</option>)}
            </optgroup>
            {customAnalyses.length ? (
              <optgroup label="Custom Analyses">
                {customAnalyses.map((analysis) => <option key={analysis.id} value={analysis.id} title={analysis.name}>{analysis.name}</option>)}
              </optgroup>
            ) : null}
          </select>
          <div className="analysis-selector-actions">
            <button type="button" className="secondary-button" onClick={() => openCustomDialog("create")} disabled={configurationLocked}>New Custom Analysis…</button>
            {selectedCustom ? (
              <div className="codes-entity-actions-menu analysis-custom-actions-menu" ref={customActionsRef}>
                <button
                  ref={customActionsButtonRef}
                  type="button"
                  className="secondary-button"
                  aria-expanded={customActionsOpen}
                  aria-haspopup="true"
                  onClick={() => setCustomActionsOpen((open) => !open)}
                  disabled={configurationLocked}
                >
                  Actions
                </button>
                {customActionsOpen ? (
                  <div className="codes-entity-actions-popover analysis-custom-actions-popover" role="group" aria-label="Custom analysis actions">
                    <button type="button" className="secondary-button" onClick={() => { setCustomActionsOpen(false); openCustomDialog("edit", selectedCustom); }}>Edit</button>
                    <button type="button" className="secondary-button" onClick={() => { setCustomActionsOpen(false); void duplicateSelectedCustom(); }}>Duplicate</button>
                    <button type="button" className="secondary-button danger-button" onClick={() => { setCustomActionsOpen(false); void deleteSelectedCustom(); }}>Delete</button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {analysisType === "research_focus" ? (
          <div className="field-group analysis-focus-field">
            <FieldLabelWithHelp label="Research Question or Analytical Focus" helpText="Findings are evaluated against this required focus and grounded in verified transcript excerpts." htmlFor="analysis-research-focus" />
            <textarea
              id="analysis-research-focus"
              className="text-input analysis-focus-input"
              value={researchFocus}
              onChange={(event) => setResearchFocus(event.target.value)}
              disabled={configurationLocked}
              required
              aria-required="true"
            />
          </div>
        ) : null}
        <div className={`transcription-advanced-accordion analysis-prompt-accordion${promptDetailsOpen ? " open" : ""}`}>
          <button
            type="button"
            className="transcription-advanced-summary"
            aria-expanded={promptDetailsOpen}
            aria-controls="analysis-prompt-customization-content"
            onClick={() => setPromptDetailsOpen((open) => !open)}
          >
            <span className="transcription-advanced-chevron" aria-hidden="true">›</span>
            <span className="transcription-advanced-summary-label">Customize Prompt</span>
            {promptCustomized ? <span className="transcription-advanced-customized-badge">Customized</span> : null}
          </button>
          <div
            id="analysis-prompt-customization-content"
            className="transcription-advanced-accordion-content analysis-prompt-content"
            hidden={!promptDetailsOpen}
          >
            <div className="field-group">
              <FieldLabelWithHelp label="Researcher Instructions" helpText="Changes apply only to this run. Protected response and source-validation rules cannot be changed." htmlFor="analysis-researcher-instructions" />
              <textarea id="analysis-researcher-instructions" className="text-input analysis-prompt-input" value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} disabled={configurationLocked} />
            </div>
            <button type="button" className="secondary-button" onClick={() => setPromptDraft(defaultPrompt)} disabled={configurationLocked || !promptCustomized}>
              {selectedCustom ? "Restore Saved Instructions" : "Restore Built-in Prompt"}
            </button>
          </div>
        </div>
      </section>

      <section className="section-card analysis-run-card">
        <div className="section-heading"><h3 className="home-section-title">Run Analysis</h3></div>
        <div className="analysis-run-summary" role={(runError || previewError || modelError || pollingError || recoveryError || providerError) ? "alert" : "status"}>
          <strong>Status</strong>
          <span>{statusText}</span>
        </div>
        <div className="analysis-run-actions">
          {activeRun ? (
            <button type="button" className="secondary-button" disabled={cancellationPending} onClick={() => void cancelRun()}>{cancellationPending ? "Cancelling…" : "Cancel"}</button>
          ) : (
            <button type="button" className="primary-button" disabled={!canStart} onClick={() => void startRun()}>{starting ? "Starting…" : "Start"}</button>
          )}
          {promptRun && TERMINAL_STATUSES.has(promptRun.status) ? <button type="button" className="secondary-button" onClick={newRun}>New Run</button> : null}
          <div className="analysis-counts" aria-label="Run counts">
            <span>{promptRun?.counts?.done ?? 0} Completed</span>
            <span>{promptRun?.counts?.failed ?? 0} Failed</span>
            <span>{promptRun?.counts?.excluded ?? preview?.counts.problems ?? 0} Excluded</span>
            <span>{promptRun?.rows_generated ?? 0} Results</span>
          </div>
        </div>
        {promptRun ? (
          <div className="analysis-progress-block">
            <progress max={100} value={promptRun.progress_percent} aria-label={promptRun.progress_label || "Analysis progress"} />
            <span>{promptRun.progress_label || `${promptRun.progress_percent}%`}</span>
          </div>
        ) : null}
        {promptRun?.transcript_outcomes?.length ? (
          <details className="analysis-results-details">
            <summary>Transcript Outcomes ({promptRun.transcript_outcomes.length})</summary>
            {promptRun.transcript_outcomes.map((outcome) => (
              <div className="analysis-outcome-row" key={`${outcome.transcript_id}-${outcome.source_file}`}>
                <strong>{outcome.transcript_id}</strong><span>{titleCase(outcome.status)}</span><span>{outcome.error || `${outcome.result_count} results`}</span>
              </div>
            ))}
          </details>
        ) : null}
        {promptRun?.exclusions?.length ? (
          <details className="analysis-results-details">
            <summary>Problems and Exclusions ({promptRun.exclusions.length})</summary>
            {promptRun.exclusions.map((item, index) => <div className="analysis-outcome-row" key={`${item.source_path}-${index}`}><strong>{item.file_name}</strong><span>{item.message}</span></div>)}
          </details>
        ) : null}
        {promptRun?.warnings?.length ? (
          <details className="analysis-results-details">
            <summary>Warnings ({promptRun.warnings.length})</summary>
            {promptRun.warnings.map((warning, index) => (
              <div className="analysis-outcome-row" key={`${warning}-${index}`}><span>{warning}</span></div>
            ))}
          </details>
        ) : null}
        {promptRun?.output_files?.length ? (
          <details className="analysis-results-details" open>
            <summary>Created Outputs ({promptRun.output_files.length})</summary>
            {promptRun.output_files.map((file) => <div className="analysis-output-row" key={file.path}><strong>{file.format.toUpperCase()} · {titleCase(file.role ?? "result")}</strong><span>{file.path}</span></div>)}
            <div className="action-row">
              <button type="button" className="secondary-button" onClick={() => void handleOpenPath(promptOutputFolder, true)}>Open Output Folder</button>
              {promptRun.log_file ? <button type="button" className="secondary-button" onClick={() => void handleOpenPath(parentPath(promptRun.log_file!), true)}>Open Logs Folder</button> : null}
            </div>
          </details>
        ) : null}
      </section>

      <ModalDialog
        open={Boolean(customDialog)}
        instanceKey={customDialog ? `${customDialog.mode}-${customDialog.analysis?.id ?? "new"}` : null}
        className="analysis-custom-dialog"
        title={customDialog?.mode === "create" ? "New Custom Analysis" : "Edit Custom Analysis"}
        cancelDisabled={customBusy}
        onCancel={closeCustomDialog}
        footer={customDialog ? (
          <>
            <button type="button" className="primary-button" disabled={customBusy || !customName.trim() || !customInstructions.trim()} onClick={() => void saveCustomAnalysis()}>{customBusy ? "Saving…" : customDialog.mode === "create" ? "Create Analysis" : "Save Changes"}</button>
            <button type="button" className="secondary-button" disabled={customBusy} onClick={closeCustomDialog}>Cancel</button>
          </>
        ) : null}
      >
        {customDialog ? (
          <>
            <label className="field-group"><span className="field-label">Name</span><input className="text-input" value={customName} onChange={(event) => setCustomName(event.target.value)} autoFocus /></label>
            <label className="field-group"><span className="field-label">Instructions</span><textarea className="text-input analysis-custom-instructions" value={customInstructions} onChange={(event) => setCustomInstructions(event.target.value)} /></label>
            {customError ? <div className="inline-alert" role="alert">{customError}</div> : null}
          </>
        ) : null}
      </ModalDialog>
      <ConfirmationDialog
        intent={confirmationIntent}
        busy={configurationLocked}
        onCancel={() => setConfirmationIntent(null)}
        onConfirm={(intent) => void confirmPromptingIntent(intent as PromptingConfirmationIntent)}
      />
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  locked,
  onSelect,
  onMappingChange
}: {
  candidate: PromptInputCandidate;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onMappingChange: (key: keyof PromptAdvancedMapping, value: string) => void;
}) {
  const isEquivalent = candidate.status === "equivalent_format";
  const selectable = candidate.status === "ready" || isEquivalent;
  return (
    <article className={`analysis-candidate ${candidate.status}`}>
      <label className="analysis-candidate-main">
        <input
          type={isEquivalent ? "radio" : "checkbox"}
          name={isEquivalent ? candidate.equivalent_group ?? undefined : undefined}
          checked={selected}
          disabled={locked || !selectable}
          onChange={onSelect}
        />
        <span><strong>{candidate.title}</strong><small>{candidate.file_name} · {candidate.format.toUpperCase()} · {candidate.segment_count} segments</small></span>
        <span className="status-pill">{candidate.recommended ? "Recommended JSON" : titleCase(candidate.status)}</span>
      </label>
      <small>{candidate.reason}</small>
      {candidate.mapping_columns.length ? (
        <details className="analysis-mapping-details" open={candidate.status === "mapping_required"}>
          <summary>Column Mapping</summary>
          <div className="analysis-mapping-grid">
            {([
              ["text_column", "Text Column"],
              ["transcript_id_column", "Transcript ID"],
              ["speaker_column", "Speaker"],
              ["start_column", "Start Time"],
              ["end_column", "End Time"]
            ] as Array<[keyof PromptAdvancedMapping, string]>).map(([key, label]) => (
              <label className="field-group" key={key}>
                <span className="field-label">{label}{key === "text_column" ? " *" : ""}</span>
                <select className="text-input" value={candidate.mapping[key] ?? ""} onChange={(event) => onMappingChange(key, event.target.value)} disabled={locked}>
                  <option value="">Not Set</option>
                  {candidate.mapping_columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function parentPath(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}
