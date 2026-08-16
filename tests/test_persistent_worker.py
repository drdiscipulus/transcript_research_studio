from __future__ import annotations

import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.sidecar_server.batch_artifacts import write_log
from backend.sidecar_server.batch_runner import BatchManager
from backend.sidecar_server.export_writer import ExportWriteError
from backend.sidecar_server.prompting_tables import load_table
from backend.sidecar_server.run_scan import ScanExclusion, ScanItem
from backend.sidecar_server.run_screen import PreparedBatch, PreparedExport
from backend.sidecar_server.transcription_types import (
    SegmentLine,
    TranscriptionResult,
    TranscriptionWorkerError,
)
from backend.transcription_worker import worker
from backend.transcription_protocol import TRANSCRIPTION_PROTOCOL_VERSION


def _result() -> TranscriptionResult:
    return TranscriptionResult(
        transcript="Hello",
        detected_language="en",
        engine="faster-whisper",
        model="small",
        device="cpu",
        used_fallback=False,
        note=None,
        speaker_summary=None,
        segments=[SegmentLine(start_seconds=0.0, end_seconds=1.0, text="Hello")],
        warnings=None,
    )


def _serialized_result() -> dict[str, object]:
    return {
        "status": "ok",
        "transcript": "Hello",
        "detected_language": "en",
        "engine": "faster-whisper",
        "model": "small",
        "device": "cpu",
        "used_fallback": False,
        "note": None,
        "speaker_summary": None,
        "warnings": [],
        "segments": [],
    }


def _prepared_batch(root: Path, file_count: int) -> PreparedBatch:
    files = [
        ScanItem(
            file_name=f"sample-{index:03d}.wav",
            extension="wav",
            size_bytes=128,
            modified_at="2026-07-17T12:00:00",
            duration_seconds=1.0,
            duration_label="0:01",
            file_info="WAV audio - 128 B",
            source_path=str(root / f"sample-{index:03d}.wav"),
        )
        for index in range(file_count)
    ]
    return PreparedBatch(
        batch_name="persistent-worker-test",
        file_count=file_count,
        total_duration_label=f"{file_count} seconds",
        export_targets=[],
        files=files,
        settings={
            "output_mode": "transcribe",
            "language": "auto",
            "model_name": "small",
            "acceleration": "cpu",
            "advanced_transcription": {},
            "input_folder": str(root),
            "transcript_output_folder": str(root),
            "export_formats": [],
            "transcript_layout": "file",
        },
    )


def _wait_for_terminal(manager: BatchManager, timeout_seconds: float = 5.0):
    deadline = time.monotonic() + timeout_seconds
    snapshot = manager.get_snapshot()
    while snapshot.status in {"starting", "running", "cancelling"} and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = manager.get_snapshot()
    return snapshot


