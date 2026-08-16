import csv
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.export_docx import write_docx
from backend.sidecar_server.export_table_formats import write_xlsx
from backend.sidecar_server.transcript_editor import (
    export_edited_transcript,
    inspect_transcript,
    load_transcript,
    save_edited_transcript,
)


def _app_json_payload() -> dict:
    return {
        "batch_name": "interviews",
        "transcript_layout": "segment",
        "rows": [],
        "documents": [
            {
                "file_name": "first.wav",
                "duration": "00:00:04",
                "file_info": "WAV audio",
                "detected_language": "de",
                "task": "transcribe",
                "transcript": "Hallo. Danke.",
                "segments": [
                    {
                        "start_seconds": 0.0,
                        "end_seconds": 2.0,
                        "speaker": "SPEAKER_00",
                        "text": "Hallo.",
                    },
                    {
                        "start_seconds": 2.0,
                        "end_seconds": 4.0,
                        "speaker": "SPEAKER_01",
                        "text": "Danke.",
                    },
                ],
            },
            {
                "file_name": "second.wav",
                "duration": "00:00:02",
                "file_info": "WAV audio",
                "detected_language": "en",
                "task": "transcribe",
                "transcript": "Hello.",
                "segments": [
                    {
                        "start_seconds": 0.0,
                        "end_seconds": 2.0,
                        "speaker": "Speaker 2",
                        "text": "Hello.",
                    }
                ],
            },
        ],
    }


