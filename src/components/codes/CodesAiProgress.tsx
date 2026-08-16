import { useEffect, useMemo, useState } from "react";
import { CODES_AI_ACTIVE_STATUSES } from "../../hooks/useCodesAiRunLifecycle";
import type { CodesAiRunSnapshot } from "../../lib/api";

type CodesAiProgressProps = {
  run: CodesAiRunSnapshot;
  timeoutSeconds: number;
  onCancel: () => void;
  cancellationPending?: boolean;
  connectionMessage?: string;
};

function elapsedSeconds(startedAt: string) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
}

export function CodesAiProgress({
  run,
  timeoutSeconds,
  onCancel,
  cancellationPending = false,
  connectionMessage = ""
}: CodesAiProgressProps) {
  const [elapsed, setElapsed] = useState(() => elapsedSeconds(run.started_at));
  const active = CODES_AI_ACTIVE_STATUSES.has(run.status);
  const cancelling = cancellationPending || run.status === "cancelling";
  const determinate = run.progress_kind === "determinate";
  const total = Math.max(1, run.progress_total);
  const completed = Math.min(total, Math.max(0, run.progress_completed));
  const label = run.progress_label || run.message;
  const batchLabel = useMemo(
    () => `${completed} of ${total} ${total === 1 ? "batch" : "batches"} completed`,
    [completed, total]
  );

  useEffect(() => {
    setElapsed(elapsedSeconds(run.started_at));
    if (!active) return;
    const timer = window.setInterval(() => setElapsed(elapsedSeconds(run.started_at)), 1000);
    return () => window.clearInterval(timer);
  }, [active, run.started_at]);

  if (!active) return null;

  return (
    <div className="codes-ai-progress">
      <div className="codes-ai-progress-heading">
        <span className="codes-ai-action-badge" aria-hidden="true"><span>✦</span> AI</span>
        <strong role="status" aria-live="polite">{label}</strong>
      </div>
      {connectionMessage ? <div className="codes-ai-inline-message" role="status">{connectionMessage}</div> : null}
      {determinate ? (
        <progress className="codes-ai-native-progress" aria-label="AI progress" max={total} value={completed} />
      ) : (
        <div className="codes-ai-indeterminate-progress" aria-hidden="true"><span /></div>
      )}
      <div className="codes-ai-progress-footer">
        <span>{determinate ? batchLabel : run.phase === "requesting" ? "Local model request in progress" : "Working locally"}</span>
        <span className="codes-ai-progress-time" aria-hidden="true">{elapsed}s elapsed · {timeoutSeconds}s timeout</span>
        <button
          type="button"
          className="secondary-button compact"
          onClick={onCancel}
          disabled={cancelling}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