class PersistentWorkerProtocolTests(unittest.TestCase):
    def test_json_lines_session_initializes_once_for_one_hundred_files(self) -> None:
        messages = [
            {
                "type": "init",
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": "init",
                "batch_name": "batch",
                "model_name": "small",
                "device_preference": "cpu",
            }
        ]
        messages.extend(
            {
                "type": "transcribe",
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": f"request-{index}",
                "media_path": f"sample-{index}.wav",
                "output_mode": "transcribe",
                "language": "auto",
            }
            for index in range(100)
        )
        messages.append(
            {
                "type": "shutdown",
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": "shutdown",
            }
        )
        stdin = io.StringIO("".join(json.dumps(message) + "\n" for message in messages))
        stdout = io.StringIO()

        with (
            patch.object(worker.sys, "stdin", stdin),
            patch.object(worker.sys, "stdout", stdout),
            patch.object(worker, "preload_transcription_runtime") as preload,
            patch.object(worker, "_run_transcription", return_value=_serialized_result()) as transcribe,
        ):
            preload.return_value.whisper_model_name = "small"
            preload.return_value.device = "cpu"
            preload.return_value.compute_type = "int8"
            exit_code = worker.session_main()

        responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(exit_code, 0)
        self.assertEqual(preload.call_count, 1)
        self.assertEqual(transcribe.call_count, 100)
        self.assertEqual(sum(response.get("type") == "result" for response in responses), 100)
        self.assertEqual(responses[0]["type"], "ready")
        self.assertEqual(responses[-1]["type"], "stopped")
        self.assertTrue(
            all(response["protocol_version"] == TRANSCRIPTION_PROTOCOL_VERSION for response in responses)
        )

    def test_successful_cuda_fallback_keeps_rest_of_session_on_cpu(self) -> None:
        messages = [
            {
                "type": "init",
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": "init",
                "batch_name": "batch",
                "model_name": "small",
                "device_preference": "cuda",
            },
            {"type": "transcribe", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "one", "media_path": "one.wav"},
            {"type": "transcribe", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "two", "media_path": "two.wav"},
            {"type": "shutdown", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "shutdown"},
        ]
        fallback = {**_serialized_result(), "used_fallback": True, "device": "cpu"}
        stdin = io.StringIO("".join(json.dumps(message) + "\n" for message in messages))

        with (
            patch.object(worker.sys, "stdin", stdin),
            patch.object(worker.sys, "stdout", io.StringIO()),
            patch.object(worker, "preload_transcription_runtime") as preload,
            patch.object(worker, "_run_transcription", side_effect=[fallback, _serialized_result()]) as transcribe,
        ):
            preload.return_value.whisper_model_name = "small"
            preload.return_value.device = "cuda"
            preload.return_value.compute_type = "float16"
            self.assertEqual(worker.session_main(), 0)

        self.assertEqual(transcribe.call_args_list[0].args[0]["device_preference"], "cuda")
        self.assertEqual(transcribe.call_args_list[1].args[0]["device_preference"], "cpu")

    def test_per_file_error_does_not_stop_json_lines_session(self) -> None:
        messages = [
            {"type": "init", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "init", "model_name": "small"},
            {"type": "transcribe", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "bad", "media_path": "bad.wav"},
            {"type": "transcribe", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "good", "media_path": "good.wav"},
            {"type": "shutdown", "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "shutdown"},
        ]
        stdin = io.StringIO("".join(json.dumps(message) + "\n" for message in messages))
        stdout = io.StringIO()

        with (
            patch.object(worker.sys, "stdin", stdin),
            patch.object(worker.sys, "stdout", stdout),
            patch.object(worker, "preload_transcription_runtime") as preload,
            patch.object(
                worker,
                "_run_transcription",
                side_effect=[RuntimeError("bad media"), _serialized_result()],
            ),
        ):
            preload.return_value.whisper_model_name = "small"
            preload.return_value.device = "cpu"
            preload.return_value.compute_type = "int8"
            self.assertEqual(worker.session_main(), 0)

        responses = {response.get("request_id"): response for response in map(json.loads, stdout.getvalue().splitlines())}
        self.assertEqual(responses["bad"]["type"], "error")
        self.assertEqual(responses["good"]["type"], "result")
        self.assertEqual(responses["shutdown"]["type"], "stopped")


class PersistentBatchTests(unittest.TestCase):
    def test_new_start_waits_for_previous_cleanup_before_publishing_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = BatchManager()
            with manager._lock:
                manager._state.batch_id = "previous-batch"
                manager._state.status = "completed"
                manager._state.message = "Previous batch completed."

            join_entered = threading.Event()
            release_cleanup = threading.Event()
            cleanup_observations: list[tuple[str | None, str]] = []

            class PreviousWorker:
                def is_alive(self) -> bool:
                    return True

                def join(self) -> None:
                    join_entered.set()
                    release_cleanup.wait(timeout=2)
                    with manager._lock:
                        cleanup_observations.append((manager._state.batch_id, manager._state.status))
                        manager._state.message = "Previous cleanup finished."

            manager._worker_thread = PreviousWorker()  # type: ignore[assignment]
            prepared = _prepared_batch(root, 1)
            start_errors: list[BaseException] = []

            def start_new_batch() -> None:
                try:
                    manager.start_batch({})
                except BaseException as error:  # pragma: no cover - assertion reports the error
                    start_errors.append(error)

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared) as prepare_mock,
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    side_effect=OSError("stop after start"),
                ),
            ):
                starter = threading.Thread(target=start_new_batch)
                starter.start()
                self.assertTrue(join_entered.wait(timeout=2))
                with manager._lock:
                    self.assertEqual(manager._state.batch_id, "previous-batch")
                    self.assertEqual(manager._state.status, "completed")
                self.assertEqual(prepare_mock.call_count, 0)
                with self.assertRaisesRegex(ValueError, "already running"):
                    manager.start_batch({})
                self.assertEqual(prepare_mock.call_count, 0)

                release_cleanup.set()
                starter.join(timeout=2)
                snapshot = _wait_for_terminal(manager)

            self.assertFalse(starter.is_alive())
            self.assertEqual(start_errors, [])
            self.assertEqual(cleanup_observations, [("previous-batch", "completed")])
            self.assertNotEqual(snapshot.batch_id, "previous-batch")
            self.assertEqual(prepare_mock.call_count, 1)

    def test_preparation_failure_restores_post_cleanup_snapshot(self) -> None:
        manager = BatchManager()
        with manager._lock:
            manager._state.batch_id = "previous-batch"
            manager._state.status = "completed"
            manager._state.message = "Before final cleanup."

        class PreviousWorker:
            def is_alive(self) -> bool:
                return True

            def join(self) -> None:
                with manager._lock:
                    manager._state.message = "Final cleanup snapshot."

        manager._worker_thread = PreviousWorker()  # type: ignore[assignment]
        with (
            patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=ValueError("invalid input")),
            self.assertRaisesRegex(ValueError, "invalid input"),
        ):
            manager.start_batch({})

        snapshot = manager.get_snapshot()
        self.assertEqual(snapshot.batch_id, "previous-batch")
        self.assertEqual(snapshot.status, "completed")
        self.assertEqual(snapshot.message, "Final cleanup snapshot.")

    def test_concurrent_start_is_rejected_before_second_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            preparation_entered = threading.Event()
            release_preparation = threading.Event()
            first_error: list[BaseException] = []

            def prepare(_payload):
                preparation_entered.set()
                release_preparation.wait(timeout=2)
                return prepared

            def start_first() -> None:
                try:
                    manager.start_batch({})
                except BaseException as error:  # pragma: no cover - assertion reports the captured error
                    first_error.append(error)

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=prepare) as prepare_mock,
                patch("backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories", side_effect=OSError("stop")),
            ):
                first_thread = threading.Thread(target=start_first)
                first_thread.start()
                self.assertTrue(preparation_entered.wait(timeout=2))
                with self.assertRaisesRegex(ValueError, "already running"):
                    manager.start_batch({})
                release_preparation.set()
                first_thread.join(timeout=2)
                _wait_for_terminal(manager)

            self.assertEqual(first_error, [])
            self.assertEqual(prepare_mock.call_count, 1)

    def test_preparation_failure_restores_previous_trustworthy_snapshot(self) -> None:
        manager = BatchManager()
        before = manager.get_snapshot().to_dict()

        with (
            patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=ValueError("invalid input")),
            self.assertRaisesRegex(ValueError, "invalid input"),
        ):
            manager.start_batch({})

        self.assertEqual(manager.get_snapshot().to_dict(), before)

    def test_cancellation_during_starting_skips_queue_without_starting_worker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            manager = BatchManager()
            observed_statuses: list[str] = []

            def prepare(_payload):
                manager.cancel_current_batch()
                return prepared

            def capture_log(*, snapshot, **_kwargs):
                observed_statuses.append(snapshot.status)

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=prepare),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_artifacts.write_log", side_effect=capture_log),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "cancelled")
            self.assertEqual(snapshot.counts["skipped"], 3)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual(snapshot.files_completed, 3)
            self.assertEqual(snapshot.progress_percent, 100)
            self.assertNotIn("running", observed_statuses)
            session_type.assert_not_called()

    def test_cancellation_during_blocked_preparation_uses_setup_message_without_termination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            preparation_entered = threading.Event()
            release_preparation = threading.Event()

            def prepare(_payload):
                preparation_entered.set()
                release_preparation.wait(timeout=2)
                return prepared

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=prepare),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                starter = threading.Thread(target=lambda: manager.start_batch({}))
                starter.start()
                self.assertTrue(preparation_entered.wait(timeout=2))

                cancelling_snapshot = manager.cancel_current_batch()
                self.assertEqual(cancelling_snapshot.status, "cancelling")
                self.assertEqual(cancelling_snapshot.message, "Cancellation requested. Stopping batch setup.")

                release_preparation.set()
                starter.join(timeout=2)
                snapshot = _wait_for_terminal(manager)

            self.assertFalse(starter.is_alive())
            self.assertEqual(snapshot.status, "cancelled")
            session_type.assert_not_called()

    def test_cancellation_before_session_construction_uses_setup_message_without_termination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            construction_entered = threading.Event()
            release_construction = threading.Event()
            session = MagicMock()

            def construct_session(*_args, **_kwargs):
                construction_entered.set()
                release_construction.wait(timeout=2)
                return session

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch.object(manager, "_new_worker_session", side_effect=construct_session),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                self.assertTrue(construction_entered.wait(timeout=2))

                cancelling_snapshot = manager.cancel_current_batch()
                self.assertEqual(cancelling_snapshot.status, "cancelling")
                self.assertEqual(cancelling_snapshot.message, "Cancellation requested. Stopping batch setup.")
                session.terminate.assert_not_called()

                release_construction.set()
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "cancelled")
            session.terminate.assert_not_called()

    def test_batch_stays_starting_until_worker_initialization_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            initialization_entered = threading.Event()
            release_initialization = threading.Event()
            transcribe_statuses: list[str] = []
            session = MagicMock()

            def initialize() -> None:
                initialization_entered.set()
                release_initialization.wait(timeout=2)

            def transcribe(**_kwargs):
                transcribe_statuses.append(manager.get_snapshot().status)
                return _result()

            session.start.side_effect = initialize
            session.transcribe.side_effect = transcribe
            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession", return_value=session),
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                self.assertTrue(initialization_entered.wait(timeout=2))
                initializing_snapshot = manager.get_snapshot()
                self.assertEqual(initializing_snapshot.status, "starting")
                self.assertIsNone(initializing_snapshot.current_file_name)

                release_initialization.set()
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "completed")
            self.assertEqual(transcribe_statuses, ["running"])
            session.close.assert_called_once_with()

    def test_cancellation_during_worker_initialization_terminates_and_skips_queue(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            manager = BatchManager()
            initialization_entered = threading.Event()
            termination_requested = threading.Event()
            observed_statuses: list[str] = []
            session = MagicMock()

            def initialize() -> None:
                initialization_entered.set()
                termination_requested.wait(timeout=2)
                raise TranscriptionWorkerError("initialization stopped", error_code="worker_crashed")

            def terminate() -> None:
                termination_requested.set()

            def capture_log(*, snapshot, **_kwargs) -> None:
                observed_statuses.append(snapshot.status)

            session.start.side_effect = initialize
            session.terminate.side_effect = terminate
            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession", return_value=session),
                patch("backend.sidecar_server.batch_artifacts.write_log", side_effect=capture_log),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                self.assertTrue(initialization_entered.wait(timeout=2))
                self.assertEqual(manager.get_snapshot().status, "starting")
                cancelling_snapshot = manager.cancel_current_batch()
                self.assertEqual(cancelling_snapshot.status, "cancelling")
                self.assertEqual(cancelling_snapshot.message, "Cancellation requested. Stopping batch setup.")
                self.assertTrue(termination_requested.wait(timeout=1))
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "cancelled")
            self.assertEqual(snapshot.counts["skipped"], 3)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual(snapshot.files_completed, 3)
            self.assertEqual(snapshot.progress_percent, 100)
            self.assertIsNone(snapshot.current_file_name)
            self.assertNotIn("running", observed_statuses)
            session.transcribe.assert_not_called()
            session.terminate.assert_called_once_with()
            session.close.assert_called_once_with()

    def test_thread_start_failure_finalizes_and_allows_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = _prepared_batch(root, 2)
            manager = BatchManager()
            failed_thread = MagicMock()
            failed_thread.start.side_effect = RuntimeError("thread unavailable")

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.threading.Thread", return_value=failed_thread),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
            ):
                snapshot = manager.start_batch({})

            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.error_code, "batch_thread_start_failed")
            self.assertEqual(snapshot.counts["failed"], 2)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual(snapshot.files_completed, 2)
            self.assertEqual(snapshot.progress_percent, 100)
            self.assertTrue(snapshot.finished_at)
            session_type.assert_not_called()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", side_effect=ValueError("retry reached")),
                self.assertRaisesRegex(ValueError, "retry reached"),
            ):
                manager.start_batch({})

    def test_runtime_path_failure_always_finalizes_batch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = _prepared_batch(root, 2)
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    side_effect=OSError("logs unavailable for hf_secretvalue123"),
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.error_code, "internal_error")
            self.assertEqual(snapshot.counts["failed"], 2)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual(snapshot.files_completed, 2)
            self.assertEqual(snapshot.progress_percent, 100)
            self.assertTrue(snapshot.finished_at)
            self.assertIsNone(snapshot.log_file)
            self.assertNotIn("hf_secretvalue123", snapshot.message)

    def test_exclusions_are_retained_in_snapshot_log_and_optional_overview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            overview_path = root / "batch_overview.xlsx"
            prepared.export_targets.append(
                PreparedExport(format="xlsx", path=str(overview_path), exists=False, role="batch_overview")
            )
            prepared.exclusions.append(
                ScanExclusion(
                    file_name="corrupt.wav",
                    source_path=str(root / "corrupt.wav"),
                    extension="wav",
                    size_bytes=4,
                    code="unreadable_media",
                    message="The media container could not be opened.",
                )
            )
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.return_value = _result()
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            overview_rows = load_table(overview_path)["rows"]
            log_text = Path(snapshot.log_file or "").read_text(encoding="utf-8")
            self.assertEqual(snapshot.status, "completed_with_warnings")
            self.assertEqual(snapshot.counts["done"], 1)
            self.assertEqual(snapshot.counts["excluded"], 1)
            self.assertEqual(snapshot.exclusions[0].code, "unreadable_media")
            self.assertEqual(overview_rows[0]["status"], "excluded")
            self.assertEqual(overview_rows[0]["source_media_file"], "corrupt.wav")
            self.assertIn("Excluded: corrupt.wav", log_text)
            self.assertIn(f"Created output: {overview_path}", log_text)

    def test_one_worker_session_handles_one_hundred_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 100)
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.return_value = _result()
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "completed")
            self.assertEqual(snapshot.counts["done"], 100)
            self.assertEqual(snapshot.counts["failed"], 0)
            self.assertEqual(session_type.call_count, 1)
            self.assertEqual(session_type.return_value.start.call_count, 1)
            self.assertEqual(session_type.return_value.transcribe.call_count, 100)
            self.assertEqual(session_type.return_value.close.call_count, 1)

    def test_worker_crash_fails_active_file_and_restarts_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            first_session = MagicMock()
            first_session.transcribe.side_effect = TranscriptionWorkerError(
                "worker stopped",
                error_code="worker_crashed",
            )
            restarted_session = MagicMock()
            restarted_session.transcribe.return_value = _result()
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_runner.TranscriptionWorkerSession",
                    side_effect=[first_session, restarted_session],
                ) as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]) as write_exports,
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "completed_with_warnings")
            self.assertEqual(snapshot.counts["failed"], 1)
            self.assertEqual(snapshot.counts["done"], 2)
            self.assertEqual(snapshot.files[0].error_code, "worker_crashed")
            self.assertEqual(session_type.call_count, 2)
            self.assertEqual(restarted_session.transcribe.call_count, 2)
            self.assertEqual(write_exports.call_count, 2)
            self.assertEqual(first_session.close.call_count, 1)
            self.assertEqual(restarted_session.close.call_count, 1)

    def test_cancellation_during_worker_crash_prevents_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            manager = BatchManager()
            failed_session = MagicMock()

            def cancel_then_crash(**_kwargs):
                manager.cancel_current_batch()
                raise TranscriptionWorkerError("worker stopped", error_code="worker_crashed")

            failed_session.transcribe.side_effect = cancel_then_crash
            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_runner.TranscriptionWorkerSession",
                    return_value=failed_session,
                ) as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "cancelled")
            self.assertEqual(snapshot.counts["failed"], 1)
            self.assertEqual(snapshot.counts["skipped"], 2)
            self.assertEqual(session_type.call_count, 1)
            self.assertEqual(failed_session.close.call_count, 1)

    def test_protocol_failure_stops_batch_without_exports_or_hidden_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            manager = BatchManager()
            failed_session = MagicMock()
            failed_session.transcribe.side_effect = TranscriptionWorkerError(
                "invalid worker response",
                error_code="worker_protocol_error",
            )

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_runner.TranscriptionWorkerSession",
                    return_value=failed_session,
                ) as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports") as write_exports,
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.counts["failed"], 3)
            self.assertEqual(snapshot.files[0].error_code, "worker_protocol_error")
            self.assertEqual(session_type.call_count, 1)
            self.assertEqual(failed_session.close.call_count, 1)
            write_exports.assert_not_called()

    def test_cpu_fallback_persists_across_worker_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            prepared.settings["acceleration"] = "cuda"
            fallback_result = _result()
            fallback_result.used_fallback = True
            first_session = MagicMock()
            first_session.transcribe.side_effect = [
                fallback_result,
                TranscriptionWorkerError("worker stopped", error_code="worker_crashed"),
            ]
            restarted_session = MagicMock()
            restarted_session.transcribe.return_value = _result()
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_runner.TranscriptionWorkerSession",
                    side_effect=[first_session, restarted_session],
                ) as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "completed_with_warnings")
            self.assertEqual(snapshot.counts["done"], 2)
            self.assertEqual(snapshot.counts["failed"], 1)
            self.assertEqual(session_type.call_args_list[0].kwargs["device_preference"], "cuda")
            self.assertEqual(session_type.call_args_list[1].kwargs["device_preference"], "cpu")

    def test_same_timestamp_batches_use_distinct_log_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch("backend.sidecar_server.batch_artifacts._safe_timestamp", return_value="fixed-time"),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.return_value = _result()
                manager.start_batch({})
                first_snapshot = _wait_for_terminal(manager)
                first_log = Path(first_snapshot.log_file or "")
                deadline = time.monotonic() + 2
                while (
                    (not first_log.exists() or "Status: completed" not in first_log.read_text(encoding="utf-8"))
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)

                manager.start_batch({})
                second_snapshot = _wait_for_terminal(manager)
                second_log = Path(second_snapshot.log_file or "")

            self.assertNotEqual(first_log, second_log)
            self.assertTrue(first_log.exists())
            self.assertTrue(second_log.exists())

    def test_processing_transition_is_logged_before_transcription(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            observed_log_text: list[str] = []

            def inspect_processing_log(**_kwargs):
                log_files = list(logs.glob("*.log"))
                self.assertEqual(len(log_files), 1)
                observed_log_text.append(log_files[0].read_text(encoding="utf-8"))
                return _result()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.side_effect = inspect_processing_log
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)
                self.assertTrue(snapshot.log_file)
                log_file = Path(str(snapshot.log_file))
                deadline = time.monotonic() + 2
                while (
                    (
                        not log_file.exists()
                        or "Status: completed" not in log_file.read_text(encoding="utf-8")
                    )
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)

            self.assertEqual(snapshot.status, "completed")
            self.assertEqual(len(observed_log_text), 1)
            self.assertIn("File: sample-000.wav | status=processing", observed_log_text[0])

    def test_unexpected_failure_after_worker_start_closes_owned_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            manager = BatchManager()
            session = MagicMock()
            log_calls = 0

            def fail_processing_log(**_kwargs):
                nonlocal log_calls
                log_calls += 1
                if log_calls == 2:
                    raise OSError("log failed")

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession", return_value=session),
                patch("backend.sidecar_server.batch_artifacts.write_log", side_effect=fail_processing_log),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(session.close.call_count, 1)

    def test_snapshot_clones_are_independently_mutable(self) -> None:
        manager = BatchManager()
        first = manager.get_snapshot()
        second = manager.get_snapshot()

        first.counts["done"] = 99
        first.warnings.append("changed")

        self.assertEqual(second.counts["done"], 0)
        self.assertEqual(second.warnings, [])

    def test_atomic_log_failure_preserves_previous_complete_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log_file = root / "batch.log"
            log_file.write_text("previous complete snapshot\n", encoding="utf-8")
            prepared = _prepared_batch(root, 1)
            snapshot = BatchManager().get_snapshot()

            with (
                patch(
                    "backend.sidecar_server.batch_artifacts.os.replace",
                    side_effect=OSError("replace interrupted"),
                ),
                self.assertRaises(OSError),
            ):
                write_log(log_file=log_file, snapshot=snapshot, prepared_batch=prepared)

            self.assertEqual(log_file.read_text(encoding="utf-8"), "previous complete snapshot\n")
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def test_partial_export_failure_reports_only_committed_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 1)
            file_name = prepared.files[0].file_name
            json_path = root / "sample-000.json"
            csv_path = root / "sample-000.csv"
            overview_path = root / "batch_overview.xlsx"
            prepared.export_targets.extend(
                [
                    PreparedExport(
                        format="json",
                        path=str(json_path),
                        exists=False,
                        file_name=file_name,
                        role="transcript",
                    ),
                    PreparedExport(
                        format="csv",
                        path=str(csv_path),
                        exists=False,
                        file_name=file_name,
                        role="transcript",
                    ),
                    PreparedExport(
                        format="xlsx",
                        path=str(overview_path),
                        exists=False,
                        role="batch_overview",
                    ),
                ]
            )
            manager = BatchManager()

            def fail_after_json(**_kwargs):
                json_path.write_text("{}", encoding="utf-8")
                raise ExportWriteError(
                    export_format="csv",
                    failed_path=str(csv_path),
                    written_paths=[str(json_path)],
                    cause=OSError("disk full"),
                )

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch(
                    "backend.sidecar_server.batch_runner.write_single_document_exports",
                    side_effect=fail_after_json,
                ),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.return_value = _result()
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            outputs_by_format = {output.format: output for output in snapshot.output_files}
            overview_rows = load_table(overview_path)["rows"]
            failed_row = next(row for row in overview_rows if row["status"] == "failed")
            log_text = Path(snapshot.log_file or "").read_text(encoding="utf-8")
            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.files[0].error_code, "export_failed")
            self.assertTrue(outputs_by_format["json"].exists)
            self.assertFalse(outputs_by_format["csv"].exists)
            self.assertEqual(failed_row["json_path"], str(json_path))
            self.assertEqual(failed_row["csv_path"], "")
            self.assertIn(f"Created output: {json_path}", log_text)
            self.assertNotIn(f"Created output: {csv_path}", log_text)

    def test_cancellation_finishes_active_file_and_skips_queued_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            manager = BatchManager()

            cancellation_messages: list[str] = []

            def finish_active_file(**_kwargs):
                cancellation_messages.append(manager.cancel_current_batch().message)
                return _result()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.side_effect = finish_active_file
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "cancelled")
            self.assertEqual(snapshot.counts["done"], 1)
            self.assertEqual(snapshot.counts["skipped"], 2)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual([file.status for file in snapshot.files], ["done", "skipped", "skipped"])
            self.assertEqual(session_type.return_value.transcribe.call_count, 1)
            self.assertEqual(
                cancellation_messages,
                ["Cancellation requested. Finishing the current file before stopping."],
            )
            session_type.return_value.terminate.assert_not_called()
            self.assertEqual(session_type.return_value.close.call_count, 1)
            self.assertTrue(snapshot.finished_at)

    def test_failed_restart_marks_remaining_queue_failed_and_finalizes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            first_session = MagicMock()
            first_session.transcribe.side_effect = TranscriptionWorkerError(
                "worker stopped",
                error_code="worker_crashed",
            )
            restarted_session = MagicMock()
            restarted_session.start.side_effect = TranscriptionWorkerError(
                "restart failed",
                error_code="worker_crashed",
            )
            manager = BatchManager()

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch(
                    "backend.sidecar_server.batch_runner.TranscriptionWorkerSession",
                    side_effect=[first_session, restarted_session],
                ),
                patch("backend.sidecar_server.batch_runner.write_single_document_exports", return_value=[]),
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "failed")
            self.assertEqual(snapshot.counts["failed"], 3)
            self.assertEqual(snapshot.counts["queued"], 0)
            self.assertEqual(snapshot.progress_percent, 100)
            self.assertTrue(snapshot.finished_at)
            self.assertEqual(first_session.close.call_count, 1)
            self.assertEqual(restarted_session.close.call_count, 1)

    def test_combined_output_checkpoints_documents_in_input_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            prepared = _prepared_batch(root, 3)
            combined_path = root / "study.json"
            prepared.settings["output_organization"] = "combined_file"
            prepared.settings["export_formats"] = ["json"]
            prepared.export_targets = [
                PreparedExport(
                    format="json",
                    path=str(combined_path),
                    exists=False,
                    role="combined_transcript",
                )
            ]
            manager = BatchManager()
            checkpoint_names: list[list[str]] = []

            def checkpoint_documents(*, documents, **_kwargs):
                checkpoint_names.append([document["file_name"] for document in documents])
                combined_path.write_text("checkpoint", encoding="utf-8")
                return [str(combined_path)]

            with (
                patch("backend.sidecar_server.batch_runner.prepare_batch", return_value=prepared),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as session_type,
                patch(
                    "backend.sidecar_server.batch_runner.write_combined_document_exports",
                    side_effect=checkpoint_documents,
                ) as combined_writer,
                patch("backend.sidecar_server.batch_runner.write_single_document_exports") as separate_writer,
                patch("backend.sidecar_server.batch_runner.transcription_worker_timeout_seconds", return_value=1),
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs, "temp": root},
                ),
            ):
                session_type.return_value.transcribe.return_value = _result()
                manager.start_batch({})
                snapshot = _wait_for_terminal(manager)

            self.assertEqual(snapshot.status, "completed")
            self.assertEqual(snapshot.counts["done"], 3)
            self.assertTrue(snapshot.output_files[0].exists)
            self.assertEqual(
                checkpoint_names,
                [
                    ["sample-000.wav"],
                    ["sample-000.wav", "sample-001.wav"],
                    ["sample-000.wav", "sample-001.wav", "sample-002.wav"],
                ],
            )
            self.assertEqual(combined_writer.call_count, 3)
            separate_writer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
