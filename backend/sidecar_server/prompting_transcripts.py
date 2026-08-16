from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .prompting_tables import load_table
from .transcript_editor import (
    normalize_docx,
    normalize_document,
    normalize_editor_working_transcript,
)
from .transcript_io import (
    normalize_speaker_id,
    read_docx_paragraphs,
)


SUPPORTED_PROMPT_TRANSCRIPT_EXTENSIONS = {".json", ".csv", ".xlsx", ".docx"}

TEXT_COLUMN_CANDIDATES = ("text", "transcript", "content", "utterance", "segment_text")
TRANSCRIPT_ID_COLUMN_CANDIDATES = ("transcript_id", "file_name", "source_file", "document_id", "recording")
SPEAKER_COLUMN_CANDIDATES = ("speaker", "speaker_name", "speaker_id")
START_COLUMN_CANDIDATES = ("start", "start_seconds", "start_time", "timestamp")
END_COLUMN_CANDIDATES = ("end", "end_seconds", "end_time")


@dataclass(slots=True)
class TranscriptSegment:
    segment_id: str
    speaker: str
    start: float | None
    end: float | None
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "segment_id": self.segment_id,
            "speaker": self.speaker,
            "start": self.start,
            "end": self.end,
            "text": self.text,
        }


@dataclass(slots=True)
class TranscriptObject:
    transcript_id: str
    source_file: str
    segments: list[TranscriptSegment]
    full_text: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "transcript_id": self.transcript_id,
            "source_file": self.source_file,
            "segments": [segment.to_dict() for segment in self.segments],
            "full_text": self.full_text,
            "metadata": dict(self.metadata),
        }


def inspect_prompting_input(payload: dict[str, Any]) -> dict[str, Any]:
    input_mode = normalize_input_mode(payload.get("input_mode"))
    input_path = resolve_input_path(payload.get("input_path"), input_mode)
    paths = transcript_paths_for_input(input_mode, input_path)
    preview, _ = build_prompt_input_preview(paths, payload.get("candidate_mappings"))
    mapping, mapping_columns = infer_mapping_for_paths(paths)
    return {
        "input_mode": input_mode,
        "input_path": str(input_path),
        "file_count": len(paths),
        "files": [
            {
                "path": str(path),
                "file_name": path.name,
                "format": path.suffix.lower().lstrip("."),
                "requires_mapping": path.suffix.lower() in {".csv", ".xlsx"},
            }
            for path in paths
        ],
        "mapping": mapping,
        "mapping_columns": mapping_columns,
        "mapping_required": any(path.suffix.lower() in {".csv", ".xlsx"} for path in paths)
        and not mapping.get("text_column"),
        **preview,
    }


def load_selected_transcript_objects(payload: dict[str, Any]) -> tuple[list[TranscriptObject], dict[str, Any]]:
    """Load an immutable logical-candidate selection from the current preview contract."""
    selected_ids = payload.get("selected_candidate_ids")
    if not isinstance(selected_ids, list):
        raise ValueError("Selected transcript candidate IDs must be a list.")
    if any(not isinstance(value, str) or not value.strip() for value in selected_ids):
        raise ValueError("Selected transcript candidate IDs must be non-empty strings.")

    input_mode = normalize_input_mode(payload.get("input_mode"))
    input_path = resolve_input_path(payload.get("input_path"), input_mode)
    paths = transcript_paths_for_input(input_mode, input_path)
    preview, records = build_prompt_input_preview(paths, payload.get("candidate_mappings"))
    selected = set(selected_ids)
    known = {record["candidate"]["candidate_id"] for record in records}
    unknown = sorted(selected - known)
    if unknown:
        raise ValueError("The transcript preview is stale. Inspect the input again before starting.")

    duplicate_groups: dict[str, list[str]] = {}
    for record in records:
        candidate = record["candidate"]
        group = str(candidate.get("equivalent_group") or "")
        if group:
            duplicate_groups.setdefault(group, []).append(candidate["candidate_id"])
    for candidate_ids in duplicate_groups.values():
        selected_in_group = selected.intersection(candidate_ids)
        if len(selected_in_group) != 1:
            raise ValueError("Choose one transcript representation from every equivalent-format group.")

    transcripts = [record["transcript"] for record in records if record["candidate"]["candidate_id"] in selected]
    if not transcripts:
        raise ValueError("Select at least one ready transcript candidate.")
    excluded = [
        {
            "file_name": item.get("file_name", ""),
            "source_path": item.get("source_path", ""),
            "code": item.get("status", "problem"),
            "message": item.get("reason", "Not selected."),
        }
        for item in preview["candidates"]
        if item.get("candidate_id") not in selected
    ]
    return transcripts, {"excluded": excluded, "candidate_count": len(preview["candidates"])}


