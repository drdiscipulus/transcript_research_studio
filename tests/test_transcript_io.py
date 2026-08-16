from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.export_docx import write_docx
from backend.sidecar_server.transcript_io import (
    first_non_empty,
    has_any_key,
    normalize_speaker_id,
    parse_docx_segment_line,
    read_docx_paragraphs,
)


class TranscriptIoTests(unittest.TestCase):
    def test_normalizes_speaker_ids(self) -> None:
        self.assertEqual(normalize_speaker_id("SPEAKER_01"), "SPEAKER_01")
        self.assertEqual(normalize_speaker_id("speaker 1"), "SPEAKER_01")
        self.assertEqual(normalize_speaker_id("speaker-12"), "SPEAKER_12")
        self.assertEqual(normalize_speaker_id("Participant A"), "Participant A")
        self.assertEqual(normalize_speaker_id(""), "")
        self.assertEqual(normalize_speaker_id(None), "")

    def test_row_helpers(self) -> None:
        rows = [{"name": "", "fallback": "first"}, {"name": "second", "fallback": "ignored"}]
        self.assertTrue(has_any_key(rows[0], ["name", "fallback"]))
        self.assertFalse(has_any_key(rows[0], ["missing", "name"]))
        self.assertEqual(first_non_empty(rows, ["name", "fallback"]), "first")
        self.assertEqual(first_non_empty(rows, ["missing"]), "")

    def test_parses_docx_segment_lines(self) -> None:
        parsed = parse_docx_segment_line("[00:00:01 - 00:00:02] SPEAKER_00: Hallo.")
        self.assertEqual(parsed["start"], 1.0)
        self.assertEqual(parsed["end"], 2.0)
        self.assertEqual(parsed["speaker"], "SPEAKER_00")
        self.assertEqual(parsed["text"], "Hallo.")

        plain = parse_docx_segment_line("Plain transcript line.")
        self.assertIsNone(plain["start"])
        self.assertEqual(plain["speaker"], "")
        self.assertEqual(plain["text"], "Plain transcript line.")

    def test_reads_docx_paragraphs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.docx"
            write_docx(path, ["Title", "", "[00:00:01] SPEAKER_00: Hello."])

            paragraphs = read_docx_paragraphs(path)

        self.assertIn("Title", paragraphs)
        self.assertIn("[00:00:01] SPEAKER_00: Hello.", paragraphs)

    def test_rejects_oversized_docx_document_xml(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.docx"
            write_docx(path, ["Title", "", "[00:00:01] SPEAKER_00: Hello."])

            with patch("backend.sidecar_server.transcript_io.MAX_DOCX_DOCUMENT_XML_BYTES", 8):
                with self.assertRaisesRegex(ValueError, "too large"):
                    read_docx_paragraphs(path)

    def test_rejects_docx_document_xml_with_suspicious_compression_ratio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.docx"
            write_docx(path, ["Title", "", "[00:00:01] SPEAKER_00: Hello."])

            with patch("backend.sidecar_server.transcript_io.MAX_DOCX_DOCUMENT_COMPRESSION_RATIO", 1):
                with self.assertRaisesRegex(ValueError, "compressed too aggressively"):
                    read_docx_paragraphs(path)


if __name__ == "__main__":
    unittest.main()
