// @vitest-environment jsdom
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  WorkbenchLifecycleProvider,
  WorkbenchPageHost,
  useWorkbenchLifecycle
} from "../../src/components/workbench/WorkbenchLifecycle";

function EditorFixture() {
  const [value, setValue] = useState("");
  return <input aria-label="Editor draft" value={value} onChange={(event) => setValue(event.target.value)} />;
}

function WorkbenchFixture() {
  const { navigateTo } = useWorkbenchLifecycle();
  return (
    <>
      <button type="button" onClick={() => navigateTo("home")}>Home</button>
      <button type="button" onClick={() => navigateTo("editor")}>Editor</button>
      <WorkbenchPageHost pageId="home"><p>Home page</p></WorkbenchPageHost>
      <WorkbenchPageHost pageId="editor"><EditorFixture /></WorkbenchPageHost>
    </>
  );
}

describe("WorkbenchPageHost", () => {
  it("keeps a visited page mounted while it is hidden", async () => {
    const user = userEvent.setup();
    render(<WorkbenchLifecycleProvider><WorkbenchFixture /></WorkbenchLifecycleProvider>);

    await user.click(screen.getByRole("button", { name: "Editor" }));
    await user.type(screen.getByLabelText("Editor draft"), "retained text");
    await user.click(screen.getByRole("button", { name: "Home" }));
    await user.click(screen.getByRole("button", { name: "Editor" }));

    expect((screen.getByLabelText("Editor draft") as HTMLInputElement).value).toBe("retained text");
  });
});