class TranscriptEditorTests(unittest.TestCase):
    def test_inspect_json_with_multiple_documents_and_load_selected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "batch.json"
            source_path.write_text(json.dumps(_app_json_payload()), encoding="utf-8")

            summary = inspect_transcript({"transcript_file": str(source_path)})
            transcript = load_transcript({"transcript_file": str(source_path), "document_id": "doc_000002"})

        self.assertTrue(summary["requires_document_selection"])
        self.assertEqual([choice["file_name"] for choice in summary["documents"]], ["first.wav", "second.wav"])
        self.assertEqual(transcript["source_document_id"], "doc_000002")
        self.assertEqual(transcript["language"], "en")
        self.assertEqual(transcript["segments"][0]["speaker"], "SPEAKER_02")

    def test_json_import_rejects_oversized_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "batch.json"
            source_path.write_text(json.dumps(_app_json_payload()), encoding="utf-8")

            with patch("backend.sidecar_server.transcript_editor.MAX_TRANSCRIPT_JSON_BYTES", 8):
                with self.assertRaisesRegex(ValueError, "too large"):
                    inspect_transcript({"transcript_file": str(source_path)})
                with self.assertRaisesRegex(ValueError, "too large"):
                    load_transcript({"transcript_file": str(source_path)})

    def test_load_segment_csv_and_build_speakers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "segments.csv"
            with source_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["file_name", "start_seconds", "end_seconds", "speaker", "text"],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "file_name": "interview.wav",
                        "start_seconds": "1.5",
                        "end_seconds": "3.0",
                        "speaker": "Speaker 0",
                        "text": "Guten Tag.",
                    }
                )

            transcript = load_transcript({"transcript_file": str(source_path)})

        self.assertEqual(transcript["segments"][0]["start"], 1.5)
        self.assertEqual(transcript["segments"][0]["speaker"], "SPEAKER_00")
        self.assertEqual(transcript["speakers"], [{"id": "SPEAKER_00", "name": "SPEAKER_00"}])

    def test_load_xlsx_export_table(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "segments.xlsx"
            write_xlsx(
                source_path,
                ["file_name", "start_seconds", "end_seconds", "speaker", "text"],
                [
                    {
                        "file_name": "interview.wav",
                        "start_seconds": 0,
                        "end_seconds": 1,
                        "speaker": "SPEAKER_00",
                        "text": "Hallo.",
                    }
                ],
            )

            transcript = load_transcript({"transcript_file": str(source_path)})

        self.assertEqual(transcript["segments"][0]["text"], "Hallo.")
        self.assertEqual(transcript["metadata"]["source_format"], "xlsx")

    def test_docx_import_reads_app_generated_segment_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "transcript.docx"
            write_docx(
                source_path,
                [
                    "interview.wav",
                    "",
                    "Duration: 00:00:02",
                    "File info: WAV audio",
                    "Detected language: de",
                    "Task: transcribe",
                    "",
                    "[00:00:01 - 00:00:02] SPEAKER_00: Hallo.",
                ],
            )

            transcript = load_transcript({"transcript_file": str(source_path)})

        self.assertEqual(transcript["metadata"]["file_name"], "interview.wav")
        self.assertEqual(transcript["segments"][0]["start"], 1.0)
        self.assertEqual(transcript["segments"][0]["end"], 2.0)
        self.assertEqual(transcript["segments"][0]["speaker"], "SPEAKER_00")

    def test_save_edited_json_refuses_to_overwrite_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "batch.json"
            source_path.write_text(json.dumps(_app_json_payload()), encoding="utf-8")
            transcript = load_transcript({"transcript_file": str(source_path), "document_id": "doc_000001"})
            output_path = Path(directory) / "edited.json"

            result = save_edited_transcript({"output_file": str(output_path), "transcript": transcript})

            with self.assertRaises(ValueError):
                save_edited_transcript({"output_file": str(source_path), "transcript": transcript})

            self.assertEqual(result["output_file"], str(output_path.resolve()))
            self.assertTrue(output_path.exists())

    def test_export_edited_transcript_reuses_existing_formats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "batch.json"
            source_path.write_text(json.dumps(_app_json_payload()), encoding="utf-8")
            transcript = load_transcript({"transcript_file": str(source_path), "document_id": "doc_000001"})
            transcript["speakers"][0]["name"] = "Interviewer"
            output_folder = Path(directory) / "exports"

            result = export_edited_transcript(
                {
                    "transcript": transcript,
                    "output_folder": str(output_folder),
                    "output_name": "cleaned",
                    "export_formats": ["csv", "xlsx", "json", "docx"],
                    "transcript_layout": "segment",
                }
            )

            csv_path = output_folder / "cleaned.csv"
            json_path = output_folder / "cleaned.json"
            xlsx_path = output_folder / "cleaned.xlsx"
            docx_files = list(output_folder.glob("cleaned_*.docx"))

            with csv_path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            exported_payload = json.loads(json_path.read_text(encoding="utf-8"))
            with zipfile.ZipFile(docx_files[0], "r") as archive:
                document_xml = archive.read("word/document.xml").decode("utf-8")

            self.assertTrue(csv_path.exists())
            self.assertTrue(xlsx_path.exists())
            self.assertEqual(rows[0]["speaker_id"], "SPEAKER_00")
            self.assertEqual(rows[0]["speaker_name"], "Interviewer")
            self.assertEqual(rows[0]["timestamp_range"], "00:00:00 - 00:00:02")
            self.assertEqual(exported_payload["documents"][0]["segments"][0]["speaker"], "Interviewer")
            self.assertEqual(exported_payload["documents"][0]["segments"][0]["timestamp_range"], "00:00:00 - 00:00:02")
            self.assertIn("[00:00:00 - 00:00:02] Interviewer: Hallo.", document_xml)
            self.assertTrue(any(item["format"] == "docx" for item in result["output_files"]))

    def test_editor_docx_export_reports_only_files_created_by_current_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "batch.json"
            source_path.write_text(json.dumps(_app_json_payload()), encoding="utf-8")
            transcript = load_transcript({"transcript_file": str(source_path), "document_id": "doc_000001"})
            output_folder = root / "exports"
            output_folder.mkdir()
            existing_target = output_folder / "cleaned_001_first.docx"
            unrelated = output_folder / "cleaned_research_notes.docx"
            existing_target.write_text("existing transcript", encoding="utf-8")
            unrelated.write_text("research notes", encoding="utf-8")

            result = export_edited_transcript(
                {
                    "transcript": transcript,
                    "output_folder": str(output_folder),
                    "output_name": "cleaned",
                    "export_formats": ["docx"],
                    "transcript_layout": "segment",
                }
            )

            reported_docx = [Path(item["path"]).name for item in result["output_files"] if item["format"] == "docx"]
            self.assertEqual(reported_docx, ["cleaned_001_first_copy01.docx"])
            self.assertEqual(existing_target.read_text(encoding="utf-8"), "existing transcript")
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "research notes")


if __name__ == "__main__":
    unittest.main()
