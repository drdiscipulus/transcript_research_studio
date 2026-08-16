import type {
  CodesAiDecisionActiveAction,
  CodesAiDecisionError,
  CodesAiSuggestionRejection
} from "../../hooks/useCodesAiDecisionLifecycle";
import type { CodesAiCodeDetailsSuggestion, CodesAiThemeSuggestion, CodesProject } from "../../lib/api";
import type { CodeForm } from "./codesPageUtils";

type CodeField = "name" | "description" | "inclusionNote" | "exclusionNote" | "memo";

function rejectionPending(
  action: CodesAiDecisionActiveAction | null,
  task: CodesAiDecisionActiveAction["task"],
  suggestionId: string
) {
  return action?.kind === "reject" && action.task === task && action.suggestionId === suggestionId;
}

function DecisionError({ message, busy, onRetry }: {
  message: string | null;
  busy: boolean;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="codes-ai-inline-message error" role="alert">
      <span>{message}</span>
      {onRetry ? <button type="button" className="text-button" disabled={busy} onClick={onRetry}>Retry</button> : null}
    </div>
  );
}

export function CodesCodeRefinementReview({ suggestion, current, aiLocked = false, decisionAction = null, decisionError = null, onApplyField, onApplyAll, onReject }: {
  suggestion: CodesAiCodeDetailsSuggestion;
  current: CodeForm;
  aiLocked?: boolean;
  decisionAction?: CodesAiDecisionActiveAction | null;
  decisionError?: string | null;
  onApplyField: (field: CodeField) => void;
  onApplyAll: () => void;
  onReject: (rejection: CodesAiSuggestionRejection) => void;
}) {
  const decisionBusy = aiLocked || Boolean(decisionAction);
  const dismissing = rejectionPending(decisionAction, "code_refinement", suggestion.suggestion_id);
  const reject = () => onReject({
    task: "code_refinement",
    suggestionId: suggestion.suggestion_id,
    runId: suggestion.run_id
  });
  const rows: Array<{ field: CodeField; label: string; before: string; after: string }> = [
    { field: "name", label: "Name", before: current.name, after: suggestion.name },
    { field: "description", label: "Definition", before: current.description, after: suggestion.description },
    { field: "inclusionNote", label: "Inclusion Criteria", before: current.inclusionNote, after: suggestion.inclusion_note },
    { field: "exclusionNote", label: "Exclusion Criteria", before: current.exclusionNote, after: suggestion.exclusion_note },
    { field: "memo", label: "Note", before: current.memo, after: suggestion.memo }
  ];
  return (
    <section className="codes-ai-review-card" aria-label="AI Code Refinement" aria-busy={dismissing}>
      <strong>AI Code Refinement</strong>
      {suggestion.rationale ? <p>{suggestion.rationale}</p> : null}
      <div className="codes-ai-comparison-list">
        {rows.map((row) => (
          <div key={row.field} className="codes-ai-comparison-row">
            <strong>{row.label}</strong>
            <div><small>Current</small><p>{row.before || "—"}</p></div>
            <div><small>Proposed</small><p>{row.after || "—"}</p></div>
            <button type="button" className="secondary-button compact" disabled={decisionBusy} onClick={() => onApplyField(row.field)}>Apply Field</button>
          </div>
        ))}
      </div>
      <DecisionError message={decisionError} busy={decisionBusy} onRetry={reject} />
      <div className="action-row"><button type="button" className="primary-button compact" disabled={decisionBusy} onClick={onApplyAll}>Apply All</button><button type="button" className="secondary-button compact" disabled={decisionBusy} onClick={reject}>{dismissing ? "Dismissing…" : "Dismiss"}</button></div>
    </section>
  );
}

