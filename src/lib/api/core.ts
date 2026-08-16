import { invoke, isTauri } from "@tauri-apps/api/core";

export type BackendHealth = {
  bind: string;
  environment: string;
  status: string;
  instance_id?: string | null;
  started_at?: string | null;
};

export type PreparedExport = {
  format: string;
  path: string;
  exists: boolean;
  file_name?: string | null;
  role?: string;
};

type BackendClientConfig = {
  base_url: string;
  auth_token: string | null;
};

type BackendErrorPayload = {
  error?: unknown;
  message?: unknown;
  error_code?: unknown;
  request_id?: unknown;
  [key: string]: unknown;
};

export type ApiErrorKind = "http" | "network" | "timeout" | "aborted" | "invalid_response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly errorCode: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly originalCause: unknown;

  constructor(options: {
    message: string;
    kind: ApiErrorKind;
    status?: number | null;
    errorCode?: string | null;
    requestId?: string | null;
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>> | null;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.errorCode = options.errorCode ?? null;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
    this.originalCause = options.cause;
  }
}

export const API_TIMEOUTS = {
  health: 5_000,
  read: 20_000,
  scan: 120_000,
  mutation: 60_000,
  longMutation: 6 * 60 * 60 * 1_000
} as const;

export type RequestJsonOptions = RequestInit & {
  timeoutMs?: number;
  operation?: string;
};

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
const AUTH_HEADER_NAME = "X-Transcript-Research-Studio-Token";

let backendClientConfigPromise: Promise<BackendClientConfig> | null = null;

async function getBackendClientConfig(): Promise<BackendClientConfig> {
  if (!isTauri()) {
    return {
      base_url: DEFAULT_BACKEND_URL,
      auth_token: null
    };
  }

  if (!backendClientConfigPromise) {
    backendClientConfigPromise = invoke<BackendClientConfig>("get_backend_client_config");
  }

  return await backendClientConfigPromise;
}

export function resetBackendClientConfig(): void {
  backendClientConfigPromise = null;
}

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const backendClient = await getBackendClientConfig();
  const headers = new Headers(init?.headers ?? {});

  if (backendClient.auth_token) {
    headers.set(AUTH_HEADER_NAME, backendClient.auth_token);
  }

  return await fetch(`${backendClient.base_url}${path}`, {
    ...init,
    headers
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readErrorPayload(response: Response): Promise<BackendErrorPayload | null> {
  try {
    const payload = (await response.json()) as unknown;
    return payload && typeof payload === "object" ? (payload as BackendErrorPayload) : null;
  } catch {
    return null;
  }
}

export async function requestJson<T>(path: string, options: RequestJsonOptions = {}): Promise<T> {
  const {
    timeoutMs = API_TIMEOUTS.read,
    operation = "Request",
    signal: externalSignal,
    ...init
  } = options;
  const method = String(init.method ?? "GET").toUpperCase();
  const isSafeRead = method === "GET" || method === "HEAD";
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromCaller();
  } else {
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeoutId = timeoutMs > 0
    ? window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  try {
    const response = await backendFetch(path, { ...init, signal: controller.signal });
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      const payloadMessage = nonEmptyString(payload?.error) ?? nonEmptyString(payload?.message);
      throw new ApiError({
        message: payloadMessage ?? `${operation} failed with status ${response.status}.`,
        kind: "http",
        status: response.status,
        errorCode: nonEmptyString(payload?.error_code),
        requestId: nonEmptyString(payload?.request_id),
        retryable: isSafeRead && (response.status === 408 || response.status === 429 || response.status >= 500),
        details: payload
      });
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ApiError({
        message: `${operation} returned an invalid response.`,
        kind: "invalid_response",
        status: response.status,
        retryable: isSafeRead,
        cause: error
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (timedOut) {
      throw new ApiError({
        message: `${operation} timed out. The local service may still be working.`,
        kind: "timeout",
        retryable: isSafeRead,
        cause: error
      });
    }
    if (externalSignal?.aborted) {
      throw new ApiError({
        message: `${operation} was cancelled.`,
        kind: "aborted",
        retryable: false,
        cause: error
      });
    }
    throw new ApiError({
      message: `${operation} could not reach the local service.`,
      kind: "network",
      retryable: isSafeRead,
      cause: error
    });
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function fetchBackendHealth(): Promise<BackendHealth> {
  return await requestJson<BackendHealth>("/health", {
    timeoutMs: API_TIMEOUTS.health,
    operation: "Service health check"
  });
}
