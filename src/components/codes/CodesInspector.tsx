import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  CodesAiDecisionActiveAction,
  CodesAiDecisionError,
  CodesAiSuggestionRejection
} from "../../hooks/useCodesAiDecisionLifecycle";
import type { CodesAiCodeDetailsSuggestion, CodesAiCodeSuggestion, CodesAiNoteSuggestion, CodesAiRunSnapshot, CodesAiRunTask, CodesEvidenceItem, CodesProject } from "../../lib/api";
import type { EvidenceDraft, EvidenceEditDraft } from "./codesPageUtils";
import { timestampRangeLabel } from "./codesPageUtils";
import { CodesAiActionButton } from "./CodesAiActionButton";
import { CodesAiProgress } from "./CodesAiProgress";
import type { ContextualAiTask } from "./codesAiPrompts";
import {
  CodesCodeDialog,
  type CodeDialogValue,
  type CodesCodeDialogTarget
} from "./CodesCodeDialog";
import { emptyCodeForm } from "./codesPageUtils";
import { ModalDialog } from "../workbench/ModalDialog";

type CodesInspectorProps = {
  project: CodesProject;
  selectedEvidence: CodesEvidenceItem | null;
  evidenceEditDraft: EvidenceEditDraft | null;
  evidenceEditDirty: boolean;
  evidenceDraft: EvidenceDraft | null;
  busy: boolean;
  canEditProject: boolean;
  onInspectorMemoChange: (value: string) => void;
  onDeleteSelectedEvidence: () => void;
  onSaveSelectedEvidence: () => void;
  onSaveEvidenceDraft: () => void;
  onCancelEvidenceDraft: () => void;
  onCancelSelectedEvidenceChanges: () => void;
  onToggleInspectorCode: (codeId: string) => void;
  onAddInspectorCode: (value: CodeDialogValue, suggestion?: CodesAiCodeSuggestion, runId?: string) => string;
  onRemoveInspectorCode: (clientId: string) => void;
  aiConfigured: boolean;
  aiRun: CodesAiRunSnapshot | null;
  aiBusyTask?: CodesAiRunTask | null;
  aiLocked?: boolean;
  aiCancellationPending?: boolean;
  aiConnectionMessage?: string;
  aiError: string | null;
  aiCodeDetailsError?: string | null;
  aiWarning?: string | null;
  aiDecisionAction?: CodesAiDecisionActiveAction | null;
  aiDecisionErrorFor?: (task: CodesAiRunTask, suggestionId: string) => CodesAiDecisionError | null;
  aiResultRunIds?: Partial<Record<"codes" | "note", string>>;
  aiCodeSuggestions: CodesAiCodeSuggestion[];
  aiCodeDetailsSuggestion: CodesAiCodeDetailsSuggestion | null;
  aiCodeDetailsSuggestionTarget: CodesCodeDialogTarget | null;
  aiNoteSuggestion: CodesAiNoteSuggestion | null;
  aiPrompts: { codes: string; note: string };
  onRequireAiConfiguration: () => void;
  onSaveAiPrompt: (task: ContextualAiTask, prompt: string) => void;
  onRestoreAiPrompt: (task: ContextualAiTask) => string | null;
  onRunAi: (task: "codes" | "note", researcherPrompt: string) => void | boolean | Promise<boolean>;
  onRunCodeDetailsAi: (value: CodeDialogValue, target: CodesCodeDialogTarget, selectedText: string) => void;
  onAuthorizeCodeDetailsAi: (
    target: CodesCodeDialogTarget,
    suggestion: CodesAiCodeDetailsSuggestion
  ) => CodesAiCodeDetailsSuggestion | null;
  onActivateCodeDialogAiTarget: (target: CodesCodeDialogTarget) => void;
  onInvalidateCodeDialogAiTarget: (target: CodesCodeDialogTarget) => void;
  onCancelAiRun: () => void;
  onRetryAiRun?: () => void;
  onStageAiCode: (suggestion: CodesAiCodeSuggestion, runId: string) => void;
  onApplyAiNote: (suggestion: CodesAiNoteSuggestion, runId: string, mode: "use" | "replace" | "append") => void;
  onRejectAiSuggestion: (rejection: CodesAiSuggestionRejection) => void;
};

