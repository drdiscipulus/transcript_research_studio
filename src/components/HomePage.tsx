import type { HardwareScanSnapshot, PromptingProviderStatus } from "../lib/api";
import { FieldLabelWithHelp } from "./FieldLabelWithHelp";

type HomeRecommendationBlock = {
  heading: string;
  intro: string;
  recommended: string;
  usable: string;
  caution: string;
  note: string;
};

type HomePageProps = {
  hardwareSnapshot: HardwareScanSnapshot;
  hardwareRequestError: string | null;
  onRetryHardwareScan: () => Promise<boolean>;
  providersLoading: boolean;
  providersError: string | null;
  providerStatuses: PromptingProviderStatus[];
  transcriptionServiceStatus: "checking" | "running" | "unavailable";
  transcriptionRecommendations: HomeRecommendationBlock;
  promptingRecommendations: HomeRecommendationBlock;
};

const homeHelpText = {
  cpu:
    "CPU is your main processor. It can handle faster-whisper transcription, pyannote speaker recognition, and local prompting, but heavier AI workloads often run more slowly here than on a suitable GPU.",
  memory:
    "Memory means system RAM. faster-whisper transcription, pyannote speaker recognition, and local LLM prompting all use RAM for models, audio or text processing, and intermediate data. More RAM helps with larger files, larger local models, and smoother CPU-based workloads.",
  gpu:
    "GPU is your graphics processor. For Whisper transcription and local LLM prompting, a suitable GPU can be much faster than CPU processing. Its own memory is called VRAM, and larger models often need enough VRAM to run well.",
  acceleration:
    "Acceleration shows whether the app can use NVIDIA CUDA for the fast GPU path during transcription. CUDA is NVIDIA's compute platform, which is why NVIDIA hardware matters here. Without compatible CUDA support, transcription falls back to CPU.",
  localPrompting:
    "In local model names, B usually means billions of parameters, such as 7B or 8B. Q4 and Q8 are quantized variants that use less or more memory, and FP16 is a higher-precision format that usually needs noticeably more memory."
} as const;

function describeProviderStatus(provider: PromptingProviderStatus): string {
  if (provider.available) {
    return "Running";
  }
  if (!provider.installed) {
    return "Not installed";
  }
  return "Not running";
}

function describeProviderReason(_provider: PromptingProviderStatus): string {
  return "";
}

function describeTranscriptionServiceStatus(
  status: HomePageProps["transcriptionServiceStatus"]
): string {
  if (status === "checking") {
    return "Checking...";
  }
  if (status === "unavailable") {
    return "Unavailable";
  }
  return "Running";
}

function describeHardwarePath(hardware: HardwareScanSnapshot["hardware"]): string {
  if (!hardware) return "Checking...";
  if (hardware.has_supported_nvidia_gpu && hardware.cuda_available) {
    return "NVIDIA / CUDA";
  }
  return "CPU";
}

