from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .export_docx import write_docx_bundle
from .export_rows import (
    build_table_export_rows,
    default_paragraph_options,
    format_export_timestamp,
    normalize_transcript_layout,
)
from .export_table_formats import write_csv, write_json, write_xlsx
from .path_utils import sanitize_path_stem
from .prompting_tables import load_table
from .transcript_io import (
    first_non_empty,
    has_any_key,
    normalize_speaker_id,
    parse_docx_segment_line,
    read_docx_paragraphs,
)

SUPPORTED_TRANSCRIPT_EXTENSIONS = {".json", ".csv", ".xlsx", ".docx"}
SUPPORTED_MEDIA_EXTENSIONS = {
    ".wav",
    ".mp3",
    ".m4a",
    ".flac",
    ".ogg",
    ".opus",
    ".aac",
    ".mp4",
    ".m4v",
    ".mov",
    ".mkv",
    ".webm",
    ".avi",
}
EDITOR_SCHEMA_VERSION = "1.0"
MAX_TRANSCRIPT_JSON_BYTES = 64 * 1024**2


@dataclass(frozen=True)
class EditorExportTarget:
    format: str
    path: str
    exists: bool = False


@dataclass(frozen=True)
class EditorPreparedBatch:
    batch_name: str
    settings: dict[str, Any]
    export_targets: list[EditorExportTarget]


def inspect_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    """Inspect a transcript file and report selectable documents without loading editor state."""
    path = resolve_transcript_path(payload.get("transcript_file"))
    extension = path.suffix.lower()
    if extension == ".json":
        raw_payload = read_json_transcript(path)
        choices = inspect_json_documents(raw_payload, path)
        format_name = detect_json_format(raw_payload)
    elif extension in {".csv", ".xlsx"}:
        table = load_table(path)
        choices = inspect_table_documents(table["rows"], path)
        format_name = str(table["format"])
    elif extension == ".docx":
        paragraphs = read_docx_paragraphs(path)
        choices = [document_choice("doc_000001", path.name, path.name, len(paragraphs), None)]
        format_name = "docx"
    else:
        raise ValueError("Only JSON, CSV, XLSX, and DOCX transcripts are supported.")

    return {
        "transcript_file": str(path),
        "format": format_name,
        "documents": choices,
        "requires_document_selection": len(choices) > 1,
    }


def load_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    """Load one transcript document into the editor's normalized working shape."""
    path = resolve_transcript_path(payload.get("transcript_file"))
    document_id = str(payload.get("document_id") or "").strip() or None
    extension = path.suffix.lower()

    if extension == ".json":
        raw_payload = read_json_transcript(path)
        transcript = normalize_json_payload(raw_payload, path, document_id)
    elif extension in {".csv", ".xlsx"}:
        table = load_table(path)
        transcript = normalize_table_rows(table["rows"], path, document_id, str(table["format"]))
    elif extension == ".docx":
        transcript = normalize_docx(path)
    else:
        raise ValueError("Only JSON, CSV, XLSX, and DOCX transcripts are supported.")

    if not str(transcript.get("media_file") or "").strip():
        transcript["media_file"] = infer_matching_media_file(transcript, path)
    transcript["validation_issues"] = validate_transcript(transcript)
    return transcript


