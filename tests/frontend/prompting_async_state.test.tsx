import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptInputPreview } from "../../src/hooks/usePromptInputPreview";
import { usePromptingModels } from "../../src/hooks/usePromptingModels";
import { useProviderModelCatalog } from "../../src/hooks/useProviderModelCatalog";

const apiMocks = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  inspectInput: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    fetchPromptingModels: apiMocks.fetchModels,
    inspectPromptInput: apiMocks.inspectInput
  };
});

const providers = [
  {
    id: "lmstudio",
    name: "LM Studio",
    installed: true,
    running: true,
    available: true,
    requires_auth: false,
    base_url: "http://127.0.0.1:1234",
    message: "",
    model_count: 1
  },
  {
    id: "ollama",
    name: "Ollama",
    installed: true,
    running: true,
    available: true,
    requires_auth: false,
    base_url: "http://127.0.0.1:11434",
    message: "",
    model_count: 1
  }
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function preview(path: string, status: "ready" | "problem" | "mapping_required" = "ready") {
  const selectable = status === "ready";
  return {
    input_mode: "file" as const,
    input_path: path,
    file_count: 1,
    files: [{ path, file_name: "interview.json", format: "json", requires_mapping: status === "mapping_required" }],
    mapping: {},
    mapping_required: status === "mapping_required",
    candidate_count: 1,
    counts: {
      ready: selectable ? 1 : 0,
      decisions_required: 0,
      mapping_required: status === "mapping_required" ? 1 : 0,
      problems: status === "problem" ? 1 : 0
    },
    candidates: [{
      candidate_id: "candidate_1",
      source_path: path,
      file_name: "interview.json",
      format: "json",
      document_id: "doc_1",
      document_index: 0,
      title: path,
      segment_count: 4,
      content_fingerprint: "fingerprint",
      status,
      reason: selectable ? "Ready to analyze." : "Needs attention.",
      recommended: true,
      equivalent_group: null,
      mapping_columns: status === "mapping_required" ? ["text"] : [],
      mapping: {}
    }],
    problems: []
  };
}

describe("Transcript Analysis asynchronous state", () => {
  beforeEach(() => {
    apiMocks.fetchModels.mockReset();
    apiMocks.inspectInput.mockReset();
  });

  it("invalidates the old model immediately and ignores a stale provider response", async () => {
    const lmStudio = deferred<Awaited<ReturnType<typeof import("../../src/lib/api").fetchPromptingModels>>>();
    const ollama = deferred<Awaited<ReturnType<typeof import("../../src/lib/api").fetchPromptingModels>>>();
    apiMocks.fetchModels.mockImplementation((providerId: string) => (
      providerId === "lmstudio" ? lmStudio.promise : ollama.promise
    ));

    const { result } = renderHook(() => usePromptingModels(providers));
    await waitFor(() => expect(result.current.selectedProviderId).toBe("lmstudio"));

    act(() => result.current.changeProvider("ollama"));
    expect(result.current.selectedProviderId).toBe("ollama");
    expect(result.current.selectedModelId).toBe("");
    expect(result.current.models).toEqual([]);
    expect(result.current.modelSelectionValid).toBe(false);

    await act(async () => {
      lmStudio.resolve({
        provider_id: "lmstudio",
        provider_name: "LM Studio",
        models: [{ id: "stale-model", display_name: "Stale", details: "", context_length: 4096, is_loaded: true }]
      });
      await lmStudio.promise;
    });
    expect(result.current.selectedProviderId).toBe("ollama");
    expect(result.current.models).toEqual([]);
    expect(result.current.selectedModelId).toBe("");

    await act(async () => {
      ollama.resolve({
        provider_id: "ollama",
        provider_name: "Ollama",
        models: [{ id: "ollama-model", display_name: "Ollama Model", details: "", context_length: 4096, is_loaded: false }]
      });
      await ollama.promise;
    });
    await waitFor(() => expect(result.current.selectedModelId).toBe("ollama-model"));
    expect(result.current.modelSelectionValid).toBe(true);
  });

  it("rejects a model snapshot attributed to another provider", async () => {
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "ollama",
      provider_name: "Ollama",
      models: [{ id: "wrong-model", display_name: "Wrong Model", details: "", context_length: null, is_loaded: false }]
    });

    const { result } = renderHook(() => usePromptingModels([providers[0]]));

    await waitFor(() => expect(result.current.modelError).toContain("different provider"));
    expect(result.current.models).toEqual([]);
    expect(result.current.selectedModelId).toBe("");
    expect(result.current.modelSelectionValid).toBe(false);
  });

  it("retains Transcript Analysis model selection semantics", async () => {
    apiMocks.fetchModels.mockResolvedValue({
      provider_id: "lmstudio",
      provider_name: "LM Studio",
      models: [
        { id: "available-model", display_name: "Available", details: "", context_length: null, is_loaded: false },
        { id: "loaded-model", display_name: "Loaded", details: "", context_length: null, is_loaded: true }
      ]
    });

    const { result } = renderHook(() => usePromptingModels([providers[0]]));
    await waitFor(() => expect(result.current.selectedModelId).toBe("loaded-model"));
    expect(result.current.modelSelectionValid).toBe(true);

    act(() => result.current.setSelectedModelId("available-model"));
    expect(result.current.selectedModelId).toBe("available-model");
    expect(result.current.modelSelectionValid).toBe(true);
  });

  it("invalidates a pending model response when the catalog is disabled", async () => {
    const pending = deferred<Awaited<ReturnType<typeof import("../../src/lib/api").fetchPromptingModels>>>();
    apiMocks.fetchModels.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useProviderModelCatalog("ollama", enabled),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(apiMocks.fetchModels).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    await act(async () => {
      pending.resolve({
        provider_id: "ollama",
        provider_name: "Ollama",
        models: [{ id: "late-model", display_name: "Late Model", details: "", context_length: null, is_loaded: false }]
      });
      await pending.promise;
    });

    expect(result.current.models).toEqual([]);
    expect(result.current.hasTrustworthySnapshot).toBe(false);
    expect(result.current.modelsLoading).toBe(false);
  });

  it("keeps a successful model snapshot identifiable when a refresh fails", async () => {
    apiMocks.fetchModels
      .mockResolvedValueOnce({
        provider_id: "ollama",
        provider_name: "Ollama",
        models: [{ id: "trusted-model", display_name: "Trusted Model", details: "", context_length: null, is_loaded: false }]
      })
      .mockRejectedValueOnce(new Error("Model refresh failed."));
    const { result } = renderHook(() => useProviderModelCatalog("ollama"));
    await waitFor(() => expect(result.current.hasTrustworthySnapshot).toBe(true));

    await act(async () => {
      await result.current.refreshModels();
    });

    expect(result.current.models.map((model) => model.id)).toEqual(["trusted-model"]);
    expect(result.current.hasTrustworthySnapshot).toBe(true);
    expect(result.current.modelError).toBe("Model refresh failed.");
  });

  it("ignores an older input inspection and keeps the newest preview", async () => {
    const older = deferred<ReturnType<typeof preview>>();
    const newer = deferred<ReturnType<typeof preview>>();
    apiMocks.inspectInput.mockImplementation(({ input_path }: { input_path: string }) => (
      input_path === "older.json" ? older.promise : newer.promise
    ));

    const { result, rerender } = renderHook(
      ({ path }) => usePromptInputPreview("file", path),
      { initialProps: { path: "older.json" } }
    );
    await waitFor(() => expect(apiMocks.inspectInput).toHaveBeenCalledTimes(1));
    rerender({ path: "newer.json" });
    await waitFor(() => expect(apiMocks.inspectInput).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.resolve(preview("newer.json"));
      await newer.promise;
    });
    expect(result.current.preview?.input_path).toBe("newer.json");
    expect(result.current.previewLoading).toBe(false);

    await act(async () => {
      older.resolve(preview("older.json"));
      await older.promise;
    });
    expect(result.current.preview?.input_path).toBe("newer.json");
    expect(result.current.previewLoading).toBe(false);
  });

  it("drops a selected candidate when reinspection makes it nonselectable", async () => {
    apiMocks.inspectInput
      .mockResolvedValueOnce(preview("interview.json"))
      .mockResolvedValueOnce(preview("interview.json", "mapping_required"));

    const { result } = renderHook(() => usePromptInputPreview("file", "interview.json"));
    await waitFor(() => expect(result.current.selectedCandidateIds).toEqual(["candidate_1"]));

    act(() => {
      result.current.updateCandidateMapping(
        result.current.preview!.candidates[0],
        "text_column",
        "text"
      );
    });
    await waitFor(() => expect(result.current.preview?.candidates[0].status).toBe("mapping_required"));
    expect(result.current.selectedCandidateIds).toEqual([]);
  });

  it("preserves mapping updates issued before another render", async () => {
    apiMocks.inspectInput.mockImplementation(({ input_path }: { input_path: string }) => (
      Promise.resolve(preview(input_path))
    ));

    const { result } = renderHook(() => usePromptInputPreview("file", "interview.json"));
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    const candidate = {
      ...result.current.preview!.candidates[0],
      mapping: { end_column: "end" }
    };

    act(() => {
      result.current.updateCandidateMapping(candidate, "text_column", "text");
      result.current.updateCandidateMapping(candidate, "speaker_column", "speaker");
    });

    await waitFor(() => expect(apiMocks.inspectInput).toHaveBeenCalledTimes(3));
    expect(apiMocks.inspectInput).toHaveBeenLastCalledWith({
      input_mode: "file",
      input_path: "interview.json",
      candidate_mappings: {
        "interview.json": {
          end_column: "end",
          text_column: "text",
          speaker_column: "speaker"
        }
      }
    });
  });
});