export function HomePage({
  hardwareSnapshot,
  hardwareRequestError,
  onRetryHardwareScan,
  providersLoading,
  providersError,
  providerStatuses,
  transcriptionServiceStatus,
  transcriptionRecommendations,
  promptingRecommendations
}: HomePageProps) {
  const hardware = hardwareSnapshot.hardware;
  const system = hardwareSnapshot.system;
  const cpuModel = hardware?.cpu_model ?? system?.cpu_model;
  const physicalCores = hardware?.physical_cores ?? system?.physical_cores;
  const logicalCores = hardware?.logical_cores ?? system?.logical_cores;
  const totalRam = hardware?.total_ram_gb ?? system?.total_ram_gb;
  const gpuModel = hardware?.gpu_model ?? system?.gpu_model;
  const hasNvidiaGpu = hardware?.has_supported_nvidia_gpu ?? system?.has_supported_nvidia_gpu;
  const vram = hardware?.vram_gb ?? system?.vram_gb;
  const scanFailed = hardwareSnapshot.status === "failed";

  return (
    <div className="page-stack">
      <section className="page-header compact-page-header">
        <div>
          <h2 className="home-main-title">System Overview</h2>
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Detected Hardware</h3>
          </div>
        </div>

        <div className="summary-grid hardware-grid">
          <article className="summary-panel hardware-card">
            <FieldLabelWithHelp label="CPU" helpText={homeHelpText.cpu} labelClassName="summary-label" />
            <strong className="hardware-value">{cpuModel ?? (scanFailed ? "Unavailable" : "Checking...")}</strong>
            <small className="hardware-meta">
              {physicalCores !== undefined && logicalCores !== undefined
                ? `${physicalCores} physical cores • ${logicalCores} logical cores`
                : "Reading system information"}
            </small>
          </article>
          <article className="summary-panel hardware-card">
            <FieldLabelWithHelp label="Memory" helpText={homeHelpText.memory} labelClassName="summary-label" />
            <strong className="hardware-value">
              {totalRam !== undefined ? `${totalRam} GB RAM` : scanFailed ? "Unavailable" : "Checking..."}
            </strong>
            <small className="hardware-meta hardware-meta-spacer" aria-hidden="true" />
          </article>
          <article className="summary-panel hardware-card">
            <FieldLabelWithHelp label="GPU" helpText={homeHelpText.gpu} labelClassName="summary-label" />
            <strong className="hardware-value">{gpuModel ?? (scanFailed ? "GPU not verified" : "Checking...")}</strong>
            <small className="hardware-meta">
              {hasNvidiaGpu === undefined
                ? "Reading graphics hardware"
                : hasNvidiaGpu
                  ? `${vram ?? "?"} GB VRAM`
                  : "CPU processing remains available."}
            </small>
          </article>
          <article className="summary-panel hardware-card">
            <FieldLabelWithHelp
              label="Acceleration"
              helpText={homeHelpText.acceleration}
              labelClassName="summary-label"
            />
            <strong className="hardware-value">
              {hardwareSnapshot.status === "failed"
                ? "CPU (GPU not verified)"
                : hardware?.cuda_available
                  ? "NVIDIA / CUDA available"
                  : describeHardwarePath(hardware)}
            </strong>
            <small className="hardware-meta hardware-meta-spacer" aria-hidden="true" />
          </article>
        </div>

        {hardwareRequestError ? (
          <div className="hardware-scan-feedback error" role="alert">
            <span>{hardwareRequestError}</span>
            {hardwareSnapshot.retryable ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void onRetryHardwareScan()}
              >
                Retry Hardware Scan
              </button>
            ) : null}
          </div>
        ) : hardwareSnapshot.status === "checking" ? (
          <div className="hardware-scan-feedback" role="status">{hardwareSnapshot.message}</div>
        ) : hardwareSnapshot.status === "failed" ? (
          <div className="hardware-scan-feedback error" role="alert">
            <span>{hardwareSnapshot.message}</span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void onRetryHardwareScan()}
              disabled={!hardwareSnapshot.retryable}
            >
              Retry Hardware Scan
            </button>
          </div>
        ) : null}
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Local Services</h3>
          </div>
        </div>

        <div className="provider-status-row">
          {providersLoading ? (
            <>
              <article className="summary-panel compact">
                <span className="summary-label">Ollama</span>
                <strong>Checking...</strong>
                <small>Checking local provider</small>
              </article>
              <article className="summary-panel compact">
                <span className="summary-label">LM Studio</span>
                <strong>Checking...</strong>
                <small>Checking local provider</small>
              </article>
            </>
          ) : providersError ? (
            <>
              <article className="summary-panel compact">
                <span className="summary-label">Ollama</span>
                <strong>Status unavailable</strong>
                <small>{providersError}</small>
              </article>
              <article className="summary-panel compact">
                <span className="summary-label">LM Studio</span>
                <strong>Status unavailable</strong>
                <small>{providersError}</small>
              </article>
            </>
          ) : (
            providerStatuses.map((provider) => (
              <article key={provider.id} className="summary-panel compact">
                <span className="summary-label">{provider.name}</span>
                <strong>{describeProviderStatus(provider)}</strong>
                <small>{describeProviderReason(provider)}</small>
              </article>
            ))
          )}
          <article className="summary-panel compact">
            <span className="summary-label">Bundled Python Runtime</span>
            <strong role="status">
              {describeTranscriptionServiceStatus(transcriptionServiceStatus)}
            </strong>
          </article>
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Recommendations</h3>
          </div>
        </div>

        <div className="recommendation-grid">
          <article className="summary-panel recommendation-card">
            <span className="summary-label">{transcriptionRecommendations.heading}</span>
            <strong>{transcriptionRecommendations.intro}</strong>
            <div className="recommendation-list">
              <p>
                <span>Recommended</span>
                {transcriptionRecommendations.recommended}
              </p>
              <p>
                <span>Usually okay</span>
                {transcriptionRecommendations.usable}
              </p>
              <p>
                <span>Use with caution</span>
                {transcriptionRecommendations.caution}
              </p>
            </div>
            <small>{transcriptionRecommendations.note}</small>
          </article>

          <article className="summary-panel recommendation-card">
            <FieldLabelWithHelp
              label={promptingRecommendations.heading}
              helpText={homeHelpText.localPrompting}
              labelClassName="summary-label"
            />
            <strong>{promptingRecommendations.intro}</strong>
            <div className="recommendation-list">
              <p>
                <span>Good starting point</span>
                {promptingRecommendations.recommended}
              </p>
              <p>
                <span>Often still okay</span>
                {promptingRecommendations.usable}
              </p>
              <p>
                <span>Likely heavy</span>
                {promptingRecommendations.caution}
              </p>
            </div>
            <small>{promptingRecommendations.note}</small>
          </article>
        </div>
      </section>
    </div>
  );
}
