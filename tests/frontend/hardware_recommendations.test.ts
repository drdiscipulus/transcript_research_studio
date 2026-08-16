import { describe, expect, it } from "vitest";

import type { HardwareSummary } from "../../src/lib/api";
import {
  buildAccelerationOptions,
  buildPromptingRecommendations,
  buildTranscriptionRecommendations
} from "../../src/lib/workflowUtils";


function hardware(overrides: Partial<HardwareSummary> = {}): HardwareSummary {
  return {
    cpu_model: "Test CPU",
    physical_cores: 8,
    logical_cores: 16,
    total_ram_gb: 64,
    gpu_model: "NVIDIA GeForce RTX 5090",
    vram_gb: 31.8,
    has_supported_nvidia_gpu: true,
    cuda_available: true,
    asr_cuda_available: true,
    pyannote_available: true,
    pyannote_cuda_available: true,
    runtime_variant: "windows-gpu",
    acceleration_path: "NVIDIA / CUDA",
    ...overrides
  };
}


describe("hardware recommendations", () => {
  it("derives acceleration options only from an authoritative hardware summary", () => {
    expect(buildAccelerationOptions(null)).toEqual([{ value: "cpu", label: "CPU" }]);
    expect(buildAccelerationOptions(hardware({ asr_cuda_available: false }))).toEqual([
      { value: "cpu", label: "CPU" }
    ]);
    expect(buildAccelerationOptions(hardware())).toEqual([
      { value: "cpu", label: "CPU" },
      { value: "cuda", label: "NVIDIA / CUDA" }
    ]);
  });

  it("uses verified transcription CUDA for Whisper guidance", () => {
    const recommendation = buildTranscriptionRecommendations(hardware());

    expect(recommendation.intro).toContain("Whisper workflow comfortably on GPU");
  });

  it("keeps transcription CPU-oriented but gives provider-aware analysis guidance in a CPU package", () => {
    const cpuPackage = hardware({
      cuda_available: false,
      asr_cuda_available: false,
      pyannote_cuda_available: false,
      runtime_variant: "windows-cpu",
      acceleration_path: "CPU"
    });

    expect(buildTranscriptionRecommendations(cpuPackage).intro).toContain("CPU-only transcription");
    const analysis = buildPromptingRecommendations(cpuPackage);
    expect(analysis.intro).toContain("detected NVIDIA GPU");
    expect(analysis.note).toContain("Ollama or LM Studio");
  });

  it("keeps analysis guidance CPU-oriented without a supported GPU", () => {
    const noGpu = hardware({
      gpu_model: "No supported GPU detected",
      vram_gb: null,
      has_supported_nvidia_gpu: false,
      cuda_available: false,
      asr_cuda_available: false,
      pyannote_cuda_available: false,
      acceleration_path: "CPU"
    });

    expect(buildPromptingRecommendations(noGpu).intro).toContain("CPU-based local analysis");
  });

  it("keeps incomplete hardware guidance in the loading state", () => {
    expect(buildTranscriptionRecommendations(null).recommended).toBe("Checking...");
    expect(buildPromptingRecommendations(null).recommended).toBe("Checking...");
  });

  it("keeps a failed-scan fallback conservative even when the GPU name is unknown", () => {
    const failedFallback = hardware({
      gpu_model: "GPU not verified",
      vram_gb: null,
      has_supported_nvidia_gpu: false,
      cuda_available: false,
      asr_cuda_available: false,
      pyannote_available: false,
      pyannote_cuda_available: false,
      runtime_variant: "unknown",
      acceleration_path: "CPU"
    });

    expect(buildPromptingRecommendations(failedFallback).intro).toContain("CPU-based local analysis");
  });
});