def build_prompt_input_preview(
    paths: list[Path],
    candidate_mappings: Any = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mappings = candidate_mappings if isinstance(candidate_mappings, dict) else {}
    candidates: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    problems: list[dict[str, Any]] = []

    for path in paths:
        columns: list[str] = []
        inferred: dict[str, str] = {}
        mapping = normalize_mapping(mappings.get(str(path)) or mappings.get(path.name))
        try:
            if path.suffix.lower() in {".csv", ".xlsx"}:
                table = load_table(path)
                columns = table["columns"]
                inferred = infer_mapping_from_columns(columns)
                effective_mapping = {key: mapping.get(key) or inferred.get(key) or "" for key in inferred}
                if not effective_mapping.get("text_column"):
                    candidates.append(_mapping_candidate(path, columns, effective_mapping))
                    continue
                transcripts = load_table_transcripts(table["rows"], columns, path, effective_mapping)
                mapping = effective_mapping
            else:
                transcripts = load_transcript_file(path, {})
            if not transcripts:
                raise ValueError("No logical transcripts were found in this file.")
            for document_index, transcript in enumerate(transcripts, start=1):
                if not transcript.segments or not transcript.full_text.strip():
                    raise ValueError("The transcript contains no readable text segments.")
                candidate = _candidate_payload(path, transcript, document_index, columns, mapping)
                candidates.append(candidate)
                records.append({"candidate": candidate, "transcript": transcript})
        except Exception as error:  # noqa: BLE001
            problem = _problem_candidate(path, str(error))
            candidates.append(problem)
            problems.append(problem)

    fingerprint_groups: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        fingerprint = str(candidate.get("content_fingerprint") or "")
        if fingerprint and candidate.get("status") == "ready":
            fingerprint_groups.setdefault(fingerprint, []).append(candidate)
    for fingerprint, grouped in fingerprint_groups.items():
        if len(grouped) < 2:
            continue
        formats = {str(candidate.get("format") or "") for candidate in grouped}
        if len(formats) < 2:
            continue
        group_id = f"equivalent_{fingerprint[:16]}"
        for candidate in grouped:
            candidate["status"] = "equivalent_format"
            candidate["equivalent_group"] = group_id
            candidate["recommended"] = candidate.get("format") == "json"
            candidate["reason"] = "Choose one representation of this transcript before running."

    counts = {
        "ready": sum(1 for item in candidates if item.get("status") == "ready"),
        "decisions_required": len({item.get("equivalent_group") for item in candidates if item.get("equivalent_group")}),
        "mapping_required": sum(1 for item in candidates if item.get("status") == "mapping_required"),
        "problems": sum(1 for item in candidates if item.get("status") == "problem"),
    }
    return {
        "candidate_count": len(candidates),
        "counts": counts,
        "candidates": candidates,
        "problems": problems,
    }, records


def _candidate_payload(
    path: Path,
    transcript: TranscriptObject,
    document_index: int,
    columns: list[str],
    mapping: dict[str, str],
) -> dict[str, Any]:
    normalized_text = "\n".join(" ".join(segment.text.casefold().split()) for segment in transcript.segments)
    fingerprint = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
    identity = f"{path.resolve()}::{document_index}::{transcript.transcript_id}"
    return {
        "candidate_id": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24],
        "source_path": str(path),
        "file_name": path.name,
        "format": path.suffix.lower().lstrip("."),
        "document_id": transcript.transcript_id,
        "document_index": document_index,
        "title": str(transcript.metadata.get("file_name") or transcript.transcript_id),
        "segment_count": len(transcript.segments),
        "content_fingerprint": fingerprint,
        "status": "ready",
        "reason": "Ready for analysis.",
        "recommended": False,
        "equivalent_group": None,
        "mapping_columns": columns,
        "mapping": mapping,
    }


def _mapping_candidate(path: Path, columns: list[str], mapping: dict[str, str]) -> dict[str, Any]:
    return {
        "candidate_id": hashlib.sha256(f"mapping::{path.resolve()}".encode("utf-8")).hexdigest()[:24],
        "source_path": str(path),
        "file_name": path.name,
        "format": path.suffix.lower().lstrip("."),
        "document_id": path.stem,
        "document_index": 1,
        "title": path.name,
        "segment_count": 0,
        "content_fingerprint": "",
        "status": "mapping_required",
        "reason": "Choose the transcript text column before running.",
        "recommended": False,
        "equivalent_group": None,
        "mapping_columns": columns,
        "mapping": mapping,
    }


