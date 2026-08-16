import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";

import { PromptingPage } from "../../src/components/PromptingPage";
import {
  WorkbenchLifecycleProvider,
  useWorkbenchLifecycle
} from "../../src/components/workbench/WorkbenchLifecycle";

const apiMocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  createCustom: vi.fn(),
  deleteCustom: vi.fn(),
  duplicateCustom: vi.fn(),
  fetchCustom: vi.fn(),
  fetchModels: vi.fn(),
  fetchRun: vi.fn(),
  inspectInput: vi.fn(),
  openPath: vi.fn(),
  pickFolder: vi.fn(),
  pickFile: vi.fn(),
  startRun: vi.fn(),
  updateCustom: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    cancelPromptRun: apiMocks.cancelRun,
    createPromptCustomAnalysis: apiMocks.createCustom,
    deletePromptCustomAnalysis: apiMocks.deleteCustom,
    duplicatePromptCustomAnalysis: apiMocks.duplicateCustom,
    fetchCurrentPromptRun: apiMocks.fetchRun,
    fetchPromptCustomAnalyses: apiMocks.fetchCustom,
    fetchPromptingModels: apiMocks.fetchModels,
    inspectPromptInput: apiMocks.inspectInput,
    openPath: apiMocks.openPath,
    pickFolder: apiMocks.pickFolder,
    pickTranscriptFile: apiMocks.pickFile,
    startPromptRun: apiMocks.startRun,
    updatePromptCustomAnalysis: apiMocks.updateCustom
  };
});

const provider = {
  id: "lmstudio",
  name: "LM Studio",
  installed: true,
  running: true,
  available: true,
  requires_auth: false,
  base_url: "http://127.0.0.1:1234",
  message: "",
  model_count: 1
};

const idleRun = {
  run_id: null,
  status: "idle",
  message: "Idle",
  progress_percent: 0,
  started_at: null,
  finished_at: null,
  provider_id: null,
  model_id: null,
  log_file: null,
  counts: {}
};

