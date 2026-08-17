import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LanguageCombobox } from "../../src/components/transcription/LanguageCombobox";
import type { TranscriptionLanguageOption } from "../../src/lib/api";

const options: TranscriptionLanguageOption[] = [
  { value: "auto", label: "Auto-Detect" },
  { value: "yue", label: "Cantonese", supported_models: ["large-v3", "large-v3-turbo"], description: "Large V3 models only" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" }
];

function Harness({ modelName = "small" }: { modelName?: string }) {
  const [language, setLanguage] = useState("auto");
  return (
    <div>
      <label htmlFor="test-language">Language</label>
      <LanguageCombobox
        id="test-language"
        value={language}
        options={options}
        modelName={modelName}
        onChange={setLanguage}
      />
    </div>
  );
}

describe("LanguageCombobox", () => {
  it("keeps Auto-Detect selected and filters by language name", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Language" });
    expect(trigger).toHaveTextContent("Auto-Detect");

    await user.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search languages" });
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Auto-Detect");

    await user.type(search, "german");
    expect(screen.getByRole("option", { name: /German/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Japanese/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /German/ }));

    expect(trigger).toHaveTextContent("German");
    expect(screen.queryByRole("combobox", { name: "Search languages" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("prioritizes an exact language code and supports keyboard selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Language" }));
    const search = screen.getByRole("combobox", { name: "Search languages" });
    await user.type(search, "de");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Language" })).toHaveTextContent("German");
  });

  it("keeps Cantonese visible but unavailable outside the Large V3 family", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness modelName="small" />);

    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.type(screen.getByRole("combobox", { name: "Search languages" }), "cantonese");
    expect(screen.getByRole("option", { name: /Cantonese/ })).toBeDisabled();
    expect(screen.getByText("Cantonese")).toBeVisible();
    expect(screen.getByText("yue")).toBeVisible();
    expect(screen.getByRole("option", { name: /Cantonese/ })).toHaveTextContent("Large V3 models only");

    rerender(<Harness modelName="large-v3" />);
    expect(screen.getByRole("option", { name: /Cantonese/ })).toBeEnabled();
  });

  it("does not open while configuration is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <label htmlFor="disabled-language">Language</label>
        <LanguageCombobox
          id="disabled-language"
          value="auto"
          options={options}
          modelName="small"
          disabled
          onChange={onChange}
        />
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Language" });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("combobox", { name: "Search languages" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
