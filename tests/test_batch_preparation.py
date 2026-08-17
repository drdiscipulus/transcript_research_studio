import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.batch_preparation import (
    normalize_input_source_type,
    normalize_output_naming_mode,
    normalize_output_organization,
    normalize_export_formats,
    normalize_paragraph_options,
    normalize_transcript_layout,
    output_stem_for_file,
    resolve_non_conflicting_stem,
    sanitize_batch_name,
    validate_transcription_folders,
    validate_transcription_paths,
)
from backend.sidecar_server.run_hardware import HardwareSummary
from backend.sidecar_server.run_scan import ScanItem, ScanPreview
from backend.sidecar_server.run_screen import prepare_batch
from backend.sidecar_server.settings_store import AppSettings


def _hardware(*, cuda_available: bool = False) -> HardwareSummary:
    return HardwareSummary(
        cpu_model="CPU",
        physical_cores=4,
        logical_cores=8,
        total_ram_gb=16.0,
        gpu_model="GPU" if cuda_available else "No supported GPU detected",
        vram_gb=8.0 if cuda_available else None,
        has_supported_nvidia_gpu=cuda_available,
        cuda_available=cuda_available,
        asr_cuda_available=cuda_available,
        pyannote_available=True,
        pyannote_cuda_available=cuda_available,
        runtime_variant="dev",
        acceleration_path="NVIDIA / CUDA" if cuda_available else "CPU",
    )


def _scan_preview(input_folder: str, *, empty: bool = False) -> ScanPreview:
    return ScanPreview(
        input_folder=input_folder,
        file_count=0 if empty else 1,
        total_duration_seconds=None if empty else 1.0,
        total_duration_label="0 files" if empty else "0:01",
        duration_status="empty" if empty else "available",
        is_empty=empty,
        message="No media files found in this folder." if empty else "Folder scanned successfully.",
        files=[]
        if empty
        else [
            ScanItem(
                file_name="sample.wav",
                extension="wav",
                size_bytes=128,
                modified_at="2026-04-24T12:00:00",
                duration_seconds=1.0,
                duration_label="0:01",
                file_info="WAV audio - 128 B",
                source_path=str(Path(input_folder) / "sample.wav"),
            )
        ],
    )


def _scan_preview_files(input_folder: str, file_names: list[str]) -> ScanPreview:
    return ScanPreview(
        input_folder=input_folder,
        file_count=len(file_names),
        total_duration_seconds=float(len(file_names)),
        total_duration_label=f"0:0{len(file_names)}",
        duration_status="available",
        is_empty=False,
        message="Folder scanned successfully.",
        files=[
            ScanItem(
                file_name=file_name,
                extension=Path(file_name).suffix.lower().lstrip("."),
                size_bytes=128,
                modified_at="2026-04-24T12:00:00",
                duration_seconds=1.0,
                duration_label="0:01",
                file_info="Media - 128 B",
                source_path=str(Path(input_folder) / file_name),
            )
            for file_name in file_names
        ],
    )


