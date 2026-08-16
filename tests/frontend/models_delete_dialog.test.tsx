import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelsDeleteDialog } from "../../src/components/models/ModelsDeleteDialog";

const target = { kind: "faster-whisper" as const, id: "small", label: "Small" };

describe("ModelsDeleteDialog", () => {
  it("identifies the exact target, focuses Cancel, and traps focus", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ModelsDeleteDialog
        open
        requestKey="request-1"
        target={target}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("alertdialog", { name: "Delete Model?" })).toBeInTheDocument();
    expect(screen.getByText(/local Small faster-whisper model/)).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete Model" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("request-1");
  });

  it("uses the latest cancellation callback across callback-only rerenders", async () => {
    const user = userEvent.setup();
    const olderCancel = vi.fn();
    const latestCancel = vi.fn();
    const { rerender } = render(
      <ModelsDeleteDialog
        open
        requestKey="request-1"
        target={target}
        onConfirm={vi.fn()}
        onCancel={olderCancel}
      />
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    rerender(
      <ModelsDeleteDialog
        open
        requestKey="request-1"
        target={target}
        onConfirm={vi.fn()}
        onCancel={latestCancel}
      />
    );
    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(latestCancel).toHaveBeenCalledWith("request-1");
    expect(olderCancel).not.toHaveBeenCalled();
  });

  it("restores focus exactly once when the dialog closes", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Delete trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(
      <ModelsDeleteDialog
        open
        requestKey="request-1"
        target={target}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await user.tab();
    rerender(
      <ModelsDeleteDialog
        open={false}
        requestKey={null}
        target={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
