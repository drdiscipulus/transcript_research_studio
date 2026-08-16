// @vitest-environment jsdom
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CloseGuardDialog } from "../../src/components/workbench/CloseGuardDialog";

function CloseGuardFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Close application</button>
      <CloseGuardDialog
        open={open}
        reasons={["Editor has unsaved changes"]}
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

describe("CloseGuardDialog", () => {
  it("traps keyboard focus and restores it after cancellation", async () => {
    const user = userEvent.setup();
    render(<CloseGuardFixture />);

    const trigger = screen.getByRole("button", { name: "Close application" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Close Transcript Research Studio?" })).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Keep working" });
    const confirm = screen.getByRole("button", { name: "Close anyway" });
    expect(cancel).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