const preview = {
  input_mode: "file",
  input_path: "D:\\research\\interview.json",
  file_count: 1,
  files: [{ path: "D:\\research\\interview.json", file_name: "interview.json", format: "json", requires_mapping: false }],
  mapping: {},
  mapping_required: false,
  candidate_count: 1,
  counts: { ready: 1, decisions_required: 0, mapping_required: 0, problems: 0 },
  candidates: [{
    candidate_id: "candidate_1",
    source_path: "D:\\research\\interview.json",
    file_name: "interview.json",
    format: "json",
    document_id: "doc_1",
    document_index: 0,
    title: "Founder interview",
    segment_count: 4,
    content_fingerprint: "fingerprint",
    status: "ready" as const,
    reason: "Ready to analyze.",
    recommended: true,
    equivalent_group: null,
    mapping_columns: [],
    mapping: {}
  }],
  problems: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPage(
  outputFolder = "D:\\analysis",
  overrides: Partial<ComponentProps<typeof PromptingPage>> = {}
) {
  const props: ComponentProps<typeof PromptingPage> = {
    providers: [provider],
    providersLoading: false,
    providerError: null,
    onRefreshProviders: vi.fn(),
    promptOutputFolder: outputFolder,
    suggestedSourceFile: null,
    browseHomeFolder: "D:\\research",
    onPromptOutputFolderChange: vi.fn(),
    ...overrides
  };
  return render(
    <WorkbenchLifecycleProvider>
      <PromptingPage {...props} />
    </WorkbenchLifecycleProvider>
  );
}

function PromptingActivationFixture(props: ComponentProps<typeof PromptingPage>) {
  const { navigateTo } = useWorkbenchLifecycle();
  const [parentRender, setParentRender] = useState(0);
  return (
    <>
      <button type="button" onClick={() => navigateTo("home")}>Open Home</button>
      <button type="button" onClick={() => navigateTo("prompting")}>Open Transcript Analysis</button>
      <button type="button" onClick={() => setParentRender((current) => current + 1)}>Rerender Parent ({parentRender})</button>
      <PromptingPage {...props} />
    </>
  );
}

describe("Transcript Analysis page", () => {
  beforeEach(() => {
    apiMocks.cancelRun.mockReset().mockResolvedValue(idleRun);
    apiMocks.createCustom.mockReset();
    apiMocks.deleteCustom.mockReset();
    apiMocks.duplicateCustom.mockReset();
    apiMocks.fetchCustom.mockReset().mockResolvedValue({ analyses: [] });
    apiMocks.fetchModels.mockReset().mockResolvedValue({
      provider_id: provider.id,
      provider_name: provider.name,
      models: [{ id: "qwen", display_name: "Qwen", details: "Local model", context_length: 8192, is_loaded: true }]
    });
    apiMocks.fetchRun.mockReset().mockResolvedValue(idleRun);
    apiMocks.inspectInput.mockReset().mockResolvedValue(preview);
    apiMocks.openPath.mockReset().mockResolvedValue({});
    apiMocks.pickFolder.mockReset().mockResolvedValue(null);
    apiMocks.pickFile.mockReset().mockResolvedValue("D:\\research\\interview.json");
    apiMocks.startRun.mockReset().mockResolvedValue({ ...idleRun, run_id: "run_1", status: "starting", message: "Starting" });
    apiMocks.updateCustom.mockReset();
  });

  it("presents the new ordered workflow without legacy Quote Finder controls", async () => {
    const { container } = renderPage();

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Transcript Analysis", "Inputs and Outputs", "Local LLM Settings", "Analysis", "Run Analysis"]));
    expect(screen.queryByText("Quote Finder")).not.toBeInTheDocument();
    expect(screen.queryByText("Result Label")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /XLSX/i })).toBeChecked();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Interview Review" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Analysis" })).toBeInTheDocument();
    expect(container.querySelector(".analysis-description")).not.toBeInTheDocument();
  });

  it("uses a dynamic help tooltip and the shared prompt accordion", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();

    const help = screen.getByLabelText("Help: Analysis");
    await user.hover(help);
    const tooltipId = help.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId!)).toHaveTextContent("Create a concise orientation");
    expect(document.getElementById(tooltipId!)).toHaveClass("visible");

    const customize = screen.getByRole("button", { name: /Customize Prompt/i });
    expect(customize).toHaveAttribute("aria-expanded", "false");
    await user.click(customize);
    expect(customize).toHaveAttribute("aria-expanded", "true");

    const instructions = container.querySelector<HTMLTextAreaElement>(".analysis-prompt-input");
    expect(instructions).not.toBeNull();
    await user.clear(instructions!);
    await user.type(instructions!, "Focus on decision points.");
    expect(screen.getByText("Customized")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore Built-in Prompt" }));
    expect(screen.queryByText("Customized")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Analysis" }), "research_focus");
    expect(container.querySelector(".analysis-focus-input")).toBeRequired();
    expect(screen.getByRole("button", { name: /Customize Prompt/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("consolidates custom-analysis commands in a dismissible Actions popover", async () => {
    const user = userEvent.setup();
    const custom = { id: "custom_1", name: "Narrative Tensions", instructions: "Analyze narrative tensions.", output_key: "narrative_tensions" };
    apiMocks.fetchCustom.mockResolvedValue({ analyses: [custom] });
    apiMocks.duplicateCustom.mockResolvedValue({ analyses: [custom], analysis: custom });
    renderPage();

    const selector = screen.getByRole("combobox", { name: "Analysis" });
    await screen.findByRole("option", { name: "Narrative Tensions" });
    await user.selectOptions(selector, "custom_1");

    const actions = screen.getByRole("button", { name: "Actions" });
    expect(actions).toHaveAttribute("aria-expanded", "false");
    await user.click(actions);
    const menu = screen.getByRole("group", { name: "Custom analysis actions" });
    expect(within(menu).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Delete" })).toHaveClass("danger-button");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Custom analysis actions" })).not.toBeInTheDocument();
    expect(actions).toHaveFocus();

    await user.click(actions);
    await user.click(within(screen.getByRole("group", { name: "Custom analysis actions" })).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(apiMocks.duplicateCustom).toHaveBeenCalledWith("custom_1"));
    expect(screen.queryByRole("group", { name: "Custom analysis actions" })).not.toBeInTheDocument();
  });

  it("guards run-only prompt changes with the in-app confirmation", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(screen.getByRole("button", { name: /Customize Prompt/i }));
    const instructions = container.querySelector<HTMLTextAreaElement>(".analysis-prompt-input")!;
    await user.clear(instructions);
    await user.type(instructions, "Focus only on decisions.");

    const selector = screen.getByRole("combobox", { name: "Analysis" });
    await user.selectOptions(selector, "research_focus");
    expect(selector).toHaveValue("overview");
    const confirmation = screen.getByRole("alertdialog", { name: "Discard Prompt Changes?" });
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(selector).toHaveValue("overview");

    await user.selectOptions(selector, "research_focus");
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(selector).toHaveValue("research_focus");
  });

  it("guards dirty custom-analysis drafts and target-bound deletion", async () => {
    const user = userEvent.setup();
    const custom = { id: "custom_1", name: "Narrative Tensions", instructions: "Analyze narrative tensions.", output_key: "narrative_tensions" };
    apiMocks.fetchCustom.mockResolvedValue({ analyses: [custom] });
    apiMocks.deleteCustom.mockResolvedValue({ analyses: [], analysis: null });
    renderPage();

    await user.click(screen.getByRole("button", { name: "New Custom Analysis…" }));
    let customDialog = screen.getByRole("dialog", { name: "New Custom Analysis" });
    await user.type(within(customDialog).getByLabelText("Name"), "Unfinished");
    await user.click(within(customDialog).getByRole("button", { name: "Cancel" }));
    const discardDialog = screen.getByRole("alertdialog", { name: "Discard Custom Analysis Draft?" });
    expect(customDialog).toHaveAttribute("aria-hidden", "true");
    expect(customDialog).toHaveAttribute("inert");
    expect(screen.queryByRole("dialog", { name: "New Custom Analysis" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(discardDialog).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "New Custom Analysis" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "New Custom Analysis" })).getByRole("button", { name: "Cancel" })).toHaveFocus();
    customDialog = screen.getByRole("dialog", { name: "New Custom Analysis" });
    await user.click(within(customDialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard Draft" }));
    expect(screen.queryByRole("dialog", { name: "New Custom Analysis" })).not.toBeInTheDocument();

    const selector = screen.getByRole("combobox", { name: "Analysis" });
    await screen.findByRole("option", { name: "Narrative Tensions" });
    await user.selectOptions(selector, "custom_1");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(within(screen.getByRole("group", { name: "Custom analysis actions" })).getByRole("button", { name: "Delete" }));
    expect(apiMocks.deleteCustom).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete Analysis" }));
    await waitFor(() => expect(apiMocks.deleteCustom).toHaveBeenCalledOnce());
    expect(apiMocks.deleteCustom).toHaveBeenCalledWith("custom_1");
  });

  it("uses automatic output naming and starts one selected analysis with the immutable preview selection", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(apiMocks.inspectInput).toHaveBeenCalled());
    expect(screen.queryByRole("textbox", { name: /^Output Basename/i })).not.toBeInTheDocument();

    const start = screen.getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);

    expect(apiMocks.startRun).toHaveBeenCalledTimes(1);
    expect(apiMocks.startRun).toHaveBeenCalledWith(expect.objectContaining({
      output_naming_mode: "input",
      output_basename: "",
      output_formats: ["xlsx"],
      selected_candidate_ids: ["candidate_1"],
      analysis: expect.objectContaining({ type: "overview", name: "Transcript Overview" })
    }));
  });

  it("exposes provider refresh from Transcript Analysis", async () => {
    const user = userEvent.setup();
    const refreshProviders = vi.fn();
    renderPage("D:\\analysis", { onRefreshProviders: refreshProviders });

    const refreshButton = screen.getByRole("button", { name: "Refresh Providers" });
    expect(refreshButton.parentElement).toHaveClass("prompting-model-refresh-field");
    await user.click(refreshButton);
    expect(refreshProviders).toHaveBeenCalledTimes(1);
  });

  it("refreshes providers once per active page visit", async () => {
    const user = userEvent.setup();
    const refreshProviders = vi.fn();
    const props: ComponentProps<typeof PromptingPage> = {
      providers: [provider],
      providersLoading: false,
      providerError: null,
      onRefreshProviders: refreshProviders,
      promptOutputFolder: "D:\\analysis",
      suggestedSourceFile: null,
      browseHomeFolder: "D:\\research",
      onPromptOutputFolderChange: vi.fn()
    };
    const page = (
      <WorkbenchLifecycleProvider>
        <PromptingActivationFixture {...props} />
      </WorkbenchLifecycleProvider>
    );
    render(page);

    await user.click(screen.getByRole("button", { name: "Open Transcript Analysis" }));
    await waitFor(() => expect(refreshProviders).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Rerender Parent (0)" }));
    expect(screen.getByRole("button", { name: "Rerender Parent (1)" })).toBeInTheDocument();
    expect(refreshProviders).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Open Home" }));
    await user.click(screen.getByRole("button", { name: "Open Transcript Analysis" }));
    await waitFor(() => expect(refreshProviders).toHaveBeenCalledTimes(2));
  });

  it("locks the complete configuration immediately while the start request is pending", async () => {
    const user = userEvent.setup();
    const pendingStart = deferred<typeof idleRun>();
    apiMocks.startRun.mockReturnValue(pendingStart.promise);
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    const start = screen.getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);

    expect(screen.getByRole("button", { name: "File" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh Providers" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /^Provider/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /^Model/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Analysis" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Founder interview/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /CSV/i })).toBeDisabled();

    await act(async () => {
      pendingStart.resolve({ ...idleRun, run_id: "run_1", status: "running", message: "Running" });
      await pendingStart.promise;
    });
    expect(screen.getByRole("combobox", { name: /^Provider/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("preserves the active snapshot through a polling failure and clears reconnecting after recovery", async () => {
    const user = userEvent.setup();
    apiMocks.fetchRun
      .mockResolvedValueOnce(idleRun)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...idleRun,
        run_id: "run_1",
        status: "completed",
        message: "Analysis completed.",
        counts: { done: 1, failed: 0, excluded: 0 }
      });
    apiMocks.startRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "running",
      message: "Analyzing transcript.",
      counts: { done: 0, failed: 0, excluded: 0 }
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Connection to the local service was interrupted. Reconnecting…", {}, { timeout: 2500 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await waitFor(
      () => expect(screen.getByText("Analysis completed.")).toBeInTheDocument(),
      { timeout: 4500 }
    );
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  }, 8000);

  it("keeps a cancelling backend run disabled after the cancellation request completes", async () => {
    const user = userEvent.setup();
    apiMocks.fetchRun
      .mockResolvedValueOnce(idleRun)
      .mockResolvedValueOnce({
        ...idleRun,
        run_id: "run_1",
        status: "running",
        message: "Stale running snapshot."
      })
      .mockResolvedValueOnce({
        ...idleRun,
        run_id: "run_1",
        status: "cancelled",
        message: "Analysis cancelled."
      });
    apiMocks.startRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "running",
      message: "Analyzing transcript."
    });
    apiMocks.cancelRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "cancelling",
      message: "Cancellation requested."
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    const cancellingButton = await screen.findByRole("button", { name: "Cancelling…" });
    expect(cancellingButton).toBeDisabled();
    expect(screen.getByText("Cancellation requested.")).toBeInTheDocument();
    await waitFor(
      () => expect(screen.getByText("Analysis cancelled.")).toBeInTheDocument(),
      { timeout: 3500 }
    );
    expect(screen.queryByText("Stale running snapshot.")).not.toBeInTheDocument();
  }, 5000);

  it("allows a failed cancellation to be retried and clears the old error after success", async () => {
    const user = userEvent.setup();
    apiMocks.fetchRun
      .mockResolvedValueOnce(idleRun)
      .mockReturnValue(new Promise(() => undefined));
    apiMocks.startRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "running",
      message: "Analyzing transcript."
    });
    apiMocks.cancelRun
      .mockRejectedValueOnce(new Error("Cancellation service unavailable."))
      .mockResolvedValueOnce({
        ...idleRun,
        run_id: "run_1",
        status: "cancelling",
        message: "Cancellation requested."
      });
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Cancellation service unavailable.")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Cancel" });
    expect(retry).toBeEnabled();
    await user.click(retry);

    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.queryByText("Cancellation service unavailable.")).not.toBeInTheDocument();
  });

  it("does not let an in-flight stale poll replace the cancellation result", async () => {
    const user = userEvent.setup();
    const stalePoll = deferred<typeof idleRun>();
    apiMocks.fetchRun
      .mockResolvedValueOnce(idleRun)
      .mockReturnValueOnce(stalePoll.promise);
    apiMocks.startRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "running",
      message: "Analyzing transcript."
    });
    apiMocks.cancelRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "cancelled",
      message: "Analysis cancelled."
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiMocks.fetchRun).toHaveBeenCalledTimes(2), { timeout: 2500 });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Analysis cancelled.")).toBeInTheDocument();

    await act(async () => {
      stalePoll.resolve({
        ...idleRun,
        run_id: "run_1",
        status: "running",
        message: "Stale running snapshot."
      });
      await stalePoll.promise;
    });
    expect(screen.getByText("Analysis cancelled.")).toBeInTheDocument();
    expect(screen.queryByText("Stale running snapshot.")).not.toBeInTheDocument();
  }, 5000);

  it("rejects a cancellation response for a different run", async () => {
    const user = userEvent.setup();
    apiMocks.fetchRun
      .mockResolvedValueOnce(idleRun)
      .mockReturnValue(new Promise(() => undefined));
    apiMocks.startRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_1",
      status: "running",
      message: "Analyzing transcript."
    });
    apiMocks.cancelRun.mockResolvedValue({
      ...idleRun,
      run_id: "run_2",
      status: "cancelled",
      message: "Wrong run cancelled."
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    expect(screen.getByText("Analyzing transcript.")).toBeInTheDocument();
    expect(screen.queryByText("Wrong run cancelled.")).not.toBeInTheDocument();
  });

  it("does not reapply the same suggested source after Clear or New Run", async () => {
    const user = userEvent.setup();
    const completed = {
      ...idleRun,
      run_id: "previous_run",
      status: "completed",
      message: "Analysis completed.",
      counts: { done: 1, failed: 0, excluded: 0 }
    };
    apiMocks.fetchRun.mockResolvedValue(completed);
    renderPage("D:\\analysis", { suggestedSourceFile: "D:\\research\\interview.json" });

    const input = screen.getByRole("textbox", { name: "Transcript Input" });
    await waitFor(() => expect(input).toHaveValue("D:\\research\\interview.json"));
    await user.click(screen.getAllByRole("button", { name: "Clear" })[0]);
    expect(input).toHaveValue("");
    await act(async () => Promise.resolve());
    expect(input).toHaveValue("");

    await waitFor(() => expect(screen.getByRole("button", { name: "New Run" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "New Run" }));
    expect(input).toHaveValue("");
    await act(async () => Promise.resolve());
    expect(input).toHaveValue("");
  });

  it("creates a reusable custom analysis from the guarded dialog", async () => {
    const user = userEvent.setup();
    apiMocks.createCustom.mockResolvedValue({
      analyses: [{ id: "custom_1", name: "Narrative Tensions", instructions: "Analyze narrative tensions.", output_key: "narrative_tensions" }],
      analysis: { id: "custom_1", name: "Narrative Tensions", instructions: "Analyze narrative tensions.", output_key: "narrative_tensions" }
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "New Custom Analysis…" }));
    const dialog = screen.getByRole("dialog", { name: "New Custom Analysis" });
    await user.type(within(dialog).getByLabelText("Name"), "Narrative Tensions");
    await user.type(within(dialog).getByLabelText("Instructions"), "Analyze narrative tensions.");
    await user.click(within(dialog).getByRole("button", { name: "Create Analysis" }));

    await waitFor(() => expect(apiMocks.createCustom).toHaveBeenCalledWith({
      name: "Narrative Tensions",
      instructions: "Analyze narrative tensions."
    }));
    expect(await screen.findByRole("option", { name: "Narrative Tensions" })).toBeInTheDocument();
  });
});
