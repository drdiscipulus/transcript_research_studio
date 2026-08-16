import { AdvancedTranscriptionPanel } from "./AdvancedPage";
import { FieldLabelWithHelp } from "./FieldLabelWithHelp";
import { RunSummaryPanel } from "./RunSummaryPanel";
import { WorkflowPathField } from "./WorkflowPathField";
import type { BatchRunSnapshot, ScanPreview } from "../lib/api";
import type { TranscriptionPageContract } from "../lib/transcriptionWorkspaceContracts";
import { TranscriptionCancelDialog } from "./transcription/TranscriptionCancelDialog";

const transcriptionFieldHelpText = {
  model:
    "Chooses one of the faster-whisper models already downloaded on the Models page. Download or delete models there before starting transcription.",
  acceleration: "Chooses which hardware to use for transcription. GPU is usually faster; CPU works on most systems.",
  language: "Choose the spoken language manually or use auto-detect. Setting it explicitly can improve speed and stability.",
  task: "Transcribe keeps the original spoken language. Translate creates an English transcript instead.",
  outputOrganization:
    "Separate files creates one transcript per recording. Combined file collects all successful recordings into one file for each selected export format.",
  transcriptLayout:
    "Controls how each output transcript file is organized after transcription. It does not change recognition or speaker detection. Full Transcript combines the whole media file into one entry. Segments keeps final timestamped segments separate. Paragraphs always split at detected speaker changes and can also split at longer pauses.",
  speakerRecognition:
    "Adds speaker labels after transcription by running the local pyannote model. Download the pyannote model on the Models page before using this.",
  includeTimestamps:
    "Adds timestamps to text-style transcript exports where supported. Segment-based table exports already include timestamp columns.",
  exportFormats:
    "Choose which files to generate after transcription. XLSX and CSV are table-friendly, JSON keeps full structure, and DOCX is best for readable transcript documents.",
  duration:
    "Shows the total detected duration of the selected media file or media files. It is based on the scan and may be unavailable if duration metadata cannot be read.",
  runTranscription:
    "Use Start to create transcript exports for the selected media. New Run clears the current workflow so you can select another input.",
  files:
    "Shows how many media files have finished processing out of the total files found in the latest scan."
} as const;

function formatModelDropdownLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  const knownLabels: Record<string, string> = {
    tiny: "Tiny",
    base: "Base",
    small: "Small",
    medium: "Medium",
    "large-v3": "Large V3",
    "large-v3-turbo": "Large V3 Turbo"
  };
  return knownLabels[normalized] ?? label;
}

function outputPathFileName(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
}

const finishedBatchStatuses = new Set([
  "completed",
  "completed_with_warnings",
  "cancelled",
  "failed",
  "interrupted"
]);

function isFinishedBatch(liveBatch: BatchRunSnapshot | null): liveBatch is BatchRunSnapshot {
  return Boolean(liveBatch && finishedBatchStatuses.has(liveBatch.status));
}

type TranscriptionRunStatusInput = {
  liveBatch: BatchRunSnapshot | null;
  batchIsActive: boolean;
  isScanning: boolean;
  scanStatusMessage: string;
  scanPreview: ScanPreview | null;
  batchActionError: string | null;
  pathActionError: string | null;
  transcriptionFolderMessages: string[];
  speakerRecognitionEnabled: boolean;
  pyannoteModelInstalled: boolean;
  modelsStatusLoading: boolean;
  modelsStatusError: string | null;
};

