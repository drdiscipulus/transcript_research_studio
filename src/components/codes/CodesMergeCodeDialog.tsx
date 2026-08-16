import { useEffect, useMemo, useRef, useState } from "react";
import type { CodesCode } from "../../lib/api";
import { ModalDialog } from "../workbench/ModalDialog";

type MergeField = "description" | "inclusion_note" | "exclusion_note" | "memo";
type MergeChoice = "target" | "source" | "combine";

export type CodesMergeFields = {
  description: string;
  inclusion_note: string;
  exclusion_note: string;
  memo: string;
};

type CodesMergeCodeDialogProps = {
  open: boolean;
  source: CodesCode | null;
  codes: CodesCode[];
  evidenceAssignments: number;
  themesAffected: number;
  busy?: boolean;
  error?: string | null;
  onSubmit: (targetCodeId: string, fields: CodesMergeFields) => void;
  onClose: () => void;
};

const fieldLabels: Record<MergeField, string> = {
  description: "Definition",
  inclusion_note: "Inclusion Criteria",
  exclusion_note: "Exclusion Criteria",
  memo: "Note"
};

function defaultChoice(source: string, target: string): MergeChoice {
  if (!target.trim() && source.trim()) return "source";
  if (target.trim() && source.trim() && target.trim() !== source.trim()) return "combine";
  return "target";
}

function resolvedValue(source: string, target: string, choice: MergeChoice) {
  if (choice === "source") return source;
  if (choice === "combine") return [target.trim(), source.trim()].filter(Boolean).join("\n\n");
  return target;
}

export function CodesMergeCodeDialog({
  open, source, codes, evidenceAssignments, themesAffected, busy = false, error = null, onSubmit, onClose
}: CodesMergeCodeDialogProps) {
  const targets = useMemo(() => codes.filter((code) => code.code_id !== source?.code_id), [codes, source?.code_id]);
  const [targetCodeId, setTargetCodeId] = useState("");
  const [choices, setChoices] = useState<Record<MergeField, MergeChoice>>({
    description: "target", inclusion_note: "target", exclusion_note: "target", memo: "target"
  });
  const target = targets.find((code) => code.code_id === targetCodeId) ?? null;
  const targetRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!open) return;
    setTargetCodeId("");
  }, [open, source?.code_id]);

  useEffect(() => {
    if (!source || !target) return;
    setChoices({
      description: defaultChoice(source.description, target.description),
      inclusion_note: defaultChoice(source.inclusion_note, target.inclusion_note),
      exclusion_note: defaultChoice(source.exclusion_note, target.exclusion_note),
      memo: defaultChoice(source.memo, target.memo)
    });
  }, [source, target]);

  const sourceCode = source;

  function submit() {
    if (!target || !sourceCode) return;
    onSubmit(target.code_id, {
      description: resolvedValue(sourceCode.description, target.description, choices.description),
      inclusion_note: resolvedValue(sourceCode.inclusion_note, target.inclusion_note, choices.inclusion_note),
      exclusion_note: resolvedValue(sourceCode.exclusion_note, target.exclusion_note, choices.exclusion_note),
      memo: resolvedValue(sourceCode.memo, target.memo, choices.memo)
    });
  }

  return (
    <ModalDialog
      open={open && Boolean(source)}
      instanceKey={source?.code_id}
      className="codes-merge-dialog"
      title="Merge Code"
      description={sourceCode ? <p>Merge <strong>{sourceCode.name}</strong> into another code.</p> : undefined}
      initialFocusRef={targetRef}
      cancelDisabled={busy}
      onCancel={onClose}
      headerAction={<button type="button" className="secondary-button compact" onClick={onClose} disabled={busy}>Close</button>}
      footer={(
        <>
          <button type="button" className="primary-button" disabled={busy || !target} onClick={submit}>Merge Codes</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        </>
      )}
    >

        <label className="field-group">
          <span className="field-label">Target Code</span>
          <select ref={targetRef} className="text-input" value={targetCodeId} onChange={(event) => setTargetCodeId(event.target.value)}>
            <option value="">Choose a target code</option>
            {targets.map((code) => <option key={code.code_id} value={code.code_id}>{code.name} · {code.code_id}</option>)}
          </select>
        </label>

        <div className="codes-merge-impact">
          <strong>{evidenceAssignments} Evidence Assignment{evidenceAssignments === 1 ? "" : "s"}</strong>
          <span>{themesAffected} Theme{themesAffected === 1 ? "" : "s"} Affected</span>
          <span>Example evidence is combined automatically.</span>
        </div>

        {target && sourceCode ? (
          <div className="codes-merge-fields">
            {(Object.keys(fieldLabels) as MergeField[]).map((field) => (
              <div key={field} className="codes-merge-field">
                <div className="section-heading">
                  <strong>{fieldLabels[field]}</strong>
                  <select
                    className="text-input compact"
                    aria-label={`${fieldLabels[field]} merge behavior`}
                    value={choices[field]}
                    onChange={(event) => setChoices((current) => ({ ...current, [field]: event.target.value as MergeChoice }))}
                  >
                    <option value="target">Keep Target</option>
                    <option value="source">Use Source</option>
                    <option value="combine">Combine Both</option>
                  </select>
                </div>
                <div className="codes-merge-comparison">
                  <div><small>Target</small><p>{target[field] || "No content"}</p></div>
                  <div><small>Source</small><p>{sourceCode[field] || "No content"}</p></div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {error ? <div className="codes-ai-inline-message error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}
