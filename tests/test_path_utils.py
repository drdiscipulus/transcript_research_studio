from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.sidecar_server.path_utils import (
    any_format_target_exists,
    first_available_copy_stem,
    sanitize_path_stem,
    sanitize_plain_stem,
)


class PathUtilsTests(unittest.TestCase):
    def test_sanitize_plain_stem_preserves_stable_filename_rules(self) -> None:
        self.assertEqual(sanitize_plain_stem(" My Batch! ", default="transcripts"), "My_Batch")
        self.assertEqual(sanitize_plain_stem("!!!", default="transcripts"), "transcripts")
        self.assertEqual(sanitize_plain_stem("-", default="transcripts"), "-")

    def test_sanitize_path_stem_preserves_filename_style_rules(self) -> None:
        self.assertEqual(sanitize_path_stem("Interview 01.mp3", default="transcript"), "Interview_01")
        self.assertEqual(sanitize_path_stem("notes.final.json", default="transcript"), "notes.final")
        self.assertEqual(sanitize_path_stem("!!!", default="transcript"), "transcript")

    def test_first_available_copy_stem_uses_deterministic_suffixes(self) -> None:
        used = {"results", "results_copy01"}
        self.assertEqual(
            first_available_copy_stem(base_stem="results", exists=lambda value: value in used),
            "results_copy02",
        )

    def test_any_format_target_exists_checks_all_requested_formats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "interview.json").write_text("old", encoding="utf-8")

            self.assertTrue(any_format_target_exists(root, "interview", ["xlsx", "json"]))
            self.assertFalse(any_format_target_exists(root, "interview", ["docx"]))
