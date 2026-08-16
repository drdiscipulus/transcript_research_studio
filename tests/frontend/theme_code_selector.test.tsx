import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodesCode } from "../../src/lib/api";
import { ThemeCodeSelector } from "../../src/components/codes/ThemeCodeSelector";

const codes: CodesCode[] = [
  { code_id: "C000001", name: "Customer Discovery", description: "Learning directly from customers", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#0f766e", memo: "", created_at: "", updated_at: "" },
  { code_id: "C000002", name: "Market Entry", description: "Entering a new market", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#1d4ed8", memo: "", created_at: "", updated_at: "" },
  { code_id: "C000003", name: "Resource Constraints", description: "Limits on available resources", inclusion_note: "", exclusion_note: "", example_evidence_ids: [], color: "#a21caf", memo: "", created_at: "", updated_at: "" }
];

function SelectorHarness({ initialIds = ["C000001"], resetKey = "theme-1", onChange = vi.fn() }: { initialIds?: string[]; resetKey?: string; onChange?: (ids: string[]) => void }) {
  const [selectedIds, setSelectedIds] = useState(initialIds);
  return (
    <ThemeCodeSelector
      codes={codes}
      selectedCodeIds={selectedIds}
      resetKey={resetKey}
      onToggle={(codeId) => setSelectedIds((current) => {
        const next = current.includes(codeId) ? current.filter((id) => id !== codeId) : [...current, codeId];
        onChange(next);
        return next;
      })}
    />
  );
}

describe("ThemeCodeSelector", () => {
  it("separates assigned chips from searchable unassigned codes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelectorHarness onChange={onChange} />);

    expect(screen.getByText("Codes (1)")).toBeInTheDocument();
    const assigned = screen.getByLabelText("Assigned Theme Codes");
    expect(within(assigned).getByText("Customer Discovery")).toBeInTheDocument();
    expect(within(assigned).queryByText("Market Entry")).not.toBeInTheDocument();

    const search = screen.getByRole("combobox", { name: "Assign Codes" });
    await user.type(search, "market");
    expect(screen.getByRole("option", { name: /Market Entry/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Customer Discovery/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Market Entry/ }));

    expect(screen.getByText("Codes (2)")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Assigned Theme Codes")).getByText("Market Entry")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(["C000001", "C000002"]);

    await user.click(screen.getByRole("button", { name: "Remove Customer Discovery from theme" }));
    expect(screen.getByText("Codes (1)")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(["C000002"]);
  });

  it("keeps Browse All collapsed and synchronizes its checkboxes", async () => {
    const user = userEvent.setup();
    render(<SelectorHarness />);

    const browser = screen.getByText("Browse All Codes").closest("details");
    expect(browser).not.toHaveAttribute("open");
    await user.click(screen.getByText("Browse All Codes"));
    expect(browser).toHaveAttribute("open");

    expect(screen.getByRole("checkbox", { name: "Customer Discovery" })).toBeChecked();
    const resourceCode = screen.getByRole("checkbox", { name: "Resource Constraints" });
    expect(resourceCode).not.toBeChecked();
    await user.click(resourceCode);
    expect(resourceCode).toBeChecked();
    expect(screen.getByText("Codes (2)")).toBeInTheDocument();
  });

  it("supports keyboard assignment and clear empty states", async () => {
    const user = userEvent.setup();
    render(<SelectorHarness initialIds={[]} />);

    expect(screen.getByText("No Codes Assigned")).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Assign Codes" });
    await user.click(search);
    await user.keyboard("{Enter}");
    expect(screen.getByText("Codes (1)")).toBeInTheDocument();

    await user.type(search, "does not exist");
    expect(screen.getByText("No Matching Codes")).toBeInTheDocument();
  });
});
