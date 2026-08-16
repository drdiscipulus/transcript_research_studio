from __future__ import annotations

from pathlib import Path
from typing import Any

from .path_utils import any_format_target_exists, first_available_copy_stem, sanitize_plain_stem

DEFAULT_PARAGRAPH_OPTIONS = {
    "paragraph_pause_enabled": True,
    "max_pause_seconds": 3.0,
}

VALID_EXPORT_FORMATS = {"xlsx", "csv", "json", "docx"}
VALID_TRANSCRIPT_LAYOUTS = {"file", "paragraph", "segment"}
VALID_INPUT_SOURCE_TYPES = {"folder", "single_file"}
VALID_OUTPUT_NAMING_MODES = {"input_filename", "override"}
VALID_OUTPUT_ORGANIZATIONS = {"separate_files", "combined_file"}


def normalize_transcript_layout(value: Any) -> str:
    normalized = str(value or "file").strip().lower()
    return normalized if normalized in VALID_TRANSCRIPT_LAYOUTS else "file"


def normalize_export_formats(value: Any) -> list[str]:
    if not isinstance(value, list):
        return ["xlsx"]

    formats: list[str] = []
    for format_name in value:
        normalized = str(format_name).strip().lower()
        if normalized and normalized in VALID_EXPORT_FORMATS and normalized not in formats:
            formats.append(normalized)
    return formats or ["xlsx"]


def normalize_input_source_type(value: Any) -> str:
    normalized = str(value or "folder").strip().lower()
    return normalized if normalized in VALID_INPUT_SOURCE_TYPES else "folder"


def normalize_output_naming_mode(value: Any) -> str:
    normalized = str(value or "input_filename").strip().lower()
    return normalized if normalized in VALID_OUTPUT_NAMING_MODES else "input_filename"


def normalize_output_organization(value: Any) -> str:
    normalized = str(value or "separate_files").strip().lower()
    return normalized if normalized in VALID_OUTPUT_ORGANIZATIONS else "separate_files"


def normalize_paragraph_options(value: Any) -> dict[str, Any]:
    payload = value if isinstance(value, dict) else {}
    return {
        "paragraph_pause_enabled": bool(payload.get("paragraph_pause_enabled", True)),
        "max_pause_seconds": normalize_paragraph_pause(payload.get("max_pause_seconds")),
    }


def normalize_paragraph_pause(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return DEFAULT_PARAGRAPH_OPTIONS["max_pause_seconds"]
    if parsed < 0:
        return DEFAULT_PARAGRAPH_OPTIONS["max_pause_seconds"]
    return parsed

def sanitize_batch_name(value: str) -> str:
    return sanitize_plain_stem(value, default=default_batch_name())


def sanitize_output_basename(value: str) -> str:
    return sanitize_batch_name(value)


def default_batch_name() -> str:
    return "transcripts"


def validate_transcription_folders(
    *,
    input_folder: str,
    transcript_output_folder: str,
) -> list[str]:
    normalized_input = _normalize_folder(input_folder)
    normalized_transcript = _normalize_folder(transcript_output_folder)
    messages: list[str] = []

    if not normalized_input:
        messages.append("Input folder is required.")
    if not normalized_transcript:
        messages.append("Transcript output folder is required.")
    if normalized_input and normalized_transcript and normalized_input == normalized_transcript:
        messages.append("Input folder and transcript output folder must be different.")
    return messages


def validate_transcription_paths(
    *,
    input_source_type: str,
    input_path: str,
    transcript_output_folder: str,
) -> list[str]:
    normalized_input = _normalize_folder(input_path)
    normalized_transcript = _normalize_folder(transcript_output_folder)
    messages: list[str] = []

    if not normalized_input:
        messages.append("Input media file is required." if input_source_type == "single_file" else "Input folder is required.")
    if not normalized_transcript:
        messages.append("Transcript output folder is required.")
    if input_source_type == "folder" and normalized_input and normalized_transcript and normalized_input == normalized_transcript:
        messages.append("Input folder and transcript output folder must be different.")
    return messages


def output_stem_for_file(
    *,
    file_name: str,
    file_index: int,
    total_files: int,
    naming_mode: str,
    output_basename: str,
) -> str:
    if naming_mode != "override":
        return sanitize_output_basename(Path(file_name).stem)
    stem = sanitize_output_basename(output_basename)
    if total_files <= 1:
        return stem
    padding_width = max(2, len(str(total_files)))
    return f"{stem}_{file_index:0{padding_width}d}"


def resolve_non_conflicting_stem(output_folder: Path, desired_stem: str, export_formats: list[str]) -> str:
    stem = sanitize_output_basename(desired_stem)
    return first_available_copy_stem(
        base_stem=stem,
        exists=lambda candidate: any_format_target_exists(output_folder, candidate, export_formats),
    )


def _normalize_folder(value: str) -> str:
    return value.strip().rstrip("\\/").lower()