export function CodesInspector({
  project,
  selectedEvidence,
  evidenceEditDraft,
  evidenceEditDirty,
  evidenceDraft,
  busy,
  canEditProject,
  onInspectorMemoChange,
  onDeleteSelectedEvidence,
  onSaveSelectedEvidence,
  onSaveEvidenceDraft,
  onCancelEvidenceDraft,
  onCancelSelectedEvidenceChanges,
  onToggleInspectorCode,
  onAddInspectorCode,
  onRemoveInspectorCode,
  aiConfigured = false,
  aiRun = null,
  aiBusyTask = null,
  aiLocked = false,
  aiCancellationPending = false,
  aiConnectionMessage = "",
  aiError = null,
  aiCodeDetailsError = null,
  aiWarning = null,
  aiDecisionAction = null,
  aiDecisionErrorFor = () => null,
  aiResultRunIds = {},
  aiCodeSuggestions = [],
  aiCodeDetailsSuggestion = null,
  aiCodeDetailsSuggestionTarget = null,
  aiNoteSuggestion = null,
  aiPrompts = { codes: "", note: "" },
  onRequireAiConfiguration = () => {},
  onSaveAiPrompt = () => {},
  onRestoreAiPrompt = () => "",
  onRunAi = () => {},
  onRunCodeDetailsAi = () => {},
  onAuthorizeCodeDetailsAi = () => null,
  onActivateCodeDialogAiTarget = () => {},
  onInvalidateCodeDialogAiTarget = () => {},
  onCancelAiRun = () => {},
  onRetryAiRun = () => {},
  onStageAiCode = () => {},
  onApplyAiNote = () => {},
  onRejectAiSuggestion = () => {}
}: CodesInspectorProps) {
  const [codeSearch, setCodeSearch] = useState("");
  const [openCodePanel, setOpenCodePanel] = useState<"existing" | null>(null);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [codeDialogInitial, setCodeDialogInitial] = useState<CodeDialogValue | null>(null);
  const [codeDialogSuggestion, setCodeDialogSuggestion] = useState<CodesAiCodeSuggestion | undefined>();
  const [codeDialogSuggestionRunId, setCodeDialogSuggestionRunId] = useState("");
  const [aiDialogTask, setAiDialogTask] = useState<"codes" | "note" | null>(null);
  const [aiPromptDraft, setAiPromptDraft] = useState("");
  const hasEvidenceContext = Boolean(evidenceDraft || selectedEvidence);
  const assignedCodeIds = useMemo(
    () => evidenceDraft?.codeIds ?? evidenceEditDraft?.codeIds ?? [],
    [evidenceDraft?.codeIds, evidenceEditDraft?.codeIds]
  );
  const provisionalCodes = evidenceDraft?.newCodes ?? evidenceEditDraft?.newCodes ?? [];
  const assignedCodes = project.codes.filter((code) => assignedCodeIds.includes(code.code_id));
  const unassignedCodes = useMemo(
    () => project.codes.filter((code) => !assignedCodeIds.includes(code.code_id)),
    [assignedCodeIds, project.codes]
  );
  const availableCodes = useMemo(() => {
    const query = codeSearch.trim().toLocaleLowerCase();
    return unassignedCodes.filter((code) => !query || code.name.toLocaleLowerCase().includes(query));
  }, [codeSearch, unassignedCodes]);
  const assignmentUnavailableLabel = !project.codes.length
    ? "No Existing Codes"
    : !unassignedCodes.length
      ? "All Codes Assigned"
      : "";
  const contextTranscriptId = evidenceDraft?.transcriptId ?? selectedEvidence?.transcript_id ?? "";
  const transcript = project.transcripts.find((item) => item.transcript_id === contextTranscriptId);
  const contextSegments = transcript?.segments.filter((segment) => (evidenceDraft?.segmentIds ?? selectedEvidence?.segment_ids ?? []).includes(segment.segment_id)) ?? [];
  const contextSpeakerIds = selectedEvidence?.speaker
    ? [selectedEvidence.speaker]
    : [...new Set(contextSegments.map((segment) => segment.speaker).filter(Boolean))];
  const contextSpeaker = contextSpeakerIds
    .map((speakerId) => transcript?.speakers.find((speaker) => speaker.id === speakerId)?.name || speakerId)
    .join(", ");
  const contextTime = selectedEvidence
    ? timestampRangeLabel(selectedEvidence.start, selectedEvidence.end)
    : timestampRangeLabel(
      contextSegments[0]?.start ?? null,
      contextSegments[contextSegments.length - 1]?.end ?? null,
    );
  const aiRunning = aiLocked;
  const aiDecisionBusy = Boolean(aiDecisionAction);
  const aiSuggestionActionsLocked = aiRunning || aiDecisionBusy;
  const codeAiRunning = aiBusyTask === "codes";
  const noteAiRunning = aiBusyTask === "note";
  const decisionPendingFor = (task: CodesAiRunTask, suggestionId: string) => Boolean(
    aiDecisionAction?.kind === "reject"
    && aiDecisionAction.task === task
    && aiDecisionAction.suggestionId === suggestionId
  );

  useEffect(() => {
    if (aiDialogTask) setAiPromptDraft(aiPrompts[aiDialogTask]);
  }, [aiDialogTask, aiPrompts]);

  function openAiDialog(task: "codes" | "note") {
    if (!aiConfigured) {
      onRequireAiConfiguration();
      return;
    }
    setAiDialogTask(task);
    setAiPromptDraft(aiPrompts[task]);
  }
  function openNewCodeDialog(suggestion?: CodesAiCodeSuggestion) {
    setOpenCodePanel(null);
    setCodeDialogSuggestion(suggestion);
    setCodeDialogSuggestionRunId(suggestion ? aiResultRunIds.codes ?? "" : "");
    setCodeDialogInitial({
      ...emptyCodeForm,
      name: suggestion?.name ?? "",
      description: suggestion?.description ?? "",
      memo: "",
      aiDecisions: [],
      useCurrentEvidenceAsExample: false
    });
    setCodeDialogOpen(true);
  }

  function rejectAiSuggestion(suggestionId: string, task: "codes" | "note") {
    onRejectAiSuggestion({ task, suggestionId, runId: aiResultRunIds[task] ?? "" });
  }

  return (
    <section className="section-card codes-inspector-panel">
      <div className="section-heading">
        <h3 className="home-section-title">Evidence Inspector</h3>
      </div>

      {!hasEvidenceContext ? (
        <div className="empty-state compact-empty-state">
          <strong>No Evidence Selected</strong>
          <p>Select transcript text to create evidence, or open saved evidence above.</p>
        </div>
      ) : (
        <div className="codes-inspector-stack">
          <div className="codes-evidence-context-meta compact">
            <strong>{transcript?.label ?? "Unknown Transcript"}</strong>
            <span>
              {contextSpeaker || "No Speaker"} · {contextTime} · {selectedEvidence?.evidence_id ?? "New Evidence"}
            </span>
          </div>

          <div className="codes-panel-section">
            <span className="field-label">Text</span>
            <div className="codes-selected-text">{evidenceDraft?.selectedText ?? selectedEvidence?.selected_text}</div>
          </div>

          <div className="codes-panel-section">
            <div className="codes-inspector-section-heading">
              <span className="field-label">Codes</span>
            </div>

            {assignedCodes.length || provisionalCodes.length ? (
              <div className="codes-assigned-code-list">
                {assignedCodes.map((code) => (
                  <span key={code.code_id} className="codes-assigned-code-chip">
                    <span className="codes-color-dot" style={{ backgroundColor: code.color }} />
                    <span>{code.name}</span>
                    <button type="button" onClick={() => onToggleInspectorCode(code.code_id)} disabled={busy} aria-label={`Remove ${code.name} from evidence`} title="Remove Assignment">×</button>
                  </span>
                ))}
                {provisionalCodes.map((code) => (
                  <span key={code.clientId} className="codes-assigned-code-chip provisional" title="This code will be created when the evidence is saved.">
                    <span className="codes-color-dot" style={{ backgroundColor: code.color }} />
                    <span>{code.name}</span>
                    <button type="button" onClick={() => onRemoveInspectorCode(code.clientId)} disabled={busy} aria-label={`Remove provisional code ${code.name}`} title="Remove Assignment">×</button>
                  </span>
                ))}
              </div>
            ) : <span className="editor-muted">No Codes Assigned</span>}

            <div className="codes-inspector-code-actions">
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => openNewCodeDialog()}
                disabled={busy || aiDecisionBusy}
                aria-label="Create New Code"
                title="Create New Code"
              >
                New Code
              </button>
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => setOpenCodePanel((current) => current === "existing" ? null : "existing")}
                disabled={busy || aiDecisionBusy || Boolean(assignmentUnavailableLabel)}
                aria-label={openCodePanel === "existing" ? "Close Existing Code List" : "Assign Existing Code"}
                aria-expanded={openCodePanel === "existing"}
                title={assignmentUnavailableLabel || (openCodePanel === "existing" ? "Close Existing Code List" : "Assign Existing Code")}
              >
                {openCodePanel === "existing" ? "Close List" : "Assign Code"}
              </button>
            </div>

            {openCodePanel === "existing" && !assignmentUnavailableLabel ? (
              <div className="codes-assign-existing-panel">
                <input className="text-input" aria-label="Search Existing Codes" value={codeSearch} placeholder="Search codes" onChange={(event) => setCodeSearch(event.target.value)} />
                <div className="codes-available-code-list">
                  {availableCodes.map((code) => (
                    <button key={code.code_id} type="button" onClick={() => onToggleInspectorCode(code.code_id)} disabled={busy || aiDecisionBusy}>
                      <span className="codes-color-dot" style={{ backgroundColor: code.color }} />{code.name}<span>Assign</span>
                    </button>
                  ))}
                  {!availableCodes.length ? <small>No Matching Codes.</small> : null}
                </div>
              </div>
            ) : null}

            <CodesAiActionButton
              action="Suggest Codes"
              fullWidth
              busy={codeAiRunning}
              busyLabel="AI Suggesting…"
              disabled={busy || aiDecisionBusy || !canEditProject || aiRunning}
              onClick={() => openAiDialog("codes")}
            />

            {codeAiRunning && aiRun ? (
              <CodesAiProgress
                run={aiRun}
                timeoutSeconds={project.ai_settings.timeout_seconds}
                onCancel={onCancelAiRun}
                cancellationPending={aiCancellationPending}
                connectionMessage={aiConnectionMessage}
              />
            ) : null}
            {aiRun?.task === "codes" && aiWarning ? <div className="codes-ai-inline-message warning" role="status">{aiWarning}</div> : null}
            {aiRun?.task === "codes" && aiError ? (
              <div className="codes-ai-inline-message error" role="alert">
                <span>{aiError}</span>
                <button type="button" className="secondary-button compact" onClick={onRetryAiRun}>Retry</button>
              </div>
            ) : null}

            {aiCodeSuggestions.length ? (
              <div className="codes-ai-inline-results" aria-label="AI Code Suggestions">
                {aiCodeSuggestions.some((suggestion) => suggestion.kind === "existing_code") ? <strong>Existing Codes</strong> : null}
                {aiCodeSuggestions.filter((suggestion) => suggestion.kind === "existing_code").map((suggestion) => {
                  const pending = decisionPendingFor("codes", suggestion.suggestion_id);
                  const decisionError = aiDecisionErrorFor("codes", suggestion.suggestion_id);
                  return (
                    <Fragment key={suggestion.suggestion_id}>
                      <article aria-busy={pending || undefined}>
                        <div><strong>{suggestion.name}</strong><small>{suggestion.rationale}</small></div>
                        <button type="button" className="secondary-button compact" onClick={() => onStageAiCode(suggestion, aiResultRunIds.codes ?? "")} disabled={busy || aiSuggestionActionsLocked}>Add</button>
                        <button type="button" className="text-button" onClick={() => rejectAiSuggestion(suggestion.suggestion_id, "codes")} disabled={busy || aiSuggestionActionsLocked}>
                          {pending ? "Dismissing…" : "Dismiss"}
                        </button>
                      </article>
                      {decisionError ? (
                        <div className="codes-ai-inline-message error" role="alert">
                          <span>{decisionError.message}</span>
                          <button type="button" className="secondary-button compact" onClick={() => rejectAiSuggestion(suggestion.suggestion_id, "codes")} disabled={busy || aiSuggestionActionsLocked}>Retry</button>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                {aiCodeSuggestions.some((suggestion) => suggestion.kind === "new_code") ? <strong>New Codes</strong> : null}
                {aiCodeSuggestions.filter((suggestion) => suggestion.kind === "new_code").map((suggestion) => {
                  const pending = decisionPendingFor("codes", suggestion.suggestion_id);
                  const decisionError = aiDecisionErrorFor("codes", suggestion.suggestion_id);
                  return (
                    <Fragment key={suggestion.suggestion_id}>
                      <article aria-busy={pending || undefined}>
                        <div><strong>{suggestion.name}</strong><span>{suggestion.description}</span><small>{suggestion.rationale}</small></div>
                        <button type="button" className="secondary-button compact" onClick={() => openNewCodeDialog(suggestion)} disabled={busy || aiSuggestionActionsLocked}>Review</button>
                        <button type="button" className="text-button" onClick={() => rejectAiSuggestion(suggestion.suggestion_id, "codes")} disabled={busy || aiSuggestionActionsLocked}>
                          {pending ? "Dismissing…" : "Dismiss"}
                        </button>
                      </article>
                      {decisionError ? (
                        <div className="codes-ai-inline-message error" role="alert">
                          <span>{decisionError.message}</span>
                          <button type="button" className="secondary-button compact" onClick={() => rejectAiSuggestion(suggestion.suggestion_id, "codes")} disabled={busy || aiSuggestionActionsLocked}>Retry</button>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="field-group">
            <div className="codes-inspector-section-heading">
              <span className="field-label">Note</span>
              <CodesAiActionButton
                action="Draft Note"
                className="compact"
                busy={noteAiRunning}
                busyLabel="AI Drafting…"
                disabled={busy || aiDecisionBusy || !canEditProject || aiRunning}
                onClick={() => openAiDialog("note")}
              />
            </div>
            {noteAiRunning && aiRun ? (
              <CodesAiProgress
                run={aiRun}
                timeoutSeconds={project.ai_settings.timeout_seconds}
                onCancel={onCancelAiRun}
                cancellationPending={aiCancellationPending}
                connectionMessage={aiConnectionMessage}
              />
            ) : null}
            {aiRun?.task === "note" && aiWarning ? <div className="codes-ai-inline-message warning" role="status">{aiWarning}</div> : null}
            {aiRun?.task === "note" && aiError ? (
              <div className="codes-ai-inline-message error" role="alert">
                <span>{aiError}</span>
                <button type="button" className="secondary-button compact" onClick={onRetryAiRun}>Retry</button>
              </div>
            ) : null}
            <textarea
              aria-label="Note"
              className="text-input codes-memo-input"
              value={evidenceDraft?.memo ?? evidenceEditDraft?.memo ?? ""}
              placeholder="No note"
              onChange={(event) => onInspectorMemoChange(event.target.value)}
            />
            {aiNoteSuggestion ? (
              <div className="codes-ai-note-preview" aria-busy={decisionPendingFor("note", aiNoteSuggestion.suggestion_id) || undefined}>
                <strong>AI Note Draft</strong>
                <p>{aiNoteSuggestion.note}</p>
                <div className="action-row">
                  {(evidenceDraft?.memo ?? evidenceEditDraft?.memo ?? "").trim() ? (
                    <>
                      <button type="button" className="secondary-button compact" onClick={() => onApplyAiNote(aiNoteSuggestion, aiResultRunIds.note ?? "", "replace")} disabled={busy || aiSuggestionActionsLocked}>Replace</button>
                      <button type="button" className="secondary-button compact" onClick={() => onApplyAiNote(aiNoteSuggestion, aiResultRunIds.note ?? "", "append")} disabled={busy || aiSuggestionActionsLocked}>Append</button>
                    </>
                  ) : <button type="button" className="secondary-button compact" onClick={() => onApplyAiNote(aiNoteSuggestion, aiResultRunIds.note ?? "", "use")} disabled={busy || aiSuggestionActionsLocked}>Use Draft</button>}
                  <button type="button" className="secondary-button compact" onClick={() => rejectAiSuggestion(aiNoteSuggestion.suggestion_id, "note")} disabled={busy || aiSuggestionActionsLocked}>
                    {decisionPendingFor("note", aiNoteSuggestion.suggestion_id) ? "Dismissing…" : "Cancel"}
                  </button>
                </div>
                {aiDecisionErrorFor("note", aiNoteSuggestion.suggestion_id) ? (
                  <div className="codes-ai-inline-message error" role="alert">
                    <span>{aiDecisionErrorFor("note", aiNoteSuggestion.suggestion_id)?.message}</span>
                    <button type="button" className="secondary-button compact" onClick={() => rejectAiSuggestion(aiNoteSuggestion.suggestion_id, "note")} disabled={busy || aiSuggestionActionsLocked}>Retry</button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {!aiRun && aiWarning ? <div className="codes-ai-inline-message warning" role="status">{aiWarning}</div> : null}
          {!aiRun && aiError ? (
            <div className="codes-ai-inline-message error" role="alert">
              <span>{aiError}</span>
              <button type="button" className="secondary-button compact" onClick={onRetryAiRun}>Retry</button>
            </div>
          ) : null}

          {selectedEvidence && !evidenceDraft ? (
            <div className="action-row field-action-row codes-inspector-actions">
              <button type="button" className="primary-button compact" onClick={onSaveSelectedEvidence} disabled={busy || !canEditProject || !evidenceEditDirty}>Save</button>
              <button type="button" className="secondary-button compact" onClick={onCancelSelectedEvidenceChanges} disabled={busy || !evidenceEditDirty}>Cancel</button>
              <button type="button" className="secondary-button compact danger-button" onClick={onDeleteSelectedEvidence} disabled={busy}>Delete</button>
            </div>
          ) : null}
          {evidenceDraft ? (
            <div className="action-row field-action-row codes-inspector-actions">
              <button type="button" className="primary-button compact" onClick={onSaveEvidenceDraft} disabled={busy || !canEditProject}>Save</button>
              <button type="button" className="secondary-button compact" onClick={onCancelEvidenceDraft} disabled={busy}>Cancel</button>
            </div>
          ) : null}
        </div>
      )}

      <ModalDialog
        open={Boolean(aiDialogTask)}
        instanceKey={aiDialogTask}
        className="codes-ai-run-dialog"
        title={<><span className="codes-ai-action-badge" aria-hidden="true"><span>✦</span> AI</span> {aiDialogTask === "codes" ? "Suggest Codes" : "Draft Note"}</>}
        onCancel={() => setAiDialogTask(null)}
        headerAction={<button type="button" className="secondary-button compact" onClick={() => setAiDialogTask(null)} aria-label="Close AI Assistance Dialog">Close</button>}
        footer={aiDialogTask ? (
          <>
            <button type="button" className="secondary-button" onClick={() => onSaveAiPrompt(aiDialogTask, aiPromptDraft)} disabled={!aiPromptDraft.trim() || busy || aiLocked}>Save as Project Default</button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const restored = onRestoreAiPrompt(aiDialogTask);
                if (restored !== null) setAiPromptDraft(restored);
              }}
              disabled={busy || aiLocked}
            >Restore Built-in Default</button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                const result = onRunAi(aiDialogTask, aiPromptDraft);
                if (result && typeof result === "object" && "then" in result) {
                  void result.then(
                    (accepted) => {
                      if (accepted !== false) setAiDialogTask(null);
                    },
                    () => {}
                  );
                } else if (result !== false) {
                  setAiDialogTask(null);
                }
              }}
              disabled={!aiPromptDraft.trim() || busy || aiLocked}
            >Run</button>
            <button type="button" className="secondary-button" onClick={() => setAiDialogTask(null)}>Cancel</button>
          </>
        ) : null}
      >
        {aiDialogTask ? (
          <>
            <div className="codes-ai-context-summary"><strong>{transcript?.label ?? "Evidence Draft"}</strong><span>{selectedEvidence?.evidence_id ?? "New Evidence"} · {contextSegments.length} source segment{contextSegments.length === 1 ? "" : "s"}</span></div>
            <label className="field-group"><span className="field-label">Researcher Prompt</span><textarea className="text-input" rows={6} value={aiPromptDraft} onChange={(event) => setAiPromptDraft(event.target.value)} /></label>
          </>
        ) : null}
      </ModalDialog>
      <CodesCodeDialog
        open={codeDialogOpen}
        project={project}
        initialValue={codeDialogInitial}
        contextExcerpt={evidenceDraft?.selectedText ?? selectedEvidence?.selected_text ?? ""}
        busy={busy}
        title="Create Code"
        submitLabel="Add Code"
        aiConfigured={aiConfigured}
        aiRun={aiRun?.task === "code_details" ? aiRun : null}
        aiBusy={aiBusyTask === "code_details"}
        aiLocked={aiLocked}
        aiCancellationPending={aiCancellationPending}
        aiConnectionMessage={aiConnectionMessage}
        aiError={aiCodeDetailsError}
        aiSuggestion={aiCodeDetailsSuggestion}
        aiSuggestionTarget={aiCodeDetailsSuggestionTarget}
        aiSurface="inspector"
        aiDecisionAction={aiDecisionAction}
        aiTimeoutSeconds={project.ai_settings.timeout_seconds}
        onRunAi={(value, target) => onRunCodeDetailsAi(value, target, evidenceDraft?.selectedText ?? selectedEvidence?.selected_text ?? "")}
        onCancelAi={onCancelAiRun}
        onRequireAiConfiguration={onRequireAiConfiguration}
        aiDecisionErrorFor={aiDecisionErrorFor}
        onAuthorizeAiSuggestion={onAuthorizeCodeDetailsAi}
        onActivateAiTarget={onActivateCodeDialogAiTarget}
        onInvalidateAiTarget={onInvalidateCodeDialogAiTarget}
        onRejectAiSuggestion={onRejectAiSuggestion}
        onSubmit={(value) => {
          const added = onAddInspectorCode(value, codeDialogSuggestion, codeDialogSuggestionRunId);
          if (!added) return;
          setCodeDialogOpen(false);
          setCodeDialogSuggestion(undefined);
          setCodeDialogSuggestionRunId("");
        }}
        onClose={() => {
          setCodeDialogOpen(false);
          setCodeDialogSuggestion(undefined);
          setCodeDialogSuggestionRunId("");
        }}
      />
    </section>
  );
}
