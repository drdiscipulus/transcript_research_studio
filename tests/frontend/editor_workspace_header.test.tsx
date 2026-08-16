import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceHeader } from "../../src/components/editor/EditorWorkspaceHeader";

function makeProps(): ComponentProps<typeof EditorWorkspaceHeader> {
  return {
    dirty: false,
    hasSavePath: false,
    busy: false,
    statusMessage: "Loaded 2 editable segments.",
    hasError: false,
    segmentCount: 2,
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onResetChanges: vi.fn(),
    onCloseEditor: vi.fn()
  };
}

describe("EditorWorkspaceHeader", () => {
  it("starts with Save As and conventional title-case document state", () => {
    render(<EditorWorkspaceHeader {...makeProps()} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Editing Copy");
    expect(status).toHaveTextContent("In Memory");
    expect(status).toHaveTextContent("2 segments loaded");
    expect(status).not.toHaveTextContent("Loaded 2 editable segments.");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeEnabled();
    expect(screen.getByLabelText("Help: Editing Copy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Editor" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close Editor" })).toHaveClass("danger-button");
  });

  it("offers Save and Save As after a path exists and wires each action", async () => {
    const user = userEvent.setup();
    const props = {
      ...makeProps(),
      dirty: true,
      hasSavePath: true
    };
    render(<EditorWorkspaceHeader {...props} />);

    expect(screen.getByText("Unsaved Edits")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved Edits");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Save As…" }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Close Editor" }));

    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onSaveAs).toHaveBeenCalledOnce();
    expect(props.onResetChanges).toHaveBeenCalledOnce();
    expect(props.onCloseEditor).toHaveBeenCalledOnce();
  });
});