def _problem_candidate(path: Path, reason: str) -> dict[str, Any]:
    return {
        "candidate_id": hashlib.sha256(f"problem::{path.resolve()}".encode("utf-8")).hexdigest()[:24],
        "source_path": str(path),
        "file_name": path.name,
        "format": path.suffix.lower().lstrip("."),
        "document_id": path.stem,
        "document_index": 1,
        "title": path.name,
        "segment_count": 0,
        "content_fingerprint": "",
        "status": "problem",
        "reason": reason or "The transcript could not be read.",
        "recommended": False,
        "equivalent_group": None,
        "mapping_columns": [],
        "mapping": {},
    }


def load_transcript_objects(payload: dict[str, Any]) -> list[TranscriptObject]:
    input_mode = normalize_input_mode(payload.get("input_mode"))
    input_path = resolve_input_path(payload.get("input_path"), input_mode)
    mapping = normalize_mapping(payload.get("advanced_mapping"))
    transcripts: list[TranscriptObject] = []
    for path in transcript_paths_for_input(input_mode, input_path):
        transcripts.extend(load_transcript_file(path, mapping))
    if not transcripts:
        raise ValueError("No readable transcript files were found.")
    return transcripts


def normalize_input_mode(value: Any) -> str:
    mode = str(value or "file").strip().lower()
    if mode in {"single", "single_file", "transcript_file"}:
        return "file"
    if mode not in {"file", "folder"}:
        raise ValueError("Choose either a transcript file or a transcript folder.")
    return mode


def resolve_input_path(value: Any, input_mode: str) -> Path:
    raw_path = str(value or "").strip()
    if not raw_path:
        raise ValueError("Choose a transcript input file or folder.")
    path = Path(raw_path).expanduser().resolve()
    if input_mode == "file":
        if not path.is_file():
            raise ValueError("Selected transcript file does not exist.")
        if path.suffix.lower() not in SUPPORTED_PROMPT_TRANSCRIPT_EXTENSIONS:
            raise ValueError("Only JSON, CSV, XLSX, and DOCX transcript files are supported.")
    else:
        if not path.is_dir():
            raise ValueError("Selected transcript folder does not exist.")
    return path


def transcript_paths_for_input(input_mode: str, input_path: Path) -> list[Path]:
    if input_mode == "file":
        return [input_path]
    paths = [
        path.resolve()
        for path in input_path.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_PROMPT_TRANSCRIPT_EXTENSIONS
    ]
    return sorted(paths, key=lambda path: path.name.lower())


def infer_mapping_for_paths(paths: list[Path]) -> tuple[dict[str, str], list[str]]:
    for path in paths:
        if path.suffix.lower() not in {".csv", ".xlsx"}:
            continue
        table = load_table(path)
        return infer_mapping_from_columns(table["columns"]), table["columns"]
    return {}, []


def infer_mapping_from_columns(columns: list[str]) -> dict[str, str]:
    normalized = {column.strip().lower(): column for column in columns}
    return {
        "text_column": first_matching_column(normalized, TEXT_COLUMN_CANDIDATES),
        "transcript_id_column": first_matching_column(normalized, TRANSCRIPT_ID_COLUMN_CANDIDATES),
        "speaker_column": first_matching_column(normalized, SPEAKER_COLUMN_CANDIDATES),
        "start_column": first_matching_column(normalized, START_COLUMN_CANDIDATES),
        "end_column": first_matching_column(normalized, END_COLUMN_CANDIDATES),
    }


def first_matching_column(normalized_columns: dict[str, str], candidates: tuple[str, ...]) -> str:
    for candidate in candidates:
        if candidate in normalized_columns:
            return normalized_columns[candidate]
    return ""


def normalize_mapping(value: Any) -> dict[str, str]:
    raw = value if isinstance(value, dict) else {}
    return {
        "text_column": str(raw.get("text_column") or "").strip(),
        "transcript_id_column": str(raw.get("transcript_id_column") or "").strip(),
        "speaker_column": str(raw.get("speaker_column") or "").strip(),
        "start_column": str(raw.get("start_column") or "").strip(),
        "end_column": str(raw.get("end_column") or "").strip(),
    }


def load_transcript_file(path: Path, mapping: dict[str, str]) -> list[TranscriptObject]:
    extension = path.suffix.lower()
    if extension == ".json":
        return load_json_transcripts(path)
    if extension in {".csv", ".xlsx"}:
        table = load_table(path)
        return load_table_transcripts(table["rows"], table["columns"], path, mapping)
    if extension == ".docx":
        return [editor_transcript_to_prompt_object(normalize_docx(path), path)]
    raise ValueError(f"Unsupported transcript format: {extension}")


