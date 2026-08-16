import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CodesAiDecisionActiveAction,
  CodesAiDecisionError,
  CodesAiSuggestionRejection
} from "../../hooks/useCodesAiDecisionLifecycle";
import type { CodesAiCodeDetailsSuggestion, CodesAiRunSnapshot, CodesProject } from "../../lib/api";
import type { CodeForm } from "./codesPageUtils";
import { emptyCodeForm } from "./codesPageUtils";
import { CodesAiActionButton } from "./CodesAiActionButton";
import { CodesAiProgress } from "./CodesAiProgress";
import { ModalDialog } from "../workbench/ModalDialog";

export type CodeDialogValue = CodeForm & {
  useCurrentEvidenceAsExample: boolean;
};

export type CodesCodeDialogTarget = {
  surface: "inspector" | "codebook";
  instanceId: string;
};

let nextCodeDialogInstanceId = 0;

export type CodesCodeDialogProps = {
  open: boolean;
  project: CodesProject;
  initialValue?: CodeDialogValue | null;
  contextExcerpt?: string;
  busy?: boolean;
  title?: string;
  submitLabel?: string;
  error?: string | null;
  onSubmit: (value: CodeDialogValue) => void;
  onClose: () => void;
  aiAction?: ReactNode;
  aiConfigured?: boolean;
  aiRun?: CodesAiRunSnapshot | null;
  aiBusy?: boolean;
  aiLocked?: boolean;
  aiCancellationPending?: boolean;
  aiConnectionMessage?: string;
  aiError?: string | null;
  aiSuggestion?: CodesAiCodeDetailsSuggestion | null;
  aiSuggestionTarget?: CodesCodeDialogTarget | null;
  aiSurface?: CodesCodeDialogTarget["surface"];
  aiDecisionAction?: CodesAiDecisionActiveAction | null;
  aiDecisionErrorFor?: (task: "code_details", suggestionId: string) => CodesAiDecisionError | null;
  aiTimeoutSeconds?: number;
  onRunAi?: (draft: CodeDialogValue, target: CodesCodeDialogTarget) => void;
  onCancelAi?: () => void;
  onRequireAiConfiguration?: () => void;
  onAuthorizeAiSuggestion?: (
    target: CodesCodeDialogTarget,
    suggestion: CodesAiCodeDetailsSuggestion
  ) => CodesAiCodeDetailsSuggestion | null;
  onActivateAiTarget?: (target: CodesCodeDialogTarget) => void;
  onInvalidateAiTarget?: (target: CodesCodeDialogTarget) => void;
  onRejectAiSuggestion?: (rejection: CodesAiSuggestionRejection) => void;
};

function initialDialogValue(value?: CodeDialogValue | null): CodeDialogValue {
  return value ?? { ...emptyCodeForm, exampleEvidenceIds: [], aiDecisions: [], useCurrentEvidenceAsExample: false };
}

