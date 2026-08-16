import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import {
  type PromptingModel,
  type PromptingProviderStatus
} from "../../lib/api";

type PromptingModelSettingsProps = {
  providersLoading: boolean;
  providerError: string | null;
  availableProviders: PromptingProviderStatus[];
  selectedProvider: PromptingProviderStatus | null;
  selectedProviderId: string;
  models: PromptingModel[];
  modelsLoading: boolean;
  selectedModelId: string;
  temperature: number;
  timeoutSeconds: number;
  providerHelpText: string;
  modelHelpText: string;
  temperatureHelpText: string;
  timeoutHelpText: string;
  configurationLocked?: boolean;
  onRefreshProviders?: () => void;
  onSelectedProviderIdChange: (value: string) => void;
  onSelectedModelIdChange: (value: string) => void;
  onTemperatureChange: (value: number) => void;
  onTimeoutSecondsChange: (value: number) => void;
};

export function PromptingModelSettings({
  providersLoading,
  providerError,
  availableProviders,
  selectedProvider,
  selectedProviderId,
  models,
  modelsLoading,
  selectedModelId,
  temperature,
  timeoutSeconds,
  providerHelpText,
  modelHelpText,
  temperatureHelpText,
  timeoutHelpText,
  configurationLocked = false,
  onRefreshProviders,
  onSelectedProviderIdChange,
  onSelectedModelIdChange,
  onTemperatureChange,
  onTimeoutSecondsChange
}: PromptingModelSettingsProps) {
  return (
    <section className="section-card">
      <div className="section-heading">
        <h3 className="home-section-title">Local LLM Settings</h3>
      </div>
      <div className="form-grid prompting-form-grid prompting-model-settings-grid">
        <div className="field-group transcription-field transcription-field-compact prompting-model-provider-field">
          <FieldLabelWithHelp label="Provider" helpText={providerHelpText} htmlFor="prompting-provider" />
          <select id="prompting-provider" className="text-input" value={selectedProviderId} onChange={(event) => onSelectedProviderIdChange(event.target.value)} disabled={configurationLocked || availableProviders.length === 0 || (providersLoading && availableProviders.length === 0)}>
            <option value="">{providersLoading ? "Checking Providers…" : availableProviders.length === 0 ? "No Provider Running" : "Choose a Provider"}</option>
            {availableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </div>
        <div className="field-group transcription-field transcription-field-compact prompting-model-model-field">
          <FieldLabelWithHelp label="Model" helpText={modelHelpText} htmlFor="prompting-model" />
          <select id="prompting-model" className="text-input" value={selectedModelId} onChange={(event) => onSelectedModelIdChange(event.target.value)} disabled={configurationLocked || !selectedProviderId || modelsLoading || !selectedProvider?.available}>
          <option value="">{modelsLoading ? "Loading Models…" : "Choose a Model"}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.display_name}</option>
            ))}
          </select>
        </div>
        <div className="field-group transcription-field transcription-field-compact prompting-model-number-field">
          <FieldLabelWithHelp label="Temperature" helpText={temperatureHelpText} htmlFor="prompting-temperature" />
          <input id="prompting-temperature" className="text-input" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => onTemperatureChange(Number(event.target.value) || 0)} disabled={configurationLocked} />
        </div>
        <div className="field-group transcription-field transcription-field-compact prompting-model-number-field">
          <FieldLabelWithHelp label="Timeout" helpText={timeoutHelpText} htmlFor="prompting-timeout" />
          <input id="prompting-timeout" className="text-input" type="number" min={10} max={3600} step={10} value={timeoutSeconds} onChange={(event) => onTimeoutSecondsChange(Number(event.target.value) || 180)} disabled={configurationLocked} />
        </div>
        {onRefreshProviders ? (
          <div className="prompting-model-refresh-field">
            <button
              type="button"
              className="secondary-button compact"
              onClick={onRefreshProviders}
              disabled={configurationLocked || providersLoading}
              aria-label="Refresh Providers"
            >
              {providersLoading ? "Refreshing…" : "Refresh Providers"}
            </button>
          </div>
        ) : null}
      </div>
      {providerError ? <div className="inline-alert" role="alert">{providerError}</div> : null}
    </section>
  );
}
