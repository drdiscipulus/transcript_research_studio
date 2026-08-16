import { useCallback, useEffect, useState } from "react";

import type { PromptingProviderStatus } from "../lib/api";
import { useProviderModelCatalog } from "./useProviderModelCatalog";

export function usePromptingModels(availableProviders: PromptingProviderStatus[]) {
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const {
    models,
    modelsLoading,
    modelError,
    hasTrustworthySnapshot,
    hasModel,
    refreshModels
  } = useProviderModelCatalog(selectedProviderId);

  const changeProvider = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setSelectedModelId("");
  }, []);

  useEffect(() => {
    if (selectedProviderId && availableProviders.some((provider) => provider.id === selectedProviderId)) {
      return;
    }
    changeProvider(availableProviders[0]?.id ?? "");
  }, [availableProviders, changeProvider, selectedProviderId]);

  useEffect(() => {
    if (!selectedProviderId || modelsLoading) return;
    if (modelError || !hasTrustworthySnapshot) {
      setSelectedModelId("");
      return;
    }
    setSelectedModelId((current) => hasModel(current)
      ? current
      : models.find((model) => model.is_loaded)?.id
        ?? models[0]?.id
        ?? "");
  }, [hasModel, hasTrustworthySnapshot, modelError, models, modelsLoading, selectedProviderId]);

  const modelSelectionValid = Boolean(
    selectedModelId
      && hasModel(selectedModelId)
      && !modelsLoading
      && !modelError
  );

  return {
    selectedProviderId,
    selectedModelId,
    models,
    modelsLoading,
    modelError,
    modelSelectionValid,
    changeProvider,
    setSelectedModelId,
    refreshModels
  };
}
