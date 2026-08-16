import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type {
  CodesAiDecisionActiveAction,
  CodesAiDecisionError,
  CodesAiSuggestionRejection
} from "../../hooks/useCodesAiDecisionLifecycle";
import type { CodesAiEvidenceSuggestion, CodesEvidenceItem, CodesProject } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import {
  ConfirmationDialog,
  type ConfirmationIntent
} from "../workbench/ConfirmationDialog";
import { timestampRangeLabel } from "./codesPageUtils";

type EvidenceScope = "active" | "all";
type ClearSuggestionsIntent = ConfirmationIntent & { suggestionIds: string[] };

type CodesProjectSidebarProps = {
  project: CodesProject;
  activeTranscriptId: string;
  selectedEvidenceId: string;
  evidenceSearch: string;
  evidenceScope: EvidenceScope;
  evidenceFilterCodeId: string;
  evidenceFilterThemeId: string;
  onSelectEvidence: (evidence: CodesEvidenceItem) => void;
  onEvidenceSearchChange: (value: string) => void;
  onEvidenceScopeChange: (scope: EvidenceScope) => void;
  onEvidenceFilterCodeChange: (codeId: string) => void;
  onEvidenceFilterThemeChange: (themeId: string) => void;
  onClearEvidenceFilters: () => void;
  aiSuggestions: CodesAiEvidenceSuggestion[];
  selectedAiSuggestionId: string;
  aiLocked?: boolean;
  aiDecisionAction: CodesAiDecisionActiveAction | null;
  aiDecisionErrorFor: (task: "evidence", suggestionId: string) => CodesAiDecisionError | null;
  onSelectAiSuggestion: (suggestion: CodesAiEvidenceSuggestion) => void;
  onAcceptAiSuggestion: (suggestion: CodesAiEvidenceSuggestion) => void;
  onRejectAiSuggestion: (rejection: CodesAiSuggestionRejection) => void;
  onClearAiSuggestions: (suggestions: readonly CodesAiEvidenceSuggestion[]) => void;
};

const PAGE_SIZE = 25;
const DEFAULT_EVIDENCE_LIST_HEIGHT = 400;
const MIN_EVIDENCE_LIST_HEIGHT = 224;
const EVIDENCE_LIST_HEIGHT_KEY = "transcript-research-studio.codes.evidence-list-height";

function storedEvidenceListHeight() {
  try {
    const stored = Number(window.sessionStorage.getItem(EVIDENCE_LIST_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= MIN_EVIDENCE_LIST_HEIGHT ? stored : null;
  } catch {
    return null;
  }
}

function segmentRangeLabel(project: CodesProject, evidence: CodesEvidenceItem) {
  const transcript = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id);
  if (!transcript) return evidence.segment_ids.join(", ");
  const positions = evidence.segment_ids
    .map((segmentId) => transcript.segments.findIndex((segment) => segment.segment_id === segmentId) + 1)
    .filter((position) => position > 0)
    .sort((left, right) => left - right);
  if (!positions.length) return evidence.segment_ids.join(", ");
  if (positions.length === 1) return `Segment ${positions[0]}`;
  return `Segments ${positions[0]}–${positions[positions.length - 1]}`;
}

function evidenceSpeakerLabel(project: CodesProject, evidence: CodesEvidenceItem) {
  const transcript = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id);
  if (!transcript) return evidence.speaker || "No Speaker";
  const speakerIds = evidence.speaker
    ? [evidence.speaker]
    : [...new Set(transcript.segments.filter((segment) => evidence.segment_ids.includes(segment.segment_id)).map((segment) => segment.speaker).filter(Boolean))];
  return speakerIds
    .map((speakerId) => transcript.speakers.find((speaker) => speaker.id === speakerId)?.name || speakerId)
    .join(", ") || "No Speaker";
}

