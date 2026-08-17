from __future__ import annotations

import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.sidecar_server import runtime_env
from backend.sidecar_server.run_hardware import (
    HardwareScanManager,
    HardwareSummary,
    SystemHardwareSummary,
)
from backend.sidecar_server.run_screen import build_run_screen_payload


def _system() -> SystemHardwareSummary:
    return SystemHardwareSummary(
        cpu_model="Test CPU",
        physical_cores=8,
        logical_cores=16,
        total_ram_gb=64.0,
        gpu_model="NVIDIA Test GPU",
        vram_gb=24.0,
        has_supported_nvidia_gpu=True,
        runtime_variant="windows-gpu",
    )


def _wait_for_status(manager: HardwareScanManager, status: str) -> dict[str, object]:
    deadline = time.monotonic() + 2
    snapshot = manager.snapshot()
    while snapshot["status"] != status and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = manager.snapshot()
    return snapshot


class HardwareDetectionTests(unittest.TestCase):
    def test_concurrent_starts_share_one_phased_scan(self) -> None:
        manager = HardwareScanManager()
        release_cuda = threading.Event()
        cuda_calls = 0

        def probe_cuda() -> bool:
            nonlocal cuda_calls
            cuda_calls += 1
            release_cuda.wait(timeout=1)
            return True

        with (
            patch("backend.sidecar_server.run_hardware.detect_system_hardware", return_value=_system()),
            patch("backend.sidecar_server.run_hardware.probe_cuda_runtime", side_effect=probe_cuda),
            patch(
                "backend.sidecar_server.run_hardware.probe_speaker_runtime",
                return_value={
                    "torch_available": True,
                    "pyannote_available": True,
                    "torch_cuda_available": True,
                    "torch_cuda_version": "12.8",
                },
            ),
        ):
            start_results: list[bool] = []
            start_barrier = threading.Barrier(5)

            def start_scan() -> None:
                start_barrier.wait()
                start_results.append(manager.start())

            starters = [threading.Thread(target=start_scan) for _ in range(4)]
            for starter in starters:
                starter.start()
            start_barrier.wait()
            for starter in starters:
                starter.join(timeout=1)

            self.assertEqual(start_results.count(True), 1)
            self.assertEqual(start_results.count(False), 3)
            deadline = time.monotonic() + 1
            snapshot = manager.snapshot()
            while snapshot["phase"] != "transcription_acceleration" and time.monotonic() < deadline:
                time.sleep(0.01)
                snapshot = manager.snapshot()

            self.assertEqual(snapshot["status"], "checking")
            self.assertEqual(snapshot["system"]["gpu_model"], "NVIDIA Test GPU")
            self.assertIsNone(snapshot["hardware"])
            release_cuda.set()
            ready = _wait_for_status(manager, "ready")

        self.assertEqual(cuda_calls, 1)
        self.assertEqual(ready["phase"], "ready")
        self.assertTrue(ready["hardware"]["cuda_available"])

    def test_failed_scan_is_retryable_and_replaces_its_generation(self) -> None:
        manager = HardwareScanManager()
        with patch(
            "backend.sidecar_server.run_hardware.detect_system_hardware",
            side_effect=RuntimeError("private driver detail"),
        ):
            self.assertTrue(manager.start())
            failed = _wait_for_status(manager, "failed")

        self.assertTrue(failed["retryable"])
        self.assertNotIn("private driver detail", failed["message"])
        first_generation = failed["generation"]

        with (
            patch("backend.sidecar_server.run_hardware.detect_system_hardware", return_value=_system()),
            patch("backend.sidecar_server.run_hardware.probe_cuda_runtime", return_value=True),
            patch(
                "backend.sidecar_server.run_hardware.probe_speaker_runtime",
                return_value={
                    "torch_available": True,
                    "pyannote_available": True,
                    "torch_cuda_available": True,
                    "torch_cuda_version": "12.8",
                },
            ),
        ):
            self.assertTrue(manager.retry())
            ready = _wait_for_status(manager, "ready")

        self.assertGreater(ready["generation"], first_generation)
        self.assertFalse(ready["retryable"])
        self.assertFalse(
            manager._publish_phase(  # noqa: SLF001 - focused generation regression
                first_generation,
                "speaker_acceleration",
                "Stale phase",
                system=_system(),
            )
        )
        self.assertEqual(manager.snapshot()["status"], "ready")

    def test_run_screen_does_not_wait_for_hardware_detection(self) -> None:
        with (
            patch("backend.sidecar_server.run_screen.ensure_default_folders") as folders,
            patch("backend.sidecar_server.run_screen._build_transcription_model_options", return_value=[]),
            patch("backend.sidecar_server.run_screen.default_batch_name", return_value="transcripts"),
        ):
            folders.return_value.to_dict.return_value = {
                "input_folder": "input",
                "transcript_output_folder": "output",
                "prompt_output_folder": "analysis",
            }
            payload = build_run_screen_payload()

        self.assertNotIn("hardware", payload)
        self.assertNotIn("acceleration_options", payload["simple_options"])
        self.assertEqual(payload["simple_options"]["acceleration"], "cpu")
        self.assertEqual(payload["simple_options"]["language_options"][0], {
            "value": "auto",
            "label": "Auto-Detect",
        })
        self.assertEqual(len(payload["simple_options"]["language_options"]), 101)

    def test_speaker_probe_does_not_import_pyannote_audio(self) -> None:
        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            version=SimpleNamespace(cuda="12.8"),
        )
        runtime_env.probe_speaker_runtime.cache_clear()
        with (
            patch("backend.sidecar_server.runtime_env.configure_ml_runtime_environment"),
            patch("backend.sidecar_server.runtime_env.importlib.util.find_spec", return_value=object()),
            patch("backend.sidecar_server.runtime_env.importlib.import_module", return_value=fake_torch) as importer,
        ):
            result = runtime_env.probe_speaker_runtime()
        runtime_env.probe_speaker_runtime.cache_clear()

        importer.assert_called_once_with("torch")
        self.assertTrue(result["pyannote_available"])
        self.assertTrue(result["torch_cuda_available"])


if __name__ == "__main__":
    unittest.main()
