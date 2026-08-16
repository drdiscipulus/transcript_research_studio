import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TranscriptionPage } from "../../src/components/TranscriptionPage";
import type { BatchRunSnapshot } from "../../src/lib/api";
import type { TranscriptionPageContract } from "../../src/lib/transcriptionWorkspaceContracts";

function InputOutputHarness({
  liveBatch = null,
  initialInputPath = "C:\\research\\recordings",
  configurationLocked = false,
  isStarting = false,
  cancellationPending = false,
  hardwareRequestError = null,
  hardwareRetryable = false,
  retryHardwareScan = vi.fn(async () => false)
}: {
  liveBatch?: BatchRunSnapshot | null;
  initialInputPath?: string;
  configurationLocked?: boolean;
  isStarting?: boolean;
  cancellationPending?: boolean;
  hardwareRequestError?: string | null;
  hardwareRetryable?: boolean;
  retryHardwareScan?: () => Promise<boolean>;
}) {
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [inputSourceType, setInputSourceType] = useState<"single_file" | "folder">("folder");
  const [inputPath, setInputPath] = useState(initialInputPath);
  const [outputOrganization, setOutputOrganization] = useState<"separate_files" | "combined_file">(
    "separate_files"
  );

  const contract: TranscriptionPageContract = {
    setup: {
      state: {
        advancedSettingsOpen,
        loading: false,
        bootstrapError: null,
        configurationLocked,
        inputSourceType,
        inputPath,
        transcriptOutputFolder: "C:\\research\\transcripts",
        outputOrganization,
        modelName: "small",
        modelOptions: [],
        acceleration: "cpu",
        accelerationOptions: [],
        hardwareStatus: "ready",
        hardwareStatusMessage: "Hardware detection complete.",
        hardwareRetryable,
        hardwareRequestError,
        language: "auto",
        languageOptions: [],
        outputMode: "transcribe",
        outputModes: [],
        transcriptLayout: "file",
        transcriptLayoutOptions: [],
        paragraphPauseEnabled: true,
        paragraphPauseSeconds: "3",
        exportFormats: ["xlsx"],
        exportFormatOptions: ["xlsx", "csv", "json", "docx"],
        appSettings: null,
        settingsLoading: false,
        settingsError: null,
        settingsSavePending: false,
        settingsPersistenceError: null,
        pathActionError: null
      },
      actions: {
        setAdvancedSettingsOpen,
        pickInputSource: async (sourceType) => {
          setInputSourceType(sourceType);
          setInputPath(sourceType === "single_file" ? "C:\\research\\interview.wav" : "C:\\research\\recordings");
        },
        pickOutputFolder: async () => undefined,
        clearInput: vi.fn(),
        clearOutputFolder: vi.fn(),
        openPath: async () => undefined,
        setOutputOrganization,
        setModelName: vi.fn(),
        setAcceleration: vi.fn(),
        retryHardwareScan,
        setLanguage: vi.fn(),
        setOutputMode: vi.fn(),
        setTranscriptLayout: vi.fn(),
        setParagraphPauseEnabled: vi.fn(),
        setParagraphPauseSeconds: vi.fn(),
        toggleExportFormat: vi.fn(),
        updateAdvancedToggle: async () => undefined,
        saveAdvancedSettings: async () => null,
        canPersistSettings: () => true
      }
    },
    scan: {
      preview: null,
      isScanning: false,
      statusMessage: "Choose an input source to scan for media files.",
      error: null,
      folderMessages: [],
      speakerRecognitionEnabled: false,
      pyannoteModelInstalled: false,
      modelsStatusLoading: false,
      modelsStatusError: null
    },
    run: {
      state: {
        liveBatch,
        batchIsActive: Boolean(liveBatch && ["starting", "running", "cancelling"].includes(liveBatch.status)),
        isStarting,
        cancellationPending,
        canStart: false,
        canStartReason: null,
        displayFilesQueued: 0,
        progressPercent: 0,
        startError: null,
        cancellationError: null,
        polling: {
          health: null,
          checking: false,
          isStale: false,
          error: null,
          compatibilityError: null,
          lastUpdatedAt: null,
          consecutiveFailures: 0
        },
        cancelDialog: { open: false, batchId: null, requestKey: null }
      },
      actions: {
        start: async () => false,
        requestCancellation: () => false,
        cancelCancellationDialog: vi.fn(),
        confirmCancellation: async () => false,
        newRun: () => true,
        retryPolling: vi.fn(),
        openLogsFolder: async () => undefined
      }
    }
  };

  return <TranscriptionPage {...contract} />;
}

