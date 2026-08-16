import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdvancedTranscriptionPanel } from "../../src/components/AdvancedPage";
import type { AppSettings } from "../../src/lib/api";

function settingsWithSpeakerDetection(enabled: boolean, includeTimestamps = true): AppSettings {
  return {
    theme_override: "system",
    advanced_transcription: {
      diarization_enabled: enabled,
      include_timestamps: includeTimestamps,
      beam_size: 5,
      vad_filter: true,
      temperature: 0,
      compute_type: "int8",
      speaker_mode: "auto",
      exact_speakers: null,
      min_speakers: null,
      max_speakers: null,
    },
  };
}

function renderPanel({
  speakerDetection,
  pauseBreaks,
}: {
  speakerDetection: boolean;
  pauseBreaks: boolean;
}) {
  const onParagraphPauseEnabledChange = vi.fn();
  render(
    <AdvancedTranscriptionPanel
      settings={settingsWithSpeakerDetection(speakerDetection)}
      settingsLoading={false}
      settingsError={null}
      transcriptLayout="paragraph"
      paragraphPauseEnabled={pauseBreaks}
      onParagraphPauseEnabledChange={onParagraphPauseEnabledChange}
      paragraphPauseSeconds="3"
      onParagraphPauseSecondsChange={vi.fn()}
      onSaveAdvancedSettings={async () => settingsWithSpeakerDetection(speakerDetection)}
    />
  );
  return { onParagraphPauseEnabledChange };
}

describe("Advanced paragraph break guidance", () => {
  it("uses a compact checkbox and keeps detailed guidance in the help tooltip", async () => {
    const user = userEvent.setup();
    const { onParagraphPauseEnabledChange } = renderPanel({ speakerDetection: true, pauseBreaks: true });

    expect(screen.getByText("Pause-Based Breaks")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "Enabled" });
    expect(checkbox).toBeChecked();
    expect(checkbox.closest("label")).toHaveClass("transcription-plain-checkbox");
    expect(screen.getByRole("spinbutton", { name: "Pause threshold in seconds" })).toHaveValue(3);
    expect(screen.getByText("seconds")).toBeInTheDocument();
    expect(screen.queryByText(/Paragraphs break on detected speaker changes/)).not.toBeInTheDocument();

    const help = screen.getByLabelText("Help: Pause-Based Breaks");
    await user.hover(help);
    const tooltip = within(help).getByRole("tooltip");
    expect(tooltip).toHaveClass("visible");
    expect(tooltip).toHaveTextContent(
      /Detected speaker changes always start a new paragraph/i
    );
    expect(tooltip).toHaveTextContent(/Without speaker labels, pauses provide/i);

    await user.click(checkbox);
    expect(onParagraphPauseEnabledChange).toHaveBeenCalledWith(false);
  });

  it("defers a scheduled settings save while a run owns the configuration lock", async () => {
    const user = userEvent.setup();
    const currentSettings = settingsWithSpeakerDetection(false);
    const saveSettings = vi.fn(async (advanced: AppSettings["advanced_transcription"]) => ({
      ...currentSettings,
      advanced_transcription: advanced
    }));
    const props = {
      settings: currentSettings,
      settingsLoading: false,
      settingsError: null,
      transcriptLayout: "paragraph",
      paragraphPauseEnabled: true,
      onParagraphPauseEnabledChange: vi.fn(),
      paragraphPauseSeconds: "3",
      onParagraphPauseSecondsChange: vi.fn(),
      canPersistSettings: () => true,
      onSaveAdvancedSettings: saveSettings
    };
    const { rerender } = render(<AdvancedTranscriptionPanel {...props} configurationLocked={false} />);

    const beamSize = screen.getByRole("spinbutton", { name: /Beam Size/ });
    await user.clear(beamSize);
    await user.type(beamSize, "7");
    rerender(<AdvancedTranscriptionPanel {...props} configurationLocked />);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 350)); });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(beamSize).toHaveValue(7);

    rerender(<AdvancedTranscriptionPanel {...props} configurationLocked={false} />);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0].beam_size).toBe(7);
  });

  it("retains a local field draft across an unrelated settings refresh and saves the composed payload", async () => {
    const user = userEvent.setup();
    const initialSettings = settingsWithSpeakerDetection(false, false);
    const refreshedSettings = settingsWithSpeakerDetection(false, true);
    const saveSettings = vi.fn(async (advanced: AppSettings["advanced_transcription"]) => ({
      ...refreshedSettings,
      advanced_transcription: advanced
    }));
    const commonProps = {
      settingsLoading: false,
      settingsError: null,
      transcriptLayout: "paragraph",
      paragraphPauseEnabled: true,
      onParagraphPauseEnabledChange: vi.fn(),
      paragraphPauseSeconds: "3",
      onParagraphPauseSecondsChange: vi.fn(),
      canPersistSettings: () => true,
      onSaveAdvancedSettings: saveSettings
    };
    const { rerender } = render(
      <AdvancedTranscriptionPanel {...commonProps} settings={initialSettings} />
    );

    const beamSize = screen.getByRole("spinbutton", { name: /Beam Size/ });
    await user.clear(beamSize);
    await user.type(beamSize, "7");
    rerender(<AdvancedTranscriptionPanel {...commonProps} settings={refreshedSettings} />);

    expect(beamSize).toHaveValue(7);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      beam_size: 7,
      include_timestamps: true
    }));
  });
});
