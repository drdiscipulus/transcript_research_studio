import json
import tempfile
import unittest
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.sidecar_server.export_writer import (
    ExportWriteError,
    FILE_ROW_HEADERS,
    PARAGRAPH_ROW_HEADERS,
    SEGMENT_ROW_HEADERS,
    build_docx_paragraphs,
    build_table_export_rows,
    write_combined_document_exports,
    write_export_files,
    write_single_document_exports,
)
from backend.sidecar_server.prompting_tables import load_table


@dataclass(slots=True)
class _ExportTarget:
    format: str
    path: str
    exists: bool = False


@dataclass(slots=True)
class _PreparedBatch:
    batch_name: str
    export_targets: list[_ExportTarget]
    settings: dict[str, Any]


def _document() -> dict[str, Any]:
    return {
        "file_name": "interview.wav",
        "duration": "00:00:08",
        "file_info": "WAV audio - 42 KB",
        "detected_language": "de",
        "task": "transcribe",
        "speaker_summary": "Speaker 1",
        "transcript": "Erster Teil. Zweiter Teil.",
        "segments": [
            {
                "start_seconds": 0.0,
                "end_seconds": 2.0,
                "speaker": "Speaker 1",
                "text": "Erster Teil.",
            },
            {
                "start_seconds": 2.4,
                "end_seconds": 5.1,
                "speaker": "Speaker 1",
                "text": "Zweiter Teil.",
            },
        ],
    }


def _prepared_batch(path: Path, *, layout: str = "file", include_timestamps: bool = False) -> _PreparedBatch:
    return _PreparedBatch(
        batch_name="transcripts",
        export_targets=[_ExportTarget(format=path.suffix.lstrip("."), path=str(path))],
        settings={
            "output_mode": "transcribe",
            "transcript_layout": layout,
            "paragraph_options": {
                "paragraph_pause_enabled": True,
                "max_pause_seconds": 3.0,
            },
            "advanced_transcription": {
                "include_timestamps": include_timestamps,
            },
        },
    )


