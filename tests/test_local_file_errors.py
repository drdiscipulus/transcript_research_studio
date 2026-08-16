from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.media_utils import MediaMetadata
from backend.sidecar_server.prompting_outputs import write_preprocessing_outputs
from backend.sidecar_server.prompting_tables import load_table
from backend.sidecar_server.run_scan import SUPPORTED_MEDIA_EXTENSIONS, scan_input_file, scan_input_folder


class LocalFileErrorTests(unittest.TestCase):
    def test_scan_keeps_valid_tiny_wav_and_excludes_bad_neighbors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            valid_tiny = root / "valid-tiny.wav"
            broken_wav = root / "broken.wav"
            empty_aac = root / "empty.aac"
            with wave.open(str(valid_tiny), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(8_000)
                wav_file.writeframes(b"\x00\x00" * 8)
            broken_wav.write_bytes(b"RIFF")
            empty_aac.write_bytes(b"")
            valid_tiny_size = valid_tiny.stat().st_size

            preview = scan_input_folder(str(root))

        self.assertLess(valid_tiny_size, 5_000)
        self.assertEqual(preview.file_count, 1)
        self.assertEqual(preview.files[0].file_name, "valid-tiny.wav")
        self.assertEqual(preview.excluded_count, 2)
        self.assertEqual(
            {item.file_name: item.code for item in preview.excluded_files},
            {"broken.wav": "unreadable_media", "empty.aac": "empty_file"},
        )
        self.assertFalse(preview.is_empty)
        self.assertEqual(preview.to_dict()["excluded_count"], 2)

    def test_video_only_file_is_excluded_without_blocking_folder_scan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            video = Path(temp_dir) / "camera.mp4"
            video.write_bytes(b"not-empty")
            metadata = MediaMetadata(
                duration_seconds=1.0,
                media_kind="video",
                container_format="mp4",
                is_valid=False,
                has_audio=False,
                error_code="no_audio_stream",
                error_message="The media file does not contain an audio stream.",
            )
            with patch("backend.sidecar_server.run_scan.probe_media_metadata", return_value=metadata):
                preview = scan_input_folder(temp_dir)

        self.assertTrue(preview.is_empty)
        self.assertEqual(preview.excluded_count, 1)
        self.assertEqual(preview.excluded_files[0].code, "no_audio_stream")

    def test_opus_is_a_supported_scan_extension(self) -> None:
        self.assertIn(".opus", SUPPORTED_MEDIA_EXTENSIONS)

    def test_prompting_rejects_unsupported_and_malformed_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            unsupported = root / "notes.txt"
            malformed_json = root / "broken.json"
            malformed_xlsx = root / "broken.xlsx"
            unsupported.write_text("hello", encoding="utf-8")
            malformed_json.write_text("{not json", encoding="utf-8")
            malformed_xlsx.write_text("not a zip", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Only CSV, JSON, and XLSX"):
                load_table(unsupported)
            with self.assertRaises(Exception):
                load_table(malformed_json)
            with self.assertRaises(Exception):
                load_table(malformed_xlsx)

    def test_prompting_outputs_use_copy_suffix_for_existing_targets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            existing = root / "results.xlsx"
            existing.write_text("old", encoding="utf-8")

            written = write_preprocessing_outputs(
                output_folder=root,
                output_basename="results",
                output_formats=["xlsx"],
                results={"summary": [{"transcript_id": "one", "short_summary": "Hello"}]},
                run_info={"status": "completed"},
            )

            self.assertTrue((root / "results_copy01.xlsx").exists())
            self.assertEqual(Path(written[0].path).name, "results_copy01.xlsx")

    def test_scan_reports_missing_invalid_empty_and_unsupported_folders(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            missing = root / "missing"
            file_path = root / "not-a-folder.txt"
            unsupported_only = root / "unsupported"
            file_path.write_text("hello", encoding="utf-8")
            unsupported_only.mkdir()
            (unsupported_only / "notes.txt").write_text("hello", encoding="utf-8")

            self.assertEqual(scan_input_folder(str(missing)).message, "Input folder does not exist yet.")
            self.assertEqual(scan_input_folder(str(file_path)).message, "Selected input path is not a folder.")
            self.assertEqual(scan_input_folder(str(unsupported_only)).message, "No media files found in this folder.")

    def test_single_file_scan_returns_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            media_file = Path(temp_dir) / "interview.wav"
            media_file.write_bytes(b"RIFF")

            with patch("backend.sidecar_server.run_scan.probe_media_metadata") as probe:
                probe.return_value.duration_seconds = 1.0
                probe.return_value.media_kind = "audio"
                preview = scan_input_file(str(media_file))

            self.assertEqual(preview.file_count, 1)
            self.assertEqual(preview.input_source_type, "single_file")
            self.assertEqual(preview.files[0].file_name, "interview.wav")
            self.assertTrue(preview.files[0].source_path.endswith("interview.wav"))
