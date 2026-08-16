// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false
}));

import {
  CodesProjectConflictError,
  createCodesCode,
  createCodesProject,
  loadCodesProject,
  previewCodesTranscriptImport,
  removeCodesProjectTranscript,
  saveCodesProject,
  updateCodesEvidenceItem,
  type CodesProject,
  type CodesProjectHandle
} from "../../src/lib/api/codes";
import { ApiError } from "../../src/lib/api/core";

const project: CodesProject = {
  schema_version: "1.1",
  project_id: "project_test",
  name: "Study",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  research_focus: "",
  ai_settings: {
    provider_id: "",
    model_id: "",
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

const handle: CodesProjectHandle = {
  project_file: "C:\\study.evidence.json",
  project_id: project.project_id,
  revision: "a".repeat(64)
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Codes requestJson integration", () => {
  it("preserves typed API metadata on project conflicts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        error: "Project changed on disk.",
        error_code: "project_conflict",
        request_id: "req-codes-1",
        current_revision: "b".repeat(64)
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )));

    const error = await loadCodesProject(handle.project_file).catch((reason) => reason);

    expect(error).toBeInstanceOf(CodesProjectConflictError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "http",
      status: 409,
      errorCode: "project_conflict",
      requestId: "req-codes-1",
      currentRevision: "b".repeat(64)
    });
  });

  it("classifies a missing project handle as an invalid response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ project, project_file: handle.project_file }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )));

    const error = await createCodesProject({ project_file: handle.project_file }).catch((reason) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "invalid_response", retryable: false });
  });

  it("sends compact mutation fields and applies the returned patch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({
        ...handle,
        revision: "c".repeat(64),
        code: {
          code_id: "C000001",
          name: "Uncertainty",
          description: "",
          inclusion_note: "",
          exclusion_note: "",
          example_evidence_ids: [],
          color: "#0f766e",
          memo: "",
          created_at: "2026-01-01T00:00:01Z",
          updated_at: "2026-01-01T00:00:01Z"
        },
        project_patch: {
          set: { id_counters: { code: 1 } },
          upsert: {
            codes: [{
              code_id: "C000001",
              name: "Uncertainty",
              description: "",
              inclusion_note: "",
              exclusion_note: "",
              example_evidence_ids: [],
              color: "#0f766e",
              memo: "",
              created_at: "2026-01-01T00:00:01Z",
              updated_at: "2026-01-01T00:00:01Z"
            }]
          },
          remove: {}
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCodesCode({ project, handle, name: "Uncertainty" });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    expect(requestBody).toMatchObject({
      project_file: handle.project_file,
      project_id: handle.project_id,
      expected_revision: handle.revision,
      name: "Uncertainty"
    });
    expect(requestBody).not.toHaveProperty("project");
    expect(result.handle.revision).toBe("c".repeat(64));
    expect(result.project.codes).toHaveLength(1);
    expect(result.project.codes[0]?.name).toBe("Uncertainty");
  });

  it("previews transcript imports with a compact project handle", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({
        ...handle,
        candidates: [],
        counts: { ready: 0, already_imported: 0, alternate_format: 0, problem: 0 },
        non_recursive: true
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    await previewCodesTranscriptImport({ handle, transcript_folder: "D:\\transcripts" });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    expect(requestBody).toMatchObject({
      project_file: handle.project_file,
      project_id: handle.project_id,
      expected_revision: handle.revision,
      transcript_folder: "D:\\transcripts"
    });
    expect(requestBody).not.toHaveProperty("project");
  });

  it("saves project settings through the required compact file handle", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({
        ...handle,
        revision: "d".repeat(64),
        project_patch: { set: { name: "Renamed Study" }, upsert: {}, remove: {} }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveCodesProject(handle.project_file, { ...project, name: "Renamed Study" }, handle);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    expect(requestUrl).toContain("/api/v1/codes/project/save");
    expect(requestBody).toMatchObject({
      project_file: handle.project_file,
      source_project_file: handle.project_file,
      project_id: handle.project_id,
      expected_revision: handle.revision,
      project_updates: {
        name: "Renamed Study",
        research_focus: project.research_focus,
        ai_settings: project.ai_settings,
        settings: project.settings
      }
    });
    expect(requestBody).not.toHaveProperty("project");
    expect(result.handle.revision).toBe("d".repeat(64));
    expect(result.project.name).toBe("Renamed Study");
  });

  it("sends staged evidence changes and provisional codes in one update", async () => {
    const evidence = {
      evidence_id: "E000001", transcript_id: "T000001", source_file: "C:\\interview.json", source_document_id: "doc_000001",
      segment_ids: ["seg_000001"], speaker: "SPEAKER_00", start: 0, end: 1, selected_text: "An opportunity",
      segment_ranges: { seg_000001: { start_offset: 0, end_offset: 14, excerpt: "An opportunity" } },
      code_ids: ["C000001"], memo: "Updated note", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z"
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        ...handle,
        revision: "e".repeat(64),
        evidence,
        created_codes: [{ code_id: "C000001", name: "Opportunity", color: "#123456", client_id: "draft-1" }],
        project_patch: { upsert: { evidence_items: [evidence] } }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateCodesEvidenceItem({
      project,
      handle,
      evidence_id: "E000001",
      memo: "Updated note",
      code_ids: [],
      new_codes: [{ client_id: "draft-1", name: "Opportunity", color: "#123456" }]
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/codes/project/update-evidence");
    expect(requestBody).toMatchObject({
      evidence_id: "E000001",
      memo: "Updated note",
      code_ids: [],
      new_codes: [{ client_id: "draft-1", name: "Opportunity", color: "#123456" }]
    });
    expect(requestBody).not.toHaveProperty("project");
    expect(result.created_codes?.[0]).toMatchObject({ code_id: "C000001", client_id: "draft-1" });
  });

  it("preserves stable transcript-integrity error codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        error: "This transcript has 2 evidence items.",
        error_code: "transcript_has_evidence",
        request_id: "req-codes-2"
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )));

    const error = await removeCodesProjectTranscript(project, handle, "T000001").catch((reason) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(CodesProjectConflictError);
    expect(error).toMatchObject({ status: 409, errorCode: "transcript_has_evidence", requestId: "req-codes-2" });
  });
});
