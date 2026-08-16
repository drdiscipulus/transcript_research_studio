import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TranscriptionCancelDialog } from "../../src/components/transcription/TranscriptionCancelDialog";

describe("TranscriptionCancelDialog", () => {
  it("focuses the safe action, traps focus, and confirms only through the destructive action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TranscriptionCancelDialog
        open
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("alertdialog", { name: "Stop Transcription?" })).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Stop Transcription" });
    expect(cancel).toHaveFocus();

    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("uses the latest Cancel callback for Escape and keeps Cancel available while pending", async () => {
    const user = userEvent.setup();
    const olderCancel = vi.fn();
    const latestCancel = vi.fn();
    const { rerender } = render(
      <TranscriptionCancelDialog
        open
        pending={false}
        onCancel={olderCancel}
        onConfirm={vi.fn()}
      />
    );
    rerender(
      <TranscriptionCancelDialog
        open
        pending
        onCancel={latestCancel}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(latestCancel).toHaveBeenCalledTimes(1);
    expect(olderCancel).not.toHaveBeenCalled();
  });
});
