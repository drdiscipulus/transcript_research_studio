import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelsPage } from "../../src/components/ModelsPage";
import type { ModelsPageContract } from "../../src/lib/modelsWorkspaceContracts";

function workspace(overrides: Partial<ModelsPageContract> = {}): ModelsPageContract {
  const base: ModelsPageContract = {
    catalog: {
      status: {
        faster_whisper: [
          { value: "small", label: "Small", repo_id: "repo/small", installed: false, availability: "incomplete", missing_files: ["model.bin"] }
        ],
        pyannote: {
          model_id: "pyannote/speaker-diarization-community-1",
          model_url: "https://huggingface.co/pyannote/model",
          token_url: "https://huggingface.co/settings/tokens",
          model_dir: "local-model-dir",
          installed: false,
          availability: "missing",
          missing_files: ["config.yaml"]
        }
      },
      loading: false,
      error: null
    },
    token: {
      input: "",
      result: null,
      error: null,
      testing: false,
      inputDisabled: false,
      setInput: vi.fn(() => true),
      test: vi.fn(async () => true)
    },
    operation: {
      kind: null,
      targetId: null,
      busy: false,
      progress: null,
      progressWarning: null,
      error: null,
      message: null
    },
    deletion: {
      open: false,
      requestKey: null,
      target: null,
      confirm: vi.fn(async () => true),
      cancel: vi.fn(() => true)
    },
    externalLinkError: null,
    actions: {
      refresh: vi.fn(async () => true),
      downloadFasterWhisper: vi.fn(async () => true),
      downloadPyannote: vi.fn(async () => true),
      requestDeleteFasterWhisper: vi.fn(() => true),
      requestDeletePyannote: vi.fn(() => true),
      openPyannoteModelPage: vi.fn(async () => true),
      openHuggingFaceTokenPage: vi.fn(async () => true)
    }
  };
  return {
    ...base,
    ...overrides,
    catalog: { ...base.catalog, ...overrides.catalog },
    token: { ...base.token, ...overrides.token },
    operation: { ...base.operation, ...overrides.operation },
    deletion: { ...base.deletion, ...overrides.deletion },
    actions: { ...base.actions, ...overrides.actions }
  };
}

describe("ModelsPage", () => {
  it("renders incomplete models as Repair and delegates actions to the workspace", async () => {
    const user = userEvent.setup();
    const value = workspace();
    render(<ModelsPage workspace={value} />);

    expect(screen.getByText("Incomplete")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Repair" }));
    expect(value.actions.downloadFasterWhisper).toHaveBeenCalledWith("small");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(value.actions.refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open Hugging Face Model Page" }));
    expect(value.actions.openPyannoteModelPage).toHaveBeenCalledTimes(1);
  });

  it("uses the same workspace lock for visible controls", () => {
    render(<ModelsPage workspace={workspace({
      operation: {
        kind: "download",
        targetId: "small",
        busy: true,
        progress: {
          id: "fw:small",
          label: "Small",
          status: "running",
          percent: 35,
          downloaded_bytes: 35,
          total_bytes: 100,
          message: "Downloading",
          updated_at: "now"
        },
        progressWarning: null,
        error: null,
        message: null
      }
    })} />);

    expect(screen.getByRole("button", { name: "35%" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test Token" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Hugging Face Model Page" })).toBeDisabled();
  });

  it("shows token results and independent operation/link errors in their own regions", () => {
    render(<ModelsPage workspace={workspace({
      token: {
        input: "",
        result: { ok: false, status: "restricted", message: "Access is restricted." },
        error: null,
        testing: false,
        inputDisabled: false,
        setInput: vi.fn(() => true),
        test: vi.fn(async () => true)
      },
      operation: {
        kind: null,
        targetId: null,
        busy: false,
        progress: null,
        progressWarning: "Download status is stale.",
        error: "Model could not be downloaded.",
        message: null
      },
      externalLinkError: "The Hugging Face link could not be opened."
    })} />);

    expect(screen.getByText("Access is restricted.")).toBeInTheDocument();
    expect(screen.getByText("Download status is stale.")).toBeInTheDocument();
    expect(screen.getByText("Model could not be downloaded.")).toBeInTheDocument();
    expect(screen.getByText("The Hugging Face link could not be opened.")).toBeInTheDocument();
  });

  it("shows an unavailable state and keeps pyannote actions disabled without a trusted catalog", () => {
    render(<ModelsPage workspace={workspace({
      catalog: {
        status: null,
        loading: false,
        error: "Model status could not be loaded. Try Refresh again."
      },
      token: {
        input: "memory-only-value",
        result: null,
        error: null,
        testing: false,
        inputDisabled: false,
        setInput: vi.fn(() => true),
        test: vi.fn(async () => true)
      }
    })} />);

    expect(screen.getByText("No model status available")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });
});