def save_edited_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist the editor working copy as JSON without overwriting the source unless requested."""
    transcript = require_transcript(payload.get("transcript"))
    output_file = str(payload.get("output_file") or "").strip()
    if not output_file:
        raise ValueError("Output file is required.")
    output_path = Path(output_file).expanduser()
    if output_path.suffix.lower() != ".json":
        output_path = output_path.with_suffix(".json")
    output_path = output_path.resolve()

    source_path = Path(str(transcript.get("source_transcript_file") or "")).expanduser()
    try:
        same_as_source = source_path.resolve() == output_path
    except OSError:
        same_as_source = False
    if same_as_source and not bool(payload.get("allow_overwrite_source", False)):
        raise ValueError("Choose a different path for the edited working JSON.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized = normalize_editor_working_transcript(transcript)
    normalized["validation_issues"] = validate_transcript(normalized)
    output_path.write_text(json.dumps(normalized, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"output_file": str(output_path), "validation_issues": normalized["validation_issues"]}


def export_edited_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    """Export the current edited transcript by adapting it to the standard document export shape."""
    transcript = normalize_editor_working_transcript(require_transcript(payload.get("transcript")))
    output_folder_value = str(payload.get("output_folder") or "").strip()
    if not output_folder_value:
        raise ValueError("Output folder is required.")
    output_folder = Path(output_folder_value).expanduser()
    output_folder = output_folder.resolve()
    output_folder.mkdir(parents=True, exist_ok=True)

    output_name = sanitize_file_stem(str(payload.get("output_name") or "").strip() or "edited_transcript")
    export_formats = [
        str(value).strip().lower()
        for value in payload.get("export_formats", [])
        if str(value).strip().lower() in {"csv", "xlsx", "json", "docx"}
    ]
    if not export_formats:
        raise ValueError("Choose at least one export format.")

    transcript_layout = normalize_transcript_layout(payload.get("transcript_layout"))
    documents = [editor_transcript_to_document(transcript)]
    settings = {
        "output_mode": "edited",
        "transcript_layout": transcript_layout,
        "paragraph_options": default_paragraph_options(),
        "advanced_transcription": {"include_timestamps": True},
    }
    prepared_batch = EditorPreparedBatch(
        batch_name=output_name,
        settings=settings,
        export_targets=[
            EditorExportTarget(format=export_format, path=str(output_folder / f"{output_name}.{export_format}"))
            for export_format in export_formats
        ],
    )

    headers, rows = build_editor_table_rows(documents, transcript_layout)
    written_docx_paths: list[Path] = []
    for export_target in prepared_batch.export_targets:
        path = Path(export_target.path)
        if export_target.format == "csv":
            write_csv(path, headers, rows)
        elif export_target.format == "xlsx":
            write_xlsx(path, headers, rows)
        elif export_target.format == "json":
            write_json(path, prepared_batch, rows, documents, transcript_layout)
        elif export_target.format == "docx":
            written_docx_paths.extend(write_docx_bundle(path, prepared_batch, documents, transcript_layout))

    output_files = [
        {"format": target.format, "path": target.path, "exists": Path(target.path).exists()}
        for target in prepared_batch.export_targets
        if target.format != "docx"
    ]
    output_files.extend(
        {
            "format": "docx",
            "path": str(path),
            "exists": path.exists(),
        }
        for path in written_docx_paths
    )
    return {"output_files": output_files, "validation_issues": validate_transcript(transcript)}


def resolve_transcript_path(value: Any) -> Path:
    path_value = str(value or "").strip()
    if not path_value:
        raise ValueError("Transcript file is required.")
    path = Path(path_value).expanduser()
    path = path.resolve()
    if not path.is_file():
        raise ValueError("Transcript file does not exist.")
    if path.suffix.lower() not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
        raise ValueError("Only JSON, CSV, XLSX, and DOCX transcripts are supported.")
    return path


def read_json_transcript(path: Path) -> Any:
    try:
        file_size = path.stat().st_size
    except OSError as error:
        raise ValueError("Could not read transcript file metadata.") from error
    if file_size > MAX_TRANSCRIPT_JSON_BYTES:
        raise ValueError("JSON transcript file is too large.")
    return json.loads(path.read_text(encoding="utf-8"))


def infer_matching_media_file(transcript: dict[str, Any], transcript_path: Path) -> str:
    metadata = transcript.get("metadata") if isinstance(transcript.get("metadata"), dict) else {}
    source_names = [
        str(metadata.get("file_name") or "").strip(),
        str(transcript.get("source_transcript_file") or "").strip(),
    ]
    stems = {
        Path(value).stem.lower()
        for value in source_names
        if value and Path(value).suffix.lower() not in SUPPORTED_TRANSCRIPT_EXTENSIONS
    }
    if not stems:
        stems.add(transcript_path.stem.lower())

    search_dirs = [transcript_path.parent]
    source_path = Path(str(transcript.get("source_transcript_file") or ""))
    if source_path.parent and source_path.parent not in search_dirs:
        search_dirs.append(source_path.parent)

    for search_dir in search_dirs:
        if not search_dir.is_dir():
            continue
        for candidate in search_dir.iterdir():
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_MEDIA_EXTENSIONS and candidate.stem.lower() in stems:
                return str(candidate.resolve())
    return ""


def detect_json_format(payload: Any) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("documents"), list):
        return "app-json"
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        return "edited-json"
    if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
        return "table-json"
    if isinstance(payload, list):
        return "table-json"
    return "json"


def inspect_json_documents(payload: Any, path: Path) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        return [
            document_choice(
                str(payload.get("source_document_id") or "doc_000001"),
                path.name,
                path.name,
                len(payload.get("segments") or []),
                None,
            )
        ]
    if isinstance(payload, dict) and isinstance(payload.get("documents"), list):
        choices = []
        for index, document in enumerate(payload["documents"], start=1):
            if not isinstance(document, dict):
                continue
            document_id = f"doc_{index:06d}"
            choices.append(
                document_choice(
                    document_id,
                    str(document.get("file_name") or f"Document {index}"),
                    str(document.get("file_name") or path.name),
                    len(document.get("segments") or []),
                    document.get("duration"),
                )
            )
        return choices or [document_choice("doc_000001", path.name, path.name, 0, None)]
    if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
        return inspect_table_documents(payload["rows"], path)
    if isinstance(payload, list):
        return inspect_table_documents(payload, path)
    return [document_choice("doc_000001", path.name, path.name, 0, None)]


def inspect_table_documents(rows: list[Any], path: Path) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    normalized_rows = [row for row in rows if isinstance(row, dict)]
    for row in normalized_rows:
        file_name = str(row.get("file_name") or row.get("source_file") or path.name).strip() or path.name
        grouped.setdefault(file_name, []).append(row)

    if not grouped:
        return [document_choice("doc_000001", path.name, path.name, 0, None)]
    if len(grouped) == 1:
        file_name, file_rows = next(iter(grouped.items()))
        return [document_choice("doc_000001", file_name, file_name, len(file_rows), None)]
    return [
        document_choice(f"doc_{index:06d}", file_name, file_name, len(file_rows), None)
        for index, (file_name, file_rows) in enumerate(grouped.items(), start=1)
    ]


def document_choice(
    document_id: str,
    label: str,
    file_name: str,
    segment_count: int,
    duration: Any,
) -> dict[str, Any]:
    return {
        "id": document_id,
        "label": label,
        "file_name": file_name,
        "segment_count": segment_count,
        "duration": float_or_none(duration),
    }


def normalize_json_payload(payload: Any, path: Path, document_id: str | None) -> dict[str, Any]:
    """Normalize app JSON exports or saved editor working JSON into the editor transcript shape."""
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        return normalize_editor_working_transcript(
            {
                **payload,
                "source_transcript_file": str(payload.get("source_transcript_file") or path),
                "source_document_id": str(payload.get("source_document_id") or document_id or "doc_000001"),
            }
        )

    if isinstance(payload, dict) and isinstance(payload.get("documents"), list):
        documents = [document for document in payload["documents"] if isinstance(document, dict)]
        selected_index = document_index_from_id(document_id) if document_id else 0
        if selected_index >= len(documents):
            raise ValueError("Selected document was not found in this transcript.")
        selected_document = documents[selected_index]
        return normalize_document(selected_document, path, f"doc_{selected_index + 1:06d}", {"source_format": "app-json"})

    rows = None
    if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
        rows = payload["rows"]
    elif isinstance(payload, list):
        rows = payload
    if rows is not None:
        return normalize_table_rows(rows, path, document_id, "json")
    raise ValueError("JSON transcript format is not recognized.")


def normalize_document(document: dict[str, Any], path: Path, document_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    """Convert one app-export JSON document into editable segments and speaker metadata."""
    raw_segments = document.get("segments") if isinstance(document.get("segments"), list) else []
    segments: list[dict[str, Any]] = []
    for index, raw_segment in enumerate(raw_segments, start=1):
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        speaker = normalize_speaker_id(raw_segment.get("speaker_id") or raw_segment.get("speaker"))
        segments.append(
            {
                "id": f"seg_{len(segments) + 1:06d}",
                "start": float_or_none(raw_segment.get("start_seconds", raw_segment.get("start"))),
                "end": float_or_none(raw_segment.get("end_seconds", raw_segment.get("end"))),
                "speaker": speaker,
                "text": text,
            }
        )
    if not segments:
        transcript_text = str(document.get("transcript") or "").strip()
        if transcript_text:
            segments.append({"id": "seg_000001", "start": None, "end": None, "speaker": "", "text": transcript_text})

    return {
        "schema_version": EDITOR_SCHEMA_VERSION,
        "source_transcript_file": str(path),
        "source_document_id": document_id,
        "media_file": "",
        "language": str(document.get("detected_language") or ""),
        "speakers": build_speakers(segments, document.get("speakers")),
        "segments": segments,
        "metadata": {
            **metadata,
            "file_name": str(document.get("file_name") or path.name),
            "duration": document.get("duration"),
            "file_info": str(document.get("file_info") or ""),
            "task": str(document.get("task") or ""),
        },
    }


def normalize_table_rows(rows: list[Any], path: Path, document_id: str | None, format_name: str) -> dict[str, Any]:
    """Convert CSV/XLSX-style transcript rows into the same editable segment shape."""
    normalized_rows = [row for row in rows if isinstance(row, dict)]
    choices = inspect_table_documents(normalized_rows, path)
    selected_choice = choices[document_index_from_id(document_id)] if document_id and len(choices) > 1 else choices[0]
    selected_file_name = selected_choice["file_name"]
    if len(choices) > 1:
        normalized_rows = [
            row for row in normalized_rows if str(row.get("file_name") or row.get("source_file") or path.name) == selected_file_name
        ]

    has_segment_columns = any(has_any_key(row, ["start_seconds", "start", "end_seconds", "end", "speaker"]) for row in normalized_rows)
    segments: list[dict[str, Any]] = []
    if has_segment_columns:
        for row in normalized_rows:
            text = str(row.get("text") or row.get("transcript") or "").strip()
            if not text:
                continue
            segments.append(
                {
                    "id": f"seg_{len(segments) + 1:06d}",
                    "start": float_or_none(row.get("start_seconds", row.get("start"))),
                    "end": float_or_none(row.get("end_seconds", row.get("end"))),
                    "speaker": normalize_speaker_id(row.get("speaker_id") or row.get("speaker")),
                    "text": text,
                }
            )
    else:
        for row in normalized_rows:
            text = str(row.get("transcript") or row.get("text") or "").strip()
            if text:
                segments.append({"id": f"seg_{len(segments) + 1:06d}", "start": None, "end": None, "speaker": "", "text": text})

    return {
        "schema_version": EDITOR_SCHEMA_VERSION,
        "source_transcript_file": str(path),
        "source_document_id": str(selected_choice["id"]),
        "media_file": "",
        "language": first_non_empty(normalized_rows, ["detected_language", "language"]),
        "speakers": build_speakers(segments, None),
        "segments": segments,
        "metadata": {
            "source_format": format_name,
            "file_name": selected_file_name,
            "duration": first_non_empty(normalized_rows, ["duration"]),
            "file_info": first_non_empty(normalized_rows, ["file_info"]),
            "task": first_non_empty(normalized_rows, ["task"]),
        },
    }


def normalize_docx(path: Path) -> dict[str, Any]:
    """Parse app-generated DOCX transcripts by reading timestamped speaker paragraphs."""
    paragraphs = [
        paragraph
        for paragraph in read_docx_paragraphs(path)
        if paragraph and not paragraph.startswith(("Duration:", "File info:", "Detected language:", "Task:", "Speakers:"))
    ]
    title = paragraphs[0] if paragraphs else path.name
    body_paragraphs = paragraphs[1:] if len(paragraphs) > 1 else paragraphs
    segments: list[dict[str, Any]] = []
    for paragraph in body_paragraphs:
        parsed = parse_docx_segment_line(paragraph)
        if parsed["text"]:
            segments.append(
                {
                    "id": f"seg_{len(segments) + 1:06d}",
                    "start": parsed["start"],
                    "end": parsed.get("end"),
                    "speaker": normalize_speaker_id(parsed["speaker"]),
                    "text": parsed["text"],
                }
            )
    for index, segment in enumerate(segments[:-1]):
        if segment["end"] is None and segments[index + 1]["start"] is not None:
            segment["end"] = segments[index + 1]["start"]

    return {
        "schema_version": EDITOR_SCHEMA_VERSION,
        "source_transcript_file": str(path),
        "source_document_id": "doc_000001",
        "media_file": "",
        "language": "",
        "speakers": build_speakers(segments, None),
        "segments": segments,
        "metadata": {"source_format": "docx", "file_name": title or path.name},
    }


def normalize_editor_working_transcript(transcript: dict[str, Any]) -> dict[str, Any]:
    """Rehydrate a saved editor JSON file while preserving segment IDs and speaker names."""
    segments: list[dict[str, Any]] = []
    for index, raw_segment in enumerate(transcript.get("segments") or [], start=1):
        if not isinstance(raw_segment, dict):
            continue
        segments.append(
            {
                "id": str(raw_segment.get("id") or f"seg_{index:06d}"),
                "start": float_or_none(raw_segment.get("start")),
                "end": float_or_none(raw_segment.get("end")),
                "speaker": normalize_speaker_id(raw_segment.get("speaker")),
                "text": str(raw_segment.get("text") or ""),
            }
        )

    return {
        "schema_version": EDITOR_SCHEMA_VERSION,
        "source_transcript_file": str(transcript.get("source_transcript_file") or ""),
        "source_document_id": str(transcript.get("source_document_id") or "doc_000001"),
        "media_file": str(transcript.get("media_file") or ""),
        "language": str(transcript.get("language") or ""),
        "speakers": normalize_speakers(transcript.get("speakers"), segments),
        "segments": segments,
        "metadata": transcript.get("metadata") if isinstance(transcript.get("metadata"), dict) else {},
    }


def validate_transcript(transcript: dict[str, Any]) -> list[dict[str, Any]]:
    """Return editor-facing validation issues without blocking save/export automatically."""
    speaker_ids = {
        str(speaker.get("id") or "").strip()
        for speaker in transcript.get("speakers", [])
        if isinstance(speaker, dict)
    }
    issues: list[dict[str, Any]] = []
    for segment in transcript.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment_id = str(segment.get("id") or "")
        if segment.get("start") is None or segment.get("end") is None:
            issues.append({"level": "warning", "segment_id": segment_id, "message": "Segment has missing timestamps."})
        if not str(segment.get("text") or "").strip():
            issues.append({"level": "error", "segment_id": segment_id, "message": "Segment text is empty."})
        speaker = str(segment.get("speaker") or "").strip()
        if speaker and speaker not in speaker_ids:
            issues.append({"level": "warning", "segment_id": segment_id, "message": f"Unknown speaker label: {speaker}."})
    if not transcript.get("segments"):
        issues.append({"level": "error", "segment_id": None, "message": "Transcript has no editable segments."})
    return issues


def build_speakers(segments: list[dict[str, Any]], raw_speakers: Any) -> list[dict[str, str]]:
    speakers = normalize_speakers(raw_speakers, segments)
    if speakers:
        return speakers
    speaker_ids = sorted({str(segment.get("speaker") or "").strip() for segment in segments if segment.get("speaker")})
    return [{"id": speaker_id, "name": speaker_id} for speaker_id in speaker_ids]


def normalize_speakers(raw_speakers: Any, segments: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Build a stable speaker list from explicit metadata plus speakers present in segments."""
    speakers: list[dict[str, str]] = []
    seen: set[str] = set()
    if isinstance(raw_speakers, list):
        for raw_speaker in raw_speakers:
            if isinstance(raw_speaker, dict):
                speaker_id = normalize_speaker_id(raw_speaker.get("id") or raw_speaker.get("speaker"))
                speaker_name = str(raw_speaker.get("name") or speaker_id).strip() or speaker_id
            else:
                speaker_id = normalize_speaker_id(raw_speaker)
                speaker_name = speaker_id
            if speaker_id and speaker_id not in seen:
                seen.add(speaker_id)
                speakers.append({"id": speaker_id, "name": speaker_name})
    for segment in segments:
        speaker_id = normalize_speaker_id(segment.get("speaker"))
        if speaker_id and speaker_id not in seen:
            seen.add(speaker_id)
            speakers.append({"id": speaker_id, "name": speaker_id})
    return speakers


