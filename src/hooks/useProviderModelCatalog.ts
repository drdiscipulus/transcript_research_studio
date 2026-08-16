import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchPromptingModels, type PromptingModel } from "../lib/api";

type ProviderModelSnapshot = {
  providerId: string;
  models: PromptingModel[];
};

type ProviderModelRequest = {
  providerId: string;
  loading: boolean;
  error: string | null;
};

export function useProviderModelCatalog(providerId: string, enabled = true) {
  const [snapshot, setSnapshot] = useState<ProviderModelSnapshot | null>(null);
  const [request, setRequest] = useState<ProviderModelRequest | null>(null);
  const requestGenerationRef = useRef(0);
  const providerIdRef = useRef(providerId);
  const enabledRef = useRef(enabled);
  providerIdRef.current = providerId;
  enabledRef.current = enabled;

  const loadModels = useCallback(async () => {
    const requestedProviderId = providerIdRef.current;
    if (!enabledRef.current || !requestedProviderId) return;

    const requestGeneration = ++requestGenerationRef.current;
    setRequest({ providerId: requestedProviderId, loading: true, error: null });
    try {
      const payload = await fetchPromptingModels(requestedProviderId);
      if (
        requestGeneration !== requestGenerationRef.current
        || !enabledRef.current
        || providerIdRef.current !== requestedProviderId
      ) return;
      if (payload.provider_id !== requestedProviderId) {
        throw new Error("The provider returned a model list for a different provider. Refresh and try again.");
      }
      setSnapshot({ providerId: requestedProviderId, models: payload.models });
      setRequest({ providerId: requestedProviderId, loading: false, error: null });
    } catch (error) {
      if (
        requestGeneration !== requestGenerationRef.current
        || !enabledRef.current
        || providerIdRef.current !== requestedProviderId
      ) return;
      // Keep a previous successful snapshot identifiable while making the failed
      // refresh explicit. Consumers decide whether that snapshot is sufficient.
      setRequest({
        providerId: requestedProviderId,
        loading: false,
        error: error instanceof Error ? error.message : "Provider models could not be loaded."
      });
    }
  }, []);

  useEffect(() => {
    requestGenerationRef.current += 1;
    if (!enabled || !providerId) {
      setRequest(null);
      return;
    }
    void loadModels();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [enabled, loadModels, providerId]);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
  }, []);

  const models = useMemo(
    () => snapshot?.providerId === providerId ? snapshot.models : [],
    [providerId, snapshot]
  );
  const activeRequest = request?.providerId === providerId ? request : null;
  const hasTrustworthySnapshot = Boolean(providerId && snapshot?.providerId === providerId);
  const modelsLoading = Boolean(
    enabled
    && providerId
    && (activeRequest?.loading ?? !hasTrustworthySnapshot)
  );
  const modelError = activeRequest?.error ?? null;
  const hasModel = useCallback(
    (modelId: string) => hasTrustworthySnapshot && models.some((model) => model.id === modelId),
    [hasTrustworthySnapshot, models]
  );

  return {
    models,
    modelsLoading,
    modelError,
    hasTrustworthySnapshot,
    hasModel,
    refreshModels: loadModels
  };
}
