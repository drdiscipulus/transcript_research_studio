import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditorConfirmationDialog } from "../../src/components/editor/EditorConfirmationDialog";
import { EditorDocumentSelectionDialog } from "../../src/components/editor/EditorDocumentSelectionDialog";

describe("Editor dialogs", () => {
  it("renders an accessible destructive confirmation with explicit actions", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <EditorConfirmationDialog
        open
        title="Reset Changes?"
        description="Reset all editor changes?"
        confirmLabel="Reset Changes"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    const dialog = screen.getByRole("alertdialog", { name: "Reset Changes?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Reset Changes" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("requires an explicit document choice and supports Cancel", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onLoad = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <EditorDocumentSelectionDialog
        inspectedPath="C:\\research\\combined.json"
        documents={[
          { id: "one", label: "Interview One", file_name: "one.m4a", segment_count: 4, duration: 60 },
          { id: "two", label: "Interview Two", file_name: "two.m4a", segment_count: 8, duration: null }
        ]}
        selectedDocumentId=""
        loading={false}
        onSelect={onSelect}
        onLoad={onLoad}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("dialog", { name: "Choose Transcript" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Load Transcript" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Interview Two/ }));
    expect(onSelect).toHaveBeenCalledWith("two");

    rerender(
      <EditorDocumentSelectionDialog
        inspectedPath="C:\\research\\combined.json"
        documents={[
          { id: "one", label: "Interview One", file_name: "one.m4a", segment_count: 4, duration: 60 },
          { id: "two", label: "Interview Two", file_name: "two.m4a", segment_count: 8, duration: null }
        ]}
        selectedDocumentId="two"
        loading={false}
        onSelect={onSelect}
        onLoad={onLoad}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("radio", { name: /Interview Two/ })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Load Transcript" }));
    expect(onLoad).toHaveBeenCalledOnce();
    rerender(
      <EditorDocumentSelectionDialog
        inspectedPath="C:\\research\\combined.json"
        documents={[
          { id: "one", label: "Interview One", file_name: "one.m4a", segment_count: 4, duration: 60 },
          { id: "two", label: "Interview Two", file_name: "two.m4a", segment_count: 8, duration: null }
        ]}
        selectedDocumentId="two"
        loading
        onSelect={onSelect}
        onLoad={onLoad}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Loading…" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: /Interview Two/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("restores the prior focus target when a document-selection dialog unmounts", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open document selector";
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <EditorDocumentSelectionDialog
        inspectedPath="C:\\research\\combined.json"
        documents={[{ id: "one", label: "Interview One", file_name: "one.m4a", segment_count: 4, duration: 60 }]}
        selectedDocumentId="one"
        loading={false}
        onSelect={vi.fn()}
        onLoad={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it("keeps focus stable across confirmation rerenders and uses the latest Escape callback", async () => {
    const user = userEvent.setup();
    const firstCancel = vi.fn();
    const latestCancel = vi.fn();
    const { rerender } = render(
      <EditorConfirmationDialog
        open
        title="Delete Speaker?"
        description="Delete this speaker?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={firstCancel}
      />
    );

    const confirmButton = screen.getByRole("button", { name: "Delete" });
    confirmButton.focus();
    expect(confirmButton).toHaveFocus();

    rerender(
      <EditorConfirmationDialog
        open
        title="Delete Speaker?"
        description="Delete this speaker?"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={latestCancel}
      />
    );

    expect(confirmButton).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(firstCancel).not.toHaveBeenCalled();
    expect(latestCancel).toHaveBeenCalledOnce();
  });

  it("restores focus once when closed and starts a fresh focus session when reopened", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open Confirmation
          </button>
          <EditorConfirmationDialog
            open={open}
            title="Reset Changes?"
            description="Reset all editor changes?"
            confirmLabel="Reset Changes"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open Confirmation" });

    await user.click(opener);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    await user.click(cancel);
    expect(opener).toHaveFocus();

    await user.click(opener);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("uses unique accessible title and description IDs for concurrent dialog instances", () => {
    render(
      <>
        <EditorConfirmationDialog
          open
          title="First Confirmation"
          description="First description"
          confirmLabel="Confirm First"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
        <EditorConfirmationDialog
          open
          title="Second Confirmation"
          description="Second description"
          confirmLabel="Confirm Second"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </>
    );

    const [first, second] = screen.getAllByRole("alertdialog", { hidden: true });
    expect(first.getAttribute("aria-labelledby")).not.toBe(second.getAttribute("aria-labelledby"));
    expect(first.getAttribute("aria-describedby")).not.toBe(second.getAttribute("aria-describedby"));
  });
});
