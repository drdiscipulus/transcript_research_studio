import { useEffect, useRef, useState } from "react";
import type { CodesProject, PromptingModel, PromptingProviderStatus } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import { BUILT_IN_CODES_AI_PROMPTS, type ContextualAiTask } from "./codesAiPrompts";

type CodesAiSettingsProps = {
  project: CodesProject;
  open: boolean;
  focusRequest: number;
  providers: PromptingProviderStatus[];
  models: PromptingModel[];
  providersLoading: boolean;
  modelsLoading: boolean;
  hasModelSnapshot: boolean;
  providerError: string | null;
  modelError: string | null;
  configurationError: string | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onRefreshProviders: () => void;
  onUpdate: (update: Partial<CodesProject["ai_settings"]>) => boolean;
};

const taskLabels: Record<ContextualAiTask, string> = {
  evidence: "Evidence Suggestions",
  codes: "Code Suggestions",
  note: "Note Drafting",
  codebook: "Codebook Assistance",
  themes: "Theme Assistance"
};

export function CodesAiSettings({
  project,
  open,
  focusRequest,
  providers,
  models,
  providersLoading,
  modelsLoading,
  hasModelSnapshot,
  providerError,
  modelError,
  configurationError,
  busy,
  onOpenChange,
  onRefreshProviders,
  onUpdate
}: CodesAiSettingsProps) {
  const providerRef = useRef<HTMLSelectElement>(null);
  const [draftPrompts, setDraftPrompts] = useState(() => ({
    evidence: project.ai_settings.prompt_overrides?.evidence ?? "",
    codes: project.ai_settings.prompt_overrides?.codes ?? "",
    note: project.ai_settings.prompt_overrides?.note ?? "",
    codebook: project.ai_settings.prompt_overrides?.codebook ?? "",
    themes: project.ai_settings.prompt_overrides?.themes ?? ""
  }));
  const [promptsOpen, setPromptsOpen] = useState(false);
  const selectedProvider = providers.find((provider) => provider.id === project.ai_settings.provider_id);
  const selectedModel = models.find((model) => model.id === project.ai_settings.model_id);
  const configuredProviderUnavailable = Boolean(
    project.ai_settings.provider_id
    && !providersLoading
    && !selectedProvider?.available
  );
  const configuredModelMissing = Boolean(
    project.ai_settings.model_id
    && hasModelSnapshot
    && !selectedModel
  );
  const configured = Boolean(project.ai_settings.provider_id && project.ai_settings.model_id);

  useEffect(() => {
    setDraftPrompts({
      evidence: project.ai_settings.prompt_overrides?.evidence ?? "",
      codes: project.ai_settings.prompt_overrides?.codes ?? "",
      note: project.ai_settings.prompt_overrides?.note ?? "",
      codebook: project.ai_settings.prompt_overrides?.codebook ?? "",
      themes: project.ai_settings.prompt_overrides?.themes ?? ""
    });
  }, [project.project_id, project.ai_settings.prompt_overrides]);

  useEffect(() => {
    if (open && focusRequest) window.setTimeout(() => providerRef.current?.focus(), 0);
  }, [focusRequest, open]);

  function savePrompt(task: ContextualAiTask) {
    if (busy) return;
    onUpdate({
      prompt_overrides: {
        evidence: project.ai_settings.prompt_overrides?.evidence ?? "",
        codes: project.ai_settings.prompt_overrides?.codes ?? "",
        note: project.ai_settings.prompt_overrides?.note ?? "",
        codebook: project.ai_settings.prompt_overrides?.codebook ?? "",
        themes: project.ai_settings.prompt_overrides?.themes ?? "",
        [task]: draftPrompts[task].trim()
      }
    });
  }

  function restorePrompt(task: ContextualAiTask) {
    if (busy) return;
    const updated = onUpdate({
      prompt_overrides: {
        evidence: project.ai_settings.prompt_overrides?.evidence ?? "",
        codes: project.ai_settings.prompt_overrides?.codes ?? "",
        note: project.ai_settings.prompt_overrides?.note ?? "",
        codebook: project.ai_settings.prompt_overrides?.codebook ?? "",
        themes: project.ai_settings.prompt_overrides?.themes ?? "",
        [task]: ""
      }
    });
    if (updated) setDraftPrompts((current) => ({ ...current, [task]: "" }));
  }

  return (
    <section className="codes-project-settings codes-ai-settings">
      <div className="details-heading-row">
        <button
          type="button"
          className="details-heading-button"
          aria-expanded={open}
          aria-controls="codes-ai-settings-content"
          onClick={() => onOpenChange(!open)}
        >
          <span className={`accordion-chevron${open ? " open" : ""}`} aria-hidden="true">›</span>
          <strong>AI Assistant Settings</strong>
          {configured ? (
            <small>{selectedProvider?.name ?? project.ai_settings.provider_id} · {selectedModel?.display_name ?? project.ai_settings.model_id}</small>
          ) : null}
        </button>
        <FieldLabelWithHelp
          label="AI Assistant Settings"
          hideLabel
          helpText="Configure a local provider for advisory assistance. AI never changes coding work without your Save action."
        />
      </div>
      <div id="codes-ai-settings-content" className="codes-ai-settings-body" hidden={!open}>
        <div className="codes-ai-settings-options-grid">
          <div className="field-group transcription-field transcription-field-compact codes-ai-provider-field">
            <FieldLabelWithHelp label="Provider" helpText="Choose a local Ollama or LM Studio service." htmlFor="codes-ai-provider" />
            <select
              id="codes-ai-provider"
              ref={providerRef}
              aria-label="Provider"
              className="text-input"
              value={project.ai_settings.provider_id}
              disabled={busy || providersLoading}
              onChange={(event) => {
                if (!busy) onUpdate({ provider_id: event.target.value, model_id: "" });
              }}
            >
              <option value="">{providersLoading ? "Checking Providers…" : "Choose A Provider"}</option>
              {configuredProviderUnavailable ? (
                <option value={project.ai_settings.provider_id} disabled>
                  Unavailable: {selectedProvider?.name ?? project.ai_settings.provider_id}
                </option>
              ) : null}
              {providers.filter((provider) => provider.available).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </div>
          <div className="field-group transcription-field transcription-field-compact codes-ai-model-field">
            <FieldLabelWithHelp label="Model" helpText="Choose the local model used for contextual Codes assistance." htmlFor="codes-ai-model" />
            <select
              id="codes-ai-model"
              aria-label="Model"
              className="text-input"
              value={project.ai_settings.model_id}
              disabled={busy || !project.ai_settings.provider_id || modelsLoading}
              onChange={(event) => {
                if (!busy) onUpdate({ model_id: event.target.value });
              }}
            >
              <option value="">{modelsLoading ? "Loading Models…" : "Choose A Model"}</option>
              {project.ai_settings.model_id && !selectedModel ? (
                <option value={project.ai_settings.model_id} disabled={configuredModelMissing}>
                  {configuredModelMissing ? "Unavailable: " : "Configured: "}{project.ai_settings.model_id}
                </option>
              ) : null}
              {models.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}
            </select>
          </div>
          <div className="field-group transcription-field transcription-field-compact codes-ai-number-field">
            <FieldLabelWithHelp label="Temperature" helpText="Lower values are more repeatable. The project default is 0." htmlFor="codes-ai-temperature" />
            <input id="codes-ai-temperature" className="text-input" type="number" min={0} max={2} step={0.1} value={project.ai_settings.temperature} disabled={busy} onChange={(event) => {
              if (!busy) onUpdate({ temperature: Number(event.target.value) || 0 });
            }} />
          </div>
          <div className="field-group transcription-field transcription-field-compact codes-ai-number-field">
            <FieldLabelWithHelp label="Timeout" helpText="Maximum seconds for each local model request. The project default is 180." htmlFor="codes-ai-timeout" />
            <input id="codes-ai-timeout" className="text-input" type="number" min={10} max={3600} step={10} value={project.ai_settings.timeout_seconds} disabled={busy} onChange={(event) => {
              if (!busy) onUpdate({ timeout_seconds: Number(event.target.value) || 180 });
            }} />
          </div>
          <div className="codes-ai-refresh-field">
            <button
              type="button"
              className="secondary-button compact"
              disabled={busy || providersLoading || modelsLoading}
              onClick={onRefreshProviders}
            >
              {providersLoading ? "Refreshing Providers…" : "Refresh Providers"}
            </button>
          </div>
        </div>
        {providerError ? <div className="codes-ai-inline-message error" role="alert">Provider status: {providerError}</div> : null}
        {modelError ? <div className="codes-ai-inline-message error" role="alert">Model catalog: {modelError}</div> : null}
        {configurationError ? <div className="codes-ai-inline-message error" role="alert">{configurationError}</div> : null}
        <section className="codes-ai-prompt-settings">
          <div className="details-heading-row">
            <button
              type="button"
              className="details-heading-button"
              aria-expanded={promptsOpen}
              aria-controls="codes-ai-prompt-list"
              onClick={() => setPromptsOpen((current) => !current)}
            >
              <span className={`accordion-chevron${promptsOpen ? " open" : ""}`} aria-hidden="true">›</span>
              <strong>Project Prompt Templates</strong>
            </button>
            <FieldLabelWithHelp
              label="Project Prompt Templates"
              hideLabel
              helpText="These analytical instructions are stored in this coding project. Protected response and source-validation rules cannot be changed here."
            />
          </div>
          <div id="codes-ai-prompt-list" className="codes-ai-prompt-list" hidden={!promptsOpen}>
            {(Object.keys(taskLabels) as ContextualAiTask[]).map((task) => (
              <label key={task} className="field-group">
                <span className="field-label">{taskLabels[task]}</span>
                <textarea
                  className="text-input"
                  rows={3}
                  value={draftPrompts[task] || BUILT_IN_CODES_AI_PROMPTS[task]}
                  disabled={busy}
                  onChange={(event) => {
                    if (!busy) setDraftPrompts((current) => ({ ...current, [task]: event.target.value }));
                  }}
                />
                <span className="action-row">
                  <button type="button" className="secondary-button compact" onClick={() => savePrompt(task)} disabled={busy}>Save as Project Default</button>
                  <button type="button" className="secondary-button compact" onClick={() => restorePrompt(task)} disabled={busy}>Restore Built-in Default</button>
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
