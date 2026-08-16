import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HomePage } from "../../src/components/HomePage";
import type { HardwareScanSnapshot } from "../../src/lib/api";

const recommendation = {
  heading: "Recommendation",
  intro: "Intro",
  recommended: "Recommended",
  usable: "Usable",
  caution: "Caution",
  note: "Note"
};

const checkingHardware: HardwareScanSnapshot = {
  generation: 1,
  status: "checking",
  phase: "system",
  message: "Reading system hardware...",
  system: null,
  hardware: null,
  retryable: false
};

function renderHome(
  hardwareSnapshot: HardwareScanSnapshot = checkingHardware,
  onRetryHardwareScan = vi.fn(async () => true),
  hardwareRequestError: string | null = null
) {
  return render(
    <HomePage
      hardwareSnapshot={hardwareSnapshot}
      hardwareRequestError={hardwareRequestError}
      onRetryHardwareScan={onRetryHardwareScan}
      providersLoading={false}
      providersError={null}
      providerStatuses={[
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
        },
        {
          id: "lm-studio",
          name: "LM Studio",
          installed: true,
          running: true,
          available: true,
          requires_auth: false,
          base_url: "http://127.0.0.1:1234",
          message: "",
          model_count: 1
        }
      ]}
      transcriptionServiceStatus="running"
      transcriptionRecommendations={recommendation}
      promptingRecommendations={recommendation}
    />
  );
}

describe("HomePage local services", () => {
  it("shows the bundled transcription service with the local providers", () => {
    renderHome();

    expect(screen.getByRole("heading", { name: "Local Services" })).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("LM Studio")).toBeInTheDocument();
    expect(screen.getByText("Bundled Python Runtime")).toBeInTheDocument();
    expect(screen.queryByText("Transcription Service")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").some((status) => status.textContent === "Running")).toBe(true);
  });

  it("keeps the GPU result neutral until system hardware is known", () => {
    renderHome();

    expect(screen.getAllByText("Checking...").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("No supported GPU detected")).not.toBeInTheDocument();
    expect(screen.getByText("Reading system hardware...")).toHaveAttribute("role", "status");
  });

  it("shows phase-one CPU, memory, and GPU details while CUDA is still checking", () => {
    renderHome({
      ...checkingHardware,
      phase: "transcription_acceleration",
      message: "Checking CUDA runtime...",
      system: {
        cpu_model: "AMD Ryzen Test CPU",
        physical_cores: 16,
        logical_cores: 32,
        total_ram_gb: 64,
        gpu_model: "NVIDIA GeForce RTX 5090",
        vram_gb: 31.8,
        has_supported_nvidia_gpu: true,
        runtime_variant: "windows-gpu"
      }
    });

    expect(screen.getByText("AMD Ryzen Test CPU")).toBeInTheDocument();
    expect(screen.getByText("64 GB RAM")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA GeForce RTX 5090")).toBeInTheDocument();
    expect(screen.getByText("31.8 GB VRAM")).toBeInTheDocument();
    expect(screen.getByText("Checking CUDA runtime...")).toHaveAttribute("role", "status");
  });

  it("offers an accessible retry after failure while keeping CPU guidance", async () => {
    const retry = vi.fn(async () => true);
    renderHome({
      ...checkingHardware,
      status: "failed",
      phase: "failed",
      message: "Hardware detection failed. CPU processing remains available.",
      retryable: true
    }, retry);

    expect(screen.getByRole("alert")).toHaveTextContent("CPU processing remains available");
    expect(screen.getByText("CPU (GPU not verified)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry Hardware Scan" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps retry available when the previous retry request was rejected", async () => {
    const retry = vi.fn(async () => true);
    renderHome({
      ...checkingHardware,
      status: "failed",
      phase: "failed",
      message: "Hardware detection failed. CPU processing remains available.",
      retryable: true
    }, retry, "Hardware scan could not be restarted. CPU processing remains available.");

    expect(screen.getByRole("alert")).toHaveTextContent("Hardware scan could not be restarted");
    await userEvent.click(screen.getByRole("button", { name: "Retry Hardware Scan" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
