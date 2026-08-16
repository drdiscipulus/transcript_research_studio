import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useProviderStatuses } from "../../src/hooks/useProviderStatuses";

const apiMocks = vi.hoisted(() => ({
  fetchProviders: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, fetchPromptingProviders: apiMocks.fetchProviders };
});

const provider = {
  id: "lmstudio",
  name: "LM Studio",
  installed: true,
  running: true,
  available: true,
  requires_auth: false,
  base_url: "http://127.0.0.1:1234",
  message: "Ready",
  model_count: 1
};

describe("useProviderStatuses", () => {
  beforeEach(() => {
    apiMocks.fetchProviders.mockReset().mockResolvedValue({ providers: [provider] });
  });

  it("preserves the last successful snapshot when refresh fails and clears the error after recovery", async () => {
    const { result } = renderHook(() => useProviderStatuses());
    await waitFor(() => expect(result.current.providersLoading).toBe(false));
    expect(result.current.providerStatuses).toEqual([provider]);
    expect(apiMocks.fetchProviders).toHaveBeenNthCalledWith(1, false);

    apiMocks.fetchProviders.mockRejectedValueOnce(new Error("Local provider check failed."));
    await act(async () => result.current.refreshProviders());
    expect(result.current.providerStatuses).toEqual([provider]);
    expect(result.current.providersError).toBe("Local provider check failed.");

    await act(async () => result.current.refreshProviders());
    expect(result.current.providerStatuses).toEqual([provider]);
    expect(result.current.providersError).toBeNull();
    expect(apiMocks.fetchProviders).toHaveBeenLastCalledWith(true);
  });

  it("ignores an older refresh that resolves after a newer request", async () => {
    const { result } = renderHook(() => useProviderStatuses());
    await waitFor(() => expect(result.current.providersLoading).toBe(false));

    let resolveOlder!: (value: { providers: Array<typeof provider> }) => void;
    const older = new Promise<{ providers: Array<typeof provider> }>((resolve) => { resolveOlder = resolve; });
    apiMocks.fetchProviders
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce({ providers: [{ ...provider, id: "ollama", name: "Ollama" }] });

    let olderRefresh!: Promise<void>;
    act(() => { olderRefresh = result.current.refreshProviders(); });
    await act(async () => result.current.refreshProviders());
    resolveOlder({ providers: [provider] });
    await act(async () => olderRefresh);

    expect(result.current.providerStatuses[0].id).toBe("ollama");
    expect(result.current.providersError).toBeNull();
  });
});
