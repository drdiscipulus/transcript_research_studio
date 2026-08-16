from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from typing import Any

from .batch_runner import batch_manager
from .desktop_utils import open_path, pick_folder
from .evidence_project import (
    EvidenceProjectConflictError,
    EvidenceProjectOperationError,
    create_code,
    create_evidence_project,
    create_evidence_item,
    create_theme,
    delete_code,
    delete_evidence_item,
    delete_theme,
    load_evidence_project,
    merge_code,
    import_transcript_candidates,
    preview_transcript_import,
    remove_project_transcript,
    run_evidence_project_mutation,
    run_evidence_project_read,
    save_evidence_project,
    update_code,
    update_evidence_item,
    update_theme,
)
from .evidence_project_ai import (
    contextual_ai_run_manager,
    prepare_contextual_ai_run,
    record_ai_suggestion_decision,
)
from .evidence_export_bundle import export_evidence_project_bundle
from .hf_credentials import test_hf_token
from .model_status import build_models_status_payload
from .model_download_progress import (
    fail_model_download,
    finish_model_download,
    model_download_progress_payload,
    start_model_download,
    update_model_download,
)
from .models import HealthStatus
from .prompting import (
    inspect_preprocessing_input,
    get_provider_statuses,
    list_provider_models,
    prompting_manager,
)
from .prompting_prompt_templates import (
    prompt_templates_payload,
    revert_prompt_template_override,
    save_prompt_template_override,
)
from .prompting_custom_analyses import (
    create_custom_analysis,
    custom_analyses_payload,
    delete_custom_analysis,
    duplicate_custom_analysis,
    update_custom_analysis,
)
from .pyannote_diarization import delete_pyannote_model, download_pyannote_model
from .product_identity import PRODUCT_NAME, PRODUCT_VERSION, SERVER_IDENTIFIER
from .run_hardware import hardware_scan_manager, start_hardware_scan
from .run_screen import build_run_screen_payload, scan_input_source
from .security import normalize_loopback_bind_host
from .settings_store import load_settings, reset_settings, save_settings
from .transcript_editor import (
    export_edited_transcript,
    inspect_transcript,
    load_transcript,
    save_edited_transcript,
)
from .transcription_models import delete_faster_whisper_model, download_faster_whisper_model

