import { useEffect, useRef, useState } from "react";
import { FieldLabelWithHelp } from "./FieldLabelWithHelp";
import type { AppSettings } from "../lib/api";

type AdvancedTranscriptionPanelProps = {
  settings: AppSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  transcriptLayout: string;
  paragraphPauseEnabled: boolean;
  onParagraphPauseEnabledChange: (value: boolean) => void;
  paragraphPauseSeconds: string;
  onParagraphPauseSecondsChange: (value: string) => void;
  configurationLocked?: boolean;
  canPersistSettings?: () => boolean;
  onSaveAdvancedSettings: (
    advanced: AppSettings["advanced_transcription"]
  ) => Promise<AppSettings | null>;
};

const advancedFieldHelpText = {
  beamSize:
    "Controls how many alternative word sequences the decoder keeps while listening. The default is a good starting point. Higher values search more possibilities and can help ambiguous audio, but they slow the run down; lower values are faster but may miss harder words.",
  vadFilter: "Skips stretches that look like silence or non-speech before decoding. This usually helps with cleaner segmentation on noisy recordings.",
  temperature:
    "Controls how deterministic decoding is. Lower values are more stable; higher values allow more variation when the audio is difficult.",
  computeType:
    "Controls numeric precision for faster-whisper. int8 is the safest default. float16 is mainly for CUDA GPUs with FP16 support. float32 uses more memory and is mostly useful for compatibility checks.",
  paragraphPause:
    "Used only when Transcript Structure is Paragraphs. Detected speaker changes always start a new paragraph. When checked, a pause longer than this value also starts a new paragraph within the same speaker's turn. Lower values create shorter paragraphs; higher values merge more text. Without speaker labels, pauses provide the paragraph boundaries. When unchecked, pauses are ignored; if speaker labels are also unavailable, the transcript may become one paragraph. Separate from faster-whisper VAD."
} as const;

type AdvancedSettings = AppSettings["advanced_transcription"];

function advancedSettingsSignature(settings: AdvancedSettings): string {
  return JSON.stringify({
    diarization_enabled: settings.diarization_enabled,
    include_timestamps: settings.include_timestamps,
    beam_size: settings.beam_size,
    vad_filter: settings.vad_filter,
    temperature: settings.temperature,
    compute_type: settings.compute_type,
    speaker_mode: settings.speaker_mode,
    exact_speakers: settings.exact_speakers,
    min_speakers: settings.min_speakers,
    max_speakers: settings.max_speakers
  });
}

