import type {
  AccelerationOption,
  AppSettings,
  BatchRunSnapshot,
  HardwareScanSnapshot,
  ModelsStatus,
  ScanPreview,
  TranscriptionLanguageOption,
  TranscriptionModelOption
} from "./api";
import type { TranscriptLayout } from "./workflowUtils";

export type BatchPollingState = {
  health: import("./api").BackendHealth | null;
  checking: boolean;
  isStale: boolean;
  error: string | null;
  compatibilityError: string | null;
  lastUpdatedAt: number | null;
  consecutiveFailures: number;
};

export type TranscriptionOperationKind =
  | "input-picker"
  | "output-picker"
  | "clear-input"
  | "clear-output"
  | "new-run"
  | "start"
  | "cancel-dialog"
  | "cancel-request";

export type TranscriptionOperationAccess = {
  acquire: (kind: TranscriptionOperationKind) => number | null;
  release: (token: number) => void;
};

export type TranscriptionInputSourceType = "single_file" | "folder";
export type TranscriptionOutputNamingMode = "input_filename" | "override";
export type TranscriptionOutputOrganization = "separate_files" | "combined_file";

export type TranscriptionSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export type TranscriptionSetupState = {
  advancedSettingsOpen: boolean;
  loading: boolean;
  bootstrapError: string | null;
  configurationLocked: boolean;
  inputSourceType: TranscriptionInputSourceType;
  inputPath: string;
  transcriptOutputFolder: string;
  outputOrganization: TranscriptionOutputOrganization;
  modelName: string;
  modelOptions: TranscriptionModelOption[];
  acceleration: string;
  accelerationOptions: AccelerationOption[];
  hardwareStatus: HardwareScanSnapshot["status"];
  hardwareStatusMessage: string;
  hardwareRetryable: boolean;
  hardwareRequestError: string | null;
  language: string;
  languageOptions: TranscriptionLanguageOption[];
  outputMode: string;
  outputModes: TranscriptionSelectOption[];
  transcriptLayout: TranscriptLayout;
  transcriptLayoutOptions: TranscriptionSelectOption[];
  paragraphPauseEnabled: boolean;
  paragraphPauseSeconds: string;
  exportFormats: string[];
  exportFormatOptions: string[];
  appSettings: AppSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsSavePending: boolean;
  settingsPersistenceError: string | null;
  pathActionError: string | null;
};

export type TranscriptionSetupActions = {
  setAdvancedSettingsOpen: (open: boolean) => void;
  pickInputSource: (sourceType: TranscriptionInputSourceType) => Promise<void>;
  pickOutputFolder: () => Promise<void>;
  clearInput: () => void;
  clearOutputFolder: () => void;
  openPath: (path: string, options?: { expectDirectory?: boolean; createIfMissing?: boolean }) => Promise<void>;
  setOutputOrganization: (organization: TranscriptionOutputOrganization) => void;
  setModelName: (modelName: string) => void;
  setAcceleration: (acceleration: string) => void;
  retryHardwareScan: () => Promise<boolean>;
  setLanguage: (language: string) => void;
  setOutputMode: (outputMode: string) => void;
  setTranscriptLayout: (layout: TranscriptLayout) => void;
  setParagraphPauseEnabled: (enabled: boolean) => void;
  setParagraphPauseSeconds: (seconds: string) => void;
  toggleExportFormat: (format: string, checked: boolean) => void;
  updateAdvancedToggle: (
    key: "diarization_enabled" | "include_timestamps",
    value: boolean
  ) => Promise<void>;
  saveAdvancedSettings: (
    advanced: AppSettings["advanced_transcription"]
  ) => Promise<AppSettings | null>;
  canPersistSettings: () => boolean;
};

export type TranscriptionScanState = {
  preview: ScanPreview | null;
  isScanning: boolean;
  statusMessage: string;
  error: string | null;
  folderMessages: string[];
  speakerRecognitionEnabled: boolean;
  pyannoteModelInstalled: boolean;
  modelsStatusLoading: boolean;
  modelsStatusError: string | null;
};

export type TranscriptionCancelDialogState = {
  open: boolean;
  batchId: string | null;
  requestKey: string | null;
};

export type TranscriptionRunState = {
  liveBatch: BatchRunSnapshot | null;
  batchIsActive: boolean;
  isStarting: boolean;
  cancellationPending: boolean;
  canStart: boolean;
  canStartReason: string | null;
  displayFilesQueued: number;
  progressPercent: number;
  startError: string | null;
  cancellationError: string | null;
  polling: BatchPollingState;
  cancelDialog: TranscriptionCancelDialogState;
};

export type TranscriptionRunActions = {
  start: () => Promise<boolean>;
  requestCancellation: () => boolean;
  cancelCancellationDialog: (requestKey: string | null) => void;
  confirmCancellation: (requestKey: string | null) => Promise<boolean>;
  newRun: () => boolean;
  retryPolling: () => void;
  openLogsFolder: () => Promise<void>;
};

export type TranscriptionPageContract = {
  setup: {
    state: TranscriptionSetupState;
    actions: TranscriptionSetupActions;
  };
  scan: TranscriptionScanState;
  run: {
    state: TranscriptionRunState;
    actions: TranscriptionRunActions;
  };
};

export type TranscriptionShellState = {
  browseHomeFolder: string;
  suggestedPromptSourceFile: string;
  polling: BatchPollingState;
  activeJob: boolean;
  activityLabel: string;
};

export type UseTranscriptionWorkspaceOptions = {
  appSettings: AppSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  modelsStatus: ModelsStatus | null;
  modelsStatusLoading: boolean;
  modelsStatusError: string | null;
  hardwareSnapshot: HardwareScanSnapshot;
  hardwareRequestError: string | null;
  onRetryHardwareScan: () => Promise<boolean>;
  onSettingsChanged: (settings: AppSettings) => void;
  onSettingsError: (error: string | null) => void;
};
