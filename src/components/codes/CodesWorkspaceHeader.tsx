type CodesProjectSaveState = "saved" | "saving" | "failed" | "draft";

type CodesWorkspaceHeaderProps = {
  projectName: string;
  researchFocus: string;
  projectFileLabel: string;
  saveState: CodesProjectSaveState;
  statusLabel: string;
  hasError: boolean;
  busy: boolean;
  canUseProjectFiles: boolean;
  canSaveProject: boolean;
  counts: {
    transcripts: number;
    evidence: number;
    codes: number;
    themes: number;
  };
  aiSettings?: ReactNode;
  onProjectNameChange: (value: string) => void;
  onResearchFocusChange: (value: string) => void;
  onSaveSettings: () => void;
  onRetrySettings: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onCloseProject: () => void;
};

const saveStateLabels: Record<CodesProjectSaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  failed: "Save Failed",
  draft: "Unsaved Draft"
};

export function CodesWorkspaceHeader({
  projectName,
  researchFocus,
  projectFileLabel,
  saveState,
  statusLabel,
  hasError,
  busy,
  canUseProjectFiles,
  canSaveProject,
  counts,
  aiSettings,
  onProjectNameChange,
  onResearchFocusChange,
  onSaveSettings,
  onRetrySettings,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onCloseProject
}: CodesWorkspaceHeaderProps) {
  return (
    <section className="codes-project-shell" aria-labelledby="codes-page-title">
      <div className="codes-project-shell-top">
        <div>
          <h2 id="codes-page-title" className="home-main-title">Codes</h2>
          <div className="codes-project-identity">
            <strong>{projectName}</strong>
            <span>{projectFileLabel}</span>
            <span className={`codes-project-save-state ${saveState}`}>{saveStateLabels[saveState]}</span>
          </div>
        </div>
        <div className="codes-project-actions">
          <button type="button" className="secondary-button" onClick={onNewProject} disabled={!canUseProjectFiles || busy}>
            New Project
          </button>
          <button type="button" className="secondary-button" onClick={onOpenProject} disabled={!canUseProjectFiles || busy}>
            Open Project
          </button>
          <button type="button" className="primary-button" onClick={onSaveProject} disabled={!canSaveProject || busy}>
            Save
          </button>
          <button type="button" className="secondary-button" onClick={onSaveProjectAs} disabled={!canUseProjectFiles || busy}>
            Save As…
          </button>
          <button type="button" className="secondary-button danger-button" onClick={onCloseProject} disabled={busy}>
            Close Project
          </button>
        </div>
      </div>

      <div className="codes-project-meta-row">
        <span><strong>{counts.transcripts}</strong> Transcripts</span>
        <span><strong>{counts.evidence}</strong> Evidence Items</span>
        <span><strong>{counts.codes}</strong> Codes</span>
        <span><strong>{counts.themes}</strong> Themes</span>
      </div>

      {hasError && statusLabel ? (
        <div className="codes-project-message error" role="alert" aria-live="assertive">
          {statusLabel}
          {saveState === "failed" ? (
            <button type="button" className="secondary-button compact" onClick={onRetrySettings} disabled={busy}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <details className="codes-project-settings">
        <summary className="details-heading-button codes-project-settings-summary">
          <span className="accordion-chevron" aria-hidden="true">›</span>
          <strong>Project Settings</strong>
        </summary>
        <div className="codes-project-settings-grid">
          <label className="field-group transcription-field transcription-field-compact codes-project-name-field">
            <span className="field-label">Project Name</span>
            <input
              className="text-input"
              value={projectName}
              disabled={busy}
              onChange={(event) => onProjectNameChange(event.target.value)}
              onBlur={onSaveSettings}
            />
          </label>
          <label className="field-group transcription-field transcription-field-compact codes-research-focus-field">
            <span className="field-label">Research Focus</span>
            <textarea
              className="text-input codes-research-focus"
              rows={1}
              value={researchFocus}
              placeholder="Optional research question or analytical focus"
              disabled={busy}
              onChange={(event) => onResearchFocusChange(event.target.value)}
              onBlur={onSaveSettings}
            />
          </label>
        </div>
      </details>
      {aiSettings}
    </section>
  );
}

export type { CodesProjectSaveState };
import type { ReactNode } from "react";