HOST = normalize_loopback_bind_host(os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_HOST"))
PORT = int(os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT", "8765"))
AUTH_TOKEN = os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN", "").strip() or None
AUTH_HEADER_NAME = "X-Transcript-Research-Studio-Token"
DEFAULT_ALLOWED_ORIGINS = {
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
}
ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS | {
    value.strip()
    for value in os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_ALLOWED_ORIGINS", "").split(",")
    if value.strip()
}
MAX_JSON_BODY_BYTES = 10 * 1024 * 1024
TOKEN_PATTERN = re.compile(r"\bhf_[A-Za-z0-9_=-]{8,}\b")
INSTANCE_ID = uuid.uuid4().hex
STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, indent=2).encode("utf-8")


def _safe_error_message(error: Exception, fallback: str = "Request failed.") -> str:
    message = str(error).strip() or fallback
    return TOKEN_PATTERN.sub("[redacted-token]", message)


def _default_error_code(status: HTTPStatus) -> str:
    return {
        HTTPStatus.BAD_REQUEST: "invalid_request",
        HTTPStatus.UNAUTHORIZED: "unauthorized",
        HTTPStatus.FORBIDDEN: "forbidden",
        HTTPStatus.NOT_FOUND: "not_found",
        HTTPStatus.CONFLICT: "conflict",
        HTTPStatus.REQUEST_ENTITY_TOO_LARGE: "payload_too_large",
    }.get(status, "internal_error" if int(status) >= 500 else "request_failed")


class JsonPayloadError(RuntimeError):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class SidecarRequestHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_IDENTIFIER}/{PRODUCT_VERSION}"

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._active_request_id = uuid.uuid4().hex
        if not self._origin_is_allowed():
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_common_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._active_request_id = uuid.uuid4().hex
        if not self._ensure_authorized():
            return
        parsed_url = urlparse(self.path)
        routes = {
            "/health": self._handle_health,
            "/api/v1/system/hardware": self._handle_hardware_status,
            "/api/v1/transcription/run-screen": self._handle_run_screen,
            "/api/v1/transcription/current-batch": self._handle_current_batch,
            "/api/v1/prompting/providers": self._handle_prompting_providers,
            "/api/v1/prompting/prompt-templates": self._handle_prompting_prompt_templates,
            "/api/v1/prompting/current-run": self._handle_current_prompting_run,
            "/api/v1/prompting/custom-analyses": self._handle_prompting_custom_analyses,
            "/api/v1/settings": self._handle_get_settings,
            "/api/v1/models/status": self._handle_models_status,
            "/api/v1/models/download-progress": self._handle_model_download_progress,
        }
        handler = routes.get(parsed_url.path, self._handle_not_found)
        try:
            handler()
        except JsonPayloadError as error:
            self._send_json(error.status, {"error": error.message})
        except Exception as error:  # noqa: BLE001
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": _safe_error_message(error)})

    def do_POST(self) -> None:  # noqa: N802
        self._active_request_id = uuid.uuid4().hex
        if not self._ensure_authorized():
            return
        parsed_url = urlparse(self.path)
        routes = {
            "/api/v1/transcription/scan": self._handle_scan_request,
            "/api/v1/transcription/start-batch": self._handle_start_batch,
            "/api/v1/transcription/cancel-batch": self._handle_cancel_batch,
            "/api/v1/prompting/inspect-input": self._handle_prompting_inspect_input,
            "/api/v1/prompting/models": self._handle_prompting_models,
            "/api/v1/prompting/start-run": self._handle_prompting_start_run,
            "/api/v1/prompting/cancel-run": self._handle_prompting_cancel_run,
            "/api/v1/prompting/prompt-templates/save": self._handle_prompting_prompt_template_save,
            "/api/v1/prompting/prompt-templates/revert": self._handle_prompting_prompt_template_revert,
            "/api/v1/prompting/custom-analyses/create": self._handle_prompting_custom_analysis_create,
            "/api/v1/prompting/custom-analyses/update": self._handle_prompting_custom_analysis_update,
            "/api/v1/prompting/custom-analyses/duplicate": self._handle_prompting_custom_analysis_duplicate,
            "/api/v1/prompting/custom-analyses/delete": self._handle_prompting_custom_analysis_delete,
            "/api/v1/settings": self._handle_save_settings,
            "/api/v1/settings/reset": self._handle_reset_settings,
            "/api/v1/advanced/hf-token/test": self._handle_hf_token_test,
            "/api/v1/advanced/pyannote-model/download": self._handle_pyannote_model_download,
            "/api/v1/advanced/pyannote-model/delete": self._handle_pyannote_model_delete,
            "/api/v1/models/faster-whisper/download": self._handle_faster_whisper_model_download,
            "/api/v1/models/faster-whisper/delete": self._handle_faster_whisper_model_delete,
            "/api/v1/editor/inspect-transcript": self._handle_editor_inspect_transcript,
            "/api/v1/editor/load-transcript": self._handle_editor_load_transcript,
            "/api/v1/editor/save": self._handle_editor_save,
            "/api/v1/editor/export": self._handle_editor_export,
            "/api/v1/codes/project/create": self._handle_codes_project_create,
            "/api/v1/codes/project/load": self._handle_codes_project_load,
            "/api/v1/codes/project/save": self._handle_codes_project_save,
            "/api/v1/codes/project/export-bundle": self._handle_codes_project_export_bundle,
            "/api/v1/codes/project/preview-transcript-import": self._handle_codes_project_preview_transcript_import,
            "/api/v1/codes/project/import-transcripts": self._handle_codes_project_import_transcripts,
            "/api/v1/codes/project/remove-transcript": self._handle_codes_project_remove_transcript,
            "/api/v1/codes/project/create-evidence": self._handle_codes_project_create_evidence,
            "/api/v1/codes/project/update-evidence": self._handle_codes_project_update_evidence,
            "/api/v1/codes/project/delete-evidence": self._handle_codes_project_delete_evidence,
            "/api/v1/codes/project/create-code": self._handle_codes_project_create_code,
            "/api/v1/codes/project/update-code": self._handle_codes_project_update_code,
            "/api/v1/codes/project/delete-code": self._handle_codes_project_delete_code,
            "/api/v1/codes/project/merge-code": self._handle_codes_project_merge_code,
            "/api/v1/codes/project/create-theme": self._handle_codes_project_create_theme,
            "/api/v1/codes/project/update-theme": self._handle_codes_project_update_theme,
            "/api/v1/codes/project/delete-theme": self._handle_codes_project_delete_theme,
            "/api/v1/codes/project/suggestion-decision": self._handle_codes_project_suggestion_decision,
            "/api/v1/codes/project/ai-run/start": self._handle_codes_project_ai_run_start,
            "/api/v1/codes/project/ai-run/status": self._handle_codes_project_ai_run_status,
            "/api/v1/codes/project/ai-run/cancel": self._handle_codes_project_ai_run_cancel,
            "/api/v1/system/pick-folder": self._handle_pick_folder,
            "/api/v1/system/open-path": self._handle_open_path,
            "/api/v1/system/hardware/retry": self._handle_hardware_retry,
        }
        handler = routes.get(parsed_url.path, self._handle_not_found)
        try:
            handler()
        except JsonPayloadError as error:
            self._send_json(error.status, {"error": error.message})
        except Exception as error:  # noqa: BLE001
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": _safe_error_message(error)})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        if int(status) >= 400 and isinstance(payload.get("error"), str):
            payload = dict(payload)
            payload.setdefault("error_code", _default_error_code(status))
            payload.setdefault("request_id", self._request_id())
        body = _json_bytes(payload)
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _request_id(self) -> str:
        request_id = getattr(self, "_active_request_id", "")
        if not request_id:
            request_id = uuid.uuid4().hex
            self._active_request_id = request_id
        return request_id

    def _send_common_headers(self) -> None:
        origin = self.headers.get("Origin", "").strip()
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {AUTH_HEADER_NAME}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    # The sidecar only serves the Tauri webview that launched it, so every request
    # should present the per-launch token passed in by the desktop shell.
    def _ensure_authorized(self) -> bool:
        if not self._origin_is_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden origin."})
            return False
        if AUTH_TOKEN is None:
            return True
        request_token = self.headers.get(AUTH_HEADER_NAME, "").strip()
        if request_token == AUTH_TOKEN:
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized request."})
        return False

    def _origin_is_allowed(self) -> bool:
        origin = self.headers.get("Origin", "").strip()
        return not origin or origin in ALLOWED_ORIGINS

    def _handle_health(self) -> None:
        payload = HealthStatus(
            status="ok",
            bind=f"{HOST}:{PORT}",
            environment="development",
        ).to_dict()
        payload.update({"instance_id": INSTANCE_ID, "started_at": STARTED_AT})
        self._send_json(
            HTTPStatus.OK,
            payload,
        )

    def _handle_run_screen(self) -> None:
        self._send_json(HTTPStatus.OK, build_run_screen_payload())

    def _handle_hardware_status(self) -> None:
        self._send_json(HTTPStatus.OK, hardware_scan_manager.snapshot())

    def _handle_hardware_retry(self) -> None:
        started = hardware_scan_manager.retry()
        payload = hardware_scan_manager.snapshot()
        payload["retry_started"] = started
        self._send_json(HTTPStatus.OK, payload)

    def _handle_scan_request(self) -> None:
        payload = self._read_json_payload()
        input_source_type = str(payload.get("input_source_type") or "folder").strip()
        input_path = str(payload.get("input_path") or payload.get("input_folder") or "").strip()
        self._send_json(HTTPStatus.OK, scan_input_source(input_source_type, input_path).to_dict())

    def _handle_start_batch(self) -> None:
        payload = self._read_json_payload()
        try:
            snapshot = batch_manager.start_batch(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        self._send_json(HTTPStatus.OK, snapshot.to_dict())

    def _handle_cancel_batch(self) -> None:
        try:
            snapshot = batch_manager.cancel_current_batch()
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        self._send_json(HTTPStatus.OK, snapshot.to_dict())

    def _handle_current_batch(self) -> None:
        self._send_json(HTTPStatus.OK, batch_manager.get_snapshot().to_dict())

    def _handle_prompting_providers(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        force_refresh = query.get("refresh") == ["1"]
        self._send_json(HTTPStatus.OK, get_provider_statuses(force_refresh=force_refresh))

    def _handle_prompting_prompt_templates(self) -> None:
        self._send_json(HTTPStatus.OK, prompt_templates_payload())

    def _handle_prompting_custom_analyses(self) -> None:
        self._send_json(HTTPStatus.OK, custom_analyses_payload())

    def _handle_prompting_inspect_input(self) -> None:
        payload = self._read_json_payload()
        try:
            summary = inspect_preprocessing_input(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, summary)

    def _handle_prompting_models(self) -> None:
        payload = self._read_json_payload()
        provider_id = str(payload.get("provider_id", "")).strip()
        try:
            models = list_provider_models(provider_id)
        except (ValueError, PermissionError, ConnectionError, TimeoutError, RuntimeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, models)

    def _handle_prompting_start_run(self) -> None:
        payload = self._read_json_payload()
        try:
            snapshot = prompting_manager.start_run(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        self._send_json(HTTPStatus.OK, snapshot.to_dict())

    def _handle_current_prompting_run(self) -> None:
        self._send_json(HTTPStatus.OK, prompting_manager.get_snapshot().to_dict())

    def _handle_prompting_cancel_run(self) -> None:
        try:
            snapshot = prompting_manager.cancel_current_run()
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return

        self._send_json(HTTPStatus.OK, snapshot.to_dict())

    def _handle_prompting_prompt_template_save(self) -> None:
        payload = self._read_json_payload()
        try:
            result = save_prompt_template_override(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_prompting_prompt_template_revert(self) -> None:
        payload = self._read_json_payload()
        try:
            result = revert_prompt_template_override(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_get_settings(self) -> None:
        self._send_json(HTTPStatus.OK, load_settings().to_dict())

    def _handle_models_status(self) -> None:
        self._send_json(HTTPStatus.OK, build_models_status_payload())

    def _handle_model_download_progress(self) -> None:
        self._send_json(HTTPStatus.OK, model_download_progress_payload())

    def _handle_save_settings(self) -> None:
        payload = self._read_json_payload()
        self._send_json(HTTPStatus.OK, save_settings(payload).to_dict())

    def _handle_reset_settings(self) -> None:
        self._send_json(HTTPStatus.OK, reset_settings().to_dict())

    def _handle_hf_token_test(self) -> None:
        payload = self._read_json_payload()
        try:
            result = test_hf_token(str(payload.get("token", "")) or None)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_pyannote_model_download(self) -> None:
        payload = self._read_json_payload()
        download_id = "pyannote"
        start_model_download(download_id, label="Pyannote Model")
        try:
            result = download_pyannote_model(
                str(payload.get("token", "")),
                progress_callback=lambda downloaded, total, filename: update_model_download(
                    download_id,
                    downloaded_bytes=downloaded,
                    total_bytes=total,
                    message=filename or "Downloading pyannote model...",
                ),
            )
        except RuntimeError as error:
            message = _safe_error_message(error, "Pyannote model download failed.")
            fail_model_download(download_id, message=message)
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": message})
            return
        except Exception as error:  # noqa: BLE001
            message = _safe_error_message(error, "Pyannote model download failed.")
            fail_model_download(download_id, message=message)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": message})
            return
        finish_model_download(download_id)
        self._send_json(HTTPStatus.OK, result)

    def _handle_prompting_custom_analysis_create(self) -> None:
        self._handle_prompting_custom_analysis_mutation(create_custom_analysis)

    def _handle_prompting_custom_analysis_update(self) -> None:
        self._handle_prompting_custom_analysis_mutation(update_custom_analysis)

    def _handle_prompting_custom_analysis_duplicate(self) -> None:
        self._handle_prompting_custom_analysis_mutation(duplicate_custom_analysis)

    def _handle_prompting_custom_analysis_delete(self) -> None:
        self._handle_prompting_custom_analysis_mutation(delete_custom_analysis)

    def _handle_prompting_custom_analysis_mutation(self, operation: Any) -> None:
        payload = self._read_json_payload()
        try:
            result = operation(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_pyannote_model_delete(self) -> None:
        try:
            result = delete_pyannote_model()
        except OSError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_faster_whisper_model_download(self) -> None:
        payload = self._read_json_payload()
        model_name = str(payload.get("model_name", "")).strip().lower()
        download_id = f"fw:{model_name}"
        start_model_download(download_id, label=model_name)
        try:
            result = download_faster_whisper_model(
                model_name,
                progress_callback=lambda downloaded, total, filename: update_model_download(
                    download_id,
                    downloaded_bytes=downloaded,
                    total_bytes=total,
                    message=filename or "Downloading model...",
                ),
            )
        except (ValueError, RuntimeError) as error:
            message = _safe_error_message(error, "Faster-whisper model download failed.")
            fail_model_download(download_id, message=message)
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": message})
            return
        except Exception as error:  # noqa: BLE001
            message = _safe_error_message(error, "Faster-whisper model download failed.")
            fail_model_download(download_id, message=message)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": message})
            return
        finish_model_download(download_id)
        self._send_json(HTTPStatus.OK, result)

    def _handle_faster_whisper_model_delete(self) -> None:
        payload = self._read_json_payload()
        try:
            result = delete_faster_whisper_model(str(payload.get("model_name", "")))
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_editor_inspect_transcript(self) -> None:
        payload = self._read_json_payload()
        try:
            result = inspect_transcript(payload)
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_editor_load_transcript(self) -> None:
        payload = self._read_json_payload()
        try:
            result = load_transcript(payload)
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_editor_save(self) -> None:
        payload = self._read_json_payload()
        try:
            result = save_edited_transcript(payload)
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_editor_export(self) -> None:
        payload = self._read_json_payload()
        try:
            result = export_edited_transcript(payload)
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _send_codes_conflict(self, error: EvidenceProjectConflictError) -> None:
        self._send_json(
            HTTPStatus.CONFLICT,
            {
                "error": str(error),
                "error_code": "project_conflict",
                "current_revision": error.current_revision,
            },
        )

    def _send_codes_operation_error(self, error: EvidenceProjectOperationError) -> None:
        status = (
            HTTPStatus.CONFLICT
            if error.code in {"transcript_has_evidence", "unsafe_transcript_refresh"}
            else HTTPStatus.BAD_REQUEST
        )
        self._send_json(status, {"error": str(error), "error_code": error.code})

    def _handle_codes_mutation(self, payload: dict[str, Any], operation: Any) -> None:
        try:
            result = run_evidence_project_mutation(payload, operation)
        except EvidenceProjectConflictError as error:
            self._send_codes_conflict(error)
            return
        except EvidenceProjectOperationError as error:
            self._send_codes_operation_error(error)
            return
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_create(self) -> None:
        payload = self._read_json_payload()
        try:
            result = create_evidence_project(payload)
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_load(self) -> None:
        payload = self._read_json_payload()
        try:
            result = load_evidence_project(payload)
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_save(self) -> None:
        payload = self._read_json_payload()
        try:
            result = save_evidence_project(payload)
        except EvidenceProjectConflictError as error:
            self._send_codes_conflict(error)
            return
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_preview_transcript_import(self) -> None:
        payload = self._read_json_payload()
        try:
            result = run_evidence_project_read(payload, preview_transcript_import)
        except EvidenceProjectConflictError as error:
            self._send_codes_conflict(error)
            return
        except (ValueError, OSError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_export_bundle(self) -> None:
        payload = self._read_json_payload()
        try:
            result = run_evidence_project_read(payload, export_evidence_project_bundle)
        except EvidenceProjectConflictError as error:
            self._send_codes_conflict(error)
            return
        except (ValueError, OSError, RuntimeError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_import_transcripts(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, import_transcript_candidates)

    def _handle_codes_project_remove_transcript(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, remove_project_transcript)

    def _handle_codes_project_create_evidence(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, create_evidence_item)

    def _handle_codes_project_update_evidence(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, update_evidence_item)

    def _handle_codes_project_delete_evidence(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, delete_evidence_item)

    def _handle_codes_project_create_code(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, create_code)

    def _handle_codes_project_update_code(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, update_code)

    def _handle_codes_project_delete_code(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, delete_code)

    def _handle_codes_project_merge_code(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, merge_code)

    def _handle_codes_project_create_theme(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, create_theme)

    def _handle_codes_project_update_theme(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, update_theme)

    def _handle_codes_project_delete_theme(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, delete_theme)

    def _handle_codes_project_suggestion_decision(self) -> None:
        payload = self._read_json_payload()
        self._handle_codes_mutation(payload, record_ai_suggestion_decision)

    def _handle_codes_project_ai_run_start(self) -> None:
        payload = self._read_json_payload()
        run_id = f"ai_run_{uuid.uuid4().hex}"
        payload["_run_id"] = run_id
        try:
            result = run_evidence_project_mutation(payload, prepare_contextual_ai_run)
        except EvidenceProjectConflictError as error:
            contextual_ai_run_manager.discard(run_id)
            self._send_codes_conflict(error)
            return
        except EvidenceProjectOperationError as error:
            contextual_ai_run_manager.discard(run_id)
            self._send_codes_operation_error(error)
            return
        except (ValueError, OSError) as error:
            contextual_ai_run_manager.discard(run_id)
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        result["run"] = contextual_ai_run_manager.launch(run_id)
        self._send_json(HTTPStatus.OK, result)

    def _handle_codes_project_ai_run_status(self) -> None:
        payload = self._read_json_payload()
        try:
            run = contextual_ai_run_manager.snapshot_for_project(
                str(payload.get("project_id") or "").strip(),
                str(payload.get("run_id") or "").strip(),
            )
        except EvidenceProjectOperationError as error:
            self._send_codes_operation_error(error)
            return
        self._send_json(HTTPStatus.OK, {"run": run})

    def _handle_codes_project_ai_run_cancel(self) -> None:
        payload = self._read_json_payload()
        try:
            run = contextual_ai_run_manager.cancel_for_project(
                str(payload.get("project_id") or "").strip(),
                str(payload.get("run_id") or "").strip(),
            )
        except EvidenceProjectOperationError as error:
            self._send_codes_operation_error(error)
            return
        self._send_json(HTTPStatus.OK, {"run": run})

    def _handle_pick_folder(self) -> None:
        payload = self._read_json_payload()
        initial_directory = str(payload.get("initial_directory", "")).strip() or None
        try:
            selected_path = pick_folder(initial_directory)
        except RuntimeError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, {"selected_path": selected_path})

    def _handle_open_path(self) -> None:
        payload = self._read_json_payload()
        target_path = str(payload.get("path", "")).strip()
        expect_directory = bool(payload.get("expect_directory", False))
        create_if_missing = bool(payload.get("create_if_missing", False))
        try:
            opened_path = open_path(
                target_path,
                expect_directory=expect_directory,
                create_if_missing=create_if_missing,
            )
        except (RuntimeError, ValueError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.OK, {"opened_path": opened_path})

    def _handle_not_found(self) -> None:
        self._send_json(
            HTTPStatus.NOT_FOUND,
            {"error": "Not found", "path": self.path},
        )

    def _read_json_payload(self) -> dict[str, Any]:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise JsonPayloadError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length header.") from error
        if content_length > MAX_JSON_BODY_BYTES:
            raise JsonPayloadError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")
        if content_length <= 0:
            return {}
        raw_body = self.rfile.read(content_length)
        if not raw_body:
            return {}
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}


def run() -> None:
    start_hardware_scan()
    server = ThreadingHTTPServer((HOST, PORT), SidecarRequestHandler)
    print(f"{PRODUCT_NAME} sidecar listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
