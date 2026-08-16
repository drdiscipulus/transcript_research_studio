import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CodesProject } from "../../lib/api";
import type { ThemeForm } from "./codesPageUtils";
import { emptyThemeForm } from "./codesPageUtils";
import { ThemeCodeSelector } from "./ThemeCodeSelector";
import { ModalDialog } from "../workbench/ModalDialog";

type CodesThemeDialogProps = {
  open: boolean;
  project: CodesProject;
  initialValue?: ThemeForm | null;
  busy?: boolean;
  error?: string | null;
  aiAction?: ReactNode;
  onSubmit: (value: ThemeForm) => void;
  onClose: () => void;
};

export function CodesThemeDialog({ open, project, initialValue, busy = false, error = null, aiAction, onSubmit, onClose }: CodesThemeDialogProps) {
  const [draft, setDraft] = useState<ThemeForm>(() => initialValue ?? emptyThemeForm);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialValue ? { ...initialValue, codeIds: [...initialValue.codeIds], aiDecisions: [...initialValue.aiDecisions] } : { ...emptyThemeForm, codeIds: [], aiDecisions: [] });
  }, [initialValue, open]);

  const duplicate = project.themes.some((theme) => theme.theme_id !== draft.themeId && theme.name.trim().toLocaleLowerCase() === draft.name.trim().toLocaleLowerCase());

  return (
    <ModalDialog
      open={open}
      className="codes-theme-dialog"
      title="Create Theme"
      initialFocusRef={nameRef}
      cancelDisabled={busy}
      onCancel={onClose}
      headerAction={<button type="button" className="secondary-button compact" onClick={onClose} disabled={busy}>Close</button>}
      footer={(
        <>
          <button type="button" className="primary-button" disabled={busy || !draft.name.trim() || duplicate} onClick={() => onSubmit(draft)}>Create Theme</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        </>
      )}
    >
        {aiAction ? <div>{aiAction}</div> : null}
        <div className="codes-code-dialog-fields">
          <label className="field-group"><span className="field-label">Theme Name</span><input ref={nameRef} className="text-input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="field-group codes-color-field"><span className="field-label">Color</span><input type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))} aria-label="Theme Color" /></label>
          <label className="field-group codes-code-dialog-wide"><span className="field-label">Description</span><textarea className="text-input" rows={4} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="field-group codes-code-dialog-wide"><span className="field-label">Note</span><textarea className="text-input" rows={3} value={draft.memo} onChange={(event) => setDraft((current) => ({ ...current, memo: event.target.value }))} /></label>
        </div>
        <ThemeCodeSelector
          codes={project.codes}
          selectedCodeIds={draft.codeIds}
          disabled={busy}
          resetKey={`${open}-${initialValue?.themeId ?? "new"}`}
          onToggle={(codeId) => setDraft((current) => ({
            ...current,
            codeIds: current.codeIds.includes(codeId)
              ? current.codeIds.filter((id) => id !== codeId)
              : [...current.codeIds, codeId]
          }))}
        />
        {duplicate ? <div className="codes-ai-inline-message error" role="alert">A theme with this name already exists.</div> : null}
        {error ? <div className="codes-ai-inline-message error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}