class BatchPreparationTests(unittest.TestCase):
    def test_prepare_batch_rejects_an_unsupported_language_before_scanning(self) -> None:
        with self.assertRaisesRegex(ValueError, "supported transcription language"):
            prepare_batch({"language": "not-a-language", "model_name": "small"})

    def test_normalizes_export_formats_layout_and_paragraph_options(self) -> None:
        self.assertEqual(normalize_export_formats(["xlsx", "docx", "xlsx", "bad", ""]), ["xlsx", "docx"])
        self.assertEqual(normalize_export_formats([]), ["xlsx"])
        self.assertEqual(normalize_export_formats("csv"), ["xlsx"])
        self.assertEqual(normalize_input_source_type("single_file"), "single_file")
        self.assertEqual(normalize_input_source_type("bad"), "folder")
        self.assertEqual(normalize_output_naming_mode("override"), "override")
        self.assertEqual(normalize_output_naming_mode("bad"), "input_filename")
        self.assertEqual(normalize_output_organization("combined_file"), "combined_file")
        self.assertEqual(normalize_output_organization("bad"), "separate_files")
        self.assertEqual(normalize_transcript_layout("paragraph"), "paragraph")
        self.assertEqual(normalize_transcript_layout("bad"), "file")
        self.assertEqual(
            normalize_paragraph_options(
                {
                    "paragraph_pause_enabled": False,
                    "max_pause_seconds": "4.5",
                    "legacy_unused_field": "ignored",
                }
            ),
            {
                "paragraph_pause_enabled": False,
                "max_pause_seconds": 4.5,
            },
        )
        self.assertEqual(normalize_paragraph_options({"max_pause_seconds": -1})["max_pause_seconds"], 3.0)

    def test_sanitizes_batch_name_and_validates_folders(self) -> None:
        self.assertEqual(sanitize_batch_name(" My Batch! "), "My_Batch")
        self.assertEqual(sanitize_batch_name("!!!"), "transcripts")
        self.assertEqual(
            validate_transcription_folders(input_folder="", transcript_output_folder=""),
            ["Input folder is required.", "Transcript output folder is required."],
        )
        self.assertEqual(
            validate_transcription_folders(input_folder="C:/same/", transcript_output_folder="c:/same"),
            ["Input folder and transcript output folder must be different."],
        )
        self.assertEqual(
            validate_transcription_paths(
                input_source_type="single_file",
                input_path="C:/same/file.wav",
                transcript_output_folder="c:/same",
            ),
            [],
        )

    def test_output_stems_cover_input_override_padding_and_conflicts(self) -> None:
        self.assertEqual(
            output_stem_for_file(
                file_name="Interview 01.mp3",
                file_index=1,
                total_files=1,
                naming_mode="input_filename",
                output_basename="ignored",
            ),
            "Interview_01",
        )
        self.assertEqual(
            output_stem_for_file(
                file_name="Interview 01.mp3",
                file_index=1,
                total_files=1,
                naming_mode="override",
                output_basename="transcript",
            ),
            "transcript",
        )
        self.assertEqual(
            output_stem_for_file(
                file_name="Interview 120.mp3",
                file_index=120,
                total_files=120,
                naming_mode="override",
                output_basename="transcript",
            ),
            "transcript_120",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "interview.json").write_text("old", encoding="utf-8")
            self.assertEqual(resolve_non_conflicting_stem(root, "interview", ["json", "xlsx"]), "interview_copy01")

    def test_prepare_batch_normalizes_empty_export_formats_to_xlsx(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = str(Path(directory) / "out")
            Path(input_folder).mkdir()

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(input_folder)),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
            ):
                prepared = prepare_batch(
                    {
                        "input_path": input_folder,
                        "transcript_output_folder": output_folder,
                        "output_naming_mode": "override",
                        "output_basename": "Test Batch",
                        "export_formats": [],
                        "transcript_layout": "not-real",
                        "paragraph_options": {"max_pause_seconds": "2"},
                        "acceleration": "cpu",
                    }
                )

        self.assertEqual(prepared.batch_name, "Test_Batch")
        self.assertEqual(prepared.settings["export_formats"], ["xlsx"])
        self.assertEqual(prepared.settings["transcript_layout"], "file")
        self.assertEqual(prepared.settings["paragraph_options"]["max_pause_seconds"], 2.0)
        self.assertEqual(prepared.export_targets[0].format, "xlsx")

    def test_prepare_batch_plans_per_file_outputs_and_automatic_timestamped_overview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = Path(directory) / "out"
            Path(input_folder).mkdir()
            output_folder.mkdir()
            (output_folder / "transcript_01.json").write_text("old", encoding="utf-8")

            with (
                patch(
                    "backend.sidecar_server.run_screen.scan_input_source",
                    return_value=_scan_preview_files(input_folder, ["a.mp3", "b.wav"]),
                ),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
            ):
                prepared = prepare_batch(
                    {
                        "input_source_type": "folder",
                        "input_path": input_folder,
                        "transcript_output_folder": str(output_folder),
                        "output_naming_mode": "override",
                        "output_basename": "transcript",
                        "export_formats": ["json", "xlsx"],
                        "create_batch_overview": False,
                        "acceleration": "cpu",
                    }
                )

        transcript_targets = [target for target in prepared.export_targets if target.role == "transcript"]
        overview_targets = [target for target in prepared.export_targets if target.role == "batch_overview"]
        self.assertEqual(
            [Path(target.path).name for target in transcript_targets],
            [
                "transcript_01_copy01.json",
                "transcript_01_copy01.xlsx",
                "transcript_02.json",
                "transcript_02.xlsx",
            ],
        )
        self.assertEqual(len(overview_targets), 1)
        self.assertRegex(
            Path(overview_targets[0].path).name,
            r"^run_overview_\d{4}-\d{2}-\d{2}_\d{6}\.xlsx$",
        )
        self.assertNotIn("create_batch_overview", prepared.settings)

    def test_prepare_batch_plans_one_target_per_format_for_combined_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = Path(directory) / "out"
            Path(input_folder).mkdir()
            output_folder.mkdir()
            (output_folder / "study.xlsx").write_text("old", encoding="utf-8")

            with (
                patch(
                    "backend.sidecar_server.run_screen.scan_input_source",
                    return_value=_scan_preview_files(input_folder, ["a.mp3", "b.wav"]),
                ),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
            ):
                prepared = prepare_batch(
                    {
                        "input_source_type": "folder",
                        "input_path": input_folder,
                        "transcript_output_folder": str(output_folder),
                        "output_organization": "combined_file",
                        "output_naming_mode": "override",
                        "output_basename": "study",
                        "export_formats": ["xlsx", "json", "docx"],
                        "acceleration": "cpu",
                    }
                )

        transcript_targets = [
            target for target in prepared.export_targets if target.role == "combined_transcript"
        ]
        self.assertEqual(prepared.settings["output_organization"], "combined_file")
        self.assertEqual(
            [Path(target.path).name for target in transcript_targets],
            ["study_copy01.xlsx", "study_copy01.json", "study_copy01.docx"],
        )
        self.assertTrue(all(target.file_name is None for target in transcript_targets))
        overview_names = [
            Path(target.path).name
            for target in prepared.export_targets
            if target.role == "batch_overview"
        ]
        self.assertEqual(len(overview_names), 1)
        self.assertRegex(overview_names[0], r"^run_overview_\d{4}-\d{2}-\d{2}_\d{6}\.xlsx$")

    def test_single_file_forces_separate_output_for_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_file = str(Path(directory) / "sample.wav")
            output_folder = str(Path(directory) / "out")
            Path(input_file).write_bytes(b"media")

            with (
                patch(
                    "backend.sidecar_server.run_screen.scan_input_source",
                    return_value=_scan_preview_files(directory, ["sample.wav"]),
                ),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
            ):
                prepared = prepare_batch(
                    {
                        "input_source_type": "single_file",
                        "input_path": input_file,
                        "transcript_output_folder": output_folder,
                        "output_organization": "combined_file",
                        "output_basename": "study",
                        "export_formats": ["xlsx"],
                        "acceleration": "cpu",
                    }
                )

        self.assertEqual(prepared.settings["output_organization"], "separate_files")
        self.assertEqual(prepared.export_targets[0].role, "transcript")

    def test_prepare_batch_rejects_empty_scan_and_unavailable_cuda(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = str(Path(directory) / "out")
            Path(input_folder).mkdir()

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(input_folder)),
            ):
                with self.assertRaisesRegex(ValueError, "NVIDIA / CUDA is not available"):
                    prepare_batch(
                        {
                            "input_path": input_folder,
                            "transcript_output_folder": output_folder,
                            "acceleration": "cuda",
                        }
                    )

    def test_prepare_batch_accepts_cuda_only_from_ready_hardware_scan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = str(Path(directory) / "out")
            Path(input_folder).mkdir()

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(input_folder)),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
                patch(
                    "backend.sidecar_server.run_screen.hardware_scan_manager.ready_summary",
                    return_value=_hardware(cuda_available=True),
                ),
            ):
                prepared = prepare_batch(
                    {
                        "input_path": input_folder,
                        "transcript_output_folder": output_folder,
                        "acceleration": "cuda",
                    }
                )

        self.assertEqual(prepared.settings["acceleration"], "cuda")

    def test_prepare_batch_rejects_missing_transcription_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_folder = str(Path(directory) / "input")
            output_folder = str(Path(directory) / "out")
            Path(input_folder).mkdir()

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(input_folder)),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": False},
                ),
            ):
                with self.assertRaisesRegex(ValueError, "Download the small faster-whisper model"):
                    prepare_batch(
                        {
                            "input_path": input_folder,
                            "transcript_output_folder": output_folder,
                            "acceleration": "cpu",
                        }
                    )

            with (
                patch("backend.sidecar_server.run_screen.scan_input_source", return_value=_scan_preview(input_folder, empty=True)),
                patch(
                    "backend.sidecar_server.run_screen._transcription_model_option",
                    return_value={"installed": True},
                ),
                patch("backend.sidecar_server.run_screen.load_settings", return_value=AppSettings()),
            ):
                with self.assertRaisesRegex(ValueError, "No media files found"):
                    prepare_batch(
                        {
                            "input_path": input_folder,
                            "transcript_output_folder": output_folder,
                            "acceleration": "cpu",
                        }
                    )


if __name__ == "__main__":
    unittest.main()
