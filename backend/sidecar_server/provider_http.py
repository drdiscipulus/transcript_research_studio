from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any, Iterable


def http_sse_events(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> Iterable[dict[str, Any]]:
    """Yield parsed server-sent events from a provider streaming endpoint."""
    request_headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if headers:
        request_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            event_type = ""
            data_lines: list[str] = []
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").rstrip("\r\n")
                if not line:
                    event = parse_sse_event(event_type=event_type, data_lines=data_lines)
                    if event:
                        yield event
                    event_type = ""
                    data_lines = []
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event_type = line.removeprefix("event:").strip()
                    continue
                if line.startswith("data:"):
                    data_lines.append(line.removeprefix("data:").strip())
            event = parse_sse_event(event_type=event_type, data_lines=data_lines)
            if event:
                yield event
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise PermissionError("Provider API requires authentication.") from error
        detail = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Provider request failed with {error.code}: {detail or error.reason}") from error
    except urllib.error.URLError as error:
        raise ConnectionError("Provider API is not reachable.") from error
    except (TimeoutError, socket.timeout) as error:
        raise TimeoutError("Provider request timed out.") from error


def parse_sse_event(*, event_type: str, data_lines: list[str]) -> dict[str, Any] | None:
    """Parse one SSE event block, preserving provider event type metadata."""
    if not event_type and not data_lines:
        return None
    raw_data = "\n".join(data_lines).strip()
    data: Any = {}
    if raw_data:
        if raw_data == "[DONE]":
            return None
        try:
            data = json.loads(raw_data)
        except json.JSONDecodeError as error:
            raise RuntimeError("Provider API returned invalid streaming JSON.") from error
    payload = dict(data) if isinstance(data, dict) else {"data": data}
    if "type" not in payload:
        payload["type"] = event_type
    else:
        payload["event"] = event_type or payload.get("type")
    if "data" not in payload:
        payload["data"] = data
    return payload


def http_json_lines(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> Iterable[dict[str, Any]]:
    """Yield JSON objects from newline-delimited provider streams."""
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError("Provider API returned invalid streaming JSON.") from error
                if isinstance(payload, dict):
                    yield payload
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise PermissionError("Provider API requires authentication.") from error
        detail = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Provider request failed with {error.code}: {detail or error.reason}") from error
    except urllib.error.URLError as error:
        raise ConnectionError("Provider API is not reachable.") from error
    except (TimeoutError, socket.timeout) as error:
        raise TimeoutError("Provider request timed out.") from error


def http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise PermissionError("Provider API requires authentication.") from error
        detail = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Provider request failed with {error.code}: {detail or error.reason}") from error
    except urllib.error.URLError as error:
        raise ConnectionError("Provider API is not reachable.") from error

    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError as error:
        raise RuntimeError("Provider API returned invalid JSON.") from error
    return payload if isinstance(payload, dict) else {}
