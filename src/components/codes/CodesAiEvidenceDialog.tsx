import { useEffect, useMemo, useState } from "react";
import type { CodesTranscript } from "../../lib/api";
import { ModalDialog } from "../workbench/ModalDialog";

export type EvidenceAiScope =
  | { type: "current_page"; segment_ids: string[] }
  | { type: "segment_range"; start_segment_id: string; end_segment_id: string }
  | { type: "entire_transcript" };

type CodesAiEvidenceDialogProps = {
  open: boolean;
  transcript: CodesTranscript;
  currentPageSegmentIds: string[];
  initialPrompt: string;
  busy: boolean;
  onSaveDefault: (prompt: string) => void;
  onRestoreDefault: () => string | null;
  onRun: (request: { scope: EvidenceAiScope; researcherPrompt: string; maximumSuggestions: number }) => void;
  onClose: () => void;
};

export function CodesAiEvidenceDialog({
  open,
  transcript,
  currentPageSegmentIds,
  initialPrompt,
  busy,
  onSaveDefault,
  onRestoreDefault,
  onRun,
  onClose
}: CodesAiEvidenceDialogProps) {
  const [scopeType, setScopeType] = useState<EvidenceAiScope["type"]>("current_page");
  const [startSegmentId, setStartSegmentId] = useState(transcript.segments[0]?.segment_id ?? "");
  const [endSegmentId, setEndSegmentId] = useState(transcript.segments[transcript.segments.length - 1]?.segment_id ?? "");
  const [researcherPrompt, setResearcherPrompt] = useState(initialPrompt);
  const [maximumSuggestions, setMaximumSuggestions] = useState(10);
  const includedCount = useMemo(() => {
    if (scopeType === "current_page") return currentPageSegmentIds.length;
    if (scopeType === "entire_transcript") return transcript.segments.length;
    const start = transcript.segments.findIndex((segment) => segment.segment_id === startSegmentId);
    const end = transcript.segments.findIndex((segment) => segment.segment_id === endSegmentId);
    return start >= 0 && end >= start ? end - start + 1 : 0;
  }, [currentPageSegmentIds.length, endSegmentId, scopeType, startSegmentId, transcript.segments]);

  useEffect(() => {
    if (!open) return;
    setResearcherPrompt(initialPrompt);
    setScopeType("current_page");
    setMaximumSuggestions(10);
  }, [initialPrompt, open]);

  if (!open) return null;

  function submit() {
    const scope: EvidenceAiScope = scopeType === "current_page"
      ? { type: "current_page", segment_ids: currentPageSegmentIds }
      : scopeType === "segment_range"
        ? { type: "segment_range", start_segment_id: startSegmentId, end_segment_id: endSegmentId }
        : { type: "entire_transcript" };
    onRun({ scope, researcherPrompt, maximumSuggestions });
  }

  return (
    <ModalDialog
      open
      className="codes-ai-run-dialog"
      title={<><span className="codes-ai-action-badge" aria-hidden="true"><span>✦</span> AI</span> Suggest Evidence</>}
      cancelDisabled={busy}
      onCancel={onClose}
      headerAction={<button type="button" className="secondary-button compact" onClick={onClose} disabled={busy} aria-label="Close AI Evidence Suggestions Dialog">Close</button>}
      footer={(
        <>
          <button type="button" className="secondary-button" onClick={() => onSaveDefault(researcherPrompt)} disabled={busy || !researcherPrompt.trim()}>Save as Project Default</button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              const restored = onRestoreDefault();
              if (restored !== null) setResearcherPrompt(restored);
            }}
            disabled={busy}
          >Restore Built-in Default</button>
          <button type="button" className="primary-button" onClick={submit} disabled={busy || !researcherPrompt.trim() || includedCount === 0}>Run</button>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        </>
      )}
    >
        <fieldset className="codes-ai-scope-options">
          <legend>Scope</legend>
          <label><input type="radio" name="evidence-ai-scope" value="current_page" checked={scopeType === "current_page"} onChange={() => setScopeType("current_page")} /> Current Page</label>
          <label><input type="radio" name="evidence-ai-scope" value="segment_range" checked={scopeType === "segment_range"} onChange={() => setScopeType("segment_range")} /> Segment Range</label>
          <label><input type="radio" name="evidence-ai-scope" value="entire_transcript" checked={scopeType === "entire_transcript"} onChange={() => setScopeType("entire_transcript")} /> Entire Transcript</label>
        </fieldset>
        {scopeType === "segment_range" ? (
          <div className="codes-ai-range-grid">
            <label className="field-group"><span className="field-label">First Segment</span><select className="text-input" value={startSegmentId} onChange={(event) => setStartSegmentId(event.target.value)}>{transcript.segments.map((segment, index) => <option key={segment.segment_id} value={segment.segment_id}>{index + 1}</option>)}</select></label>
            <label className="field-group"><span className="field-label">Last Segment</span><select className="text-input" value={endSegmentId} onChange={(event) => setEndSegmentId(event.target.value)}>{transcript.segments.map((segment, index) => <option key={segment.segment_id} value={segment.segment_id}>{index + 1}</option>)}</select></label>
          </div>
        ) : null}
        <div className="codes-ai-context-summary" role="status"><strong>{transcript.label}</strong><span>{includedCount} segment{includedCount === 1 ? "" : "s"} included</span></div>
        <label className="field-group">
          <span className="field-label">Researcher Prompt</span>
          <textarea className="text-input" rows={6} value={researcherPrompt} onChange={(event) => setResearcherPrompt(event.target.value)} />
        </label>
        <label className="field-group codes-ai-maximum-field">
          <span className="field-label">Maximum Suggestions</span>
          <select className="text-input" value={maximumSuggestions} onChange={(event) => setMaximumSuggestions(Number(event.target.value))}>{[5, 10, 15, 20, 25].map((value) => <option key={value} value={value}>{value}</option>)}</select>
        </label>
    </ModalDialog>
  );
}