export function AdvancedTranscriptionPanel({
  settings,
  settingsLoading,
  settingsError,
  transcriptLayout,
  paragraphPauseEnabled,
  onParagraphPauseEnabledChange,
  paragraphPauseSeconds,
  onParagraphPauseSecondsChange,
  configurationLocked = false,
  canPersistSettings = () => true,
  onSaveAdvancedSettings
}: AdvancedTranscriptionPanelProps) {
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [advancedSaveError, setAdvancedSaveError] = useState<string | null>(null);

  const [diarizationEnabled, setDiarizationEnabled] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(false);
  const [beamSize, setBeamSize] = useState("5");
  const [vadFilter, setVadFilter] = useState(true);
  const [temperature, setTemperature] = useState("0");
  const [computeType, setComputeType] = useState("int8");
  const [speakerMode, setSpeakerMode] = useState("auto");
  const [exactSpeakers, setExactSpeakers] = useState("");
  const [minSpeakers, setMinSpeakers] = useState("");
  const [maxSpeakers, setMaxSpeakers] = useState("");
  const savedSignatureRef = useRef("");
  const paragraphLayoutSelected = transcriptLayout === "paragraph";

  useEffect(() => {
    if (!settings) {
      return;
    }
    const advanced = settings.advanced_transcription;
    const localSignature = advancedSettingsSignature({
      diarization_enabled: diarizationEnabled,
      include_timestamps: includeTimestamps,
      beam_size: Math.max(Number.parseInt(beamSize || "0", 10) || 0, 1),
      vad_filter: vadFilter,
      temperature: Math.min(Math.max(Number.parseFloat(temperature || "0") || 0, 0), 1),
      compute_type: computeType || "int8",
      speaker_mode: speakerMode,
      exact_speakers: speakerMode === "exact" ? Number(exactSpeakers || 0) || null : null,
      min_speakers: speakerMode === "range" ? Number(minSpeakers || 0) || null : null,
      max_speakers: speakerMode === "range" ? Number(maxSpeakers || 0) || null : null
    });
    const hasLocalDraft = Boolean(
      savedSignatureRef.current && localSignature !== savedSignatureRef.current
    );
    setDiarizationEnabled(advanced.diarization_enabled);
    setIncludeTimestamps(advanced.include_timestamps);
    if (!hasLocalDraft) {
      setBeamSize(String(advanced.beam_size || 5));
      setVadFilter(advanced.vad_filter ?? true);
      setTemperature(String(advanced.temperature ?? 0));
      setComputeType(advanced.compute_type || "int8");
      setSpeakerMode(advanced.speaker_mode);
      setExactSpeakers(advanced.exact_speakers ? String(advanced.exact_speakers) : "");
      setMinSpeakers(advanced.min_speakers ? String(advanced.min_speakers) : "");
      setMaxSpeakers(advanced.max_speakers ? String(advanced.max_speakers) : "");
    }
    savedSignatureRef.current = advancedSettingsSignature(advanced);
    // A settings refresh may update top-level toggles while the remaining local fields stay a draft.
    // The save effect below compares that retained draft with this exact persisted baseline.
  }, [
    beamSize,
    computeType,
    diarizationEnabled,
    exactSpeakers,
    includeTimestamps,
    maxSpeakers,
    minSpeakers,
    settings,
    speakerMode,
    temperature,
    vadFilter
  ]);

  useEffect(() => {
    if (!settings || settingsLoading || settingsError || configurationLocked) {
      return;
    }

    const nextPayload = {
      diarization_enabled: diarizationEnabled,
      include_timestamps: includeTimestamps,
      beam_size: Math.max(Number.parseInt(beamSize || "0", 10) || 0, 1),
      vad_filter: vadFilter,
      temperature: Math.min(Math.max(Number.parseFloat(temperature || "0") || 0, 0), 1),
      compute_type: computeType || "int8",
      speaker_mode: speakerMode,
      exact_speakers: speakerMode === "exact" ? Number(exactSpeakers || 0) || null : null,
      min_speakers: speakerMode === "range" ? Number(minSpeakers || 0) || null : null,
      max_speakers: speakerMode === "range" ? Number(maxSpeakers || 0) || null : null,
    };
    const nextSignature = JSON.stringify(nextPayload);
    if (!savedSignatureRef.current || nextSignature === savedSignatureRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      if (!canPersistSettings()) {
        return;
      }
      setIsSavingSettings(true);
      setAdvancedSaveError(null);
      try {
        const nextSettings = await onSaveAdvancedSettings(nextPayload);
        if (!nextSettings) {
          return;
        }
        if (advancedSettingsSignature(nextSettings.advanced_transcription) === nextSignature) {
          savedSignatureRef.current = nextSignature;
        }
      } catch (error) {
        setAdvancedSaveError(error instanceof Error ? error.message : "Advanced settings could not be saved.");
      } finally {
        setIsSavingSettings(false);
      }
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [
    beamSize,
    canPersistSettings,
    computeType,
    configurationLocked,
    diarizationEnabled,
    exactSpeakers,
    includeTimestamps,
    maxSpeakers,
    minSpeakers,
    onSaveAdvancedSettings,
    settings,
    settingsError,
    settingsLoading,
    speakerMode,
    temperature,
    vadFilter,
  ]);

  function resetAdvancedSettings() {
    if (configurationLocked) return;
    setBeamSize("5");
    setVadFilter(true);
    setTemperature("0");
    setComputeType("int8");
    setSpeakerMode("auto");
    setExactSpeakers("");
    setMinSpeakers("");
    setMaxSpeakers("");
    onParagraphPauseEnabledChange(true);
    onParagraphPauseSecondsChange("3");
  }

  return (
    <div className="advanced-panel-stack">
      {settingsLoading ? (
        <div className="empty-state">
          <strong>Loading advanced settings</strong>
          <p>Reading saved transcription options.</p>
        </div>
      ) : settingsError ? (
        <div className="empty-state">
          <strong>Advanced settings are not available</strong>
          <p>{settingsError}</p>
        </div>
      ) : (
        <>
            <div className="form-grid advanced-form-grid">
              <div className="field-group transcription-field transcription-field-compact advanced-field-beam">
                <FieldLabelWithHelp label="Beam Size" helpText={advancedFieldHelpText.beamSize} htmlFor="advanced-beam-size" />
                <input
                  id="advanced-beam-size"
                  className="text-input"
                  type="number"
                  min={1}
                  placeholder="5"
                  value={beamSize}
                  onChange={(event) => setBeamSize(event.target.value)}
                  disabled={configurationLocked}
                />
              </div>

              <div className="field-group transcription-field transcription-field-compact advanced-field-vad">
                <FieldLabelWithHelp label="VAD Filter" helpText={advancedFieldHelpText.vadFilter} htmlFor="advanced-vad-filter" />
                <select
                  id="advanced-vad-filter"
                  className="text-input"
                  value={vadFilter ? "on" : "off"}
                  onChange={(event) => setVadFilter(event.target.value === "on")}
                  disabled={configurationLocked}
                >
                  <option value="on">Enabled</option>
                  <option value="off">Disabled</option>
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact advanced-field-temperature">
                <FieldLabelWithHelp label="Temperature" helpText={advancedFieldHelpText.temperature} htmlFor="advanced-temperature" />
                <input
                  id="advanced-temperature"
                  className="text-input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  placeholder="0"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                  disabled={configurationLocked}
                />
              </div>

              <div className="field-group transcription-field transcription-field-compact advanced-field-compute">
                <FieldLabelWithHelp label="Compute Type" helpText={advancedFieldHelpText.computeType} htmlFor="advanced-compute-type" />
                <select
                  id="advanced-compute-type"
                  className="text-input"
                  value={computeType}
                  onChange={(event) => setComputeType(event.target.value)}
                  disabled={configurationLocked}
                >
                  <option value="int8">int8 (safe/default)</option>
                  <option value="float16">float16 (CUDA/FP16 GPU)</option>
                  <option value="float32">float32 (heavier fallback)</option>
                </select>
              </div>

              <div className="field-group transcription-field transcription-field-compact paragraph-rule-field paragraph-pause-control-field advanced-field-paragraph">
                <FieldLabelWithHelp label="Pause-Based Breaks" helpText={advancedFieldHelpText.paragraphPause} />
                <div className="paragraph-pause-control-row">
                  <label className="transcription-plain-checkbox paragraph-pause-checkbox">
                    <input
                      type="checkbox"
                      checked={paragraphPauseEnabled}
                      onChange={(event) => onParagraphPauseEnabledChange(event.target.checked)}
                      disabled={configurationLocked || !paragraphLayoutSelected}
                    />
                    <span>Enabled</span>
                  </label>
                  <input
                    className="text-input"
                    type="number"
                    min={0}
                    step={0.1}
                    aria-label="Pause threshold in seconds"
                    value={paragraphPauseSeconds}
                    onChange={(event) => onParagraphPauseSecondsChange(event.target.value)}
                    disabled={configurationLocked || !paragraphLayoutSelected || !paragraphPauseEnabled}
                  />
                  <span className="paragraph-pause-unit" aria-hidden="true">seconds</span>
                </div>
              </div>
            </div>

            <div className="advanced-speaker-settings">
              <label className="field-group transcription-field transcription-field-compact">
                <span className="field-label">Speaker Mode</span>
                <select
                  className="text-input"
                  value={speakerMode}
                  onChange={(event) => setSpeakerMode(event.target.value)}
                  disabled={configurationLocked || !diarizationEnabled}
                >
                  <option value="auto">Auto</option>
                  <option value="exact">Exact count</option>
                  <option value="range">Range</option>
                </select>
              </label>

              {speakerMode === "exact" ? (
                <label className="field-group transcription-field transcription-field-compact">
                  <span className="field-label">Exact Speakers</span>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    value={exactSpeakers}
                    onChange={(event) => setExactSpeakers(event.target.value)}
                    disabled={configurationLocked || !diarizationEnabled}
                  />
                </label>
              ) : speakerMode === "range" ? (
                <>
                  <label className="field-group transcription-field transcription-field-compact">
                    <span className="field-label">Minimum Speakers</span>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      value={minSpeakers}
                      onChange={(event) => setMinSpeakers(event.target.value)}
                    disabled={configurationLocked || !diarizationEnabled}
                    />
                  </label>
                  <label className="field-group transcription-field transcription-field-compact">
                    <span className="field-label">Maximum Speakers</span>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      value={maxSpeakers}
                      onChange={(event) => setMaxSpeakers(event.target.value)}
                    disabled={configurationLocked || !diarizationEnabled}
                    />
                  </label>
                </>
              ) : null}
            </div>

          <div className="advanced-settings-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={resetAdvancedSettings}
              disabled={!settings || isSavingSettings || configurationLocked}
            >
              Reset to defaults
            </button>
            {isSavingSettings ? <span className="helper-text">Saving advanced settings...</span> : null}
          </div>
          {advancedSaveError ? <p className="helper-text">{advancedSaveError}</p> : null}
        </>
      )}
    </div>
  );
}