export function CodesThemeSuggestionReviews({ suggestions, project, aiLocked = false, decisionAction = null, decisionErrorFor = () => null, onAccept, onReject }: {
  suggestions: CodesAiThemeSuggestion[];
  project: CodesProject;
  aiLocked?: boolean;
  decisionAction?: CodesAiDecisionActiveAction | null;
  decisionErrorFor?: (task: "theme_suggestions", suggestionId: string) => CodesAiDecisionError | null;
  onAccept: (suggestion: CodesAiThemeSuggestion) => void;
  onReject: (rejection: CodesAiSuggestionRejection) => void;
}) {
  if (!suggestions.length) return null;
  const decisionBusy = aiLocked || Boolean(decisionAction);
  return (
    <section className="codes-ai-review-list" aria-label="AI Theme Suggestions">
      <strong>AI Theme Suggestions ({suggestions.length})</strong>
      {suggestions.map((suggestion) => {
        const dismissing = rejectionPending(decisionAction, "theme_suggestions", suggestion.suggestion_id);
        const reject = () => onReject({
          task: "theme_suggestions",
          suggestionId: suggestion.suggestion_id,
          runId: suggestion.run_id
        });
        return (
          <article key={suggestion.suggestion_id} className="codes-ai-review-card" aria-busy={dismissing}>
            <strong>{suggestion.name}</strong>
            <p>{suggestion.description}</p>
            {suggestion.rationale ? <p className="editor-muted">{suggestion.rationale}</p> : null}
            <div className="codes-chip-list">{suggestion.code_ids.map((id) => <span key={id} className="codes-code-chip">{project.codes.find((code) => code.code_id === id)?.name ?? id}</span>)}</div>
            <DecisionError message={decisionErrorFor("theme_suggestions", suggestion.suggestion_id)?.message ?? null} busy={decisionBusy} onRetry={reject} />
            <div className="action-row"><button type="button" className="primary-button compact" disabled={decisionBusy} onClick={() => onAccept(suggestion)}>Review Theme</button><button type="button" className="secondary-button compact" disabled={decisionBusy} onClick={reject}>{dismissing ? "Dismissing…" : "Dismiss"}</button></div>
          </article>
        );
      })}
    </section>
  );
}

export function CodesThemeRefinementReview({ suggestion, project, aiLocked = false, decisionAction = null, decisionError = null, onApply, onReject }: {
  suggestion: CodesAiThemeSuggestion;
  project: CodesProject;
  aiLocked?: boolean;
  decisionAction?: CodesAiDecisionActiveAction | null;
  decisionError?: string | null;
  onApply: () => void;
  onReject: (rejection: CodesAiSuggestionRejection) => void;
}) {
  const decisionBusy = aiLocked || Boolean(decisionAction);
  const dismissing = rejectionPending(decisionAction, "theme_refinement", suggestion.suggestion_id);
  const reject = () => onReject({
    task: "theme_refinement",
    suggestionId: suggestion.suggestion_id,
    runId: suggestion.run_id
  });
  return (
    <section className="codes-ai-review-card" aria-label="AI Theme Refinement" aria-busy={dismissing}>
      <strong>AI Theme Refinement</strong>
      <div><small>Proposed Description</small><p>{suggestion.description || "—"}</p></div>
      <div><small>Proposed Note</small><p>{suggestion.memo || "—"}</p></div>
      <div><small>Proposed Code Membership</small><div className="codes-chip-list">{suggestion.code_ids.map((id) => <span key={id} className="codes-code-chip">{project.codes.find((code) => code.code_id === id)?.name ?? id}</span>)}</div></div>
      {suggestion.rationale ? <p className="editor-muted">{suggestion.rationale}</p> : null}
      <DecisionError message={decisionError} busy={decisionBusy} onRetry={reject} />
      <div className="action-row"><button type="button" className="primary-button compact" disabled={decisionBusy} onClick={onApply}>Apply to Draft</button><button type="button" className="secondary-button compact" disabled={decisionBusy} onClick={reject}>{dismissing ? "Dismissing…" : "Dismiss"}</button></div>
    </section>
  );
}
