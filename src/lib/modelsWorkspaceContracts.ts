import type {
  ModelDownloadProgress,
  ModelsStatus
} from "./api/models";

export type ModelsTarget =
  | {
      kind: "faster-whisper";
      id: string;
      label: string;
    }
  | {
      kind: "pyannote";
      id: "pyannote";
      label: "Pyannote Model";
    };

export type ModelsOperationKind =
  | "refresh"
  | "token-test"
  | "download"
  | "delete-confirmation"
  | "delete"
  | "external-link";

export type ModelsSharedCatalogContract = {
  modelsStatus: ModelsStatus | null;
  modelsStatusLoading: boolean;
  modelsStatusError: string | null;
};

export type ModelsCatalogContract = {
  status: ModelsStatus | null;
  loading: boolean;
  error: string | null;
};

export type ModelsTokenTestResult = {
  ok: boolean;
  status: string;
  message: string;
};

export type ModelsTokenContract = {
  input: string;
  result: ModelsTokenTestResult | null;
  error: string | null;
  testing: boolean;
  inputDisabled: boolean;
  setInput: (value: string) => boolean;
  test: () => Promise<boolean>;
};

export type ModelsOperationContract = {
  kind: ModelsOperationKind | null;
  targetId: string | null;
  busy: boolean;
  progress: ModelDownloadProgress | null;
  progressWarning: string | null;
  error: string | null;
  message: string | null;
};

export type ModelsDeleteConfirmationContract = {
  open: boolean;
  requestKey: string | null;
  target: ModelsTarget | null;
  confirm: (requestKey: string | null) => Promise<boolean>;
  cancel: (requestKey: string | null) => boolean;
};

export type ModelsPageContract = {
  catalog: ModelsCatalogContract;
  token: ModelsTokenContract;
  operation: ModelsOperationContract;
  deletion: ModelsDeleteConfirmationContract;
  externalLinkError: string | null;
  actions: {
    refresh: () => Promise<boolean>;
    downloadFasterWhisper: (modelId: string) => Promise<boolean>;
    downloadPyannote: () => Promise<boolean>;
    requestDeleteFasterWhisper: (modelId: string) => boolean;
    requestDeletePyannote: () => boolean;
    openPyannoteModelPage: () => Promise<boolean>;
    openHuggingFaceTokenPage: () => Promise<boolean>;
  };
};

export type ModelsShellContract = {
  activeJob: boolean;
  activityLabel: string;
};

export type ModelsWorkspaceContract = {
  shared: ModelsSharedCatalogContract;
  page: ModelsPageContract;
  shell: ModelsShellContract;
};
