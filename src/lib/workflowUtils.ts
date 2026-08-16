import type {
  AccelerationOption,
  BatchRunSnapshot,
  HardwareSummary,
  TranscriptionModelOption
} from "./api";

export type TranscriptLayout = "file" | "paragraph" | "segment";

export type HomeRecommendationBlock = {
  heading: string;
  intro: string;
  recommended: string;
  usable: string;
  caution: string;
  note: string;
};

export const languageOptions = [
  { value: "auto", label: "Auto-Detect" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" }
];

export const outputModes = [
  { value: "transcribe", label: "Transcribe" },
  { value: "translate", label: "Translate To English" }
];

export const exportFormatOptions = ["xlsx", "csv", "json", "docx"];

export const transcriptLayoutOptions = [
  {
    value: "file",
    label: "Full Transcript",
    description:
      "Creates one combined transcript entry for the whole media file. Best when you want one row or text block per interview or recording."
  },
  {
    value: "segment",
    label: "Segments",
    description:
      "CSV, XLSX, and JSON rows are grouped by final timestamped segment. DOCX writes one paragraph per segment."
  },
  {
    value: "paragraph",
    label: "Paragraphs",
    description:
      "CSV, XLSX, and JSON rows are grouped into generated paragraphs. DOCX writes one paragraph per generated paragraph; detected speaker changes always split paragraphs, with optional additional pause-based breaks."
  }
];

export const defaultParagraphOptions = {
  paragraph_pause_enabled: true,
  max_pause_seconds: 3
};

const fallbackModelOptions: TranscriptionModelOption[] = [
  { value: "small", label: "small", installed: false, bundled: false },
  { value: "tiny", label: "tiny", installed: false, bundled: false },
  { value: "base", label: "base", installed: false, bundled: false },
  { value: "medium", label: "medium", installed: false, bundled: false },
  { value: "large-v3", label: "large-v3", installed: false, bundled: false },
  { value: "large-v3-turbo", label: "large-v3-turbo", installed: false, bundled: false }
];

export function normalizePath(value: string): string {
  return value.trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function buildTranscriptionFolderMessages(
  inputSourceType: string,
  inputPath: string,
  transcriptOutputFolder: string
): string[] {
  const normalizedInput = normalizePath(inputPath);
  const normalizedTranscript = normalizePath(transcriptOutputFolder);
  const messages: string[] = [];

  if (!normalizedInput) {
    messages.push(inputSourceType === "single_file" ? "Choose a media file." : "Choose an input folder.");
  }
  if (!normalizedTranscript) {
    messages.push("Choose a transcript output folder.");
  }
  if (inputSourceType !== "single_file" && normalizedInput && normalizedTranscript && normalizedInput === normalizedTranscript) {
    messages.push("Input folder and transcript output folder must be different.");
  }

  return messages;
}

export function preferredOutputPath(batch: BatchRunSnapshot | null): string | null {
  if (!batch || batch.output_files.length === 0) {
    return null;
  }

  const formatPriority: Record<string, number> = {
    xlsx: 0,
    csv: 1,
    json: 2
  };
  const selected = [...batch.output_files]
    .filter((outputFile) => outputFile.format in formatPriority)
    .filter((outputFile) => outputFile.role !== "batch_overview")
    .sort((left, right) => (formatPriority[left.format] ?? 99) - (formatPriority[right.format] ?? 99))[0];
  return selected?.path ?? null;
}

export function sanitizeModelOptions(value: unknown): TranscriptionModelOption[] {
  if (!Array.isArray(value)) {
    return fallbackModelOptions;
  }

  const options = value
    .map((option) => {
      if (!option || typeof option !== "object") {
        return null;
      }
      const record = option as Record<string, unknown>;
      const normalizedValue = String(record.value ?? "").trim().toLowerCase();
      const label = String(record.label ?? normalizedValue).trim();
      if (!normalizedValue || !label) {
        return null;
      }
      return {
        value: normalizedValue,
        label,
        installed: Boolean(record.installed),
        bundled: Boolean(record.bundled)
      } satisfies TranscriptionModelOption;
    })
    .filter((option): option is TranscriptionModelOption => Boolean(option));

  return options.length > 0 ? options : fallbackModelOptions;
}

export function buildAccelerationOptions(hardware: HardwareSummary | null): AccelerationOption[] {
  return hardware?.asr_cuda_available
    ? [
        { value: "cpu", label: "CPU" },
        { value: "cuda", label: "NVIDIA / CUDA" }
      ]
    : [{ value: "cpu", label: "CPU" }];
}

export function sanitizeParagraphOptions(value: unknown): typeof defaultParagraphOptions {
  if (!value || typeof value !== "object") {
    return defaultParagraphOptions;
  }
  const record = value as Record<string, unknown>;
  const maxPauseSeconds = Number(record.max_pause_seconds);
  return {
    paragraph_pause_enabled: Boolean(record.paragraph_pause_enabled ?? true),
    max_pause_seconds:
      Number.isFinite(maxPauseSeconds) && maxPauseSeconds >= 0
        ? maxPauseSeconds
        : defaultParagraphOptions.max_pause_seconds
  };
}

export function normalizeParagraphPauseInput(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultParagraphOptions.max_pause_seconds;
}

export function folderParent(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return undefined;
  }
  const parent = trimmedValue.replace(/[\\/]+[^\\/]+$/, "");
  if (!parent || parent === trimmedValue) {
    return undefined;
  }
  return parent;
}

export function buildTranscriptionRecommendations(hardware: HardwareSummary | null): HomeRecommendationBlock {
  if (!hardware) {
    return {
      heading: "Transcription",
      intro: "Waiting for hardware detection.",
      recommended: "Checking...",
      usable: "Checking...",
      caution: "Checking...",
      note: "Guidance appears after the hardware scan finishes."
    };
  }

  const hasCuda = hardware.has_supported_nvidia_gpu && hardware.cuda_available;
  const vram = hardware.vram_gb ?? 0;
  const ram = hardware.total_ram_gb;
  const logicalCores = hardware.logical_cores;

  if (hasCuda && vram >= 16) {
    return {
      heading: "Transcription",
      intro: "This machine should handle the standard Whisper workflow comfortably on GPU.",
      recommended: "small (default), medium, and large-v3-turbo",
      usable: "large-v3 should also be practical, but it remains the heaviest option",
      caution: "CPU fallback is still available, but it will be noticeably slower",
      note: "Long recordings and diarization will still take more time than shorter single-speaker files."
    };
  }

  if (hasCuda && vram >= 10) {
    return {
      heading: "Transcription",
      intro: "GPU acceleration is available and should keep most common Whisper choices practical.",
      recommended: "small (default) and medium",
      usable: "large-v3-turbo is a reasonable step up if you want more accuracy",
      caution: "large-v3 may feel heavier or slower on longer batches",
      note: "If a larger model feels slow, falling back to medium is usually the most practical next step."
    };
  }

  if (hasCuda && vram >= 6) {
    return {
      heading: "Transcription",
      intro: "This machine can use CUDA, but larger Whisper models may still be memory-heavy.",
      recommended: "small (default)",
      usable: "medium should often work, especially for shorter batches",
      caution: "large-v3-turbo and large-v3 may be slow or uncomfortable on this GPU",
      note: "This is a good profile for staying close to the default unless you specifically need a larger model."
    };
  }

  if (ram >= 64 && logicalCores >= 12) {
    return {
      heading: "Transcription",
      intro: "CPU-only transcription is available and this machine has enough headroom for more than the default.",
      recommended: "small (default)",
      usable: "medium may be reasonable if you accept longer runtimes",
      caution: "large-v3-turbo and large-v3 will likely be slow on CPU",
      note: "For multi-hour batches, the default small model is usually the safer everyday choice."
    };
  }

  if (ram >= 32 && logicalCores >= 8) {
    return {
      heading: "Transcription",
      intro: "This machine should be comfortable with the default CPU path.",
      recommended: "small (default)",
      usable: "medium may still be workable for short or occasional runs",
      caution: "larger Whisper models will likely feel slow on CPU",
      note: "If turnaround time matters, staying on the default model is the safer choice."
    };
  }

  return {
    heading: "Transcription",
    intro: "This machine is best treated as a conservative CPU profile.",
    recommended: "small (default)",
    usable: "stay close to the default for normal use",
    caution: "medium and larger models may feel slow or uncomfortably heavy",
    note: "Shorter files and smaller batches will feel better than long combined runs."
  };
}

export function buildPromptingRecommendations(hardware: HardwareSummary | null): HomeRecommendationBlock {
  if (!hardware) {
    return {
      heading: "Transcript Analysis",
      intro: "Waiting for hardware detection.",
      recommended: "Checking...",
      usable: "Checking...",
      caution: "Checking...",
      note: "Guidance appears after the hardware scan finishes."
    };
  }

  const hasSupportedGpu = hardware.has_supported_nvidia_gpu;
  const vram = hardware.vram_gb ?? 0;
  const ram = hardware.total_ram_gb;

  if (hasSupportedGpu && vram >= 16) {
    return {
      heading: "Transcript Analysis",
      intro: "The detected NVIDIA GPU should give local providers room for a broad range of quantized models.",
      recommended: "roughly 2B to 9B Q4 models are a practical starting point",
      usable: "larger Q4 models can also be realistic if the provider supports them well",
      caution: "Q8 and FP16 models need noticeably more memory and may load more slowly",
      note: "Actual GPU use and fit depend on Ollama or LM Studio, provider overhead, context size, and the exact quantization."
    };
  }

  if (hasSupportedGpu && vram >= 8) {
    return {
      heading: "Transcript Analysis",
      intro: "The detected NVIDIA GPU should give local providers a useful path for small to mid-sized models.",
      recommended: "roughly 2B to 8B Q4 models",
      usable: "some 9B-class Q4 models may still be practical",
      caution: "Q8, FP16, or much larger models may feel memory-heavy",
      note: "Actual GPU use depends on Ollama or LM Studio; if generation feels sluggish, try a smaller Q4 model."
    };
  }

  if (ram >= 32) {
    return {
      heading: "Transcript Analysis",
      intro: "CPU-based local analysis should work best with smaller quantized models.",
      recommended: "roughly 2B to 4B Q4 models",
      usable: "7B-class Q4 models may still be okay if you accept slower generation",
      caution: "Q8, FP16, and larger models may feel slow or memory-heavy",
      note: "Analysis performance depends heavily on the provider and the installed model, not just the hardware."
    };
  }

  return {
    heading: "Transcript Analysis",
    intro: "This machine is best suited to lighter local models.",
    recommended: "roughly 2B to 4B Q4 models",
    usable: "stay with smaller quantized models when possible",
    caution: "larger, higher-precision, or more complex models may feel slow",
    note: "Ollama or LM Studio must already have the model downloaded before the app can use it."
  };
}
