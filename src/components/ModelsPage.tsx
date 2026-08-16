import type { ModelsPageContract } from "../lib/modelsWorkspaceContracts";
import { modelAvailability } from "../lib/modelsAvailability";
import { FieldLabelWithHelp } from "./FieldLabelWithHelp";
import { ModelsDeleteDialog } from "./models/ModelsDeleteDialog";

export function ModelsPage({ workspace }: { workspace: ModelsPageContract }) {
  const { catalog, token, operation, deletion, actions, externalLinkError } = workspace;
  const pyannote = catalog.status?.pyannote;
  const pyannoteAvailability = pyannote ? modelAvailability(pyannote) : "missing";
  const pyannoteReady = pyannoteAvailability === "ready";
  const fasterWhisperModels = catalog.status?.faster_whisper ?? [];
  const pyannoteHelpText =
    "Speaker recognition uses a pyannote model hosted on Hugging Face. To use it, accept the terms on Hugging Face first and provide a read-only Hugging Face Access Token here to download the model. This setup is only required once. After that, speaker recognition runs locally. The token is not stored.";
  const fasterWhisperHelpText =
    "These are the local faster-whisper transcription models. Download the models you want to use, or delete models you no longer need. Only downloaded models appear in the Transcription page model dropdown.";

  const actionLabel = (targetId: string, downloadId: string, defaultLabel: string) => {
    if (operation.kind !== "download" || operation.targetId !== targetId) return defaultLabel;
    const percent = operation.progress?.id === downloadId ? operation.progress.percent : null;
    return typeof percent === "number" && percent > 0 ? `${percent}%` : "Downloading...";
  };

  return (
    <div className="page-stack">
      <section className="page-header compact-page-header">
        <h2 className="home-main-title">Models</h2>
      </section>

      <div className="models-page-grid">
        <section className="section-card">
          <div className="section-heading">
            <div>
              <h3 className="home-section-title">
                <FieldLabelWithHelp
                  label="Available Whisper Models"
                  helpText={fasterWhisperHelpText}
                  labelClassName="home-section-title"
                />
              </h3>
            </div>
            <button
              type="button"
              className="secondary-button models-refresh-button"
              disabled={operation.busy || catalog.loading}
              onClick={() => void actions.refresh()}
            >
              {catalog.loading ? "Checking..." : "Refresh"}
            </button>
          </div>

          {catalog.error ? <p className="helper-text warning-note" role="status">{catalog.error}</p> : null}
          {operation.progressWarning ? (
            <p className="helper-text warning-note" role="status">{operation.progressWarning}</p>
          ) : null}
          <div className="model-list">
            {fasterWhisperModels.map((model) => {
              const availability = modelAvailability(model);
              const isReady = availability === "ready";
              const isIncomplete = availability === "incomplete";
              const isDeleting = operation.kind === "delete" && operation.targetId === model.value;
              const defaultLabel = isReady ? "Delete" : isIncomplete ? "Repair" : "Download";
              return (
                <div key={model.value} className="model-list-row">
                  <strong>{model.label}</strong>
                  <div className="model-row-actions">
                    <small
                      className={isReady ? "model-state downloaded" : isIncomplete ? "model-state incomplete" : "model-state"}
                      title={isIncomplete && model.missing_files?.length ? `Missing: ${model.missing_files.join(", ")}` : undefined}
                    >
                      {isReady ? "Downloaded" : isIncomplete ? "Incomplete" : "Not Downloaded"}
                    </small>
                    <button
                      type="button"
                      className={isReady ? "secondary-button danger-button model-action-button" : "secondary-button model-action-button"}
                      disabled={operation.busy}
                      onClick={() => {
                        if (isReady) actions.requestDeleteFasterWhisper(model.value);
                        else void actions.downloadFasterWhisper(model.value);
                      }}
                    >
                      {isDeleting ? "Deleting..." : actionLabel(model.value, `fw:${model.value}`, defaultLabel)}
                    </button>
                  </div>
                </div>
              );
            })}
            {!catalog.loading && fasterWhisperModels.length === 0 ? (
              <div className="empty-state">
                <strong>No model status available</strong>
                <p>Refresh model status after the app is ready.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="section-card">
          <div className="section-heading">
            <div>
              <h3 className="home-section-title">
                <FieldLabelWithHelp
                  label="Diarization / Hugging Face"
                  helpText={pyannoteHelpText}
                  labelClassName="home-section-title"
                />
              </h3>
            </div>
          </div>

          <div className="models-setup-column">
            <div className="model-link-row">
              <button
                type="button"
                className="secondary-button"
                disabled={operation.busy || !pyannote?.model_url}
                onClick={() => void actions.openPyannoteModelPage()}
              >
                Open Hugging Face Model Page
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={operation.busy || !pyannote?.token_url}
                onClick={() => void actions.openHuggingFaceTokenPage()}
              >
                Create Hugging Face Token
              </button>
            </div>
            {externalLinkError ? <p className="helper-text warning-note" role="alert">{externalLinkError}</p> : null}

            <div className="advanced-token-row models-token-row">
              <label className="field-group advanced-token-field">
                <span className="field-label">Hugging Face Token</span>
                <div className="models-token-control-row">
                  <input
                    className="text-input"
                    type="password"
                    value={token.input}
                    onChange={(event) => token.setInput(event.target.value)}
                    placeholder="hf_..."
                    autoComplete="off"
                    disabled={token.inputDisabled}
                  />
                  <button
                    type="button"
                    className="secondary-button models-token-test-button"
                    disabled={operation.busy || !token.input.trim()}
                    onClick={() => void token.test()}
                  >
                    {token.testing ? "Testing..." : "Test Token"}
                  </button>
                </div>
              </label>
            </div>

            {token.error ? <div className="inline-note warning-note" role="alert">{token.error}</div> : null}
            {token.result ? (
              <div className={`inline-note${token.result.status === "restricted" ? " warning-note" : ""}`} role="status">
                <strong>{token.result.status === "restricted" ? "Model access still missing" : "Token Test"}</strong>
                <p>{token.result.message}</p>
                {token.result.status === "restricted" ? (
                  <p>Open the Hugging Face model page, accept the model terms, then test the token again.</p>
                ) : null}
              </div>
            ) : null}

            <div className="model-list pyannote-model-list">
              <div className="model-list-row">
                <div className="model-list-main">
                  <strong>Pyannote Model</strong>
                </div>
                <div className="model-row-actions">
                  <small
                    className={pyannoteReady ? "model-state downloaded" : pyannoteAvailability === "incomplete" ? "model-state incomplete" : "model-state"}
                    title={pyannoteAvailability === "incomplete" && pyannote?.missing_files?.length ? `Missing: ${pyannote.missing_files.join(", ")}` : undefined}
                  >
                    {catalog.loading
                      ? "Checking..."
                      : !pyannote
                        ? "Unavailable"
                      : pyannoteReady
                        ? "Downloaded"
                        : pyannoteAvailability === "incomplete"
                          ? "Incomplete"
                          : "Not Downloaded"}
                  </small>
                  <button
                    type="button"
                    className={pyannoteReady ? "secondary-button danger-button model-action-button" : "secondary-button model-action-button"}
                    disabled={operation.busy || !pyannote || (!pyannoteReady && !token.input.trim())}
                    onClick={() => {
                      if (pyannoteReady) actions.requestDeletePyannote();
                      else void actions.downloadPyannote();
                    }}
                  >
                    {operation.kind === "delete" && operation.targetId === "pyannote"
                      ? "Deleting..."
                      : actionLabel(
                          "pyannote",
                          "pyannote",
                          pyannoteReady ? "Delete" : pyannoteAvailability === "incomplete" ? "Repair" : "Download"
                        )}
                  </button>
                </div>
              </div>
            </div>

            {operation.error || operation.message ? (
              <div className={`models-status-box${operation.error ? " warning-note" : ""}`} role={operation.error ? "alert" : "status"}>
                <span className="summary-label">Status</span>
                <strong>{operation.error ?? operation.message}</strong>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <ModelsDeleteDialog
        open={deletion.open}
        requestKey={deletion.requestKey}
        target={deletion.target}
        onConfirm={(requestKey) => void deletion.confirm(requestKey)}
        onCancel={deletion.cancel}
      />
    </div>
  );
}
