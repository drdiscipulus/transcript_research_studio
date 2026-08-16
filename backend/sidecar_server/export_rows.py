from __future__ import annotations

from typing import Any

from .paragraph_builder import build_paragraphs
from .value_utils import (
    float_or_default,
    float_or_none,
    format_timestamp_hhmmss as format_export_timestamp,
)


FILE_ROW_HEADERS = [
    "file_name",
    "duration",
    "file_info",
    "detected_language",
    "task",
    "speaker_summary",
    "transcript",
]

SEGMENT_ROW_HEADERS = [
    "file_name",
    "duration",
    "file_info",
    "detected_language",
    "task",
    "segment_index",
    "start_seconds",
    "end_seconds",
    "start_timestamp",
    "end_timestamp",
    "speaker",
    "text",
]

PARAGRAPH_ROW_HEADERS = [
    "file_name",
    "duration",
    "file_info",
    "detected_language",
    "task",
    "paragraph_index",
    "start_seconds",
    "end_seconds",
    "start_timestamp",
    "end_timestamp",
    "speaker",
    "source_segment_count",
    "text",
]


def build_table_export_rows(
    documents: list[dict[str, Any]],
    *,
    transcript_layout: str,
    paragraph_options: dict[str, Any] | None = None,
) -> tuple[list[str], list[dict[str, Any]]]:
    normalized_layout = normalize_transcript_layout(transcript_layout)
    if normalized_layout == "segment":
        return SEGMENT_ROW_HEADERS, build_segment_rows(documents)
    if normalized_layout == "paragraph":
        return PARAGRAPH_ROW_HEADERS, build_paragraph_rows(
            documents,
            paragraph_options=paragraph_options or default_paragraph_options(),
        )
    return FILE_ROW_HEADERS, build_file_rows(documents)


def build_file_rows(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for document in documents:
        rows.append(
            {
                "file_name": str(document.get("file_name") or ""),
                "duration": str(document.get("duration") or ""),
                "file_info": str(document.get("file_info") or ""),
                "detected_language": str(document.get("detected_language") or ""),
                "task": str(document.get("task") or ""),
                "speaker_summary": str(document.get("speaker_summary") or ""),
                "transcript": str(document.get("transcript") or ""),
            }
        )
    return rows


def build_paragraph_rows(
    documents: list[dict[str, Any]],
    *,
    paragraph_options: dict[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for document in documents:
        paragraphs = document_paragraphs(document, paragraph_options=paragraph_options)
        if not paragraphs:
            paragraphs = [
                {
                    "paragraph_index": 1,
                    "start_seconds": None,
                    "end_seconds": None,
                    "speaker": None,
                    "source_segment_count": 0,
                    "text": str(document.get("transcript") or ""),
                }
            ]

        for paragraph in paragraphs:
            start_seconds = float_or_none(paragraph.get("start_seconds"))
            end_seconds = float_or_none(paragraph.get("end_seconds"))
            rows.append(
                {
                    "file_name": str(document.get("file_name") or ""),
                    "duration": str(document.get("duration") or ""),
                    "file_info": str(document.get("file_info") or ""),
                    "detected_language": str(document.get("detected_language") or ""),
                    "task": str(document.get("task") or ""),
                    "paragraph_index": int(paragraph.get("paragraph_index") or len(rows) + 1),
                    "start_seconds": "" if start_seconds is None else start_seconds,
                    "end_seconds": "" if end_seconds is None else end_seconds,
                    "start_timestamp": format_export_timestamp(start_seconds),
                    "end_timestamp": format_export_timestamp(end_seconds),
                    "speaker": str(paragraph.get("speaker") or ""),
                    "source_segment_count": int(paragraph.get("source_segment_count") or 0),
                    "text": str(paragraph.get("text") or ""),
                }
            )
    return rows


def build_segment_rows(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for document in documents:
        segments = document_segments(document)
        if not segments:
            segments = [
                {
                    "start_seconds": None,
                    "end_seconds": None,
                    "speaker": None,
                    "text": str(document.get("transcript") or ""),
                }
            ]

        for segment_index, segment in enumerate(segments, start=1):
            start_seconds = float_or_none(segment.get("start_seconds"))
            end_seconds = float_or_none(segment.get("end_seconds"))
            rows.append(
                {
                    "file_name": str(document.get("file_name") or ""),
                    "duration": str(document.get("duration") or ""),
                    "file_info": str(document.get("file_info") or ""),
                    "detected_language": str(document.get("detected_language") or ""),
                    "task": str(document.get("task") or ""),
                    "segment_index": segment_index,
                    "start_seconds": "" if start_seconds is None else start_seconds,
                    "end_seconds": "" if end_seconds is None else end_seconds,
                    "start_timestamp": format_export_timestamp(start_seconds),
                    "end_timestamp": format_export_timestamp(end_seconds),
                    "speaker": str(segment.get("speaker") or ""),
                    "text": str(segment.get("text") or ""),
                }
            )
    return rows


def document_segments(document: dict[str, Any]) -> list[dict[str, Any]]:
    raw_segments = document.get("segments")
    if not isinstance(raw_segments, list):
        return []
    segments: list[dict[str, Any]] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start_seconds": float_or_none(raw_segment.get("start_seconds", raw_segment.get("start"))),
                "end_seconds": float_or_none(raw_segment.get("end_seconds", raw_segment.get("end"))),
                "timestamp_range": str(raw_segment.get("timestamp_range") or "").strip(),
                "speaker": str(raw_segment.get("speaker") or "").strip() or None,
                "text": text,
            }
        )
    return segments


def document_paragraphs(document: dict[str, Any], *, paragraph_options: dict[str, Any]) -> list[dict[str, Any]]:
    max_pause_seconds = (
        float_or_default(paragraph_options.get("max_pause_seconds"), 3.0)
        if bool(paragraph_options.get("paragraph_pause_enabled", True))
        else None
    )
    return build_paragraphs(
        document_segments(document),
        max_pause_seconds=max_pause_seconds,
    )


def format_docx_segment_line(segment: dict[str, Any], *, include_timestamps: bool) -> str:
    parts: list[str] = []
    start_seconds = float_or_none(segment.get("start_seconds"))
    speaker = str(segment.get("speaker") or "").strip()
    text = str(segment.get("text") or "").strip()
    timestamp = str(segment.get("timestamp_range") or "").strip() or format_export_timestamp(start_seconds)
    if include_timestamps and timestamp:
        parts.append(f"[{timestamp}]")
    if speaker:
        parts.append(f"{speaker}:")
    parts.append(text)
    return " ".join(part for part in parts if part).strip()


def normalize_transcript_layout(value: Any) -> str:
    normalized = str(value or "file").strip().lower()
    return normalized if normalized in {"file", "paragraph", "segment"} else "file"


def paragraph_options(prepared_batch: Any) -> dict[str, Any]:
    raw_options = prepared_batch.settings.get("paragraph_options")
    if not isinstance(raw_options, dict):
        return default_paragraph_options()
    return raw_options


def default_paragraph_options() -> dict[str, Any]:
    return {
        "paragraph_pause_enabled": True,
        "max_pause_seconds": 3.0,
    }
