from __future__ import annotations

from typing import Any


TRANSCRIPTION_PROTOCOL_VERSION = 2
PROTOCOL_ERROR_CODE = "worker_protocol_error"
REQUEST_MESSAGE_TYPES = frozenset({"init", "transcribe", "shutdown"})
RESPONSE_MESSAGE_TYPES = frozenset({"ready", "result", "error", "stopped"})


class TranscriptionProtocolError(ValueError):
    """A safe protocol-contract failure shared by the worker and its parent."""

    error_code = PROTOCOL_ERROR_CODE


def validate_message_envelope(
    payload: Any,
    *,
    supported_types: frozenset[str] | None = None,
) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise TranscriptionProtocolError("Transcription worker messages must be JSON objects.")
    if payload.get("protocol_version") != TRANSCRIPTION_PROTOCOL_VERSION:
        raise TranscriptionProtocolError("Unsupported transcription worker protocol version.")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip():
        raise TranscriptionProtocolError("Transcription worker messages require a request ID.")
    message_type = payload.get("type")
    if not isinstance(message_type, str) or not message_type.strip():
        raise TranscriptionProtocolError("Transcription worker messages require a message type.")
    normalized_type = message_type.strip().lower()
    if supported_types is not None and normalized_type not in supported_types:
        raise TranscriptionProtocolError(f"Unsupported transcription worker message type: {normalized_type}.")
    return normalized_type, request_id.strip()


def response_envelope(*, message_type: str, request_id: str) -> dict[str, Any]:
    return {
        "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
        "request_id": request_id,
        "type": message_type,
    }