function transcriptionRunStatusLabel({
  liveBatch,
  batchIsActive,
  isScanning,
  scanStatusMessage,
  scanPreview,
  batchActionError,
  pathActionError,
  transcriptionFolderMessages,
  speakerRecognitionEnabled,
  pyannoteModelInstalled,
  modelsStatusLoading,
  modelsStatusError
}: TranscriptionRunStatusInput): string {
  if (batchActionError) {
    return batchActionError;
  }
  if (pathActionError) {
    return pathActionError;
  }
  if (speakerRecognitionEnabled && modelsStatusError) {
    return `Speaker recognition status could not be checked: ${modelsStatusError}`;
  }
  if (speakerRecognitionEnabled && modelsStatusLoading) {
    return "Checking speaker recognition setup.";
  }
  if (speakerRecognitionEnabled && !pyannoteModelInstalled) {
    return "Speaker recognition setup required. Open Models to download the pyannote model.";
  }
  if (batchIsActive) {
    return liveBatch?.message || liveBatch?.current_file_name || "Processing files";
  }
  if (isFinishedBatch(liveBatch)) {
    return liveBatch.message || liveBatch.status;
  }
  if (isScanning) {
    return "Scanning input source...";
  }
  if (transcriptionFolderMessages.length > 0) {
    return transcriptionFolderMessages.join(" ");
  }
  if (scanStatusMessage && scanStatusMessage !== "Choose an input source to scan for media files.") {
    return scanStatusMessage;
  }
  if (scanPreview && !scanPreview.is_empty) {
    return "Ready to start transcription.";
  }
  return "Scan the input source before starting transcription.";
}

