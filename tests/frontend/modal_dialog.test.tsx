import { StrictMode, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ConfirmationDialog,
  type ConfirmationIntent
} from "../../src/components/workbench/ConfirmationDialog";
import { CodesDeleteEntityDialog } from "../../src/components/codes/CodesDeleteEntityDialog";
import { EditorDocumentSelectionDialog } from "../../src/components/editor/EditorDocumentSelectionDialog";
import { ModelsDeleteDialog } from "../../src/components/models/ModelsDeleteDialog";
import { TranscriptionCancelDialog } from "../../src/components/transcription/TranscriptionCancelDialog";
import { ModalDialog } from "../../src/components/workbench/ModalDialog";

function StackHarness() {
  const [lowerOpen, setLowerOpen] = useState(false);
  const [topOpen, setTopOpen] = useState(false);
  const [lowerInstanceKey, setLowerInstanceKey] = useState(1);
  const [topInstanceKey, setTopInstanceKey] = useState(1);
  return (
    <>
      <button type="button" onClick={() => setLowerOpen(true)}>Open Lower</button>
      <ModalDialog
        open={lowerOpen}
        instanceKey={lowerInstanceKey}
        title="Lower Dialog"
        onCancel={() => setLowerOpen(false)}
        footer={(
          <>
            <button type="button" onClick={() => setTopOpen(true)}>Open Top</button>
            <button type="button" onClick={() => setLowerOpen(false)}>Close Lower</button>
          </>
        )}
      >
        <p>Lower instance {lowerInstanceKey}</p>
        <button type="button">Lower Content</button>
      </ModalDialog>
      <ModalDialog
        open={topOpen}
        instanceKey={topInstanceKey}
        title="Top Dialog"
        onCancel={() => setTopOpen(false)}
        footer={(
          <>
            <button type="button" onClick={() => setLowerOpen(false)}>Remove Lower</button>
            <button type="button" onClick={() => setLowerInstanceKey((key) => key + 1)}>Replace Lower Instance</button>
            <button type="button" onClick={() => setTopInstanceKey((key) => key + 1)}>Replace Top Instance</button>
            <button type="button" onClick={() => setTopOpen(false)}>Close Top</button>
          </>
        )}
      >
        <p>Top instance {topInstanceKey}</p>
        <button type="button">Top Content</button>
      </ModalDialog>
    </>
  );
}

