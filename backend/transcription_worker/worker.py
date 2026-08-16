from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from backend.sidecar_server.pyannote_diarization import redact_secret
from backend.sidecar_server.transcription_engine import (
    preload_transcription_runtime,
    transcribe_media_direct,
)
from backend.sidecar_server.transcription_types import TranscriptionConfigurationError
from backend.transcription_protocol import (
    PROTOCOL_ERROR_CODE,
    REQUEST_MESSAGE_TYPES,
    TRANSCRIPTION_PROTOCOL_VERSION,
    TranscriptionProtocolError,
    response_envelope,
    validate_message_envelope,
)


_UNKNOWN_REQUEST_ID = "unknown"
_SAFE_MESSAGE_LIMIT = 2_000


def main() -> int:
    return session_main()


def _run_transcription(request: dict[str, Any]) -> dict[str, Any]:
    media_path = Path(str(request.get("media_path", "")).strip())
    if not media_path.is_file():
        raise TranscriptionConfigurationError(
            f"Media file was not found for transcription: {media_path}",
            error_code="media_not_found",
        )

    result = transcribe_media_direct(
        media_path=media_path,
        output_mode=str(request.get("output_mode") or "transcribe"),
        language=str(request.get("language") or "auto"),
        batch_name=str(request.get("batch_name") or "batch"),
        model_name=str(request.get("model_name") or "small"),
        device_preference=str(request.get("device_preference") or ""),
        advanced_settings=request.get("advanced_settings") if isinstance(request.get("advanced_settings"), dict) else None,
    )
    return _serialize_result(result)


def _serialize_result(result: Any) -> dict[str, Any]:
    return {
        "status": "ok",
        "transcript": result.transcript,
        "detected_language": result.detected_language,
        "engine": result.engine,
        "model": result.model,
        "device": result.device,
        "used_fallback": result.used_fallback,
        "note": result.note,
        "speaker_summary": result.speaker_summary,
        "warnings": result.warnings or [],
        "segments": [segment.to_dict() for segment in result.segments],
    }


def session_main() -> int:
    """Serve the strict JSON-lines protocol while retaining one ML runtime."""
    session_config: dict[str, Any] | None = None
    initialized = False

    for line in sys.stdin:
        raw_line = line.strip()
        if not raw_line:
            continue
        request_id = _UNKNOWN_REQUEST_ID
        try:
            try:
                message = json.loads(raw_line)
            except json.JSONDecodeError as error:
                raise TranscriptionProtocolError("The transcription worker received invalid JSON.") from error

            if isinstance(message, dict) and isinstance(message.get("request_id"), str):
                request_id = message["request_id"].strip() or _UNKNOWN_REQUEST_ID
            message_type, request_id = validate_message_envelope(
                message,
                supported_types=REQUEST_MESSAGE_TYPES,
            )
            if not initialized:
                if message_type != "init":
                    raise TranscriptionProtocolError("Initialize the transcription worker before sending other requests.")
                session_config = _session_config_from_init(message)
                context = preload_transcription_runtime(
                    model_name=session_config["model_name"],
                    device_preference=session_config["device_preference"],
                    advanced_settings=session_config["advanced_settings"],
                )
                initialized = True
                _write_session_response(
                    {
                        **response_envelope(message_type="ready", request_id=request_id),
                        "status": "ok",
                        "model": context.whisper_model_name,
                        "device": context.device,
                        "compute_type": context.compute_type,
                    }
                )
                continue

            if message_type == "init":
                raise TranscriptionProtocolError("The transcription worker is already initialized.")
            if message_type == "shutdown":
                _write_session_response(
                    {
                        **response_envelope(message_type="stopped", request_id=request_id),
                        "status": "ok",
                    }
                )
                return 0
            assert session_config is not None
            request = {
                **session_config,
                "media_path": message.get("media_path"),
                "output_mode": str(message.get("output_mode") or "transcribe"),
                "language": str(message.get("language") or "auto"),
            }
            payload = _run_transcription(request)
            payload.update(response_envelope(message_type="result", request_id=request_id))
            if bool(payload.get("used_fallback")) and str(payload.get("device") or "").lower() == "cpu":
                session_config["device_preference"] = "cpu"
            _write_session_response(payload)
        except TranscriptionProtocolError as error:
            _write_error_response(
                request_id=request_id,
                error_kind="protocol",
                error_code=PROTOCOL_ERROR_CODE,
                error=error,
            )
        except TranscriptionConfigurationError as error:
            _write_error_response(
                request_id=request_id,
                error_kind="configuration",
                error_code=str(getattr(error, "error_code", "model_not_ready")),
                error=error,
            )
        except Exception as error:  # noqa: BLE001 - one file must not terminate the session
            _write_error_response(
                request_id=request_id,
                error_kind="runtime",
                error_code=str(getattr(error, "error_code", "internal_error")),
                error=error,
            )
    return 0


def _session_config_from_init(message: dict[str, Any]) -> dict[str, Any]:
    return {
        "batch_name": str(message.get("batch_name") or "batch"),
        "model_name": str(message.get("model_name") or "small"),
        "device_preference": str(message.get("device_preference") or "cpu"),
        "advanced_settings": message.get("advanced_settings")
        if isinstance(message.get("advanced_settings"), dict)
        else None,
    }


def _write_error_response(
    *,
    request_id: str,
    error_kind: str,
    error_code: str,
    error: BaseException,
) -> None:
    _write_session_response(
        {
            **response_envelope(message_type="error", request_id=request_id or _UNKNOWN_REQUEST_ID),
            "status": "error",
            "error_kind": error_kind,
            "error_code": error_code,
            "message": _safe_error_message(error),
        }
    )


def _safe_error_message(error: BaseException) -> str:
    message = redact_secret(str(error)).replace("\r", " ").replace("\n", " ").strip()
    return (message or type(error).__name__)[:_SAFE_MESSAGE_LIMIT]


def _write_session_response(payload: dict[str, Any]) -> None:
    payload["protocol_version"] = TRANSCRIPTION_PROTOCOL_VERSION
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