def editor_transcript_to_document(transcript: dict[str, Any]) -> dict[str, Any]:
    """Convert the editor working shape back into the shared export document shape."""
    speaker_names = {
        str(speaker.get("id") or ""): str(speaker.get("name") or speaker.get("id") or "")
        for speaker in transcript.get("speakers", [])
        if isinstance(speaker, dict)
    }
    segments = []
    transcript_text_parts: list[str] = []
    for segment in transcript.get("segments", []):
        if not isinstance(segment, dict):
            continue
        speaker_id = str(segment.get("speaker") or "").strip()
        speaker_name = speaker_names.get(speaker_id, speaker_id)
        text = str(segment.get("text") or "").strip()
        display_speaker = speaker_name or speaker_id
        timestamp_range = timestamp_range_label(segment.get("start"), segment.get("end"))
        prefix = f"[{timestamp_range}] " if timestamp_range else ""
        if display_speaker:
            transcript_text_parts.append(f"{prefix}{display_speaker}: {text}")
        else:
            transcript_text_parts.append(f"{prefix}{text}".strip())
        segments.append(
            {
                "start_seconds": float_or_none(segment.get("start")),
                "end_seconds": float_or_none(segment.get("end")),
                "timestamp_range": timestamp_range,
                "speaker": display_speaker,
                "speaker_id": speaker_id,
                "speaker_name": speaker_name,
                "text": text,
            }
        )
    metadata = transcript.get("metadata") if isinstance(transcript.get("metadata"), dict) else {}
    return {
        "file_name": str(metadata.get("file_name") or Path(str(transcript.get("source_transcript_file") or "edited")).name),
        "duration": metadata.get("duration") or "",
        "file_info": str(metadata.get("file_info") or "Edited transcript"),
        "detected_language": str(transcript.get("language") or ""),
        "task": str(metadata.get("task") or "edited"),
        "speaker_summary": ", ".join(
            f"{speaker_id}={speaker_name}" if speaker_name and speaker_name != speaker_id else speaker_id
            for speaker_id, speaker_name in speaker_names.items()
        ),
        "transcript": "\n".join(transcript_text_parts),
        "segments": segments,
    }


