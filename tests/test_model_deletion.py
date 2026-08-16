import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.pyannote_diarization import delete_pyannote_model
from backend.sidecar_server.transcription_models import (
    delete_faster_whisper_model,
    download_faster_whisper_model,
    faster_whisper_model_roots,
)


class ModelDeletionTests(unittest.TestCase):
    def test_download_faster_whisper_model_returns_refreshed_status(self) -> None:
        with (
            patch("backend.sidecar_server.transcription_models.ensure_faster_whisper_model_available") as ensure_model,
            patch(
                "backend.sidecar_server.transcription_models.faster_whisper_model_status",
                return_value={"value": "small", "installed": True},
            ),
        ):
            result = download_faster_whisper_model("small")

        ensure_model.assert_called_once_with("small", progress_callback=None)
        self.assertEqual(result["model"]["value"], "small")
        self.assertTrue(result["model"]["installed"])

    def test_delete_faster_whisper_model_removes_cache_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory) / "hub"
            model_root = cache_root / "models--Systran--faster-whisper-small"
            snapshot = model_root / "snapshots" / "abc"
            snapshot.mkdir(parents=True)
            (snapshot / "model.bin").write_text("model", encoding="utf-8")

            with patch(
                "backend.sidecar_server.transcription_models.huggingface_cache_roots",
                return_value=[cache_root],
            ):
                self.assertEqual(faster_whisper_model_roots("small"), [model_root])
                result = delete_faster_whisper_model("small")

        self.assertFalse(model_root.exists())
        self.assertFalse(result["model"]["installed"])
        self.assertEqual(result["deleted_paths"], [str(model_root)])

    def test_delete_pyannote_model_removes_local_model_dir(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            model_dir = Path(directory) / "pyannote"
            model_dir.mkdir()
            (model_dir / "config.yaml").write_text("pipeline", encoding="utf-8")

            result = delete_pyannote_model(model_dir)

        self.assertFalse(model_dir.exists())
        self.assertFalse(result["installed"])


if __name__ == "__main__":
    unittest.main()