export function CodesProjectSidebar({
  project,
  activeTranscriptId,
  selectedEvidenceId,
  evidenceSearch,
  evidenceScope,
  evidenceFilterCodeId,
  evidenceFilterThemeId,
  onSelectEvidence,
  onEvidenceSearchChange,
  onEvidenceScopeChange,
  onEvidenceFilterCodeChange,
  onEvidenceFilterThemeChange,
  onClearEvidenceFilters,
  aiSuggestions = [],
  selectedAiSuggestionId = "",
  aiLocked = false,
  aiDecisionAction = null,
  aiDecisionErrorFor = () => null,
  onSelectAiSuggestion = () => {},
  onAcceptAiSuggestion = () => {},
  onRejectAiSuggestion = () => {},
  onClearAiSuggestions = () => {}
}: CodesProjectSidebarProps) {
  const [page, setPage] = useState(1);
  const [evidenceListOpen, setEvidenceListOpen] = useState(true);
  const [evidenceListHeight, setEvidenceListHeight] = useState<number | null>(storedEvidenceListHeight);
  const [clearSuggestionsIntent, setClearSuggestionsIntent] = useState<ClearSuggestionsIntent | null>(null);
  const evidenceListResizerRef = useRef<HTMLDivElement | null>(null);
  const evidenceResizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const hasFilters = Boolean(evidenceSearch || evidenceScope === "all" || evidenceFilterCodeId || evidenceFilterThemeId);
  const filteredEvidenceItems = useMemo(() => project.evidence_items.filter((evidence) => {
    if (evidenceScope === "active" && evidence.transcript_id !== activeTranscriptId) return false;
    if (evidenceFilterCodeId && !evidence.code_ids.includes(evidenceFilterCodeId)) return false;
    if (evidenceFilterThemeId) {
      const theme = project.themes.find((item) => item.theme_id === evidenceFilterThemeId);
      if (!evidence.code_ids.some((codeId) => (theme?.code_ids ?? []).includes(codeId))) return false;
    }
    const query = evidenceSearch.trim().toLowerCase();
    const transcriptLabel = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id)?.label ?? "";
    return !query
      || evidence.evidence_id.toLowerCase().includes(query)
      || evidence.selected_text.toLowerCase().includes(query)
      || evidence.memo.toLowerCase().includes(query)
      || transcriptLabel.toLowerCase().includes(query);
  }), [activeTranscriptId, evidenceFilterCodeId, evidenceFilterThemeId, evidenceScope, evidenceSearch, project]);
  const pageCount = Math.max(1, Math.ceil(filteredEvidenceItems.length / PAGE_SIZE));
  const visibleEvidenceItems = filteredEvidenceItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const evidenceListHeightValue = Math.round(evidenceListHeight ?? DEFAULT_EVIDENCE_LIST_HEIGHT);
  const evidenceListMaxHeight = Math.max(MIN_EVIDENCE_LIST_HEIGHT, Math.floor(window.innerHeight * 0.72));
  const selectedAiSuggestionIndex = Math.max(0, aiSuggestions.findIndex((suggestion) => suggestion.suggestion_id === selectedAiSuggestionId));
  const decisionsBusy = aiLocked || Boolean(aiDecisionAction);
  const clearingSuggestions = aiDecisionAction?.kind === "clear" && aiDecisionAction.task === "evidence";

  useEffect(() => setPage(1), [activeTranscriptId, evidenceFilterCodeId, evidenceFilterThemeId, evidenceScope, evidenceSearch]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);
  useEffect(() => {
    if (evidenceListHeight === null) return;
    try {
      window.sessionStorage.setItem(EVIDENCE_LIST_HEIGHT_KEY, String(evidenceListHeight));
    } catch {
      // Session storage can be unavailable in hardened webviews; resizing still works for the mounted page.
    }
  }, [evidenceListHeight]);

  function clampEvidenceListHeight(height: number) {
    return Math.min(Math.max(MIN_EVIDENCE_LIST_HEIGHT, height), Math.max(MIN_EVIDENCE_LIST_HEIGHT, Math.floor(window.innerHeight * 0.72)));
  }

  function beginEvidenceListResize(event: PointerEvent<HTMLButtonElement>) {
    const startHeight = evidenceListResizerRef.current?.getBoundingClientRect().height || evidenceListHeight || DEFAULT_EVIDENCE_LIST_HEIGHT;
    evidenceResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeEvidenceList(event: PointerEvent<HTMLButtonElement>) {
    const resize = evidenceResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setEvidenceListHeight(clampEvidenceListHeight(resize.startHeight + event.clientY - resize.startY));
  }

  function finishEvidenceListResize(event: PointerEvent<HTMLButtonElement>) {
    if (evidenceResizeRef.current?.pointerId !== event.pointerId) return;
    evidenceResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeEvidenceListWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const currentHeight = evidenceListHeight ?? (evidenceListResizerRef.current?.getBoundingClientRect().height || DEFAULT_EVIDENCE_LIST_HEIGHT);
    setEvidenceListHeight(clampEvidenceListHeight(currentHeight + (event.key === "ArrowDown" ? 24 : -24)));
  }

  function rejectAiSuggestion(suggestion: CodesAiEvidenceSuggestion) {
    onRejectAiSuggestion({
      task: "evidence",
      suggestionId: suggestion.suggestion_id,
      runId: suggestion.run_id
    });
  }

  function clearAiSuggestions() {
    if (decisionsBusy || clearSuggestionsIntent || aiSuggestions.length === 0) return;
    const suggestionIds = aiSuggestions.map((suggestion) => suggestion.suggestion_id);
    setClearSuggestionsIntent({
      id: `clear-ai-evidence-${suggestionIds.join("-")}`,
      suggestionIds,
      title: "Clear AI Evidence Suggestions?",
      description: `Reject and clear ${aiSuggestions.length} remaining AI evidence suggestion(s)?`,
      confirmLabel: "Reject and Clear",
      destructive: true
    });
  }

  function confirmClearAiSuggestions(intent: ClearSuggestionsIntent) {
    const currentIds = aiSuggestions.map((suggestion) => suggestion.suggestion_id);
    if (
      clearSuggestionsIntent?.id !== intent.id
      || decisionsBusy
      || currentIds.length !== intent.suggestionIds.length
      || currentIds.some((id, index) => id !== intent.suggestionIds[index])
    ) {
      setClearSuggestionsIntent(null);
      return;
    }
    setClearSuggestionsIntent(null);
    onClearAiSuggestions([...aiSuggestions]);
  }

  return (
    <section className="section-card codes-sidebar-panel codes-evidence-list-panel">
      <div className="section-heading codes-evidence-list-heading">
        <FieldLabelWithHelp label={`Evidence (${filteredEvidenceItems.length})`} helpText="Open saved evidence and return to its exact transcript passage." labelClassName="home-section-title" />
        {hasFilters ? <button type="button" className="text-button" onClick={onClearEvidenceFilters}>Clear Filters</button> : null}
      </div>

      <div className="codes-evidence-primary-filters">
        <input className="text-input" aria-label="Search Evidence" value={evidenceSearch} placeholder="Search evidence" onChange={(event) => onEvidenceSearchChange(event.target.value)} />
        <select className="text-input" aria-label="Evidence Scope" value={evidenceScope} onChange={(event) => onEvidenceScopeChange(event.target.value as EvidenceScope)}>
          <option value="active">Current Transcript</option>
          <option value="all">All Transcripts</option>
        </select>
      </div>

      <details className="codes-evidence-filter-details">
        <summary>Filters{evidenceFilterCodeId || evidenceFilterThemeId ? " (Active)" : ""}</summary>
        <div className="codes-evidence-filter-grid">
          <select className="text-input" aria-label="Filter by Code" value={evidenceFilterCodeId} disabled={!project.codes.length} onChange={(event) => onEvidenceFilterCodeChange(event.target.value)}>
            <option value="">All Codes</option>
            {project.codes.map((code) => <option key={code.code_id} value={code.code_id}>{code.name}</option>)}
          </select>
          <select className="text-input" aria-label="Filter by Theme" value={evidenceFilterThemeId} disabled={!project.themes.length} onChange={(event) => onEvidenceFilterThemeChange(event.target.value)}>
            <option value="">All Themes</option>
            {project.themes.map((theme) => <option key={theme.theme_id} value={theme.theme_id}>{theme.name}</option>)}
          </select>
        </div>
      </details>

      {aiSuggestions.length ? (
        <details className="codes-ai-evidence-suggestions" open>
          <summary><span className="codes-ai-action-badge" aria-hidden="true"><span>✦</span> AI</span> Evidence Suggestions ({aiSuggestions.length})</summary>
          <div className="codes-ai-suggestion-navigation">
            <button type="button" className="secondary-button compact" disabled={decisionsBusy || selectedAiSuggestionIndex <= 0} onClick={() => onSelectAiSuggestion(aiSuggestions[selectedAiSuggestionIndex - 1])}>Previous</button>
            <span>{selectedAiSuggestionIndex + 1} / {aiSuggestions.length}</span>
            <button type="button" className="secondary-button compact" disabled={decisionsBusy || selectedAiSuggestionIndex >= aiSuggestions.length - 1} onClick={() => onSelectAiSuggestion(aiSuggestions[selectedAiSuggestionIndex + 1])}>Next</button>
            <button type="button" className="text-button" disabled={decisionsBusy} onClick={clearAiSuggestions}>
              {clearingSuggestions
                ? `Clearing… ${aiDecisionAction.completed} / ${aiDecisionAction.total}`
                : "Clear Suggestions"}
            </button>
          </div>
          <div className="codes-ai-evidence-suggestion-list">
            {aiSuggestions.map((suggestion) => {
              const pendingAction = aiDecisionAction?.suggestionId === suggestion.suggestion_id
                ? aiDecisionAction.kind
                : null;
              const decisionError = aiDecisionErrorFor("evidence", suggestion.suggestion_id);
              return (
                <article
                  key={suggestion.suggestion_id}
                  className={suggestion.suggestion_id === selectedAiSuggestionId ? "codes-ai-evidence-suggestion active" : "codes-ai-evidence-suggestion"}
                  aria-busy={Boolean(pendingAction)}
                >
                  <button type="button" className="codes-ai-suggestion-open" disabled={decisionsBusy} onClick={() => onSelectAiSuggestion(suggestion)}>
                    <strong>{suggestion.selected_text}</strong>
                    <small>{timestampRangeLabel(suggestion.start, suggestion.end)} · {suggestion.speaker || "No Speaker"}</small>
                    {suggestion.rationale ? <span>{suggestion.rationale}</span> : null}
                  </button>
                  {decisionError ? (
                    <div className="codes-ai-inline-message error" role="alert">
                      <span>{decisionError.message}</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={decisionsBusy}
                        onClick={() => decisionError.kind === "accept"
                          ? onAcceptAiSuggestion(suggestion)
                          : rejectAiSuggestion(suggestion)}
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary-button compact"
                      disabled={decisionsBusy}
                      title="Save this passage immediately as evidence without codes or a note."
                      onClick={() => onAcceptAiSuggestion(suggestion)}
                    >
                      {pendingAction === "accept" ? "Accepting…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={decisionsBusy}
                      title="Reject this AI suggestion."
                      onClick={() => rejectAiSuggestion(suggestion)}
                    >
                      {pendingAction === "reject" ? "Dismissing…" : "Dismiss"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </details>
      ) : null}

      <details
        className="codes-evidence-items-details"
        open={evidenceListOpen}
        onToggle={(event) => setEvidenceListOpen(event.currentTarget.open)}
      >
        <summary>Evidence List</summary>
        <div className="codes-evidence-list-content">
          <div
            ref={evidenceListResizerRef}
            className={evidenceListHeight === null ? "codes-evidence-list-resizer" : "codes-evidence-list-resizer resized"}
            style={evidenceListHeight === null ? undefined : { height: `${evidenceListHeight}px` }}
          >
            <div className="codes-evidence-list codes-evidence-list-scroll" aria-label="Saved Evidence">
              {visibleEvidenceItems.map((evidence) => {
                const transcript = project.transcripts.find((item) => item.transcript_id === evidence.transcript_id);
                const assignedCodes = project.codes.filter((code) => evidence.code_ids.includes(code.code_id));
                const speaker = evidenceSpeakerLabel(project, evidence);
                const location = evidence.start !== null || evidence.end !== null
                  ? timestampRangeLabel(evidence.start, evidence.end)
                  : segmentRangeLabel(project, evidence);
                return (
                  <button
                    key={evidence.evidence_id}
                    type="button"
                    className={evidence.evidence_id === selectedEvidenceId ? "codes-evidence-row active" : "codes-evidence-row"}
                    onClick={() => onSelectEvidence(evidence)}
                    aria-label={`${evidence.selected_text}. ${transcript?.label ?? "Unknown Transcript"}. ${speaker}. ${location}. Evidence ${evidence.evidence_id}`}
                    title={`Evidence ${evidence.evidence_id}`}
                  >
                    <span className="codes-evidence-row-excerpt">{evidence.selected_text}</span>
                    <small>{transcript?.label ?? "Unknown Transcript"} · {speaker} · {location}</small>
                    {assignedCodes.length ? (
                      <span className="codes-evidence-row-codes">
                        {assignedCodes.map((code) => <span key={code.code_id} className="codes-mini-code-chip"><span className="codes-color-dot" style={{ backgroundColor: code.color }} />{code.name}</span>)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {!visibleEvidenceItems.length ? <div className="codes-empty-list compact">No matching evidence</div> : null}
            </div>
            <button
              type="button"
              role="separator"
              className="codes-evidence-resize-handle"
              aria-label="Resize Evidence List"
              aria-orientation="horizontal"
              aria-valuemin={MIN_EVIDENCE_LIST_HEIGHT}
              aria-valuemax={evidenceListMaxHeight}
              aria-valuenow={evidenceListHeightValue}
              title="Drag or use the arrow keys to resize the evidence list"
              onPointerDown={beginEvidenceListResize}
              onPointerMove={resizeEvidenceList}
              onPointerUp={finishEvidenceListResize}
              onPointerCancel={finishEvidenceListResize}
              onKeyDown={resizeEvidenceListWithKeyboard}
            />
          </div>

          {pageCount > 1 ? (
            <div className="codes-evidence-pagination">
              <button type="button" className="secondary-button compact" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
              <span>Page {page} / {pageCount}</span>
              <button type="button" className="secondary-button compact" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button>
            </div>
          ) : null}
        </div>
      </details>
      <ConfirmationDialog
        intent={clearSuggestionsIntent}
        busy={decisionsBusy}
        onCancel={() => setClearSuggestionsIntent(null)}
        onConfirm={(intent) => confirmClearAiSuggestions(intent as ClearSuggestionsIntent)}
      />
    </section>
  );
}

export type { EvidenceScope };
