import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPromptingProviders, type PromptingProviderStatus } from "../lib/api";

export function useProviderStatuses() {
  const [providerStatuses, setProviderStatuses] = useState<PromptingProviderStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  const refreshProviders = useCallback(async (forceRefresh = true) => {
    const requestGeneration = ++requestGenerationRef.current;
    setProvidersLoading(true);
    try {
      const payload = await fetchPromptingProviders(forceRefresh);
      if (requestGeneration !== requestGenerationRef.current) return;
      setProviderStatuses(payload.providers);
      setProvidersError(null);
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return;
      // A failed refresh must not discard the last trustworthy provider snapshot.
      setProvidersError(error instanceof Error ? error.message : "Provider status could not be loaded.");
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setProvidersLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshProviders(false);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [refreshProviders]);

  return {
    providerStatuses,
    providersLoading,
    providersError,
    refreshProviders
  };
}
