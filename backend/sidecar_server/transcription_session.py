from __future__ import annotations

import collections
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from backend.transcription_protocol import (
    PROTOCOL_ERROR_CODE,
    RESPONSE_MESSAGE_TYPES,
    TRANSCRIPTION_PROTOCOL_VERSION,
    TranscriptionProtocolError,
    validate_message_envelope,
)

from .pyannote_diarization import redact_secret
from .transcription_formatting import (
    normalize_optional_text,
    segments_from_serialized_result,
)
from .transcription_types import (
    TranscriptionConfigurationError,
    TranscriptionResult,
    TranscriptionWorkerError,
)


_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_STDERR_LINE_LIMIT = 200
_PROCESS_POLL_INTERVAL_SECONDS = 0.1


class TranscriptionWorkerSession:
    """Own one isolated ML worker for a batch and exchange versioned JSON lines."""

    def __init__(
        self,
        *,
        batch_name: str,
        model_name: str,
        device_preference: str,
        advanced_settings: dict[str, Any] | None,
        init_timeout_seconds: int = 300,
    ) -> None:
        self.batch_name = batch_name
        self.model_name = model_name
        self.device_preference = device_preference
        self.advanced_settings = advanced_settings
        self.init_timeout_seconds = init_timeout_seconds
        self._process: subprocess.Popen[str] | None = None
        self._messages: queue.Queue[dict[str, Any] | TranscriptionWorkerError] = queue.Queue()
        self._stderr: collections.deque[str] = collections.deque(maxlen=_STDERR_LINE_LIMIT)
        self._write_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._termination_requested = threading.Event()
        self.device = device_preference

    def start(self) -> None:
        if self._termination_requested.is_set():
            raise self._termination_error()
        exited_process: subprocess.Popen[str] | None = None
        with self._lifecycle_lock:
            if self._process is not None:
                if self._process.poll() is None:
                    return
                exited_process = self._process
                self._process = None
        if exited_process is not None:
            self._close_process_pipes(exited_process)
            raise TranscriptionWorkerError(
                self._worker_exit_message(exited_process),
                error_code="worker_crashed",
            )
        messages: queue.Queue[dict[str, Any] | TranscriptionWorkerError] = queue.Queue()
        stderr: collections.deque[str] = collections.deque(maxlen=_STDERR_LINE_LIMIT)
        self._messages = messages
        self._stderr = stderr
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "backend.transcription_worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=str(_PROJECT_ROOT),
                env=env,
            )
        except OSError as error:
            raise TranscriptionConfigurationError(
                f"The transcription worker could not be started from {sys.executable}: {error}"
            ) from error
        with self._lifecycle_lock:
            if self._termination_requested.is_set():
                terminate_before_assignment = True
            else:
                self._process = process
                terminate_before_assignment = False
        if terminate_before_assignment:
            self._terminate_process(process)
            raise self._termination_error()
        try:
            if self._termination_requested.is_set():
                raise self._termination_error()
            stdout_reader = threading.Thread(
                target=self._read_stdout,
                args=(process, messages),
                daemon=True,
                name="transcription-worker-stdout",
            )
            stderr_reader = threading.Thread(
                target=self._read_stderr,
                args=(process, stderr),
                daemon=True,
                name="transcription-worker-stderr",
            )
            stdout_reader.start()
            stderr_reader.start()

            request_id = f"init-{uuid.uuid4().hex}"
            self._send(
                {
                    "type": "init",
                    "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                    "request_id": request_id,
                    "batch_name": self.batch_name,
                    "model_name": self.model_name,
                    "device_preference": self.device_preference,
                    "advanced_settings": self.advanced_settings,
                }
            )
            response = self._await_response(request_id, timeout_seconds=self.init_timeout_seconds)
            self._raise_for_error(response)
            self._require_response_type(response, "ready")
            if (
                self._termination_requested.is_set()
                or self._process is not process
                or process.poll() is not None
            ):
                raise self._termination_error()
            self.device = str(response.get("device") or self.device_preference)
        except Exception:
            self.terminate()
            raise

    def transcribe(
        self,
        *,
        media_path: Path,
        output_mode: str,
        language: str,
        timeout_seconds: int,
    ) -> TranscriptionResult:
        if self._process is None:
            raise TranscriptionWorkerError(
                "The transcription worker is not initialized.",
                error_code="worker_crashed",
            )
        request_id = uuid.uuid4().hex
        self._send(
            {
                "type": "transcribe",
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": request_id,
                "media_path": str(media_path),
                "output_mode": output_mode,
                "language": language,
            }
        )
        try:
            response = self._await_response(request_id, timeout_seconds=timeout_seconds)
        except TimeoutError as error:
            self.terminate()
            raise TranscriptionWorkerError(
                f"Transcription timed out for {media_path.name}.",
                error_code="worker_timeout",
            ) from error
        except TranscriptionWorkerError:
            self.terminate()
            raise
        try:
            self._raise_for_error(response)
            self._require_response_type(response, "result")
            return _result_from_payload(response, model_name=self.model_name, language=language)
        except TranscriptionWorkerError as error:
            if error.error_code == PROTOCOL_ERROR_CODE:
                self.terminate()
            raise

    def close(self) -> None:
        process = self._process
        if process is None:
            return
        if process.poll() is None:
            request_id = f"shutdown-{uuid.uuid4().hex}"
            try:
                self._send(
                    {
                        "type": "shutdown",
                        "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                        "request_id": request_id,
                    }
                )
                response = self._await_response(request_id, timeout_seconds=10)
                self._raise_for_error(response)
                self._require_response_type(response, "stopped")
            except (OSError, RuntimeError, TimeoutError, TranscriptionWorkerError):
                pass
        self.terminate()

    def terminate(self) -> None:
        self._termination_requested.set()
        with self._lifecycle_lock:
            process = self._process
            self._process = None
        if process is None:
            return
        self._terminate_process(process)

    def _terminate_process(self, process: subprocess.Popen[str]) -> None:
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
        except OSError:
            pass
        finally:
            self._close_process_pipes(process)

    def _close_process_pipes(self, process: subprocess.Popen[str]) -> None:
        for stream_name in ("stdin", "stdout", "stderr"):
            stream = getattr(process, stream_name, None)
            if stream is None:
                continue
            try:
                stream.close()
            except (OSError, ValueError):
                pass

    def _termination_error(self) -> TranscriptionWorkerError:
        return TranscriptionWorkerError(
            "The transcription worker was terminated before initialization completed.",
            error_code="worker_crashed",
        )

    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

    def _send(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise TranscriptionWorkerError(
                self._worker_exit_message(),
                error_code="worker_crashed",
            )
        serialized = json.dumps(payload, ensure_ascii=False)
        try:
            with self._write_lock:
                process.stdin.write(serialized + "\n")
                process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise TranscriptionWorkerError(
                self._worker_exit_message(),
                error_code="worker_crashed",
            ) from error

    def _await_response(self, request_id: str, *, timeout_seconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + max(float(timeout_seconds), 1.0)
        while True:
            if self._termination_requested.is_set():
                raise self._termination_error()
            try:
                message = self._messages.get_nowait()
            except queue.Empty:
                message = None

            if message is not None:
                return self._validate_response(message, request_id=request_id)

            process = self._process
            if process is None:
                raise TranscriptionWorkerError("The transcription worker is not running.", error_code="worker_crashed")
            if process.poll() is not None:
                raise TranscriptionWorkerError(self._worker_exit_message(), error_code="worker_crashed")

            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise TimeoutError(f"Timed out waiting for worker response {request_id}.")

            try:
                message = self._messages.get(
                    timeout=min(_PROCESS_POLL_INTERVAL_SECONDS, remaining_seconds)
                )
            except queue.Empty as error:
                if self._termination_requested.is_set():
                    raise self._termination_error() from error
                if process.poll() is not None:
                    raise TranscriptionWorkerError(self._worker_exit_message(), error_code="worker_crashed") from error
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for worker response {request_id}.") from error
                continue
            return self._validate_response(message, request_id=request_id)

    def _validate_response(
        self,
        message: dict[str, Any] | TranscriptionWorkerError,
        *,
        request_id: str,
    ) -> dict[str, Any]:
        if isinstance(message, TranscriptionWorkerError):
            raise message
        try:
            _message_type, message_request_id = validate_message_envelope(
                message,
                supported_types=RESPONSE_MESSAGE_TYPES,
            )
        except TranscriptionProtocolError as error:
            raise TranscriptionWorkerError(str(error), error_code=PROTOCOL_ERROR_CODE) from error
        if message_request_id != request_id:
            raise TranscriptionWorkerError(
                "The transcription worker returned a response for an unexpected request.",
                error_code=PROTOCOL_ERROR_CODE,
            )
        return message

    def _raise_for_error(self, response: dict[str, Any]) -> None:
        if str(response.get("status") or "") == "ok":
            return
        message = redact_secret(str(response.get("message") or self._worker_exit_message()))
        error_code = str(response.get("error_code") or "internal_error")
        if str(response.get("error_kind") or "") == "configuration":
            raise TranscriptionConfigurationError(message, error_code=error_code)
        raise TranscriptionWorkerError(message, error_code=error_code)

    def _require_response_type(self, response: dict[str, Any], expected_type: str) -> None:
        if response.get("type") != expected_type:
            raise TranscriptionWorkerError(
                f"The transcription worker returned an unexpected response instead of {expected_type}.",
                error_code=PROTOCOL_ERROR_CODE,
            )

    def _worker_exit_message(self, process: subprocess.Popen[str] | None = None) -> str:
        process = self._process if process is None else process
        exit_code = process.poll() if process is not None else None
        detail = redact_secret(self.stderr_tail().strip())
        suffix = f" Details: {detail[-1000:]}" if detail else ""
        return f"The transcription worker stopped unexpectedly (exit code {exit_code}).{suffix}"

    def _read_stdout(
        self,
        process: subprocess.Popen[str],
        messages: queue.Queue[dict[str, Any] | TranscriptionWorkerError],
    ) -> None:
        if process.stdout is None:
            return
        try:
            for line in process.stdout:
                payload = line.strip()
                if not payload:
                    continue
                try:
                    message = json.loads(payload)
                except json.JSONDecodeError:
                    messages.put(
                        TranscriptionWorkerError(
                            "The transcription worker returned invalid JSON output.",
                            error_code=PROTOCOL_ERROR_CODE,
                        )
                    )
                    return
                if not isinstance(message, dict):
                    messages.put(
                        TranscriptionWorkerError(
                            "The transcription worker returned a non-object response.",
                            error_code=PROTOCOL_ERROR_CODE,
                        )
                    )
                    return
                messages.put(message)
        except (OSError, ValueError):
            return

    def _read_stderr(
        self,
        process: subprocess.Popen[str],
        stderr: collections.deque[str],
    ) -> None:
        if process.stderr is None:
            return
        try:
            for line in process.stderr:
                cleaned = line.rstrip()
                if cleaned:
                    stderr.append(cleaned)
        except (OSError, ValueError):
            return


def _result_from_payload(response: dict[str, Any], *, model_name: str, language: str) -> TranscriptionResult:
    if not isinstance(response.get("transcript"), str) or not isinstance(response.get("segments"), list):
        raise TranscriptionWorkerError(
            "The transcription worker returned an invalid result payload.",
            error_code=PROTOCOL_ERROR_CODE,
        )
    warnings = (
        [str(value) for value in response.get("warnings", []) if str(value).strip()]
        if isinstance(response.get("warnings"), list)
        else None
    )
    return TranscriptionResult(
        transcript=str(response.get("transcript") or ""),
        detected_language=str(response.get("detected_language") or language or "unknown"),
        engine=str(response.get("engine") or "faster-whisper"),
        model=str(response.get("model") or model_name),
        device=str(response.get("device") or "cpu"),
        used_fallback=bool(response.get("used_fallback", False)),
        note=normalize_optional_text(response.get("note")),
        speaker_summary=normalize_optional_text(response.get("speaker_summary")),
        segments=segments_from_serialized_result(response.get("segments")),
        warnings=warnings,
    )