describe("Transcription Inputs and Outputs", () => {
  it("keeps hardware retry visible after a rejected retry request", async () => {
    const retryHardwareScan = vi.fn(async () => true);
    render(
      <InputOutputHarness
        hardwareRequestError="Hardware scan could not be restarted. CPU processing remains available."
        hardwareRetryable
        retryHardwareScan={retryHardwareScan}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Hardware scan could not be restarted");
    await userEvent.click(screen.getByRole("button", { name: "Retry Hardware Scan" }));
    expect(retryHardwareScan).toHaveBeenCalledTimes(1);
  });

  it("hides transcript-file organization until an input folder is selected", async () => {
    const user = userEvent.setup();
    render(<InputOutputHarness initialInputPath="" />);

    expect(screen.queryByRole("radiogroup", { name: "Transcript Files" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Help: Transcript Files")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Folder" }));

    expect(screen.getByRole("radiogroup", { name: "Transcript Files" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Separate files" })).toBeChecked();
  });

  it("uses compact native radios and keeps filename controls out of the main workflow", async () => {
    const user = userEvent.setup();
    render(<InputOutputHarness />);

    const separateFiles = screen.getByRole("radio", { name: "Separate files" });
    expect(separateFiles).toBeChecked();
    expect(separateFiles).toHaveAttribute("type", "radio");
    expect(screen.queryByText("Transcript files")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Help: Transcript Files")).toBeInTheDocument();
    const outputHeadingRow = screen.getByRole("heading", { name: "Output" }).parentElement;
    expect(outputHeadingRow).toContainElement(screen.getByRole("radiogroup", { name: "Transcript Files" }));
    expect(screen.queryByText("File naming")).not.toBeInTheDocument();
    expect(screen.queryByText("Level of control")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Source filename" })).not.toBeInTheDocument();
    expect(screen.queryByText("Batch overview")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Combined filename")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Combined file" }));
    expect(screen.getByRole("radio", { name: "Combined file" })).toBeChecked();
    expect(screen.queryByLabelText("Combined filename")).not.toBeInTheDocument();

    const xlsxFormat = screen.getByRole("checkbox", { name: "XLSX" });
    expect(xlsxFormat.closest("label")).toHaveClass("transcription-format-checkbox");
    expect(xlsxFormat.closest("label")).toHaveClass("transcription-plain-checkbox");
    expect(xlsxFormat.closest("label")).not.toHaveClass("checkbox-chip");

    expect(screen.getByText("Transcript Structure")).toBeInTheDocument();
    expect(screen.getByText("Speaker Detection")).toBeInTheDocument();
    expect(screen.getByText("Export Formats")).toBeInTheDocument();
    const setupGrid = screen.getByRole("heading", { name: "Transcription Setup" }).closest("section")
      ?.querySelector(".transcription-form-grid");
    expect(Array.from(setupGrid?.children ?? []).map((field) =>
      field.querySelector(".field-label-with-help > :first-child")?.textContent
    )).toEqual([
      "Task",
      "Model",
      "Acceleration",
      "Language",
      "Transcript Structure",
      "Speaker Detection",
      "Timestamps",
      "Export Formats"
    ]);
    expect(screen.getByRole("combobox", { name: /Speaker Detection/ })).toHaveValue("disabled");
    expect(screen.getByRole("combobox", { name: /Timestamps/ })).toHaveValue("disabled");
  });

  it("opens Advanced settings as an accordion without output naming controls", async () => {
    const user = userEvent.setup();
    render(<InputOutputHarness />);

    const advancedSummary = screen.getByRole("button", { name: "Advanced Settings" });
    expect(advancedSummary).toHaveAttribute("aria-expanded", "false");
    await user.click(advancedSummary);
    expect(advancedSummary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("spinbutton", { name: /Beam Size/ })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Speaker Mode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Custom basename" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Combined filename")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Source filename" })).not.toBeInTheDocument();
  });

  it("keeps advanced values mounted while the accordion is collapsed", async () => {
    const user = userEvent.setup();
    render(<InputOutputHarness />);

    const advancedSummary = screen.getByRole("button", { name: "Advanced Settings" });
    await user.click(advancedSummary);
    const beamSize = screen.getByRole("spinbutton", { name: /Beam Size/ });
    await user.clear(beamSize);
    await user.type(beamSize, "7");
    expect(beamSize).toHaveValue(7);

    await user.click(advancedSummary);
    expect(beamSize).not.toBeVisible();
    await user.click(advancedSummary);
    expect(screen.getByRole("spinbutton", { name: /Beam Size/ })).toHaveValue(7);
  });

  it("offers direct File and Folder picker actions", async () => {
    const user = userEvent.setup();
    render(<InputOutputHarness />);

    expect(screen.queryByRole("dialog", { name: "Select input" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByLabelText("Media File")).toHaveValue("C:\\research\\interview.wav");
    expect(screen.queryByRole("radiogroup", { name: "Transcript Files" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Folder" }));
    expect(screen.getByLabelText("Media Folder")).toHaveValue("C:\\research\\recordings");
    expect(screen.getByRole("radiogroup", { name: "Transcript Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Run" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
  });

  it("locks visible setup and New Run synchronously while starting", async () => {
    render(<InputOutputHarness configurationLocked isStarting />);

    expect(screen.getByRole("button", { name: "File" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Separate files" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "XLSX" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New Run" })).toBeDisabled();
  });

  it("shows the actual created export filenames and title-case result headings", () => {
    const liveBatch: BatchRunSnapshot = {
      batch_id: "batch-1",
      batch_name: "Test batch",
      status: "completed",
      message: "Run successful.",
      progress_percent: 100,
      files_completed: 1,
      total_files: 1,
      current_file_name: null,
      started_at: "2026-07-18T10:00:00Z",
      finished_at: "2026-07-18T10:01:00Z",
      output_files: [
        {
          format: "xlsx",
          path: "D:\\transcripts\\interview.xlsx",
          exists: true,
          file_name: "interview.m4a"
        },
        {
          format: "docx",
          path: "D:\\transcripts\\interview.docx",
          exists: true,
          file_name: "interview.m4a"
        },
        {
          format: "json",
          path: "/research/transcripts/interview.json",
          exists: true,
          file_name: "interview.m4a"
        }
      ],
      files: [
        {
          file_name: "interview.m4a",
          duration_label: "1:00",
          file_info: "M4A",
          status: "completed",
          transcript_preview: "",
          error: null,
          engine: "faster-whisper",
          warnings: []
        }
      ],
      counts: { completed: 1 },
      log_file: null,
      warnings: []
    };

    render(<InputOutputHarness liveBatch={liveBatch} />);

    expect(screen.getByText("File Status (1)")).toBeInTheDocument();
    expect(screen.getByText("Created Outputs (3)")).toBeInTheDocument();
    expect(screen.getByText("interview.xlsx")).toHaveAttribute(
      "title",
      "D:\\transcripts\\interview.xlsx"
    );
    expect(screen.getByText("interview.docx")).toBeInTheDocument();
    expect(screen.getByText("interview.json")).toBeInTheDocument();
    expect(screen.queryAllByText("interview.m4a")).toHaveLength(1);
  });

  it("presents an interrupted batch as finished using its authoritative status message", () => {
    const liveBatch: BatchRunSnapshot = {
      batch_id: "batch-interrupted",
      batch_name: "Interrupted batch",
      status: "interrupted",
      message: "The local transcription service restarted. This run was interrupted.",
      progress_percent: 50,
      files_completed: 1,
      total_files: 2,
      current_file_name: null,
      started_at: "2026-08-06T10:00:00Z",
      finished_at: "2026-08-06T10:01:00Z",
      output_files: [{
        format: "xlsx",
        path: "D:\\transcripts\\interview.xlsx",
        exists: true,
        file_name: "interview.m4a"
      }],
      files: [{
        file_name: "interview.m4a",
        duration_label: "1:00",
        file_info: "M4A",
        status: "completed",
        transcript_preview: "",
        error: null,
        engine: "faster-whisper",
        warnings: []
      }],
      counts: { completed: 1, failed: 1 },
      log_file: "D:\\transcripts\\logs\\batch-interrupted.log",
      warnings: ["The local service restarted."]
    };

    render(<InputOutputHarness liveBatch={liveBatch} />);

    expect(screen.getByText("The local transcription service restarted. This run was interrupted.")).toBeInTheDocument();
    expect(screen.queryByText("Ready to start transcription.")).not.toBeInTheDocument();
    expect(screen.getByText("File Status (1)")).toBeInTheDocument();
    expect(screen.getByText("Created Outputs (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Output Folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Run" })).toBeEnabled();
  });
});
