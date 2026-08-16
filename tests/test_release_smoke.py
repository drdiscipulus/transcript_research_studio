from __future__ import annotations

import csv
import json
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.batch_runner import BatchManager
from backend.sidecar_server.prompting import PromptingManager
from backend.sidecar_server.prompting_transcripts import inspect_prompting_input
from backend.sidecar_server.run_hardware import HardwareSummary
from backend.sidecar_server.run_scan import ScanItem, ScanPreview
from backend.sidecar_server.server import AUTH_HEADER_NAME, SidecarRequestHandler
from backend.sidecar_server.settings_store import AppSettings
from backend.sidecar_server.transcription_types import SegmentLine, TranscriptionResult


def _hardware() -> HardwareSummary:
    return HardwareSummary(
        cpu_model="CPU",
        physical_cores=4,
        logical_cores=8,
        total_ram_gb=16.0,
        gpu_model="No supported GPU detected",
        vram_gb=None,
        has_supported_nvidia_gpu=False,
        cuda_available=False,
        asr_cuda_available=False,
        pyannote_available=True,
        pyannote_cuda_available=False,
        runtime_variant="dev",
        acceleration_path="CPU",
    )


def _scan_preview(input_folder: str) -> ScanPreview:
    return ScanPreview(
        input_folder=input_folder,
        file_count=1,
        total_duration_seconds=2.0,
        total_duration_label="0:02",
        duration_status="available",
        is_empty=False,
        message="Folder scanned successfully.",
        files=[
            ScanItem(
                file_name="sample.wav",
                extension="wav",
                size_bytes=128,
                modified_at="2026-04-24T12:00:00",
                duration_seconds=2.0,
                duration_label="0:02",
                file_info="WAV audio - 128 B",
                source_path=str(Path(input_folder) / "sample.wav"),
            )
        ],
    )


def _transcription_result() -> TranscriptionResult:
    return TranscriptionResult(
        transcript="Speaker 1: Hello world.",
        detected_language="en",
        engine="test-engine",
        model="small",
        device="cpu",
        used_fallback=False,
        note=None,
        speaker_summary="Speaker 1",
        segments=[
            SegmentLine(
                start_seconds=0.0,
                end_seconds=2.0,
                text="Hello world.",
                speaker="Speaker 1",
            )
        ],
    )


def _wait_until_finished(snapshot_getter, *, timeout_seconds: float = 5.0):
    deadline = time.monotonic() + timeout_seconds
    snapshot = snapshot_getter()
    while snapshot.status in {"starting", "running", "cancelling"} and time.monotonic() < deadline:
        time.sleep(0.02)
        snapshot = snapshot_getter()
    return snapshot


def _prompt_selection(source_file: Path) -> tuple[dict[str, dict[str, str]], list[str]]:
    candidate_mappings = {str(source_file): {"text_column": "text"}}
    preview = inspect_prompting_input({
        "input_mode": "file",
        "input_path": str(source_file),
        "candidate_mappings": candidate_mappings,
    })
    selected_candidate_ids = [
        str(candidate["candidate_id"])
        for candidate in preview["candidates"]
        if candidate["status"] in {"ready", "equivalent_format"}
    ]
    return candidate_mappings, selected_candidate_ids


