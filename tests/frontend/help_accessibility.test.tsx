import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FieldLabelWithHelp } from "../../src/components/FieldLabelWithHelp";
import { HelpPage } from "../../src/components/HelpPage";
import packageManifest from "../../package.json";
import { appName, appSubtitle } from "../../src/lib/appMetadata";

describe("Help and field-help accessibility", () => {
  it("implements Help chapters as roving tabs with associated panels", async () => {
    const user = userEvent.setup();
    render(<HelpPage />);

    const about = screen.getByRole("tab", { name: "About" });
    const workflow = screen.getByRole("tab", { name: "How It Works" });
    expect(about).toHaveAttribute("tabindex", "0");
    expect(workflow).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", about.id);
    expect(about).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);

    about.focus();
    await user.keyboard("{ArrowRight}");
    expect(workflow).toHaveFocus();
    expect(workflow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", workflow.id);

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Troubleshooting" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(about).toHaveFocus();
  });

  it("shows the authoritative package version in Help", () => {
    render(<HelpPage />);
    expect(screen.getByRole("heading", { name: `About ${appName}` })).toBeInTheDocument();
    expect(screen.getByText(appSubtitle)).toBeInTheDocument();
    expect(screen.getByText(packageManifest.version)).toBeInTheDocument();
  });

  it("uses durable product and toolchain wording", async () => {
    const user = userEvent.setup();
    render(<HelpPage />);

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Tauri 2")).toBeInTheDocument();
    expect(within(panel).getByText("React 19")).toBeInTheDocument();
    expect(within(panel).getByText("TypeScript")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Transcript Analysis" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Transcript Research Studio");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("AI Transcription Studio");
  });

  it("documents evidence persistence and QDPX boundaries truthfully", async () => {
    const user = userEvent.setup();
    render(<HelpPage />);

    await user.click(screen.getByRole("tab", { name: "Codes" }));
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent(/Accepting an AI evidence suggestion immediately saves that exact passage/u);
    expect(panel).toHaveTextContent(/Dismissing a suggestion saves a rejection decision/u);
    expect(panel).toHaveTextContent(/suggestion remains available for retry/u);
    expect(panel).toHaveTextContent(/not a native MAXQDA or ATLAS\.ti project/u);
    expect(panel).toHaveTextContent(/does not import or round-trip QDPX/u);
  });

  it("uses independent button help triggers with stable focus, Escape, and unique tooltip IDs", async () => {
    const user = userEvent.setup();
    render(
      <>
        <FieldLabelWithHelp label="Research Focus" helpText="Explain the analytical focus." htmlFor="research-focus" />
        <input id="research-focus" />
        <FieldLabelWithHelp label="Model" helpText="Choose a local model." />
      </>
    );

    expect(screen.getByLabelText("Research Focus")).toHaveAttribute("id", "research-focus");
    const focusHelp = screen.getByRole("button", { name: "Help: Research Focus" });
    const modelHelp = screen.getByRole("button", { name: "Help: Model" });
    expect(focusHelp.closest("label")).toBeNull();
    expect(focusHelp.getAttribute("aria-describedby")).not.toBe(modelHelp.getAttribute("aria-describedby"));

    focusHelp.focus();
    expect(focusHelp).toHaveFocus();
    const tooltip = screen.getByRole("tooltip", { name: "Explain the analytical focus." });
    await waitFor(() => expect(tooltip).toHaveClass("visible"));
    await user.keyboard("{Escape}");
    expect(focusHelp).toHaveFocus();
    expect(tooltip).not.toHaveClass("visible");
  });
});