def build_editor_table_rows(documents: list[dict[str, Any]], transcript_layout: str) -> tuple[list[str], list[dict[str, Any]]]:
    """Build table rows from edited segments using the same layout rules as transcription exports."""
    headers, rows = build_table_export_rows(
        documents,
        transcript_layout=transcript_layout,
        paragraph_options=default_paragraph_options(),
    )
    if normalize_transcript_layout(transcript_layout) != "segment":
        return headers, rows

    next_headers = list(headers)
    if "speaker_id" not in next_headers:
        next_headers.insert(next_headers.index("speaker") + 1, "speaker_id")
    if "speaker_name" not in next_headers:
        next_headers.insert(next_headers.index("speaker_id") + 1, "speaker_name")
    if "timestamp_range" not in next_headers:
        next_headers.insert(next_headers.index("end_timestamp") + 1, "timestamp_range")

    enriched_rows: list[dict[str, Any]] = []
    for document in documents:
        for index, segment in enumerate(document.get("segments") or [], start=1):
            row_index = len(enriched_rows)
            if row_index >= len(rows):
                break
            row = dict(rows[row_index])
            row["speaker_id"] = str(segment.get("speaker_id") or "")
            row["speaker_name"] = str(segment.get("speaker_name") or "")
            row["timestamp_range"] = str(segment.get("timestamp_range") or "")
            enriched_rows.append(row)
    return next_headers, enriched_rows


def require_transcript(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Transcript payload is required.")
    return value


def document_index_from_id(document_id: str | None) -> int:
    if not document_id:
        return 0
    match = re.search(r"(\d+)$", document_id)
    if not match:
        return 0
    return max(0, int(match.group(1)) - 1)


def parse_timestamp_seconds(value: str | None) -> float | None:
    if not value:
        return None
    parts = [int(part) for part in value.split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return float(minutes * 60 + seconds)
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return float(hours * 3600 + minutes * 60 + seconds)
    return None


def float_or_none(value: Any) -> float | None:
    try:
        if value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def sanitize_file_stem(value: str) -> str:
    return sanitize_path_stem(value, default="edited_transcript")


def timestamp_label(value: Any) -> str:
    return format_export_timestamp(float_or_none(value))


def timestamp_range_label(start: Any, end: Any) -> str:
    start_label = timestamp_label(start)
    end_label = timestamp_label(end)
    if start_label and end_label:
        return f"{start_label} - {end_label}"
    return start_label or end_label
