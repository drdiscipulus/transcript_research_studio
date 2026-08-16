// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { isTauriMock, invokeMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  invokeMock: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock
}));

import { ApiError, requestJson, resetBackendClientConfig } from "../../src/lib/api/core";

afterEach(() => {
  resetBackendClientConfig();
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(false);
  invokeMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requestJson", () => {
  it("preserves legacy backend error messages in a typed ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Project changed on disk." }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )));

    const error = await requestJson("/api/v1/test", { operation: "Test request" }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "http",
      status: 409,
      message: "Project changed on disk."
    });
  });

  it("reads additive error_code and request_id fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Conflict.", error_code: "project_conflict", request_id: "req-1" }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    )));

    const error = await requestJson("/api/v1/test", { method: "POST" }).catch((reason) => reason);
    expect(error).toMatchObject({
      errorCode: "project_conflict",
      requestId: "req-1",
      retryable: false
    });
  });

  it("sends the desktop token only under the current authentication header", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({
      base_url: "http://127.0.0.1:9876",
      auth_token: "synthetic-token"
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestJson("/health", { operation: "Health request" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const retiredHeader = ["X", "AI", "Transcription", "Token"].join("-");
    expect(headers.get("X-Transcript-Research-Studio-Token")).toBe("synthetic-token");
    expect(headers.has(retiredHeader)).toBe(false);
  });
});
