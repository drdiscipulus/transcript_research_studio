import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SpeakerPanel } from "../../src/components/editor/SpeakerPanel";

describe("SpeakerPanel", () => {
  it("uses an expanded accordion with explicit model-style delete actions", async () => {
    const user = userEvent.setup();
    const onRemoveSpeaker = vi.fn();

    render(
      <SpeakerPanel
        speakers={[
          { id: "SPEAKER_00", name: "Interviewer" },
          { id: "SPEAKER_01", name: "Participant" }
        ]}
        onUpdateSpeaker={vi.fn()}
        onRemoveSpeaker={onRemoveSpeaker}
        onAddSpeaker={vi.fn()}
      />
    );

    const summary = screen.getByRole("button", { name: "Speakers (2)" });
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Add Speaker" })).toBeVisible();

    const deleteButton = screen.getByRole("button", { name: "Delete SPEAKER_00" });
    expect(deleteButton).toHaveTextContent("Delete");
    expect(deleteButton).toHaveClass("danger-button", "model-action-button");
    await user.click(deleteButton);
    expect(onRemoveSpeaker).toHaveBeenCalledWith("SPEAKER_00");

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add Speaker" })).not.toBeInTheDocument();
  });
});
