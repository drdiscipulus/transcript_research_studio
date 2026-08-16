import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchRunScreenPayload,
  openPath,
  pickFolder,
  pickMediaFile,
  saveAppSettings,
  scanInputSource,
  type AppSettings,
  type ScanPreview,
  type TranscriptionModelOption
} from "../lib/api";
import {
  buildTranscriptionFolderMessages,
  defaultParagraphOptions,
  exportFormatOptions,
  folderParent,
  languageOptions,
  normalizeParagraphPauseInput,
  outputModes,
  preferredOutputPath,
  buildAccelerationOptions,
  sanitizeModelOptions,
  sanitizeParagraphOptions,
  transcriptLayoutOptions,
  type TranscriptLayout
} from "../lib/workflowUtils";
import type {
  TranscriptionInputSourceType,
  TranscriptionOperationAccess,
  TranscriptionOperationKind,
  TranscriptionOutputNamingMode,
  TranscriptionOutputOrganization,
  TranscriptionPageContract,
  TranscriptionShellState,
  UseTranscriptionWorkspaceOptions
} from "../lib/transcriptionWorkspaceContracts";
import { useTranscriptionRunLifecycle } from "./useTranscriptionRunLifecycle";

type SetupSnapshot = {
  inputSourceType: TranscriptionInputSourceType;
  inputPath: string;
  transcriptOutputFolder: string;
  outputOrganization: TranscriptionOutputOrganization;
  outputNamingMode: TranscriptionOutputNamingMode;
  outputBasename: string;
  combinedOutputBasename: string;
  language: string;
  outputMode: string;
  exportFormats: string[];
  transcriptLayout: TranscriptLayout;
  paragraphPauseEnabled: boolean;
  paragraphPauseSeconds: string;
  modelName: string;
  acceleration: string;
};

type ScanIdentity = {
  sourceType: TranscriptionInputSourceType;
  normalizedPath: string;
  generation: number;
};

type TrustedScan = {
  identity: ScanIdentity;
  preview: ScanPreview;
};

const DEFAULT_SCAN_MESSAGE = "Choose an input source to scan for media files.";

function normalizeInputPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.toLocaleLowerCase();
}

function sameScanIdentity(left: ScanIdentity | null, right: ScanIdentity | null): boolean {
  return Boolean(
    left
    && right
    && left.sourceType === right.sourceType
    && left.normalizedPath === right.normalizedPath
    && left.generation === right.generation
  );
}

function sameAdvancedTranscriptionSettings(
  left: AppSettings["advanced_transcription"],
  right: AppSettings["advanced_transcription"]
): boolean {
  return (
    left.diarization_enabled === right.diarization_enabled
    && left.include_timestamps === right.include_timestamps
    && left.beam_size === right.beam_size
    && left.vad_filter === right.vad_filter
    && left.temperature === right.temperature
    && left.compute_type === right.compute_type
    && left.speaker_mode === right.speaker_mode
    && left.exact_speakers === right.exact_speakers
    && left.min_speakers === right.min_speakers
    && left.max_speakers === right.max_speakers
  );
}

function modelsStatusOptions(
  status: UseTranscriptionWorkspaceOptions["modelsStatus"]
): TranscriptionModelOption[] | null {
  if (!status) return null;
  return status.faster_whisper.map((model) => ({
    value: model.value,
    label: model.label,
    installed: model.availability ? model.availability === "ready" : model.installed,
    bundled: false
  }));
}

function firstReadyModel(options: TranscriptionModelOption[], preferred: string): string {
  const ready = options.filter((option) => option.installed || option.bundled);
  return ready.some((option) => option.value === preferred) ? preferred : ready[0]?.value ?? "";
}

function buildStartPayload(setup: SetupSnapshot) {
  const outputOrganization = setup.inputSourceType === "folder"
    ? setup.outputOrganization
    : "separate_files";
  return {
    input_source_type: setup.inputSourceType,
    input_path: setup.inputPath,
    transcript_output_folder: setup.transcriptOutputFolder,
    output_organization: outputOrganization,
    output_naming_mode: outputOrganization === "combined_file" ? "override" : setup.outputNamingMode,
    output_basename: outputOrganization === "combined_file"
      ? setup.combinedOutputBasename
      : setup.outputBasename,
    language: setup.language,
    output_mode: setup.outputMode,
    export_formats: [...setup.exportFormats],
    transcript_layout: setup.transcriptLayout,
    paragraph_options: {
      paragraph_pause_enabled: setup.paragraphPauseEnabled,
      max_pause_seconds: normalizeParagraphPauseInput(setup.paragraphPauseSeconds)
    },
    model_name: setup.modelName,
    acceleration: setup.acceleration
  };
}