export function TranscriptionPage({ setup, scan, run }: TranscriptionPageContract) {
  const setupState = setup.state;
  const setupActions = setup.actions;
  const runState = run.state;
  const runActions = run.actions;
  const {
    advancedSettingsOpen,
    loading: runScreenLoading,
    bootstrapError: runScreenError,
    configurationLocked,
    inputSourceType,
    inputPath,
    transcriptOutputFolder,
    outputOrganization,
    modelName,
    modelOptions,
    acceleration,
    accelerationOptions,
    hardwareStatus,
    hardwareStatusMessage,
    hardwareRetryable,
    hardwareRequestError,
    language,
    languageOptions,
    outputMode,
    outputModes,
    transcriptLayout,
    transcriptLayoutOptions,
    paragraphPauseEnabled,
    paragraphPauseSeconds,
    exportFormats,
    exportFormatOptions,
    appSettings,
    settingsLoading,
    settingsError,
    settingsSavePending,
    settingsPersistenceError,
    pathActionError
  } = setupState;
  const {
    preview: scanPreview,
    isScanning,
    statusMessage: scanStatusMessage,
    folderMessages: transcriptionFolderMessages,
    speakerRecognitionEnabled,
    pyannoteModelInstalled,
    modelsStatusLoading,
    modelsStatusError
  } = scan;
  const {
    liveBatch,
    batchIsActive,
    isStarting: isStartingBatch,
    cancellationPending: isCancellingBatch,
    canStart: canStartBatch,
    displayFilesQueued,
    progressPercent: activeProgressPercent,
    startError,
    cancellationError,
    polling,
    cancelDialog
  } = runState;
  const batchActionError = cancellationError ?? startError;
  const statusIsStale = polling.isStale;
  const statusLastUpdatedAt = polling.lastUpdatedAt;
  const statusPollingError = polling.error;
  const setupTogglesDisabled = !appSettings || settingsLoading || settingsSavePending || configurationLocked;
  const setupSettingsError = settingsPersistenceError;
  const hasFinishedBatch = isFinishedBatch(liveBatch);
  const downloadedModelOptions = modelOptions.filter((option) => option.installed || option.bundled);
  const runStatusLabel = transcriptionRunStatusLabel({
    liveBatch,
    batchIsActive,
    isScanning,
    scanStatusMessage,
    scanPreview,
    batchActionError,
    pathActionError,
    transcriptionFolderMessages,
    speakerRecognitionEnabled,
    pyannoteModelInstalled,
    modelsStatusLoading,
    modelsStatusError
  });
  const hasSelectedInputFolder = inputSourceType === "folder" && Boolean(inputPath.trim());
  const includeTimestampsEnabled = Boolean(appSettings?.advanced_transcription.include_timestamps);
  const scanExclusions = scanPreview?.excluded_files ?? [];
  const batchExclusions = liveBatch?.exclusions ?? [];
  const displayedExclusions = batchExclusions.length > 0 ? batchExclusions : scanExclusions;
  const excludedCount = liveBatch?.excluded_count
    ?? liveBatch?.counts?.excluded
    ?? scanPreview?.excluded_count
    ?? displayedExclusions.length;
  const statusCount = (keys: string[], statuses: string[]): number => {
    for (const key of keys) {
      const value = liveBatch?.counts?.[key];
      if (typeof value === "number") {
        return value;
      }
    }
    return liveBatch?.files.filter((file) => statuses.includes(file.status.toLowerCase())).length ?? 0;
  };
  const completedCount = statusCount(["completed", "done", "success"], ["completed", "done", "success"]);
  const failedCount = statusCount(["failed", "error"], ["failed", "error"]);
  const skippedCount = statusCount(["skipped", "cancelled"], ["skipped", "cancelled"]);
  const createdOutputs = liveBatch?.output_files.filter((output) => output.exists) ?? [];
  const advancedSettings = appSettings?.advanced_transcription;
  const paragraphPauseValue = Number.parseFloat(paragraphPauseSeconds);
  const advancedSettingsCustomized = Boolean(
    (advancedSettings && (
      advancedSettings.beam_size !== 5
      || advancedSettings.vad_filter !== true
      || advancedSettings.temperature !== 0
      || advancedSettings.compute_type !== "int8"
      || advancedSettings.speaker_mode !== "auto"
      || advancedSettings.exact_speakers !== null
      || advancedSettings.min_speakers !== null
      || advancedSettings.max_speakers !== null
    ))
    || !paragraphPauseEnabled
    || !Number.isFinite(paragraphPauseValue)
    || paragraphPauseValue !== 3
  );

  return (
    <div className="page-stack">
      <section className="page-header compact-page-header transcription-page-header">
        <h2 className="home-main-title">Configure and Run Transcription</h2>
      </section>

      {runScreenLoading ? (
        <section className="section-card">
          <div className="empty-state">
            <strong>Loading transcription</strong>
            <p>Reading hardware, folders, and the current scan preview.</p>
          </div>
        </section>
      ) : runScreenError ? (
        <section className="section-card">
          <div className="empty-state">
            <strong>Transcription is not available</strong>
            <p>{runScreenError}</p>
          </div>
        </section>
      ) : (
        <>
          <div className="transcription-top-grid transcription-top-grid-single">
            <section className="section-card top-equal-card">
              <div className="section-heading">
                <div>
                  <h3 className="home-section-title">Inputs and Outputs</h3>
                </div>
              </div>

              <div className="transcription-io-columns">
                <section className="transcription-io-column" aria-labelledby="transcription-input-heading">
                  <h4 id="transcription-input-heading" className="transcription-io-column-title">Input</h4>
                  <WorkflowPathField
                    label={!inputPath ? "Media Input" : inputSourceType === "single_file" ? "Media File" : "Media Folder"}
                    value={inputPath}
                    placeholder="Choose a media file or folder"
                    onBrowse={() => void setupActions.pickInputSource("single_file")}
                    browseLabel="File"
                    secondaryBrowseLabel="Folder"
                    onSecondaryBrowse={() => void setupActions.pickInputSource("folder")}
                    onOpen={() =>
                      void setupActions.openPath(inputPath, {
                        expectDirectory: inputSourceType === "folder",
                        createIfMissing: inputSourceType === "folder"
                      })
                    }
                    onReset={setupActions.clearInput}
                    inlineBrowse
                    resetLabel="Clear"
                    disabled={configurationLocked}
                  />
                </section>

                <section className="transcription-io-column" aria-labelledby="transcription-output-heading">
                  <div className="transcription-output-heading-row">
                    <h4 id="transcription-output-heading" className="transcription-io-column-title">Output</h4>
                    {hasSelectedInputFolder ? (
                      <div className="transcription-output-heading-options">
                        <div className="transcription-native-radio-group" role="radiogroup" aria-label="Transcript Files">
                          <label className="transcription-native-radio">
                            <input
                              type="radio"
                              name="transcription-output-organization"
                              value="separate_files"
                              checked={outputOrganization === "separate_files"}
                              onChange={() => setupActions.setOutputOrganization("separate_files")}
                              disabled={configurationLocked}
                            />
                            <span>Separate files</span>
                          </label>
                          <label className="transcription-native-radio">
                            <input
                              type="radio"
                              name="transcription-output-organization"
                              value="combined_file"
                              checked={outputOrganization === "combined_file"}
                              onChange={() => setupActions.setOutputOrganization("combined_file")}
                              disabled={configurationLocked}
                            />
                            <span>Combined file</span>
                          </label>
                        </div>
                        <FieldLabelWithHelp
                          label="Transcript Files"
                          helpText={transcriptionFieldHelpText.outputOrganization}
                          labelClassName="transcription-output-heading-help"
                          hideLabel
                        />
                      </div>
                    ) : null}
                  </div>
                  <WorkflowPathField
                    label="Transcript Output Folder"
                    value={transcriptOutputFolder}
                    placeholder="Choose a transcript output folder"
                    onBrowse={() => void setupActions.pickOutputFolder()}
                    onOpen={() =>
                      void setupActions.openPath(transcriptOutputFolder, {
                        expectDirectory: true,
                        createIfMissing: true
                      })
                    }
                    onReset={setupActions.clearOutputFolder}
                    inlineBrowse
                    resetLabel="Clear"
                    disabled={configurationLocked}
                  />
                </section>
              </div>
            </section>
          </div>

          <section className="section-card">
            <div className="section-heading">
              <div>
                <h3 className="home-section-title">Transcription Setup</h3>
              </div>
            </div>

            <div className="form-grid transcription-form-grid">
              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp label="Task" helpText={transcriptionFieldHelpText.task} htmlFor="transcription-task" />
                <select id="transcription-task" className="text-input" value={outputMode} onChange={(event) => setupActions.setOutputMode(event.target.value)} disabled={configurationLocked}>
                  {outputModes.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {hardwareRequestError ? (
                  <div className="transcription-hardware-retry" role="alert">
                    <small>{hardwareRequestError}</small>
                    {hardwareRetryable ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={configurationLocked}
                        onClick={() => void setupActions.retryHardwareScan()}
                      >
                        Retry Hardware Scan
                      </button>
                    ) : null}
                  </div>
                ) : hardwareStatus === "checking" ? (
                  <small className="transcription-hardware-status" role="status">
                    {hardwareStatusMessage}
                  </small>
                ) : hardwareStatus === "failed" ? (
                  <div className="transcription-hardware-retry" role="alert">
                    <small>{hardwareStatusMessage}</small>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!hardwareRetryable || configurationLocked}
                      onClick={() => void setupActions.retryHardwareScan()}
                    >
                      Retry Hardware Scan
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp label="Model" helpText={transcriptionFieldHelpText.model} htmlFor="transcription-model" />
                <select
                  id="transcription-model"
                  className="text-input"
                  value={downloadedModelOptions.some((option) => option.value === modelName) ? modelName : ""}
                  onChange={(event) => setupActions.setModelName(event.target.value)}
                  disabled={configurationLocked || downloadedModelOptions.length === 0}
                >
                  {downloadedModelOptions.length === 0 ? (
                    <option value="">Download a model in Models first</option>
                  ) : null}
                  {downloadedModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {formatModelDropdownLabel(option.label)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp label="Acceleration" helpText={transcriptionFieldHelpText.acceleration} htmlFor="transcription-acceleration" />
                <select
                  id="transcription-acceleration"
                  className="text-input"
                  value={acceleration}
                  onChange={(event) => setupActions.setAcceleration(event.target.value)}
                  disabled={configurationLocked}
                >
                  {accelerationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp label="Language" helpText={transcriptionFieldHelpText.language} htmlFor="transcription-language" />
                <select id="transcription-language" className="text-input" value={language} onChange={(event) => setupActions.setLanguage(event.target.value)} disabled={configurationLocked}>
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp label="Transcript Structure" helpText={transcriptionFieldHelpText.transcriptLayout} htmlFor="transcription-structure" />
                <select
                  id="transcription-structure"
                  className="text-input"
                  value={transcriptLayout}
                  onChange={(event) => setupActions.setTranscriptLayout(event.target.value as typeof transcriptLayout)}
                  disabled={configurationLocked}
                >
                  {transcriptLayoutOptions.map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp
                  label="Speaker Detection"
                  helpText={transcriptionFieldHelpText.speakerRecognition}
                  htmlFor="transcription-speaker-detection"
                />
                <select
                  id="transcription-speaker-detection"
                  className="text-input"
                  value={speakerRecognitionEnabled ? "enabled" : "disabled"}
                  onChange={(event) => void setupActions.updateAdvancedToggle("diarization_enabled", event.target.value === "enabled")}
                  disabled={setupTogglesDisabled}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact">
                <FieldLabelWithHelp
                  label="Timestamps"
                  helpText={transcriptionFieldHelpText.includeTimestamps}
                  htmlFor="transcription-timestamps"
                />
                <select
                  id="transcription-timestamps"
                  className="text-input"
                  value={includeTimestampsEnabled ? "enabled" : "disabled"}
                  onChange={(event) => void setupActions.updateAdvancedToggle("include_timestamps", event.target.value === "enabled")}
                  disabled={setupTogglesDisabled}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact transcription-field-formats">
                <FieldLabelWithHelp label="Export Formats" helpText={transcriptionFieldHelpText.exportFormats} />
                <div className="transcription-format-grid" role="group" aria-label="Export Formats">
                  {exportFormatOptions.map((format) => (
                    <label key={format} className="transcription-plain-checkbox transcription-format-checkbox">
                      <input
                        type="checkbox"
                        checked={exportFormats.includes(format)}
                        onChange={(event) => setupActions.toggleExportFormat(format, event.target.checked)}
                        disabled={configurationLocked}
                      />
                      <span>{format.toUpperCase()}</span>
                    </label>
                  ))}
                </div>
              </div>

              {setupSettingsError ? (
                <div className="field-group transcription-field transcription-setup-error">
                  <p className="helper-text">{setupSettingsError}</p>
                </div>
              ) : null}
            </div>

            <div className={`transcription-advanced-accordion${advancedSettingsOpen ? " open" : ""}`}>
              <button
                type="button"
                className="transcription-advanced-summary"
                aria-expanded={advancedSettingsOpen}
                aria-controls="transcription-advanced-settings-content"
                onClick={() => setupActions.setAdvancedSettingsOpen(!advancedSettingsOpen)}
              >
                <span className="transcription-advanced-chevron" aria-hidden="true">›</span>
                <span className="transcription-advanced-summary-label">Advanced Settings</span>
                {advancedSettingsCustomized ? (
                  <span className="transcription-advanced-customized-badge">Customized</span>
                ) : null}
              </button>
              <div
                id="transcription-advanced-settings-content"
                className="transcription-advanced-accordion-content"
                hidden={!advancedSettingsOpen}
              >
                <AdvancedTranscriptionPanel
                  settings={appSettings}
                  settingsLoading={settingsLoading}
                  settingsError={settingsError}
                  transcriptLayout={transcriptLayout}
                  paragraphPauseEnabled={paragraphPauseEnabled}
                  onParagraphPauseEnabledChange={setupActions.setParagraphPauseEnabled}
                  paragraphPauseSeconds={paragraphPauseSeconds}
                  onParagraphPauseSecondsChange={setupActions.setParagraphPauseSeconds}
                  configurationLocked={configurationLocked}
                  canPersistSettings={setupActions.canPersistSettings}
                  onSaveAdvancedSettings={setupActions.saveAdvancedSettings}
                />
              </div>
            </div>
          </section>

          <section className="section-card">
            <div className="section-heading">
              <div>
                <h3 className="home-section-title">
                  <FieldLabelWithHelp
                    label="Run Transcription"
                    helpText={transcriptionFieldHelpText.runTranscription}
                    labelClassName="home-section-title"
                  />
                </h3>
              </div>
            </div>

            {scanPreview ? (
              <div className="scan-readiness" role="status" aria-live="polite">
                <strong>{scanPreview.file_count} ready · {excludedCount} excluded</strong>
                {displayedExclusions.length > 0 ? (
                  <details className="run-detail-disclosure">
                    <summary>Problems ({excludedCount})</summary>
                    <ul className="run-problem-list">
                      {displayedExclusions.map((excluded, index) => (
                        <li key={`${excluded.source_path ?? excluded.file_name}:${index}`}>
                          <strong>{excluded.file_name}</strong>
                          <span>{excluded.message || excluded.code}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}

            {statusIsStale && liveBatch ? (
              <div className="stale-status-note" role="alert">
                <strong>Showing the last known run status.</strong>
                <span>{statusPollingError ?? "The local service is temporarily unavailable."}</span>
                {statusLastUpdatedAt ? (
                  <small>Last updated {new Date(statusLastUpdatedAt).toLocaleTimeString()}</small>
                ) : null}
              </div>
            ) : null}

            {/* Keep scanning and running in one action row so the everyday workflow
                stays visible without bouncing between separate status sections. */}
            <div className="run-action-row transcription-run-action-row">
              <button
                type="button"
                className={`${batchIsActive ? "secondary-button danger-button" : "primary-button"} transcription-action-button`}
                disabled={batchIsActive ? isCancellingBatch : !canStartBatch}
                onClick={() => (batchIsActive ? runActions.requestCancellation() : void runActions.start())}
              >
                {batchIsActive
                  ? isCancellingBatch
                    ? "Stopping..."
                    : "Stop"
                  : isStartingBatch
                    ? "Starting..."
                    : "Start"}
              </button>

              <button
                type="button"
                className="secondary-button transcription-action-button"
                onClick={runActions.newRun}
                disabled={isScanning || batchIsActive || isStartingBatch || isCancellingBatch}
              >
                New Run
              </button>

              <div className="progress-grid run-summary-grid transcription-run-summary-grid">
                <RunSummaryPanel label="Status" value={runStatusLabel} className="status-summary-panel" />
                <RunSummaryPanel
                  label="Files"
                  helpText={transcriptionFieldHelpText.files}
                  value={`${liveBatch?.files_completed ?? 0} / ${displayFilesQueued}`}
                />
                <RunSummaryPanel
                  label="Duration"
                  helpText={transcriptionFieldHelpText.duration}
                  value={scanPreview?.total_duration_label ?? "Unavailable"}
                />
              </div>
            </div>

            {liveBatch ? (
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Transcription progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(activeProgressPercent)}
                aria-valuetext={`${liveBatch.files_completed} of ${liveBatch.total_files} files processed`}
              >
                <div className="progress-fill" style={{ width: `${activeProgressPercent}%` }} />
              </div>
            ) : null}

            {liveBatch ? (
              <div className="run-detail-grid" aria-live="polite">
                <div className="run-count-summary">
                  <span><strong>{completedCount}</strong> completed</span>
                  <span><strong>{failedCount}</strong> failed</span>
                  <span><strong>{excludedCount}</strong> excluded</span>
                  <span><strong>{skippedCount}</strong> skipped</span>
                  <span><strong>{createdOutputs.length}</strong> outputs</span>
                </div>
                {liveBatch.files.length > 0 ? (
                  <details className="run-detail-disclosure" open={failedCount > 0}>
                    <summary>File Status ({liveBatch.files.length})</summary>
                    <ul className="batch-file-status-list">
                      {liveBatch.files.map((file, index) => (
                        <li key={`${file.file_name}:${index}`} className={`batch-file-status ${file.status.toLowerCase()}`}>
                          <div>
                            <strong>{file.file_name}</strong>
                            <span className="batch-status-label">{file.status.replace(/_/g, " ")}</span>
                          </div>
                          {file.error ? <p>{file.error}</p> : null}
                          {file.warnings.length > 0 ? <p>{file.warnings.join(" ")}</p> : null}
                          {file.device || file.used_fallback ? (
                            <small>{file.device ? `Device: ${file.device}` : ""}{file.used_fallback ? " · CPU fallback used" : ""}</small>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {hasFinishedBatch && createdOutputs.length > 0 ? (
                  <details className="run-detail-disclosure">
                    <summary>Created Outputs ({createdOutputs.length})</summary>
                    <ul className="created-output-list">
                      {createdOutputs.map((output, index) => (
                        <li key={`${output.path}:${index}`} title={output.path}>
                          {outputPathFileName(output.path) || output.file_name || output.path}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}

            {hasFinishedBatch ? (
              <div className="run-results">
                <div className="action-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!transcriptOutputFolder.trim()}
                    onClick={() =>
                      void setupActions.openPath(transcriptOutputFolder, {
                        expectDirectory: true,
                        createIfMissing: true
                      })
                    }
                  >
                    Open Output Folder
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!liveBatch.log_file}
                    onClick={() => void runActions.openLogsFolder()}
                  >
                    Open Logs Folder
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      )}
      <TranscriptionCancelDialog
        open={cancelDialog.open}
        pending={isCancellingBatch}
        onConfirm={() => void runActions.confirmCancellation(cancelDialog.requestKey)}
        onCancel={() => runActions.cancelCancellationDialog(cancelDialog.requestKey)}
      />
    </div>
  );
}
