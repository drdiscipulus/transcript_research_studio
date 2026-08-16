type CodesSetupPanelProps = {
  desktopAvailable: boolean;
  busy: boolean;
  statusLabel: string;
  hasError: boolean;
  onNewProject: () => void;
  onOpenProject: () => void;
};

export function CodesSetupPanel({
  desktopAvailable,
  busy,
  statusLabel,
  hasError,
  onNewProject,
  onOpenProject
}: CodesSetupPanelProps) {
  return (
    <div className="page-stack codes-page">
      <section className="page-header compact-page-header transcription-page-header">
        <div className="codes-setup-header-content">
          <h2 className="home-main-title">Codes</h2>
          <p>Create a new coding project or open an existing project.</p>
          {hasError ? (
            <div className="codes-setup-error" role="alert" aria-live="assertive">
              {statusLabel}
            </div>
          ) : null}
        <div className="codes-setup-actions">
          <button type="button" className="primary-button" onClick={onNewProject} disabled={!desktopAvailable || busy}>
            Create New Project
          </button>
          <button type="button" className="secondary-button" onClick={onOpenProject} disabled={!desktopAvailable || busy}>
            Open Existing Project
          </button>
        </div>
        {!desktopAvailable ? (
          <div className="empty-state compact-empty-state">
            <strong>Desktop app required</strong>
            <p>Coding project files can be created and opened in the desktop app.</p>
          </div>
        ) : null}
        </div>
      </section>
    </div>
  );
}