class ExportWriterTests(unittest.TestCase):
    def test_file_paragraph_and_segment_headers_are_stable(self) -> None:
        self.assertEqual(build_table_export_rows([_document()], transcript_layout="file")[0], FILE_ROW_HEADERS)
        self.assertEqual(
            build_table_export_rows([_document()], transcript_layout="paragraph")[0],
            PARAGRAPH_ROW_HEADERS,
        )
        self.assertEqual(build_table_export_rows([_document()], transcript_layout="segment")[0], SEGMENT_ROW_HEADERS)

    def test_paragraph_rows_preserve_derived_metadata(self) -> None:
        headers, rows = build_table_export_rows([_document()], transcript_layout="paragraph")

        self.assertEqual(headers, PARAGRAPH_ROW_HEADERS)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["paragraph_index"], 1)
        self.assertEqual(rows[0]["start_seconds"], 0.0)
        self.assertEqual(rows[0]["end_seconds"], 5.1)
        self.assertEqual(rows[0]["start_timestamp"], "00:00:00")
        self.assertEqual(rows[0]["end_timestamp"], "00:00:05")
        self.assertEqual(rows[0]["speaker"], "Speaker 1")
        self.assertEqual(rows[0]["source_segment_count"], 2)
        self.assertEqual(rows[0]["text"], "Erster Teil. Zweiter Teil.")

    def test_paragraph_rows_split_on_speaker_changes(self) -> None:
        document = _document()
        document["speaker_summary"] = "Speaker 1, Speaker 2"
        document["segments"][1]["speaker"] = "Speaker 2"

        headers, rows = build_table_export_rows([document], transcript_layout="paragraph")

        self.assertEqual(headers, PARAGRAPH_ROW_HEADERS)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["speaker"], "Speaker 1")
        self.assertEqual(rows[0]["text"], "Erster Teil.")
        self.assertEqual(rows[1]["speaker"], "Speaker 2")
        self.assertEqual(rows[1]["text"], "Zweiter Teil.")

    def test_paragraph_rows_ignore_long_pauses_when_pause_rule_is_disabled(self) -> None:
        document = _document()
        document["segments"][1]["start_seconds"] = 25.0
        document["segments"][1]["end_seconds"] = 28.0

        _, enabled_rows = build_table_export_rows(
            [document],
            transcript_layout="paragraph",
            paragraph_options={"paragraph_pause_enabled": True, "max_pause_seconds": 3.0},
        )
        _, disabled_rows = build_table_export_rows(
            [document],
            transcript_layout="paragraph",
            paragraph_options={"paragraph_pause_enabled": False, "max_pause_seconds": 3.0},
        )

        self.assertEqual(len(enabled_rows), 2)
        self.assertEqual(len(disabled_rows), 1)
        self.assertEqual(disabled_rows[0]["text"], "Erster Teil. Zweiter Teil.")

    def test_segment_rows_preserve_segment_metadata(self) -> None:
        headers, rows = build_table_export_rows([_document()], transcript_layout="segment")

        self.assertEqual(headers, SEGMENT_ROW_HEADERS)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["segment_index"], 2)
        self.assertEqual(rows[1]["start_seconds"], 2.4)
        self.assertEqual(rows[1]["end_timestamp"], "00:00:05")
        self.assertEqual(rows[1]["speaker"], "Speaker 1")
        self.assertEqual(rows[1]["text"], "Zweiter Teil.")

    def test_json_keeps_documents_segments_while_rows_follow_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "transcripts.json"
            write_export_files(prepared_batch=_prepared_batch(output_path, layout="paragraph"), documents=[_document()])

            payload = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["transcript_layout"], "paragraph")
        self.assertEqual(payload["rows"][0]["text"], "Erster Teil. Zweiter Teil.")
        self.assertEqual(payload["documents"][0]["segments"][1]["text"], "Zweiter Teil.")

    def test_docx_body_follows_layout_and_timestamp_setting(self) -> None:
        batch = _prepared_batch(Path("transcripts.docx"), layout="paragraph", include_timestamps=True)
        paragraphs = build_docx_paragraphs(
            prepared_batch=batch,
            document=_document(),
            transcript_layout="paragraph",
            include_timestamps=True,
        )

        self.assertIn("[00:00:00] Speaker 1: Erster Teil. Zweiter Teil.", paragraphs)

        untimed = build_docx_paragraphs(
            prepared_batch=batch,
            document=_document(),
            transcript_layout="segment",
            include_timestamps=False,
        )

        self.assertIn("Speaker 1: Erster Teil.", untimed)
        self.assertNotIn("[00:00:00] Speaker 1: Erster Teil.", untimed)

    def test_docx_writer_creates_one_file_per_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base_path = Path(directory) / "transcripts.docx"
            write_export_files(
                prepared_batch=_prepared_batch(base_path, layout="file", include_timestamps=False),
                documents=[_document()],
            )
            docx_files = list(Path(directory).glob("transcripts_*.docx"))
            self.assertEqual(len(docx_files), 1)
            with zipfile.ZipFile(docx_files[0], "r") as archive:
                document_xml = archive.read("word/document.xml").decode("utf-8")

        self.assertIn("interview.wav", document_xml)
        self.assertIn("Speaker 1: Erster Teil. Speaker 1: Zweiter Teil.", document_xml)

    def test_docx_bundle_preserves_existing_matching_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base_path = root / "transcripts.docx"
            existing_target = root / "transcripts_001_interview.docx"
            unrelated = root / "transcripts_research_notes.docx"
            existing_target.write_text("existing transcript", encoding="utf-8")
            unrelated.write_text("research notes", encoding="utf-8")

            write_export_files(
                prepared_batch=_prepared_batch(base_path, layout="file", include_timestamps=False),
                documents=[_document()],
            )

            self.assertEqual(existing_target.read_text(encoding="utf-8"), "existing transcript")
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "research notes")
            self.assertTrue((root / "transcripts_001_interview_copy01.docx").exists())

    def test_single_document_export_writes_exact_target_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            targets = [
                _ExportTarget(format="json", path=str(output_dir / "interview.json")),
                _ExportTarget(format="xlsx", path=str(output_dir / "interview.xlsx")),
                _ExportTarget(format="docx", path=str(output_dir / "interview.docx")),
            ]
            batch = _PreparedBatch(
                batch_name="interview",
                export_targets=targets,
                settings={
                    "output_mode": "transcribe",
                    "transcript_layout": "segment",
                    "paragraph_options": {
                        "paragraph_pause_enabled": True,
                        "max_pause_seconds": 3.0,
                    },
                    "advanced_transcription": {
                        "include_timestamps": True,
                    },
                },
            )

            written_paths = write_single_document_exports(
                prepared_batch=batch,
                document=_document(),
                export_targets=targets,
            )

            self.assertEqual({Path(path).name for path in written_paths}, {"interview.json", "interview.xlsx", "interview.docx"})
            self.assertTrue((output_dir / "interview.json").exists())
            self.assertTrue((output_dir / "interview.xlsx").exists())
            self.assertTrue((output_dir / "interview.docx").exists())

    def test_single_document_export_reports_committed_paths_and_removes_partial_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            targets = [
                _ExportTarget(format="json", path=str(output_dir / "interview.json")),
                _ExportTarget(format="xlsx", path=str(output_dir / "interview.xlsx")),
            ]
            batch = _PreparedBatch(
                batch_name="interview",
                export_targets=targets,
                settings={"output_mode": "transcribe", "transcript_layout": "file"},
            )

            def fail_after_partial_write(path: Path, *_args: Any, **_kwargs: Any) -> None:
                path.write_bytes(b"partial")
                raise OSError("simulated disk failure")

            with (
                patch(
                    "backend.sidecar_server.export_writer.write_xlsx",
                    side_effect=fail_after_partial_write,
                ),
                self.assertRaises(ExportWriteError) as caught,
            ):
                write_single_document_exports(
                    prepared_batch=batch,
                    document=_document(),
                    export_targets=targets,
                )

            self.assertEqual(caught.exception.error_code, "export_failed")
            self.assertEqual(caught.exception.written_paths, [str(output_dir / "interview.json")])
            self.assertTrue((output_dir / "interview.json").is_file())
            self.assertFalse((output_dir / "interview.xlsx").exists())
            self.assertEqual(list(output_dir.glob(".*.tmp*")), [])

    def test_combined_exports_preserve_document_order_and_create_one_docx(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            targets = [
                _ExportTarget(format="json", path=str(output_dir / "study.json")),
                _ExportTarget(format="docx", path=str(output_dir / "study.docx")),
            ]
            batch = _PreparedBatch(
                batch_name="study",
                export_targets=targets,
                settings={
                    "output_mode": "transcribe",
                    "transcript_layout": "file",
                    "paragraph_options": {"paragraph_pause_enabled": True, "max_pause_seconds": 3.0},
                    "advanced_transcription": {"include_timestamps": False},
                },
            )
            second_document = _document()
            second_document["file_name"] = "second.wav"
            second_document["transcript"] = "Second transcript."

            written_paths = write_combined_document_exports(
                prepared_batch=batch,
                documents=[_document(), second_document],
                export_targets=targets,
            )

            payload = json.loads((output_dir / "study.json").read_text(encoding="utf-8"))
            with zipfile.ZipFile(output_dir / "study.docx", "r") as archive:
                document_xml = archive.read("word/document.xml").decode("utf-8")

        self.assertEqual({Path(path).name for path in written_paths}, {"study.json", "study.docx"})
        self.assertEqual(
            [document["file_name"] for document in payload["documents"]],
            ["interview.wav", "second.wav"],
        )
        self.assertIn("interview.wav", document_xml)
        self.assertIn("second.wav", document_xml)
        self.assertIn('<w:br w:type="page"/>', document_xml)

    def test_combined_export_failure_preserves_previous_atomic_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            target_path = output_dir / "study.json"
            target_path.write_text("previous checkpoint", encoding="utf-8")
            targets = [_ExportTarget(format="json", path=str(target_path), exists=True)]
            batch = _PreparedBatch(
                batch_name="study",
                export_targets=targets,
                settings={"output_mode": "transcribe", "transcript_layout": "file"},
            )

            def fail_after_partial_write(path: Path, *_args: Any, **_kwargs: Any) -> None:
                path.write_text("partial", encoding="utf-8")
                raise OSError("simulated disk failure")

            with (
                patch("backend.sidecar_server.export_writer.write_json", side_effect=fail_after_partial_write),
                self.assertRaises(ExportWriteError),
            ):
                write_combined_document_exports(
                    prepared_batch=batch,
                    documents=[_document()],
                    export_targets=targets,
                )

            self.assertEqual(target_path.read_text(encoding="utf-8"), "previous checkpoint")
            self.assertEqual(list(output_dir.glob(".*.tmp*")), [])

    def test_combined_xlsx_contains_fifty_recordings_in_input_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "study.xlsx"
            target = _ExportTarget(format="xlsx", path=str(output_path))
            batch = _PreparedBatch(
                batch_name="study",
                export_targets=[target],
                settings={"output_mode": "transcribe", "transcript_layout": "file"},
            )
            documents = []
            for index in range(50):
                document = _document()
                document["file_name"] = f"interview-{index:02d}.wav"
                document["transcript"] = f"Transcript {index}."
                documents.append(document)

            write_combined_document_exports(
                prepared_batch=batch,
                documents=documents,
                export_targets=[target],
            )
            rows = load_table(output_path)["rows"]

        self.assertEqual(len(rows), 50)
        self.assertEqual(rows[0]["file_name"], "interview-00.wav")
        self.assertEqual(rows[-1]["file_name"], "interview-49.wav")


if __name__ == "__main__":
    unittest.main()