class ReleaseSmokeTests(unittest.TestCase):
    def test_authenticated_health_and_active_setup_routes_respond(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"

        token = "synthetic-release-smoke-token"
        try:
            with (
                patch("backend.sidecar_server.server.AUTH_TOKEN", token),
                patch(
                    "backend.sidecar_server.server.build_models_status_payload",
                    return_value={"faster_whisper": [], "pyannote": {"availability": "missing"}},
                ),
                patch(
                    "backend.sidecar_server.server.build_run_screen_payload",
                    return_value={"suggested_folders": {}, "transcription_models": []},
                ),
            ):
                payloads = []
                for path in ("/health", "/api/v1/models/status", "/api/v1/transcription/run-screen"):
                    request = urllib.request.Request(
                        f"{base_url}{path}",
                        headers={AUTH_HEADER_NAME: token},
                    )
                    with urllib.request.urlopen(request, timeout=2) as response:
                        payloads.append(json.loads(response.read().decode("utf-8")))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(payloads[0]["status"], "ok")
        self.assertEqual(payloads[1]["pyannote"]["availability"], "missing")
        self.assertEqual(payloads[2]["transcription_models"], [])

    def test_hardware_status_and_retry_routes_return_manager_snapshots(self) -> None:
        snapshot = {
            "generation": 3,
            "status": "failed",
            "phase": "failed",
            "message": "Hardware detection failed. CPU processing remains available.",
            "system": None,
            "hardware": None,
            "retryable": True,
        }
        with patch("backend.sidecar_server.server.hardware_scan_manager") as manager:
            manager.snapshot.side_effect = lambda: dict(snapshot)
            manager.retry.return_value = True
            server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                with urllib.request.urlopen(f"{base_url}/api/v1/system/hardware", timeout=2) as response:
                    status_payload = json.loads(response.read().decode("utf-8"))
                request = urllib.request.Request(
                    f"{base_url}/api/v1/system/hardware/retry",
                    data=b"",
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    retry_payload = json.loads(response.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

        self.assertEqual(status_payload, snapshot)
        self.assertTrue(retry_payload["retry_started"])
        manager.retry.assert_called_once_with()

    def test_transcription_batch_smoke_writes_expected_exports_and_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_folder = root / "input"
            output_folder = root / "output"
            logs_folder = root / "logs"
            temp_folder = root / "temp"
            input_folder.mkdir()
            output_folder.mkdir()
            logs_folder.mkdir()
            temp_folder.mkdir()
            (input_folder / "sample.wav").write_bytes(b"RIFF")

            manager = BatchManager()

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(str(input_folder))),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
                patch("backend.sidecar_server.batch_runner.TranscriptionWorkerSession") as worker_session_type,
                patch(
                    "backend.sidecar_server.batch_artifacts.ensure_app_runtime_directories",
                    return_value={"root": root, "logs": logs_folder, "temp": temp_folder},
                ),
            ):
                worker_session_type.return_value.transcribe.return_value = _transcription_result()
                manager.start_batch(
                    {
                        "input_path": str(input_folder),
                        "transcript_output_folder": str(output_folder),
                        "output_naming_mode": "override",
                        "output_basename": "release_smoke",
                        "export_formats": ["json", "csv"],
                        "transcript_layout": "segment",
                        "acceleration": "cpu",
                    }
                )
                snapshot = _wait_until_finished(manager.get_snapshot)

            self.assertEqual(snapshot.status, "completed")
            self.assertEqual(snapshot.message, "Run successful. Created 3 output files.")
            self.assertEqual(snapshot.files_completed, 1)
            self.assertTrue((output_folder / "release_smoke.json").exists())
            self.assertTrue((output_folder / "release_smoke.csv").exists())
            overview_files = list(output_folder.glob("run_overview_*.xlsx"))
            self.assertEqual(len(overview_files), 1)
            self.assertEqual(sum(1 for output_file in snapshot.output_files if output_file.exists), 3)
            self.assertEqual(len(list(logs_folder.glob("release_smoke_*.log"))), 1)

            payload = json.loads((output_folder / "release_smoke.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["transcript_layout"], "segment")
            self.assertEqual(payload["rows"][0]["speaker"], "Speaker 1")
            self.assertEqual(payload["documents"][0]["transcript"], "Speaker 1: Hello world.")

    def test_prompting_run_smoke_writes_preprocessing_output_and_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_file = root / "source.csv"
            output_folder = root / "prompt-output"
            logs_folder = root / "logs"
            output_folder.mkdir()
            logs_folder.mkdir()
            source_file.write_text("file_name,text\nsample.wav,Hello world\n", encoding="utf-8")
            candidate_mappings, selected_candidate_ids = _prompt_selection(source_file)

            manager = PromptingManager()

            with (
                patch("backend.sidecar_server.prompting.validate_provider_model"),
                patch("backend.sidecar_server.prompting._run_provider_task_prompt", return_value='{"short_summary":"Short summary.","main_topics":["Topic"],"keywords":["hello"]}'),
                patch(
                    "backend.sidecar_server.prompting._ensure_runtime_paths",
                    return_value={"root": root, "logs": logs_folder},
                ),
            ):
                manager.start_run(
                    {
                        "provider_id": "ollama",
                        "model_id": "llama3",
                        "input_mode": "file",
                        "input_path": str(source_file),
                        "advanced_mapping": {"text_column": "text"},
                        "candidate_mappings": candidate_mappings,
                        "selected_candidate_ids": selected_candidate_ids,
                        "temperature": 0,
                        "tasks": {
                            "summary": {
                                "enabled": True,
                                "components": {"short_summary": True, "main_topics": True, "keywords": True},
                            }
                        },
                        "output_folder": str(output_folder),
                        "output_basename": "source_preprocessed",
                        "output_formats": ["csv"],
                    }
                )
                snapshot = _wait_until_finished(manager.get_snapshot)

            self.assertEqual(snapshot.status, "completed")
            self.assertIn("Preprocessing completed", snapshot.message)
            self.assertEqual(snapshot.transcripts_completed, 1)
            self.assertEqual(snapshot.counts["done"], 1)
            self.assertTrue((output_folder / "source_preprocessed_summary.csv").exists())
            self.assertTrue((output_folder / "source_preprocessed_run_info.csv").exists())
            log_files = list(logs_folder.glob("source_preprocessed_*.prompt.log"))
            self.assertEqual(len(log_files), 1)

            with (output_folder / "source_preprocessed_summary.csv").open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["short_summary"], "Short summary.")

    def test_prompting_run_reports_failed_rows_instead_of_silent_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_file = root / "source.csv"
            output_folder = root / "prompt-output"
            logs_folder = root / "logs"
            output_folder.mkdir()
            logs_folder.mkdir()
            source_file.write_text("file_name,text\nsample.wav,Hello world\n", encoding="utf-8")
            candidate_mappings, selected_candidate_ids = _prompt_selection(source_file)

            manager = PromptingManager()

            with (
                patch("backend.sidecar_server.prompting.validate_provider_model"),
                patch("backend.sidecar_server.prompting._run_provider_task_prompt", side_effect=TimeoutError("provider timed out")),
                patch(
                    "backend.sidecar_server.prompting._ensure_runtime_paths",
                    return_value={"root": root, "logs": logs_folder},
                ),
            ):
                manager.start_run(
                    {
                        "provider_id": "ollama",
                        "model_id": "llama3",
                        "input_mode": "file",
                        "input_path": str(source_file),
                        "advanced_mapping": {"text_column": "text"},
                        "candidate_mappings": candidate_mappings,
                        "selected_candidate_ids": selected_candidate_ids,
                        "temperature": 0,
                        "tasks": {
                            "summary": {
                                "enabled": True,
                                "components": {"short_summary": True},
                            }
                        },
                        "output_folder": str(output_folder),
                        "output_basename": "source_preprocessed",
                        "output_formats": ["csv"],
                    }
                )
                snapshot = _wait_until_finished(manager.get_snapshot)

            self.assertEqual(snapshot.status, "failed")
            self.assertIn("1 failed transcript", snapshot.message)
            self.assertEqual(snapshot.transcripts_completed, 1)
            self.assertEqual(snapshot.counts["failed"], 1)
            self.assertTrue((output_folder / "source_preprocessed_run_info.csv").exists())

            log_files = list(logs_folder.glob("source_preprocessed_*.prompt.log"))
            self.assertEqual(len(log_files), 1)
            self.assertIn("provider timed out", log_files[0].read_text(encoding="utf-8"))