export function CodesCodeDialog({
  open,
  project,
  initialValue,
  contextExcerpt = "",
  busy = false,
  title = "Create Code",
  submitLabel = "Create Code",
  error = null,
  onSubmit,
  onClose,
  aiAction,
  aiConfigured = false,
  aiRun = null,
  aiBusy = false,
  aiLocked = false,
  aiCancellationPending = false,
  aiConnectionMessage = "",
  aiError = null,
  aiSuggestion = null,
  aiSuggestionTarget = null,
  aiSurface = "codebook",
  aiDecisionAction = null,
  aiDecisionErrorFor = () => null,
  aiTimeoutSeconds = 180,
  onRunAi,
  onCancelAi,
  onRequireAiConfiguration,
  onAuthorizeAiSuggestion,
  onActivateAiTarget,
  onInvalidateAiTarget,
  onRejectAiSuggestion
}: CodesCodeDialogProps) {
  const openRef = useRef(false);
  const targetRef = useRef<CodesCodeDialogTarget | null>(null);
  if (open && !openRef.current) {
    nextCodeDialogInstanceId += 1;
    targetRef.current = {
      surface: aiSurface,
      instanceId: `${aiSurface}-${nextCodeDialogInstanceId}`
    };
  } else if (!open) {
    targetRef.current = null;
  }
  openRef.current = open;
  const dialogTarget = targetRef.current;
  const visibleAiSuggestion = dialogTarget
    && aiSuggestion
    && aiSuggestionTarget?.surface === dialogTarget.surface
    && aiSuggestionTarget.instanceId === dialogTarget.instanceId
      ? aiSuggestion
      : null;
  const aiDecisionBusy = Boolean(aiDecisionAction);
  const aiDecisionPending = Boolean(
    visibleAiSuggestion
    && aiDecisionAction?.kind === "reject"
    && aiDecisionAction.task === "code_details"
    && aiDecisionAction.suggestionId === visibleAiSuggestion.suggestion_id
  );
  const aiDecisionError = visibleAiSuggestion
    ? aiDecisionErrorFor("code_details", visibleAiSuggestion.suggestion_id)?.message ?? null
    : null;
  const [draft, setDraft] = useState<CodeDialogValue>(() => initialDialogValue(initialValue));
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [evidencePage, setEvidencePage] = useState(1);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialDialogValue(initialValue));
    setEvidenceSearch("");
    setEvidencePage(1);
  }, [initialValue, open]);

  useEffect(() => {
    if (!open || !dialogTarget) return;
    onActivateAiTarget?.(dialogTarget);
    return () => onInvalidateAiTarget?.(dialogTarget);
  }, [dialogTarget, onActivateAiTarget, onInvalidateAiTarget, open]);

  const evidenceOptions = useMemo(() => {
    const query = evidenceSearch.trim().toLocaleLowerCase();
    return project.evidence_items.filter((evidence) => {
      const transcript = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id);
      return !query
        || evidence.selected_text.toLocaleLowerCase().includes(query)
        || evidence.evidence_id.toLocaleLowerCase().includes(query)
        || transcript?.label.toLocaleLowerCase().includes(query);
    });
  }, [evidenceSearch, project.evidence_items, project.transcripts]);
  const evidencePageCount = Math.max(1, Math.ceil(evidenceOptions.length / 25));
  const safeEvidencePage = Math.min(evidencePage, evidencePageCount);
  const visibleEvidenceOptions = evidenceOptions.slice((safeEvidencePage - 1) * 25, safeEvidencePage * 25);

  if (!open) return null;

  function update<K extends keyof CodeDialogValue>(key: K, value: CodeDialogValue[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleExample(evidenceId: string) {
    update(
      "exampleEvidenceIds",
      draft.exampleEvidenceIds.includes(evidenceId)
        ? draft.exampleEvidenceIds.filter((id) => id !== evidenceId)
        : [...draft.exampleEvidenceIds, evidenceId]
    );
  }

  function applyAiSuggestion() {
    if (!visibleAiSuggestion || !dialogTarget) return;
    const authorized = onAuthorizeAiSuggestion?.(dialogTarget, visibleAiSuggestion) ?? null;
    if (!authorized) return;
    setDraft((current) => ({
      ...current,
      name: authorized.name,
      description: authorized.description,
      inclusionNote: authorized.inclusion_note,
      exclusionNote: authorized.exclusion_note,
      memo: authorized.memo,
      aiDecisions: [...current.aiDecisions, {
        run_id: authorized.run_id,
        suggestion_id: authorized.suggestion_id,
        task: "code_details",
        decision: "accepted"
      }]
    }));
  }

  function rejectAiSuggestion() {
    if (!visibleAiSuggestion) return;
    onRejectAiSuggestion?.({
      task: "code_details",
      suggestionId: visibleAiSuggestion.suggestion_id,
      runId: visibleAiSuggestion.run_id
    });
  }

  function closeDialog() {
    onClose();
  }

  const duplicate = project.codes.some((code) =>
    code.code_id !== draft.codeId && code.name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase()
  );

  return (
    <ModalDialog
      open
      instanceKey={dialogTarget?.instanceId}
      className="codes-code-dialog"
      title={title}
      initialFocusRef={nameRef}
      cancelDisabled={busy || aiDecisionBusy}
      onCancel={closeDialog}
      headerAction={<button type="button" className="secondary-button compact" onClick={closeDialog} disabled={busy || aiDecisionBusy} aria-label="Close Code Dialog">Close</button>}
      footer={(
        <>
          <button type="button" className="primary-button" disabled={busy || aiDecisionBusy || !draft.name.trim() || duplicate} onClick={() => onSubmit(draft)}>{submitLabel}</button>
          <button type="button" className="secondary-button" disabled={busy || aiDecisionBusy} onClick={closeDialog}>Cancel</button>
        </>
      )}
    >

        {contextExcerpt ? (
          <div className="codes-code-dialog-context">
            <span className="field-label">Current Evidence</span>
            <p>{contextExcerpt}</p>
            <label>
              <input
                type="checkbox"
                checked={draft.useCurrentEvidenceAsExample}
                onChange={(event) => update("useCurrentEvidenceAsExample", event.target.checked)}
              />
              Use Current Evidence as Example
            </label>
          </div>
        ) : null}

        {aiAction ? <div className="codes-code-dialog-ai-action">{aiAction}</div> : null}
        {onRunAi ? (
          <div className="codes-code-dialog-ai-action">
            <CodesAiActionButton
              action="Draft Code Details"
              busy={aiBusy}
              disabled={busy || aiLocked || aiDecisionBusy}
              onClick={() => aiConfigured && dialogTarget ? onRunAi(draft, dialogTarget) : onRequireAiConfiguration?.()}
            />
            {aiRun?.task === "code_details" ? (
              <CodesAiProgress
                run={aiRun}
                timeoutSeconds={aiTimeoutSeconds}
                onCancel={() => onCancelAi?.()}
                cancellationPending={aiCancellationPending}
                connectionMessage={aiConnectionMessage}
              />
            ) : null}
            {aiError ? <div className="codes-ai-inline-message error" role="alert">{aiError}</div> : null}
            {visibleAiSuggestion ? (
              <div className="codes-ai-review-card" aria-busy={aiDecisionPending || undefined}>
                <strong>{visibleAiSuggestion.name}</strong>
                <p>{visibleAiSuggestion.description}</p>
                <div className="action-row">
                  <button type="button" className="secondary-button compact" onClick={applyAiSuggestion} disabled={busy || aiLocked || aiDecisionBusy}>Apply to Draft</button>
                  <button type="button" className="secondary-button compact" onClick={rejectAiSuggestion} disabled={busy || aiLocked || aiDecisionBusy}>
                    {aiDecisionPending ? "Dismissing…" : "Dismiss"}
                  </button>
                </div>
                {aiDecisionError ? (
                  <div className="codes-ai-inline-message error" role="alert">
                    <span>{aiDecisionError}</span>
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={rejectAiSuggestion}
                      disabled={busy || aiLocked || aiDecisionBusy}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="codes-code-dialog-fields">
          <label className="field-group">
            <span className="field-label">Code Name</span>
            <input ref={nameRef} className="text-input" value={draft.name} onChange={(event) => update("name", event.target.value)} />
          </label>
          <label className="field-group codes-color-field">
            <span className="field-label">Color</span>
            <input type="color" value={draft.color} onChange={(event) => update("color", event.target.value)} aria-label="Code Color" />
          </label>
          <label className="field-group codes-code-dialog-wide">
            <span className="field-label">Definition</span>
            <textarea className="text-input" rows={3} value={draft.description} onChange={(event) => update("description", event.target.value)} />
          </label>
          <div className="codes-criteria-grid codes-code-dialog-wide">
            <label className="field-group">
              <span className="field-label">Inclusion Criteria</span>
              <textarea className="text-input" rows={3} value={draft.inclusionNote} onChange={(event) => update("inclusionNote", event.target.value)} />
            </label>
            <label className="field-group">
              <span className="field-label">Exclusion Criteria</span>
              <textarea className="text-input" rows={3} value={draft.exclusionNote} onChange={(event) => update("exclusionNote", event.target.value)} />
            </label>
          </div>
          <label className="field-group codes-code-dialog-wide">
            <span className="field-label">Note</span>
            <textarea className="text-input" rows={3} value={draft.memo} onChange={(event) => update("memo", event.target.value)} />
          </label>
        </div>

        <details className="codes-code-example-picker">
          <summary>Example Evidence ({draft.exampleEvidenceIds.length})</summary>
          <small className="editor-muted">Selected examples are also assigned to this code when it is created.</small>
          <input
            className="text-input"
            value={evidenceSearch}
            placeholder="Search evidence"
            aria-label="Search Example Evidence"
            onChange={(event) => { setEvidenceSearch(event.target.value); setEvidencePage(1); }}
          />
          <div className="codes-code-example-list">
            {visibleEvidenceOptions.map((evidence) => {
              const transcript = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id);
              return (
                <label key={evidence.evidence_id}>
                  <input type="checkbox" checked={draft.exampleEvidenceIds.includes(evidence.evidence_id)} onChange={() => toggleExample(evidence.evidence_id)} />
                  <span><strong>{evidence.selected_text}</strong><small>{transcript?.label ?? "Unknown Transcript"} · {evidence.evidence_id}</small></span>
                </label>
              );
            })}
            {!visibleEvidenceOptions.length ? <span className="editor-muted">No Matching Evidence</span> : null}
          </div>
          {evidencePageCount > 1 ? <div className="codes-evidence-pagination"><button type="button" className="secondary-button compact" disabled={safeEvidencePage <= 1} onClick={() => setEvidencePage((page) => Math.max(1, page - 1))}>Previous</button><span>Page {safeEvidencePage} / {evidencePageCount}</span><button type="button" className="secondary-button compact" disabled={safeEvidencePage >= evidencePageCount} onClick={() => setEvidencePage((page) => Math.min(evidencePageCount, page + 1))}>Next</button></div> : null}
        </details>

        {duplicate ? <div className="codes-ai-inline-message error" role="alert">A code with this name already exists.</div> : null}
        {error ? <div className="codes-ai-inline-message error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}