describe("ModalDialog", () => {
  it("exposes only the top stacked dialog and restores focus through the stack before returning to the trigger", async () => {
    const user = userEvent.setup();
    render(<StackHarness />);
    const trigger = screen.getByRole("button", { name: "Open Lower" });
    await user.click(trigger);
    const lower = screen.getByRole("dialog", { name: "Lower Dialog" });
    const openTop = within(lower).getByRole("button", { name: "Open Top" });

    await user.click(openTop);
    const top = screen.getByRole("dialog", { name: "Top Dialog" });
    const coveredLower = screen.getByText("Lower Dialog").closest("section");
    expect(coveredLower).not.toBeNull();
    expect(top).toHaveAttribute("aria-modal", "true");
    expect(coveredLower).toHaveAttribute("aria-hidden", "true");
    expect(coveredLower).toHaveAttribute("inert");
    expect(screen.queryByRole("dialog", { name: "Lower Dialog" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Top Dialog" })).not.toBeInTheDocument());
    expect(openTop).toHaveFocus();
    expect(lower).toHaveAttribute("aria-modal", "true");
    expect(lower).not.toHaveAttribute("aria-hidden");

    await user.click(within(lower).getByRole("button", { name: "Close Lower" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not move focus outside the active top dialog when a covered dialog unmounts", async () => {
    const user = userEvent.setup();
    render(<StackHarness />);
    await user.click(screen.getByRole("button", { name: "Open Lower" }));
    await user.click(screen.getByRole("button", { name: "Open Top" }));
    const top = screen.getByRole("dialog", { name: "Top Dialog" });
    const removeLower = within(top).getByRole("button", { name: "Remove Lower" });
    removeLower.focus();

    await user.click(removeLower);
    expect(screen.queryByRole("dialog", { name: "Lower Dialog", hidden: true })).not.toBeInTheDocument();
    expect(removeLower).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Top Dialog" })).toHaveAttribute("aria-modal", "true");
  });

  it("keeps a covered dialog in place when its instance changes and restores focus into its current instance after the real top dialog closes", async () => {
    const user = userEvent.setup();
    render(<StackHarness />);
    await user.click(screen.getByRole("button", { name: "Open Lower" }));
    const lower = screen.getByRole("dialog", { name: "Lower Dialog" });
    const openTop = within(lower).getByRole("button", { name: "Open Top" });
    await user.click(openTop);

    const top = screen.getByRole("dialog", { name: "Top Dialog" });
    const replaceLower = within(top).getByRole("button", { name: "Replace Lower Instance" });
    await user.click(replaceLower);

    const coveredLower = screen.getByText("Lower Dialog").closest("section");
    expect(screen.getByText("Lower instance 2")).toBeInTheDocument();
    expect(coveredLower).toHaveAttribute("aria-hidden", "true");
    expect(coveredLower).toHaveAttribute("inert");
    expect(coveredLower).not.toHaveAttribute("aria-modal");
    expect(top).toHaveAttribute("aria-modal", "true");
    expect(top).not.toHaveAttribute("inert");
    expect(replaceLower).toHaveFocus();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Top Dialog" })).not.toBeInTheDocument());
    expect(screen.getByText("Lower instance 2")).toBeInTheDocument();
    expect(lower).toHaveAttribute("aria-modal", "true");
    expect(openTop).toHaveFocus();
  });

  it("keeps the active dialog on top when its instance changes without duplicating its stack entry", async () => {
    const user = userEvent.setup();
    render(<StackHarness />);
    await user.click(screen.getByRole("button", { name: "Open Lower" }));
    await user.click(screen.getByRole("button", { name: "Open Top" }));

    const top = screen.getByRole("dialog", { name: "Top Dialog" });
    const replaceTop = within(top).getByRole("button", { name: "Replace Top Instance" });
    await user.click(replaceTop);

    expect(screen.getByText("Top instance 2")).toBeInTheDocument();
    expect(top).toHaveAttribute("aria-modal", "true");
    expect(top).not.toHaveAttribute("inert");
    expect(within(top).getByRole("button", { name: "Top Content" })).toHaveFocus();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Top Dialog" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Lower Dialog" })).toHaveAttribute("aria-modal", "true");
  });

  it("skips unreachable controls and safely falls back when the requested initial control cannot receive focus", async () => {
    const user = userEvent.setup();
    function Harness() {
      const invalidInitialRef = useRef<HTMLButtonElement>(null);
      return (
        <ModalDialog
          open
          title="Keyboard Reachability"
          initialFocusRef={invalidInitialRef}
          onCancel={vi.fn()}
          footer={(
            <>
              <button ref={invalidInitialRef} type="button" disabled>Disabled Initial</button>
              <button type="button">Fallback</button>
            </>
          )}
        >
          <details>
            <summary>More Options</summary>
            <button type="button">Hidden Detail Action</button>
          </details>
          <fieldset disabled><button type="button">Disabled Fieldset Action</button></fieldset>
          <div aria-hidden="true"><button type="button">Hidden Ancestor Action</button></div>
          <button type="button" tabIndex={-1}>Programmatic Only</button>
        </ModalDialog>
      );
    }

    render(<Harness />);
    const summary = screen.getByText("More Options");
    expect(summary).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Fallback" })).toHaveFocus();
    await user.tab();
    expect(summary).toHaveFocus();
  });

  it("contains Escape while cancellation is locked and resumes the latest cancellation callback after release", async () => {
    const user = userEvent.setup();
    const firstCancel = vi.fn();
    const latestCancel = vi.fn();
    const { rerender } = render(
      <ModalDialog
        open
        title="Locked Cancellation"
        cancelDisabled
        onCancel={firstCancel}
        footer={<button type="button" disabled>Cancel</button>}
      />
    );

    await user.keyboard("{Escape}");
    expect(firstCancel).not.toHaveBeenCalled();
    rerender(
      <ModalDialog
        open
        title="Locked Cancellation"
        cancelDisabled={false}
        onCancel={latestCancel}
        footer={<button type="button">Cancel</button>}
      />
    );
    await user.keyboard("{Escape}");
    expect(latestCancel).toHaveBeenCalledOnce();
  });

  it("propagates each workflow's visible cancellation rule to Escape", async () => {
    const user = userEvent.setup();
    const codesClose = vi.fn();
    const codesView = render(
      <CodesDeleteEntityDialog
        open
        entityType="code"
        entityName="Setup"
        primaryImpact="0 evidence assignments"
        secondaryImpact="0 theme memberships"
        busy
        onConfirm={vi.fn()}
        onClose={codesClose}
      />
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(codesClose).not.toHaveBeenCalled();
    codesView.unmount();

    const editorCancel = vi.fn();
    const editorView = render(
      <EditorDocumentSelectionDialog
        inspectedPath="C:\\research\\combined.json"
        documents={[{ id: "one", label: "Interview one", file_name: "one.json", segment_count: 1, duration: null }]}
        selectedDocumentId="one"
        loading
        onSelect={vi.fn()}
        onLoad={vi.fn()}
        onCancel={editorCancel}
      />
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(editorCancel).toHaveBeenCalledOnce();
    editorView.unmount();

    const modelsCancel = vi.fn();
    const modelsView = render(
      <ModelsDeleteDialog
        open
        requestKey="model-request"
        target={{ kind: "faster-whisper", id: "small", label: "Small" }}
        onConfirm={vi.fn()}
        onCancel={modelsCancel}
      />
    );
    await user.keyboard("{Escape}");
    expect(modelsCancel).toHaveBeenCalledWith("model-request");
    modelsView.unmount();

    const transcriptionCancel = vi.fn();
    render(<TranscriptionCancelDialog open pending onCancel={transcriptionCancel} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(transcriptionCancel).toHaveBeenCalledOnce();
  });

  it("keeps a StrictMode focus session clean and restores the original external trigger only after the final modal closes", async () => {
    const user = userEvent.setup();
    function StrictHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Dialog opener</button>
          <ModalDialog open={open} title="Strict Dialog" onCancel={() => setOpen(false)} footer={<button type="button">Inside</button>} />
        </>
      );
    }

    const view = render(
      <StrictMode>
        <StrictHarness />
      </StrictMode>
    );
    const opener = screen.getByRole("button", { name: "Dialog opener" });
    await user.click(opener);
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body).not.toHaveClass("modal-open");
    view.unmount();
  });

  it("cleans StrictMode stack state after an instance replacement without leaving inert surfaces or a modal session behind", async () => {
    const user = userEvent.setup();
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const view = render(
      <StrictMode>
        <StackHarness />
      </StrictMode>,
      { container: root }
    );

    await user.click(screen.getByRole("button", { name: "Open Lower" }));
    await user.click(screen.getByRole("button", { name: "Open Top" }));
    await user.click(screen.getByRole("button", { name: "Replace Lower Instance" }));

    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "Top Dialog" })).toHaveAttribute("aria-modal", "true");
    expect(root).toHaveAttribute("inert");

    view.unmount();
    await waitFor(() => expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(0));
    expect(root).not.toHaveAttribute("inert");
    expect(document.body).not.toHaveClass("modal-open");
    root.remove();
  });

  it("uses synchronous confirmation admission and permits a retained failed confirmation to be retried", () => {
    const onConfirm = vi.fn();
    const firstIntent: ConfirmationIntent = {
      id: "first",
      title: "First Confirmation",
      description: "First description",
      confirmLabel: "Confirm"
    };
    const secondIntent: ConfirmationIntent = { ...firstIntent, id: "second", title: "Second Confirmation" };
    const { rerender } = render(
      <ConfirmationDialog intent={firstIntent} busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />
    );
    const confirm = screen.getByRole("button", { name: "Confirm" });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(<ConfirmationDialog intent={firstIntent} busy onConfirm={onConfirm} onCancel={vi.fn()} />);
    rerender(<ConfirmationDialog intent={firstIntent} busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledTimes(2);

    rerender(<ConfirmationDialog intent={secondIntent} busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    act(() => screen.getByRole("button", { name: "Confirm" }).click());
    expect(onConfirm).toHaveBeenCalledTimes(3);
  });

  it("creates unique accessible IDs and makes the application root inert while any dialog remains open", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    const view = render(
      <>
        <button type="button">Background</button>
        <ModalDialog open title="First" description="First description" onCancel={vi.fn()} />
        <ModalDialog open title="Second" description="Second description" onCancel={vi.fn()} />
      </>,
      { container: root }
    );
    const dialogs = screen.getAllByRole("dialog", { hidden: true });
    expect(dialogs[0].getAttribute("aria-labelledby")).not.toBe(dialogs[1].getAttribute("aria-labelledby"));
    expect(dialogs[0].getAttribute("aria-describedby")).not.toBe(dialogs[1].getAttribute("aria-describedby"));
    expect(root).toHaveAttribute("inert");
    const background = screen.getByRole("button", { name: "Background", hidden: true });
    fireEvent.keyDown(background, { key: "x" });

    view.unmount();
    await waitFor(() => expect(root).not.toHaveAttribute("inert"));
    root.remove();
  });
});
