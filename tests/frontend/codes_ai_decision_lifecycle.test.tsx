import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCodesAiDecisionLifecycle,
  type CodesAiBulkRejectionResult,
  type CodesAiSuggestionRejection
} from "../../src/hooks/useCodesAiDecisionLifecycle";
import {
  ApiError,
  CodesProjectConflictError,
  type CodesAiDecisionPayload,
  type CodesAiEvidenceSuggestion,
  type CodesEvidencePayload,
  type CodesProject,
  type CodesProjectHandle
} from "../../src/lib/api";
import type {
  CodesProjectSessionSnapshot,
  PersistedProjectSettings
} from "../../src/hooks/useCodesProjectSession";

const apiMocks = vi.hoisted(() => ({
  createEvidence: vi.fn(),
  recordDecision: vi.fn()
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    createCodesEvidenceItem: apiMocks.createEvidence,
    recordCodesContextualAiDecision: apiMocks.recordDecision
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeProject(projectId = "project_a"): CodesProject {
  return {
    schema_version: "1.1",
    project_id: projectId,
    name: "Study",
    created_at: "2026-08-05T10:00:00Z",
    updated_at: "2026-08-05T10:00:00Z",
    research_focus: "",
    ai_settings: {
      provider_id: "lmstudio",
      model_id: "local-model",
      temperature: 0,
      timeout_seconds: 180,
      suggestion_language: "auto"
    },
    transcripts: [],
    evidence_items: [],
    codes: [],
    themes: [],
    report_drafts: [],
    suggestion_decisions: [],
    settings: {
      case_definition: "transcript",
      theme_assignment: "multiple",
      memo_format: "plain_text",
      transcript_folder_import: "non_recursive",
      ai_audit: "decisions_only"
    },
    id_counters: {}
  };
}

function makeHandle(projectId = "project_a", revision = "a", projectFile = `D:\\research\\${projectId}.evidence.json`): CodesProjectHandle {
  return {
    project_file: projectFile,
    project_id: projectId,
    revision: revision.repeat(64)
  };
}

function persisted(project = makeProject(), handle = makeHandle()): PersistedProjectSettings {
  return { project, handle };
}

function session(payload: PersistedProjectSettings | null = persisted()): CodesProjectSessionSnapshot {
  return {
    project: payload?.project ?? null,
    projectFile: payload?.handle.project_file ?? null,
    projectHandle: payload?.handle ?? null,
    projectConflict: null,
    settingsDirty: false
  };
}

function makeSuggestion(id = "suggestion_1"): CodesAiEvidenceSuggestion {
  return {
    suggestion_id: id,
    run_id: "run_evidence",
    kind: "evidence",
    transcript_id: "T000001",
    segment_ids: ["S000001"],
    segment_ranges: {
      S000001: { start_offset: 2, end_offset: 11, excerpt: "quotation" }
    },
    selected_text: "quotation",
    speaker: "SPEAKER_00",
    start: 1,
    end: 2,
    rationale: "Relevant"
  };
}

function evidencePayload(
  revision = "b",
  project = makeProject(),
  handle = makeHandle(project.project_id, revision)
): CodesEvidencePayload {
  return {
    ...handle,
    project,
    handle,
    evidence: {
      evidence_id: "E000001",
      transcript_id: "T000001",
      source_file: "transcript.json",
      source_document_id: "document",
      segment_ids: ["S000001"],
      speaker: "SPEAKER_00",
      start: 1,
      end: 2,
      selected_text: "quotation",
      segment_ranges: {
        S000001: { start_offset: 2, end_offset: 11, excerpt: "quotation" }
      },
      code_ids: [],
      memo: "",
      created_at: "2026-08-05T10:01:00Z",
      updated_at: "2026-08-05T10:01:00Z"
    }
  };
}

function decisionPayload(
  revision = "b",
  project = makeProject(),
  handle = makeHandle(project.project_id, revision),
  suggestionId = "suggestion_1"
): CodesAiDecisionPayload {
  return {
    ...handle,
    project,
    handle,
    decision: {
      decision_id: `decision_${suggestionId}`,
      suggestion_id: suggestionId,
      task: "evidence",
      decision: "rejected",
      result_ids: [],
      note: "",
      provider_id: "lmstudio",
      model_id: "local-model",
      created_at: "2026-08-05T10:01:00Z"
    }
  };
}

function renderDecisionLifecycle(initialSession = session(), strictMode = false) {
  let currentSession = initialSession;
  let externallyLocked = false;
  const persistProjectSettings = vi.fn(async () => {
    if (!currentSession.project || !currentSession.projectHandle) return null;
    return { project: currentSession.project, handle: currentSession.projectHandle };
  });
  const applyPersistedProject = vi.fn((payload: PersistedProjectSettings) => {
    currentSession = session(payload);
    return true;
  });
  const onEvidenceAccepted = vi.fn();
  const onSuggestionRejected = vi.fn();
  const onProjectConflict = vi.fn();
  const hook = renderHook(() => useCodesAiDecisionLifecycle({
    getCurrentSession: () => currentSession,
    persistProjectSettings,
    applyPersistedProject,
    isExternallyLocked: () => externallyLocked || Boolean(currentSession.projectConflict),
    onProjectConflict,
    onEvidenceAccepted,
    onSuggestionRejected
  }), strictMode ? {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
  } : undefined);
  return {
    ...hook,
    persistProjectSettings,
    applyPersistedProject,
    onEvidenceAccepted,
    onSuggestionRejected,
    onProjectConflict,
    replaceSession(next: CodesProjectSessionSnapshot) {
      currentSession = next;
      hook.rerender();
    },
    setPersistedSession(payload: PersistedProjectSettings) {
      currentSession = session(payload);
    },
    setExternallyLocked(value: boolean) {
      externallyLocked = value;
    }
  };
}

function projectConflict(message = "The coding project changed on disk.") {
  return new CodesProjectConflictError(new ApiError({
    message,
    kind: "http",
    status: 409,
    errorCode: "project_conflict",
    retryable: true
  }), "z".repeat(64));
}

const rejection = (suggestionId = "suggestion_1"): CodesAiSuggestionRejection => ({
  task: "evidence",
  suggestionId,
  runId: "run_evidence"
});

describe("useCodesAiDecisionLifecycle", () => {
  beforeEach(() => {
    apiMocks.createEvidence.mockReset().mockResolvedValue(evidencePayload());
    apiMocks.recordDecision.mockReset().mockResolvedValue(decisionPayload());
  });

  it("remains operational after Strict Mode replays its mount effect", async () => {
    const hook = renderDecisionLifecycle(session(), true);
    await act(async () => {
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(true);
    });
    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(1);
    expect(hook.onSuggestionRejected).toHaveBeenCalledWith(rejection());
  });

  it("acquires its lock before settings persistence and refuses concurrent work", async () => {
    const pending = deferred<PersistedProjectSettings | null>();
    const hook = renderDecisionLifecycle();
    hook.persistProjectSettings.mockReturnValueOnce(pending.promise);
    let first!: Promise<boolean>;
    act(() => { first = hook.result.current.rejectSuggestion(rejection()); });
    expect(hook.result.current.isLocked()).toBe(true);
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.activeAction).toEqual(expect.objectContaining({ kind: "reject", suggestionId: "suggestion_1" }));
    await expect(hook.result.current.acceptEvidenceSuggestion(makeSuggestion("suggestion_2"))).resolves.toBe(false);
    expect(hook.persistProjectSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(persisted());
      await first;
    });
    expect(hook.result.current.isLocked()).toBe(false);
  });

  it("refuses every decision operation while an external workflow owns the project", async () => {
    const hook = renderDecisionLifecycle();
    hook.setExternallyLocked(true);
    await act(async () => {
      await expect(hook.result.current.acceptEvidenceSuggestion(makeSuggestion())).resolves.toBe(false);
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(false);
      await expect(hook.result.current.rejectEvidenceSuggestions([makeSuggestion()])).resolves.toEqual({
        rejectedSuggestionIds: [],
        failedSuggestionId: null
      });
    });
    expect(hook.persistProjectSettings).not.toHaveBeenCalled();
    expect(apiMocks.createEvidence).not.toHaveBeenCalled();
    expect(apiMocks.recordDecision).not.toHaveBeenCalled();
    expect(hook.result.current.isLocked()).toBe(false);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.activeAction).toBeNull();
  });

  it("refuses a decision while the active project has an unresolved conflict", async () => {
    const conflictedSession = session();
    conflictedSession.projectConflict = projectConflict();
    const hook = renderDecisionLifecycle(conflictedSession);
    await act(async () => {
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(false);
    });
    expect(hook.persistProjectSettings).not.toHaveBeenCalled();
    expect(apiMocks.recordDecision).not.toHaveBeenCalled();
    expect(hook.result.current.activeAction).toBeNull();
  });

  it("persists settings before submitting an immediate decision", async () => {
    const order: string[] = [];
    const hook = renderDecisionLifecycle();
    const authoritativeProject = makeProject();
    hook.persistProjectSettings.mockImplementationOnce(async () => {
      order.push("settings");
      return persisted(authoritativeProject);
    });
    apiMocks.recordDecision.mockImplementationOnce(async () => {
      order.push("decision");
      return decisionPayload();
    });
    await act(async () => { await hook.result.current.rejectSuggestion(rejection()); });
    expect(order).toEqual(["settings", "decision"]);
    expect(apiMocks.recordDecision.mock.calls[0][0].project).toBe(authoritativeProject);
  });

  it("does not mutate after a current settings failure and reports a retryable decision error", async () => {
    const hook = renderDecisionLifecycle();
    hook.persistProjectSettings.mockResolvedValueOnce(null);
    await act(async () => { await hook.result.current.rejectSuggestion(rejection()); });
    expect(apiMocks.recordDecision).not.toHaveBeenCalled();
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errorFor("evidence", "suggestion_1")?.message).toBe("The dismissal could not be saved.");
    expect(hook.result.current.busy).toBe(false);
  });

  it("silences stale settings completion after project replacement", async () => {
    const pending = deferred<PersistedProjectSettings | null>();
    const hook = renderDecisionLifecycle();
    hook.persistProjectSettings.mockReturnValueOnce(pending.promise);
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    act(() => hook.replaceSession(session(persisted(makeProject("project_b"), makeHandle("project_b")))));
    await act(async () => {
      pending.resolve(persisted());
      await expect(operation).resolves.toBe(false);
    });
    expect(apiMocks.recordDecision).not.toHaveBeenCalled();
    expect(hook.result.current.errors).toEqual({});
    expect(hook.result.current.busy).toBe(false);
  });

  it("captures an immutable evidence-acceptance payload before asynchronous preflight", async () => {
    const pending = deferred<PersistedProjectSettings | null>();
    const hook = renderDecisionLifecycle();
    hook.persistProjectSettings.mockReturnValueOnce(pending.promise);
    const suggestion = makeSuggestion();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.acceptEvidenceSuggestion(suggestion); });
    suggestion.segment_ids.push("S000002");
    suggestion.segment_ranges.S000001.excerpt = "changed";
    suggestion.selected_text = "changed";
    await act(async () => {
      pending.resolve(persisted());
      await operation;
    });
    expect(apiMocks.createEvidence).toHaveBeenCalledWith(expect.objectContaining({
      segment_ids: ["S000001"],
      segment_ranges: { S000001: { start_offset: 2, end_offset: 11, excerpt: "quotation" } },
      selected_text: "quotation",
      code_ids: [],
      new_codes: [],
      memo: ""
    }));
  });

  it("applies a successful evidence acceptance before notifying the page", async () => {
    const hook = renderDecisionLifecycle();
    hook.onEvidenceAccepted.mockImplementation(() => {
      expect(hook.result.current.isLocked()).toBe(false);
    });
    await act(async () => {
      await expect(hook.result.current.acceptEvidenceSuggestion(makeSuggestion())).resolves.toBe(true);
    });
    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(1);
    expect(hook.onEvidenceAccepted).toHaveBeenCalledWith(expect.objectContaining({
      suggestion: expect.objectContaining({ suggestion_id: "suggestion_1" }),
      payload: expect.objectContaining({ evidence: expect.objectContaining({ evidence_id: "E000001" }) })
    }));
    expect(hook.result.current.errorFor("evidence", "suggestion_1")).toBeNull();
  });

  it("retains a failed evidence suggestion and clears its error on retry", async () => {
    const hook = renderDecisionLifecycle();
    apiMocks.createEvidence
      .mockRejectedValueOnce(new Error("Evidence save failed."))
      .mockResolvedValueOnce(evidencePayload());
    await act(async () => { await hook.result.current.acceptEvidenceSuggestion(makeSuggestion()); });
    expect(hook.onEvidenceAccepted).not.toHaveBeenCalled();
    expect(hook.result.current.errorFor("evidence", "suggestion_1")?.message).toBe("Evidence save failed.");
    await act(async () => { await hook.result.current.acceptEvidenceSuggestion(makeSuggestion()); });
    expect(hook.onEvidenceAccepted).toHaveBeenCalledTimes(1);
    expect(hook.result.current.errorFor("evidence", "suggestion_1")).toBeNull();
  });

  it("persists and then publishes one rejection", async () => {
    const hook = renderDecisionLifecycle();
    hook.onSuggestionRejected.mockImplementation(() => {
      expect(hook.result.current.isLocked()).toBe(false);
    });
    await act(async () => {
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(true);
    });
    expect(apiMocks.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      run_id: "run_evidence",
      suggestion_id: "suggestion_1",
      task: "evidence",
      decision: "rejected"
    }));
    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(1);
    expect(hook.onSuggestionRejected).toHaveBeenCalledWith(rejection());
  });

  it("keeps a rejected suggestion available after a current failure and permits retry", async () => {
    const hook = renderDecisionLifecycle();
    apiMocks.recordDecision
      .mockRejectedValueOnce(new Error("Decision failed."))
      .mockResolvedValueOnce(decisionPayload());
    await act(async () => { await hook.result.current.rejectSuggestion(rejection()); });
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errorFor("evidence", "suggestion_1")?.message).toBe("Decision failed.");
    await act(async () => { await hook.result.current.rejectSuggestion(rejection()); });
    expect(hook.onSuggestionRejected).toHaveBeenCalledTimes(1);
    expect(hook.result.current.errorFor("evidence", "suggestion_1")).toBeNull();
  });

  it("publishes a current project conflict without consuming the suggestion", async () => {
    const hook = renderDecisionLifecycle();
    const conflict = projectConflict();
    apiMocks.recordDecision.mockRejectedValueOnce(conflict);
    await act(async () => {
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(false);
    });
    expect(hook.onProjectConflict).toHaveBeenCalledWith(conflict);
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errorFor("evidence", "suggestion_1")?.message).toBe(conflict.message);
    expect(hook.result.current.busy).toBe(false);
  });

  it("silences a stale project conflict after project replacement", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(persisted(makeProject("project_b"), makeHandle("project_b")))));
    await act(async () => {
      pending.reject(projectConflict());
      await expect(operation).resolves.toBe(false);
    });
    expect(hook.onProjectConflict).not.toHaveBeenCalled();
    expect(hook.result.current.errors).toEqual({});
  });

  it("ignores a late success after project replacement", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(persisted(makeProject("project_b"), makeHandle("project_b")))));
    await act(async () => {
      pending.resolve(decisionPayload());
      await expect(operation).resolves.toBe(false);
    });
    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errors).toEqual({});
  });

  it("ignores a late rejection after project replacement", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(persisted(makeProject("project_b"), makeHandle("project_b")))));
    await act(async () => {
      pending.reject(new Error("Stale failure."));
      await expect(operation).resolves.toBe(false);
    });
    expect(hook.result.current.errors).toEqual({});
  });

  it("invalidates pending work across Save As", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(persisted(
      makeProject(),
      makeHandle("project_a", "c", "D:\\research\\copy.evidence.json")
    ))));
    await act(async () => {
      pending.resolve(decisionPayload());
      await operation;
    });
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.busy).toBe(false);
  });

  it("rejects a response after an unrelated revision advance", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.replaceSession(session(persisted(makeProject(), makeHandle("project_a", "z")))));
    await act(async () => {
      pending.resolve(decisionPayload());
      await expect(operation).resolves.toBe(false);
    });
    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errors).toEqual({});
  });

  it("invalidates pending work on reset", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.reset());
    await act(async () => {
      pending.reject(new Error("Stale failure."));
      await expect(operation).resolves.toBe(false);
    });
    expect(hook.result.current.errors).toEqual({});
    expect(hook.result.current.busy).toBe(false);
  });

  it("does not publish after unmount", async () => {
    const pending = deferred<CodesAiDecisionPayload>();
    apiMocks.recordDecision.mockReturnValueOnce(pending.promise);
    const hook = renderDecisionLifecycle();
    let operation!: Promise<boolean>;
    act(() => { operation = hook.result.current.rejectSuggestion(rejection()); });
    await waitFor(() => expect(apiMocks.recordDecision).toHaveBeenCalledTimes(1));
    hook.unmount();
    await act(async () => {
      pending.resolve(decisionPayload());
      await operation;
    });
    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
  });

  it.each([
    ["project ID", decisionPayload("b", makeProject("project_b"), makeHandle("project_b", "b"))],
    ["project file", decisionPayload("b", makeProject(), makeHandle("project_a", "b", "D:\\research\\other.evidence.json"))],
    ["revision progression", decisionPayload("a", makeProject(), makeHandle("project_a", "a"))]
  ])("rejects a response with a mismatched %s", async (_field, response) => {
    apiMocks.recordDecision.mockResolvedValueOnce(response);
    const hook = renderDecisionLifecycle();
    await act(async () => { await hook.result.current.rejectSuggestion(rejection()); });
    expect(hook.applyPersistedProject).not.toHaveBeenCalled();
    expect(hook.onSuggestionRejected).not.toHaveBeenCalled();
    expect(hook.result.current.errorFor("evidence", "suggestion_1")).not.toBeNull();
  });

  it("advances project and handle after every successful bulk rejection", async () => {
    const hook = renderDecisionLifecycle();
    const lockStates: boolean[] = [];
    hook.onSuggestionRejected.mockImplementation(() => {
      lockStates.push(hook.result.current.isLocked());
    });
    apiMocks.recordDecision
      .mockResolvedValueOnce(decisionPayload("b", makeProject(), makeHandle("project_a", "b"), "suggestion_1"))
      .mockResolvedValueOnce(decisionPayload("c", makeProject(), makeHandle("project_a", "c"), "suggestion_2"))
      .mockResolvedValueOnce(decisionPayload("d", makeProject(), makeHandle("project_a", "d"), "suggestion_3"));
    const suggestions = [makeSuggestion("suggestion_1"), makeSuggestion("suggestion_2"), makeSuggestion("suggestion_3")];
    let outcome: CodesAiBulkRejectionResult | undefined;
    await act(async () => { outcome = await hook.result.current.rejectEvidenceSuggestions(suggestions); });
    expect(outcome).toEqual({
      rejectedSuggestionIds: ["suggestion_1", "suggestion_2", "suggestion_3"],
      failedSuggestionId: null
    });
    expect(apiMocks.recordDecision.mock.calls.map(([payload]) => payload.handle.revision)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64)
    ]);
    expect(hook.applyPersistedProject).toHaveBeenCalledTimes(3);
    expect(hook.onSuggestionRejected).toHaveBeenCalledTimes(3);
    expect(hook.onSuggestionRejected.mock.calls.map(([value]) => value.suggestionId)).toEqual([
      "suggestion_1",
      "suggestion_2",
      "suggestion_3"
    ]);
    expect(lockStates).toEqual([false, false, false]);
  });

  it("preserves bulk progress after partial failure and retries without replaying successes", async () => {
    const hook = renderDecisionLifecycle();
    apiMocks.recordDecision
      .mockResolvedValueOnce(decisionPayload("b", makeProject(), makeHandle("project_a", "b"), "suggestion_1"))
      .mockRejectedValueOnce(new Error("Second rejection failed."));
    const suggestions = [makeSuggestion("suggestion_1"), makeSuggestion("suggestion_2"), makeSuggestion("suggestion_3")];
    let firstOutcome: CodesAiBulkRejectionResult | undefined;
    await act(async () => { firstOutcome = await hook.result.current.rejectEvidenceSuggestions(suggestions); });
    expect(firstOutcome).toEqual({
      rejectedSuggestionIds: ["suggestion_1"],
      failedSuggestionId: "suggestion_2"
    });
    expect(hook.onSuggestionRejected).toHaveBeenCalledTimes(1);
    expect(hook.onSuggestionRejected).toHaveBeenLastCalledWith(rejection("suggestion_1"));
    expect(hook.result.current.errorFor("evidence", "suggestion_2")?.message).toBe("Second rejection failed.");

    apiMocks.recordDecision
      .mockResolvedValueOnce(decisionPayload("c", makeProject(), makeHandle("project_a", "c"), "suggestion_2"))
      .mockResolvedValueOnce(decisionPayload("d", makeProject(), makeHandle("project_a", "d"), "suggestion_3"));
    let retryOutcome: CodesAiBulkRejectionResult | undefined;
    await act(async () => {
      retryOutcome = await hook.result.current.rejectEvidenceSuggestions(suggestions.slice(1));
    });
    expect(retryOutcome).toEqual({
      rejectedSuggestionIds: ["suggestion_2", "suggestion_3"],
      failedSuggestionId: null
    });
    expect(apiMocks.recordDecision.mock.calls.map(([payload]) => payload.suggestion_id)).toEqual([
      "suggestion_1",
      "suggestion_2",
      "suggestion_2",
      "suggestion_3"
    ]);
    expect(apiMocks.recordDecision.mock.calls[2][0].handle.revision).toBe("b".repeat(64));
    expect(hook.onSuggestionRejected).toHaveBeenCalledTimes(3);
    expect(hook.result.current.errorFor("evidence", "suggestion_2")).toBeNull();
  });

  it("refuses an incoherent project session without persistence or mutation", async () => {
    const incoherent = session();
    incoherent.projectFile = "D:\\research\\different.evidence.json";
    const hook = renderDecisionLifecycle(incoherent);
    await act(async () => {
      await expect(hook.result.current.rejectSuggestion(rejection())).resolves.toBe(false);
    });
    expect(hook.persistProjectSettings).not.toHaveBeenCalled();
    expect(apiMocks.recordDecision).not.toHaveBeenCalled();
    expect(hook.result.current.errors).toEqual({});
  });
});