def load_json_transcripts(path: Path) -> list[TranscriptObject]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        return [editor_transcript_to_prompt_object(normalize_editor_working_transcript(payload), path)]
    if isinstance(payload, dict) and isinstance(payload.get("documents"), list):
        transcripts = []
        for index, document in enumerate(payload["documents"], start=1):
            if isinstance(document, dict):
                normalized = normalize_document(
                    document,
                    path,
                    f"doc_{index:06d}",
                    {"source_format": "app-json"},
                )
                transcripts.append(editor_transcript_to_prompt_object(normalized, path))
        return transcripts
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if isinstance(rows, list):
        columns = table_columns([row for row in rows if isinstance(row, dict)])
        return load_table_transcripts(rows, columns, path, {})
    raise ValueError("JSON transcript format is not recognized.")


def table_columns(rows: list[dict[str, Any]]) -> list[str]:
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    return columns


def load_table_transcripts(
    rows: list[Any],
    columns: list[str],
    path: Path,
    mapping: dict[str, str],
) -> list[TranscriptObject]:
    normalized_rows = [row for row in rows if isinstance(row, dict)]
    inferred = infer_mapping_from_columns(columns)
    text_column = mapping.get("text_column") or inferred.get("text_column")
    if not text_column:
        raise ValueError("Could not infer a transcript text column. Open Advanced input mapping and choose one.")
    transcript_id_column = mapping.get("transcript_id_column") or inferred.get("transcript_id_column")
    speaker_column = mapping.get("speaker_column") or inferred.get("speaker_column")
    start_column = mapping.get("start_column") or inferred.get("start_column")
    end_column = mapping.get("end_column") or inferred.get("end_column")

    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in normalized_rows:
        transcript_id = str(row.get(transcript_id_column) or path.stem).strip() if transcript_id_column else path.stem
        grouped.setdefault(transcript_id or path.stem, []).append(row)

    transcripts: list[TranscriptObject] = []
    for transcript_id, group_rows in grouped.items():
        segments: list[TranscriptSegment] = []
        for index, row in enumerate(group_rows, start=1):
            text = str(row.get(text_column) or "").strip()
            if not text:
                continue
            segments.append(
                TranscriptSegment(
                    segment_id=str(row.get("segment_id") or row.get("id") or f"seg_{len(segments) + 1:06d}"),
                    speaker=normalize_speaker_id(row.get(speaker_column)) if speaker_column else "",
                    start=parse_time_value(row.get(start_column)) if start_column else None,
                    end=parse_time_value(row.get(end_column)) if end_column else None,
                    text=text,
                )
            )
        transcripts.append(
            TranscriptObject(
                transcript_id=sanitize_transcript_id(transcript_id),
                source_file=str(path),
                segments=segments,
                full_text=segments_to_text(segments),
                metadata={"source_format": path.suffix.lower().lstrip("."), "file_name": transcript_id or path.name},
            )
        )
    return transcripts


def editor_transcript_to_prompt_object(transcript: dict[str, Any], path: Path) -> TranscriptObject:
    metadata = transcript.get("metadata") if isinstance(transcript.get("metadata"), dict) else {}
    file_name = str(metadata.get("file_name") or Path(str(transcript.get("source_transcript_file") or path)).name)
    segments: list[TranscriptSegment] = []
    speaker_names = {
        str(speaker.get("id") or ""): str(speaker.get("name") or speaker.get("id") or "")
        for speaker in transcript.get("speakers", [])
        if isinstance(speaker, dict)
    }
    for index, raw_segment in enumerate(transcript.get("segments") or [], start=1):
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        speaker_id = normalize_speaker_id(raw_segment.get("speaker"))
        segments.append(
            TranscriptSegment(
                segment_id=str(raw_segment.get("id") or f"seg_{index:06d}"),
                speaker=speaker_names.get(speaker_id, speaker_id),
                start=parse_time_value(raw_segment.get("start")),
                end=parse_time_value(raw_segment.get("end")),
                text=text,
            )
        )
    return TranscriptObject(
        transcript_id=sanitize_transcript_id(Path(file_name).stem or path.stem),
        source_file=str(path),
        segments=segments,
        full_text=segments_to_text(segments),
        metadata={**metadata, "file_name": file_name, "paragraph_count": len(read_docx_paragraphs(path)) if path.suffix.lower() == ".docx" else None},
    )


def segments_to_text(segments: list[TranscriptSegment]) -> str:
    parts: list[str] = []
    for segment in segments:
        prefix = f"{segment.speaker}: " if segment.speaker else ""
        parts.append(f"{prefix}{segment.text}".strip())
    return "\n".join(parts).strip()


def parse_time_value(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        pass
    parts = raw.split(":")
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    return None


def sanitize_transcript_id(value: str) -> str:
    cleaned = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in value)
    cleaned = cleaned.strip("_")
    return cleaned or "transcript"
