import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodesExportPanel } from "../../src/components/codes/CodesExportPanel";

function renderPanel(overrides: Partial<Parameters<typeof CodesExportPanel>[0]> = {}) {
  const props: Parameters<typeof CodesExportPanel>[0] = {
    products: ["xlsx"],
    docxMode: "separate",
    includeLocalPaths: false,
    includeAiAudit: false,
    bundlePath: "",
    artifacts: [],
    warnings: [],
    statusLabel: "",
    errorLabel: null,
    busy: false,
    canEditProject: true,
    onToggleProduct: vi.fn(),
    onDocxModeChange: vi.fn(),
    onIncludeLocalPathsChange: vi.fn(),
    onIncludeAiAuditChange: vi.fn(),
    onOpenOutputFolder: vi.fn(),
    onExportProject: vi.fn(),
    ...overrides
  };
  render(<CodesExportPanel {...props} />);
  return props;
}

describe("CodesExportPanel", () => {
  it("explains every export product and defaults to a selected workbook", () => {
    renderPanel();

    expect(screen.getByRole("checkbox", { name: /Analysis Workbook/ })).toBeChecked();
    expect(screen.getByText("Coded Transcript Report")).toBeInTheDocument();
    expect(screen.getByText("Structured CSV Data")).toBeInTheDocument();
    expect(screen.getByText("Structured JSON")).toBeInTheDocument();
    expect(screen.getByText("QDA Exchange Project")).toBeInTheDocument();
    expect(screen.getAllByText("Includes:")).toHaveLength(5);
  });

  it("shows DOCX grouping and privacy settings only when relevant", async () => {
    const user = userEvent.setup();
    const props = renderPanel({ products: ["xlsx", "docx"] });

    expect(screen.getByRole("radio", { name: "Separate Transcripts" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Combined Document" }));
    expect(props.onDocxModeChange).toHaveBeenCalledWith("combined");

    await user.click(screen.getByText("Advanced Export Settings"));
    await user.click(screen.getByRole("checkbox", { name: /Include AI Audit/ }));
    expect(props.onIncludeAiAuditChange).toHaveBeenCalledWith(true);
  });

  it("requires a product and reports contained bundle files", () => {
    const { rerender } = render(
      <CodesExportPanel
        products={[]}
        docxMode="separate"
        includeLocalPaths={false}
        includeAiAudit={false}
        bundlePath=""
        artifacts={[]}
        warnings={[]}
        statusLabel=""
        errorLabel={null}
        busy={false}
        canEditProject
        onToggleProduct={vi.fn()}
        onDocxModeChange={vi.fn()}
        onIncludeLocalPathsChange={vi.fn()}
        onIncludeAiAuditChange={vi.fn()}
        onOpenOutputFolder={vi.fn()}
        onExportProject={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Export Bundle…" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one export product");

    rerender(
      <CodesExportPanel
        products={["xlsx"]}
        docxMode="separate"
        includeLocalPaths={false}
        includeAiAudit={false}
        bundlePath="D:/exports/study_export.zip"
        artifacts={[{ product: "xlsx", role: "analysis_workbook", archive_path: "analysis_workbook.xlsx", size: 2048 }]}
        warnings={[]}
        statusLabel="Bundle created."
        errorLabel={null}
        busy={false}
        canEditProject
        onToggleProduct={vi.fn()}
        onDocxModeChange={vi.fn()}
        onIncludeLocalPathsChange={vi.fn()}
        onIncludeAiAuditChange={vi.fn()}
        onOpenOutputFolder={vi.fn()}
        onExportProject={vi.fn()}
      />
    );
    const results = screen.getByText("Created Export Bundle").closest("div")?.parentElement;
    expect(results).not.toBeNull();
    expect(within(results as HTMLElement).getByText("D:/exports/study_export.zip")).toBeInTheDocument();
  });
});
