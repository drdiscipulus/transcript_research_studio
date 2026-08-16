from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.sidecar_server.transcription_models import (
    get_or_create_model,
    inspect_faster_whisper_model,
    is_model_cached_locally,
)


class ModelIntegrityTests(unittest.TestCase):
    def test_partial_snapshot_is_incomplete_not_installed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            snapshot = cache / "models--Systran--faster-whisper-small" / "snapshots" / "partial"
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text("{}", encoding="utf-8")

            with patch(
                "backend.sidecar_server.transcription_models.huggingface_cache_roots",
                return_value=[cache],
            ):
                status = inspect_faster_whisper_model("small")
                self.assertEqual(status.availability, "incomplete")
                self.assertIn("model.bin", status.missing_files)
                self.assertFalse(is_model_cached_locally("small"))

    def test_complete_snapshot_is_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            snapshot = cache / "models--Systran--faster-whisper-small" / "snapshots" / "complete"
            snapshot.mkdir(parents=True)
            for name in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
                (snapshot / name).write_bytes(b"ready")

            with patch(
                "backend.sidecar_server.transcription_models.huggingface_cache_roots",
                return_value=[cache],
            ):
                status = inspect_faster_whisper_model("small")
                self.assertEqual(status.availability, "ready")
                self.assertEqual(status.snapshot_path, snapshot.resolve())
                self.assertTrue(is_model_cached_locally("small"))

    def test_model_constructor_receives_verified_local_path_and_offline_flag(self) -> None:
        model_type = Mock(return_value=object())
        faster_whisper = SimpleNamespace(WhisperModel=model_type)
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory).resolve()
            with patch(
                "backend.sidecar_server.transcription_models.resolve_faster_whisper_model_snapshot",
                return_value=snapshot,
            ):
                get_or_create_model(
                    faster_whisper=faster_whisper,
                    model_name="unit-test-model",
                    device="cpu",
                    compute_type="int8",
                )

        model_type.assert_called_once_with(
            str(snapshot),
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )


if __name__ == "__main__":
    unittest.main()