export function useTranscriptionWorkspace(options: UseTranscriptionWorkspaceOptions) {
  const {
    appSettings,
    settingsLoading,
    settingsError,
    modelsStatus,
    modelsStatusLoading,
    modelsStatusError,
    hardwareSnapshot,
    hardwareRequestError,
    onRetryHardwareScan,
    onSettingsChanged,
    onSettingsError
  } = options;
  const [setup, setSetupState] = useState<SetupSnapshot>({
    inputSourceType: "folder",
    inputPath: "",
    transcriptOutputFolder: "",
    outputOrganization: "separate_files",
    outputNamingMode: "input_filename",
    outputBasename: "",
    combinedOutputBasename: "combined_transcripts",
    language: "auto",
    outputMode: "transcribe",
    exportFormats: ["xlsx"],
    transcriptLayout: "file",
    paragraphPauseEnabled: defaultParagraphOptions.paragraph_pause_enabled,
    paragraphPauseSeconds: String(defaultParagraphOptions.max_pause_seconds),
    modelName: "small",
    acceleration: "cpu"
  });
  const [advancedSettingsOpen, setAdvancedSettingsOpenState] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [browseHomeFolder, setBrowseHomeFolder] = useState("");
  const [modelOptions, setModelOptionsState] = useState<TranscriptionModelOption[]>([]);
  const [accelerationOptions, setAccelerationOptions] = useState<ReturnType<typeof buildAccelerationOptions>>([]);
  const [trustedScan, setTrustedScanState] = useState<TrustedScan | null>(null);
  const [isScanning, setIsScanningState] = useState(false);
  const [scanStatusMessage, setScanStatusMessage] = useState("Preparing scan preview...");
  const [scanError, setScanError] = useState<string | null>(null);
  const [pathActionError, setPathActionError] = useState<string | null>(null);
  const [settingsPersistenceError, setSettingsPersistenceError] = useState<string | null>(null);
  const [settingsSavePending, setSettingsSavePendingState] = useState(false);

  const lifecycleSessionSequenceRef = useRef(0);
  const activeLifecycleSessionRef = useRef<number | null>(null);
  const setupRef = useRef(setup);
  const appSettingsRef = useRef(appSettings);
  const modelOptionsRef = useRef(modelOptions);
  const modelsStatusRef = useRef(modelsStatus);
  const trustedScanRef = useRef<TrustedScan | null>(null);
  const isScanningRef = useRef(false);
  const workspaceGenerationRef = useRef(0);
  const inputGenerationRef = useRef(0);
  const setupEditVersionRef = useRef(0);
  const accelerationEditedRef = useRef(false);
  const bootstrapRequestRef = useRef(0);
  const scanRequestRef = useRef(0);
  const lastAutomaticScanKeyRef = useRef("");
  const pathRequestRef = useRef(0);
  const settingsIntentVersionRef = useRef(0);
  const settingsIntentAdvancedRef = useRef<AppSettings["advanced_transcription"] | null>(
    appSettings?.advanced_transcription ?? null
  );
  const settingsWriteTailRef = useRef<Promise<void>>(Promise.resolve());
  const settingsSavePendingRef = useRef(false);
  const operationStateRef = useRef<{ kind: TranscriptionOperationKind; token: number } | null>(null);
  const operationTokenRef = useRef(0);

  setupRef.current = setup;
  modelOptionsRef.current = modelOptions;
  modelsStatusRef.current = modelsStatus;

  const acceptedAdvancedSettings = settingsIntentAdvancedRef.current;
  if (!appSettings) {
    appSettingsRef.current = null;
  } else if (
    !settingsSavePendingRef.current
    && (!acceptedAdvancedSettings || sameAdvancedTranscriptionSettings(
      appSettings.advanced_transcription,
      acceptedAdvancedSettings
    ))
  ) {
    appSettingsRef.current = appSettings;
    settingsIntentAdvancedRef.current = appSettings.advanced_transcription;
  }

  const isLifecycleSessionActive = useCallback((session: number | null) => (
    session !== null && activeLifecycleSessionRef.current === session
  ), []);

  const operation = useMemo<TranscriptionOperationAccess>(() => ({
    acquire(kind) {
      if (activeLifecycleSessionRef.current === null || operationStateRef.current) return null;
      const token = operationTokenRef.current + 1;
      operationTokenRef.current = token;
      operationStateRef.current = { kind, token };
      return token;
    },
    release(token) {
      if (operationStateRef.current?.token === token) operationStateRef.current = null;
    }
  }), []);

  useEffect(() => {
    const session = lifecycleSessionSequenceRef.current + 1;
    lifecycleSessionSequenceRef.current = session;
    activeLifecycleSessionRef.current = session;
    return () => {
      if (activeLifecycleSessionRef.current === session) {
        activeLifecycleSessionRef.current = null;
      }
      workspaceGenerationRef.current += 1;
      bootstrapRequestRef.current += 1;
      scanRequestRef.current += 1;
      pathRequestRef.current += 1;
      settingsIntentVersionRef.current += 1;
      settingsSavePendingRef.current = false;
      operationTokenRef.current += 1;
      operationStateRef.current = null;
    };
  }, []);

  const getWorkspaceGeneration = useCallback(() => workspaceGenerationRef.current, []);
  const runLifecycle = useTranscriptionRunLifecycle({ operation, getWorkspaceGeneration });

  const publishSetup = useCallback((next: SetupSnapshot, researcherEdit = false) => {
    setupRef.current = next;
    setSetupState(next);
    if (researcherEdit) setupEditVersionRef.current += 1;
  }, []);

  const updateSetup = useCallback((
    transform: (current: SetupSnapshot) => SetupSnapshot,
    researcherEdit = true
  ): boolean => {
    if (
      activeLifecycleSessionRef.current === null
      || runLifecycle.refs.isConfigurationLocked()
    ) return false;
    const next = transform(setupRef.current);
    if (next === setupRef.current) return true;
    publishSetup(next, researcherEdit);
    return true;
  }, [publishSetup, runLifecycle.refs]);

  const currentInputIdentity = useCallback((): ScanIdentity | null => {
    const current = setupRef.current;
    const normalizedPath = normalizeInputPath(current.inputPath);
    if (!normalizedPath) return null;
    return {
      sourceType: current.inputSourceType,
      normalizedPath,
      generation: inputGenerationRef.current
    };
  }, []);

  const publishTrustedScan = useCallback((next: TrustedScan | null) => {
    trustedScanRef.current = next;
    setTrustedScanState(next);
  }, []);

  const publishScanning = useCallback((next: boolean) => {
    isScanningRef.current = next;
    setIsScanningState(next);
  }, []);

  const invalidateScan = useCallback((message = DEFAULT_SCAN_MESSAGE) => {
    inputGenerationRef.current += 1;
    scanRequestRef.current += 1;
    lastAutomaticScanKeyRef.current = "";
    publishTrustedScan(null);
    publishScanning(false);
    setScanError(null);
    setScanStatusMessage(message);
  }, [publishScanning, publishTrustedScan]);

  useEffect(() => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return;
    const requestId = bootstrapRequestRef.current + 1;
    bootstrapRequestRef.current = requestId;
    const editVersion = setupEditVersionRef.current;
    setBootstrapLoading(true);
    setBootstrapError(null);

    void fetchRunScreenPayload()
      .then((payload) => {
        if (
          !isLifecycleSessionActive(lifecycleSession)
          || bootstrapRequestRef.current !== requestId
        ) return;
        setBrowseHomeFolder(payload.browse_home_folder);

        const bootstrapModels = sanitizeModelOptions(payload.simple_options.model_options);
        const authoritativeModels = modelsStatusOptions(modelsStatusRef.current) ?? bootstrapModels;
        modelOptionsRef.current = authoritativeModels;
        setModelOptionsState(authoritativeModels);
        if (setupEditVersionRef.current === editVersion) {
          const nextParagraph = sanitizeParagraphOptions(payload.simple_options.paragraph_options);
          const requestedLayout = String(payload.simple_options.transcript_layout ?? "file").trim().toLowerCase();
          const transcriptLayout: TranscriptLayout = requestedLayout === "segment" || requestedLayout === "paragraph"
            ? requestedLayout
            : "file";
          const requestedModel = String(payload.simple_options.model_name ?? "small").trim().toLowerCase() || "small";
          publishSetup({
            ...setupRef.current,
            inputSourceType: "folder",
            inputPath: "",
            transcriptOutputFolder: "",
            language: payload.simple_options.language,
            outputMode: payload.simple_options.output_mode,
            exportFormats: [...payload.simple_options.export_formats],
            transcriptLayout,
            paragraphPauseEnabled: nextParagraph.paragraph_pause_enabled,
            paragraphPauseSeconds: String(nextParagraph.max_pause_seconds),
            modelName: firstReadyModel(authoritativeModels, requestedModel),
            acceleration: setupRef.current.acceleration,
            outputBasename: payload.batch_name
          });
          setScanStatusMessage(DEFAULT_SCAN_MESSAGE);
        }
      })
      .catch((error) => {
        if (
          isLifecycleSessionActive(lifecycleSession)
          && bootstrapRequestRef.current === requestId
        ) {
          setBootstrapError(error instanceof Error ? error.message : "Transcription data could not be loaded.");
        }
      })
      .finally(() => {
        if (
          isLifecycleSessionActive(lifecycleSession)
          && bootstrapRequestRef.current === requestId
        ) setBootstrapLoading(false);
      });

    return () => {
      bootstrapRequestRef.current += 1;
    };
  }, [isLifecycleSessionActive, publishSetup]);

  useEffect(() => {
    const detectedHardware = hardwareSnapshot.status === "ready"
      ? hardwareSnapshot.hardware
      : null;
    const nextOptions = buildAccelerationOptions(detectedHardware);
    setAccelerationOptions(nextOptions);
    if (runLifecycle.refs.isConfigurationLocked()) return;

    const current = setupRef.current;
    const cudaAvailable = Boolean(detectedHardware?.asr_cuda_available);
    if (cudaAvailable && !accelerationEditedRef.current && current.acceleration !== "cuda") {
      publishSetup({ ...current, acceleration: "cuda" });
    } else if (!cudaAvailable && current.acceleration === "cuda") {
      publishSetup({ ...current, acceleration: "cpu" });
    }
  }, [hardwareSnapshot.hardware, hardwareSnapshot.status, publishSetup, runLifecycle.refs]);

  useEffect(() => {
    const authoritativeModels = modelsStatusOptions(modelsStatus);
    if (!authoritativeModels) return;
    modelOptionsRef.current = authoritativeModels;
    setModelOptionsState(authoritativeModels);
    const current = setupRef.current;
    const nextModel = firstReadyModel(authoritativeModels, current.modelName);
    if (nextModel !== current.modelName) publishSetup({ ...current, modelName: nextModel });
  }, [modelsStatus, publishSetup]);

  const scanCurrentInput = useCallback(async (identity: ScanIdentity) => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return;
    const requestId = scanRequestRef.current + 1;
    scanRequestRef.current = requestId;
    publishScanning(true);
    setScanError(null);
    setScanStatusMessage(identity.sourceType === "single_file" ? "Checking media file..." : "Scanning folder...");
    try {
      const current = setupRef.current;
      const preview = await scanInputSource(identity.sourceType, current.inputPath);
      if (
        !isLifecycleSessionActive(lifecycleSession)
        || scanRequestRef.current !== requestId
        || !sameScanIdentity(currentInputIdentity(), identity)
      ) return;
      publishTrustedScan({ identity: { ...identity }, preview });
      setScanStatusMessage(preview.message);
    } catch (error) {
      if (
        !isLifecycleSessionActive(lifecycleSession)
        || scanRequestRef.current !== requestId
        || !sameScanIdentity(currentInputIdentity(), identity)
      ) return;
      const message = error instanceof Error ? error.message : "Input scan failed. Check the selected path.";
      setScanError(message);
      setScanStatusMessage(message);
    } finally {
      if (
        isLifecycleSessionActive(lifecycleSession)
        && scanRequestRef.current === requestId
        && sameScanIdentity(currentInputIdentity(), identity)
      ) {
        publishScanning(false);
      }
    }
  }, [currentInputIdentity, isLifecycleSessionActive, publishScanning, publishTrustedScan]);

  useEffect(() => {
    if (bootstrapLoading || bootstrapError) return;
    const identity = currentInputIdentity();
    if (!identity) return;
    const key = `${identity.sourceType}:${identity.normalizedPath}:${identity.generation}`;
    if (lastAutomaticScanKeyRef.current === key) return;
    lastAutomaticScanKeyRef.current = key;
    const timerId = window.setTimeout(() => {
      if (sameScanIdentity(currentInputIdentity(), identity)) void scanCurrentInput(identity);
    }, 450);
    return () => window.clearTimeout(timerId);
  }, [bootstrapError, bootstrapLoading, currentInputIdentity, scanCurrentInput, setup.inputPath, setup.inputSourceType]);

  const replaceInput = useCallback((sourceType: TranscriptionInputSourceType, path: string) => {
    pathRequestRef.current += 1;
    const current = setupRef.current;
    publishSetup({ ...current, inputSourceType: sourceType, inputPath: path }, true);
    invalidateScan(path ? "Input selected. Scanning will begin shortly." : DEFAULT_SCAN_MESSAGE);
  }, [invalidateScan, publishSetup]);

  const pickInputSource = useCallback(async (sourceType: TranscriptionInputSourceType) => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null || runLifecycle.refs.isConfigurationLocked()) return;
    const token = operation.acquire("input-picker");
    if (token === null) return;
    const workspaceGeneration = workspaceGenerationRef.current;
    try {
      const initialPath = setupRef.current.inputPath || browseHomeFolder || undefined;
      const selected = sourceType === "single_file"
        ? await pickMediaFile(initialPath)
        : await pickFolder(initialPath);
      if (
        !isLifecycleSessionActive(lifecycleSession)
        || workspaceGeneration !== workspaceGenerationRef.current
        || runLifecycle.refs.isConfigurationLocked()
      ) return;
      if (!selected) return;
      replaceInput(sourceType, selected);
      setPathActionError(null);
    } catch (error) {
      if (
        isLifecycleSessionActive(lifecycleSession)
        && workspaceGeneration === workspaceGenerationRef.current
      ) {
        setPathActionError(error instanceof Error ? error.message : "Input picker failed.");
      }
    } finally {
      operation.release(token);
    }
  }, [browseHomeFolder, isLifecycleSessionActive, operation, replaceInput, runLifecycle.refs]);

  const pickOutputFolder = useCallback(async () => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null || runLifecycle.refs.isConfigurationLocked()) return;
    const token = operation.acquire("output-picker");
    if (token === null) return;
    const workspaceGeneration = workspaceGenerationRef.current;
    try {
      const selected = await pickFolder(setupRef.current.transcriptOutputFolder || browseHomeFolder || undefined);
      if (
        !isLifecycleSessionActive(lifecycleSession)
        || workspaceGeneration !== workspaceGenerationRef.current
        || runLifecycle.refs.isConfigurationLocked()
      ) return;
      if (!selected) return;
      pathRequestRef.current += 1;
      publishSetup({ ...setupRef.current, transcriptOutputFolder: selected }, true);
      setPathActionError(null);
    } catch (error) {
      if (
        isLifecycleSessionActive(lifecycleSession)
        && workspaceGeneration === workspaceGenerationRef.current
      ) {
        setPathActionError(error instanceof Error ? error.message : "Folder picker failed.");
      }
    } finally {
      operation.release(token);
    }
  }, [browseHomeFolder, isLifecycleSessionActive, operation, publishSetup, runLifecycle.refs]);

  const clearInput = useCallback(() => {
    if (runLifecycle.refs.isConfigurationLocked()) return;
    const token = operation.acquire("clear-input");
    if (token === null) return;
    replaceInput("folder", "");
    setPathActionError(null);
    operation.release(token);
  }, [operation, replaceInput, runLifecycle.refs]);

  const clearOutputFolder = useCallback(() => {
    if (runLifecycle.refs.isConfigurationLocked()) return;
    const token = operation.acquire("clear-output");
    if (token === null) return;
    pathRequestRef.current += 1;
    publishSetup({ ...setupRef.current, transcriptOutputFolder: "" }, true);
    setPathActionError(null);
    operation.release(token);
  }, [operation, publishSetup, runLifecycle.refs]);

  const openLocalPath = useCallback(async (
    path: string,
    pathOptions: { expectDirectory?: boolean; createIfMissing?: boolean } = {}
  ) => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null) return;
    const requestId = pathRequestRef.current + 1;
    pathRequestRef.current = requestId;
    const workspaceGeneration = workspaceGenerationRef.current;
    try {
      await openPath({
        path,
        expect_directory: pathOptions.expectDirectory,
        create_if_missing: pathOptions.createIfMissing
      });
      if (
        isLifecycleSessionActive(lifecycleSession)
        && workspaceGeneration === workspaceGenerationRef.current
        && pathRequestRef.current === requestId
      ) {
        setPathActionError(null);
      }
    } catch (error) {
      if (
        isLifecycleSessionActive(lifecycleSession)
        && workspaceGeneration === workspaceGenerationRef.current
        && pathRequestRef.current === requestId
      ) {
        setPathActionError(error instanceof Error ? error.message : "The selected path could not be opened.");
      }
    }
  }, [isLifecycleSessionActive]);

  const currentEligibility = useCallback((): { eligible: boolean; reason: string | null } => {
    const current = setupRef.current;
    const folderMessages = buildTranscriptionFolderMessages(
      current.inputSourceType,
      current.inputPath,
      current.transcriptOutputFolder
    );
    if (folderMessages.length > 0) return { eligible: false, reason: folderMessages.join(" ") };
    if (isScanningRef.current) return { eligible: false, reason: "Wait for the input scan to finish." };
    const identity = currentInputIdentity();
    if (!identity || !trustedScanRef.current || !sameScanIdentity(trustedScanRef.current.identity, identity)) {
      return { eligible: false, reason: "Scan the current input source before starting transcription." };
    }
    if (trustedScanRef.current.preview.is_empty) return { eligible: false, reason: "The current input contains no eligible media." };
    const selectedModel = modelOptionsRef.current.find((item) => item.value === current.modelName);
    if (!selectedModel || (!selectedModel.installed && !selectedModel.bundled)) {
      return { eligible: false, reason: "Download a transcription model before starting." };
    }
    if (current.exportFormats.length === 0) return { eligible: false, reason: "Choose at least one export format." };
    const usesCombined = current.inputSourceType === "folder" && current.outputOrganization === "combined_file";
    if (usesCombined && !current.combinedOutputBasename.trim()) {
      return { eligible: false, reason: "Choose a name for the combined transcript." };
    }
    if (!usesCombined && current.outputNamingMode === "override" && !current.outputBasename.trim()) {
      return { eligible: false, reason: "Choose an output basename." };
    }
    if (
      current.acceleration === "cuda"
      && (
        hardwareSnapshot.status !== "ready"
        || !hardwareSnapshot.hardware?.asr_cuda_available
      )
    ) {
      return { eligible: false, reason: "Wait for CUDA hardware detection to finish." };
    }
    const speakerEnabled = Boolean(appSettingsRef.current?.advanced_transcription.diarization_enabled);
    const pyannoteReady = Boolean(
      modelsStatus?.pyannote.availability
        ? modelsStatus.pyannote.availability === "ready"
        : modelsStatus?.pyannote.installed
    );
    if (speakerEnabled && !modelsStatusLoading && !pyannoteReady) {
      return { eligible: false, reason: "Speaker recognition setup is required before starting." };
    }
    if (settingsSavePendingRef.current) return { eligible: false, reason: "Wait for transcription settings to finish saving." };
    if (runLifecycle.refs.isConfigurationLocked()) return { eligible: false, reason: "A transcription run is already active." };
    return { eligible: true, reason: null };
  }, [currentInputIdentity, hardwareSnapshot, modelsStatus, modelsStatusLoading, runLifecycle.refs]);

  const start = useCallback(async () => runLifecycle.actions.start(() => {
    const eligibility = currentEligibility();
    const scan = trustedScanRef.current;
    const identity = currentInputIdentity();
    if (!eligibility.eligible || !scan || !identity || !sameScanIdentity(scan.identity, identity)) return null;
    const acceptedSetup: SetupSnapshot = {
      ...setupRef.current,
      exportFormats: [...setupRef.current.exportFormats]
    };
    return {
      payload: buildStartPayload(acceptedSetup),
      workspaceGeneration: workspaceGenerationRef.current
    };
  }), [currentEligibility, currentInputIdentity, runLifecycle.actions]);

  const newRun = useCallback((): boolean => {
    if (
      activeLifecycleSessionRef.current === null
      || isScanningRef.current
      || runLifecycle.refs.isNewRunBlocked()
    ) return false;
    const pendingOperation = operationStateRef.current;
    if (
      pendingOperation
      && pendingOperation.kind !== "input-picker"
      && pendingOperation.kind !== "output-picker"
    ) return false;
    const token = operationTokenRef.current + 1;
    operationTokenRef.current = token;
    operationStateRef.current = { kind: "new-run", token };
    if (!runLifecycle.actions.resetForNewRun()) {
      operation.release(token);
      return false;
    }
    workspaceGenerationRef.current += 1;
    pathRequestRef.current += 1;
    scanRequestRef.current += 1;
    inputGenerationRef.current += 1;
    lastAutomaticScanKeyRef.current = "";
    publishSetup({
      ...setupRef.current,
      inputSourceType: "folder",
      inputPath: "",
      transcriptOutputFolder: "",
      outputOrganization: "separate_files"
    }, true);
    publishTrustedScan(null);
    publishScanning(false);
    setScanError(null);
    setScanStatusMessage(DEFAULT_SCAN_MESSAGE);
    setPathActionError(null);
    operation.release(token);
    return true;
  }, [operation, publishScanning, publishSetup, publishTrustedScan, runLifecycle.actions, runLifecycle.refs]);

  const canPersistSettings = useCallback(
    () => (
      activeLifecycleSessionRef.current !== null
      && !runLifecycle.refs.isConfigurationLocked()
    ),
    [runLifecycle.refs]
  );

  const persistAdvancedSettings = useCallback((
    advanced: AppSettings["advanced_transcription"]
  ): Promise<AppSettings | null> => {
    const lifecycleSession = activeLifecycleSessionRef.current;
    if (lifecycleSession === null || !appSettingsRef.current || !canPersistSettings()) {
      return Promise.resolve(null);
    }
    const intentVersion = settingsIntentVersionRef.current + 1;
    settingsIntentVersionRef.current = intentVersion;
    const acceptedAdvanced = { ...advanced };
    settingsIntentAdvancedRef.current = acceptedAdvanced;
    settingsSavePendingRef.current = true;
    setSettingsSavePendingState(true);
    setSettingsPersistenceError(null);

    const write = settingsWriteTailRef.current.then(async (): Promise<AppSettings | null> => {
      if (!isLifecycleSessionActive(lifecycleSession)) return null;
      try {
        const saved = await saveAppSettings({ advanced_transcription: acceptedAdvanced });
        if (
          !isLifecycleSessionActive(lifecycleSession)
          || settingsIntentVersionRef.current !== intentVersion
        ) return null;
        appSettingsRef.current = saved;
        settingsIntentAdvancedRef.current = { ...saved.advanced_transcription };
        onSettingsChanged(saved);
        onSettingsError(null);
        setSettingsPersistenceError(null);
        return saved;
      } catch (error) {
        if (
          isLifecycleSessionActive(lifecycleSession)
          && settingsIntentVersionRef.current === intentVersion
        ) {
          setSettingsPersistenceError(
            error instanceof Error ? error.message : "Advanced settings could not be saved."
          );
        }
        return null;
      } finally {
        if (
          isLifecycleSessionActive(lifecycleSession)
          && settingsIntentVersionRef.current === intentVersion
        ) {
          settingsSavePendingRef.current = false;
          setSettingsSavePendingState(false);
        }
      }
    });
    settingsWriteTailRef.current = write.then(() => undefined, () => undefined);
    return write;
  }, [
    canPersistSettings,
    isLifecycleSessionActive,
    onSettingsChanged,
    onSettingsError
  ]);

  const saveAdvancedSettings = useCallback((
    advanced: AppSettings["advanced_transcription"]
  ): Promise<AppSettings | null> => {
    const currentAdvanced = settingsIntentAdvancedRef.current
      ?? appSettingsRef.current?.advanced_transcription;
    if (!currentAdvanced) return Promise.resolve(null);
    return persistAdvancedSettings({
      ...advanced,
      diarization_enabled: currentAdvanced.diarization_enabled,
      include_timestamps: currentAdvanced.include_timestamps
    });
  }, [persistAdvancedSettings]);

  const updateAdvancedToggle = useCallback(async (
    key: "diarization_enabled" | "include_timestamps",
    value: boolean
  ) => {
    const currentAdvanced = settingsIntentAdvancedRef.current
      ?? appSettingsRef.current?.advanced_transcription;
    if (!currentAdvanced || !canPersistSettings()) return;
    await persistAdvancedSettings({
      ...currentAdvanced,
      [key]: value
    });
  }, [canPersistSettings, persistAdvancedSettings]);

  const toggleExportFormat = useCallback((format: string, checked: boolean) => {
    const changed = updateSetup((current) => ({
      ...current,
      exportFormats: checked
        ? current.exportFormats.includes(format) ? current.exportFormats : [...current.exportFormats, format]
        : current.exportFormats.filter((item) => item !== format)
    }));
    if (changed && checked && format === "docx") {
      const currentAdvanced = settingsIntentAdvancedRef.current
        ?? appSettingsRef.current?.advanced_transcription;
      if (
        currentAdvanced
        && !currentAdvanced.diarization_enabled
        && !currentAdvanced.include_timestamps
      ) {
        void persistAdvancedSettings({ ...currentAdvanced, include_timestamps: true });
      }
    }
  }, [persistAdvancedSettings, updateSetup]);

  const openLogsFolder = useCallback(async () => {
    const logsFolder = folderParent(runLifecycle.state.liveBatch?.log_file);
    if (logsFolder) await openLocalPath(logsFolder, { expectDirectory: true, createIfMissing: true });
  }, [openLocalPath, runLifecycle.state.liveBatch?.log_file]);

  const setAdvancedSettingsOpen = useCallback((open: boolean) => {
    if (activeLifecycleSessionRef.current === null) return;
    setAdvancedSettingsOpenState(open);
  }, []);

  const folderMessages = buildTranscriptionFolderMessages(
    setup.inputSourceType,
    setup.inputPath,
    setup.transcriptOutputFolder
  );
  const eligibility = currentEligibility();
  const speakerRecognitionEnabled = Boolean(appSettings?.advanced_transcription.diarization_enabled);
  const pyannoteModelInstalled = Boolean(
    modelsStatus?.pyannote.availability
      ? modelsStatus.pyannote.availability === "ready"
      : modelsStatus?.pyannote.installed
  );
  const liveBatch = runLifecycle.state.liveBatch;
  const page: TranscriptionPageContract = {
    setup: {
      state: {
        advancedSettingsOpen,
        loading: bootstrapLoading,
        bootstrapError,
        configurationLocked: runLifecycle.state.configurationLocked,
        inputSourceType: setup.inputSourceType,
        inputPath: setup.inputPath,
        transcriptOutputFolder: setup.transcriptOutputFolder,
        outputOrganization: setup.outputOrganization,
        modelName: setup.modelName,
        modelOptions,
        acceleration: setup.acceleration,
        accelerationOptions,
        hardwareStatus: hardwareSnapshot.status,
        hardwareStatusMessage: hardwareSnapshot.message,
        hardwareRetryable: hardwareSnapshot.retryable,
        hardwareRequestError,
        language: setup.language,
        languageOptions,
        outputMode: setup.outputMode,
        outputModes,
        transcriptLayout: setup.transcriptLayout,
        transcriptLayoutOptions,
        paragraphPauseEnabled: setup.paragraphPauseEnabled,
        paragraphPauseSeconds: setup.paragraphPauseSeconds,
        exportFormats: setup.exportFormats,
        exportFormatOptions,
        appSettings,
        settingsLoading,
        settingsError,
        settingsSavePending,
        settingsPersistenceError,
        pathActionError
      },
      actions: {
        setAdvancedSettingsOpen,
        pickInputSource,
        pickOutputFolder,
        clearInput,
        clearOutputFolder,
        openPath: openLocalPath,
        setOutputOrganization: (value) => { updateSetup((current) => ({ ...current, outputOrganization: value })); },
        setModelName: (value) => { updateSetup((current) => ({ ...current, modelName: value })); },
        setAcceleration: (value) => {
          accelerationEditedRef.current = true;
          updateSetup((current) => ({ ...current, acceleration: value }));
        },
        retryHardwareScan: onRetryHardwareScan,
        setLanguage: (value) => { updateSetup((current) => ({ ...current, language: value })); },
        setOutputMode: (value) => { updateSetup((current) => ({ ...current, outputMode: value })); },
        setTranscriptLayout: (value) => { updateSetup((current) => ({ ...current, transcriptLayout: value })); },
        setParagraphPauseEnabled: (value) => { updateSetup((current) => ({ ...current, paragraphPauseEnabled: value })); },
        setParagraphPauseSeconds: (value) => { updateSetup((current) => ({ ...current, paragraphPauseSeconds: value })); },
        toggleExportFormat,
        updateAdvancedToggle,
        saveAdvancedSettings,
        canPersistSettings
      }
    },
    scan: {
      preview: trustedScan?.preview ?? null,
      isScanning,
      statusMessage: scanStatusMessage,
      error: scanError,
      folderMessages,
      speakerRecognitionEnabled,
      pyannoteModelInstalled,
      modelsStatusLoading,
      modelsStatusError
    },
    run: {
      state: {
        liveBatch,
        batchIsActive: runLifecycle.state.batchIsActive,
        isStarting: runLifecycle.state.isStarting,
        cancellationPending: runLifecycle.state.cancellationPending,
        canStart: eligibility.eligible,
        canStartReason: eligibility.reason,
        displayFilesQueued: liveBatch?.total_files ?? trustedScan?.preview.file_count ?? 0,
        progressPercent: liveBatch?.progress_percent ?? 0,
        startError: runLifecycle.state.startError,
        cancellationError: runLifecycle.state.cancellationError,
        polling: runLifecycle.state.pollingState,
        cancelDialog: runLifecycle.state.cancelDialog
      },
      actions: {
        start,
        requestCancellation: runLifecycle.actions.requestCancellation,
        cancelCancellationDialog: runLifecycle.actions.cancelCancellationDialog,
        confirmCancellation: runLifecycle.actions.confirmCancellation,
        newRun,
        retryPolling: runLifecycle.actions.retryPolling,
        openLogsFolder
      }
    }
  };

  const shell: TranscriptionShellState = {
    browseHomeFolder,
    suggestedPromptSourceFile: preferredOutputPath(liveBatch) ?? "",
    polling: runLifecycle.state.pollingState,
    activeJob: runLifecycle.state.configurationLocked,
    activityLabel: runLifecycle.state.configurationLocked ? "Transcription run in progress" : ""
  };

  return { page, shell };
}
