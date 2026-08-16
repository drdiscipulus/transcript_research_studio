from __future__ import annotations

from typing import Any

from .transcription_types import AdvancedTranscriptionOptions, SegmentLine, WordLine
from .value_utils import (
    float_or_none,
    format_timestamp_mmss_or_hhmmss as format_timestamp,
)


def segments_from_serialized_result(raw_segments: Any) -> list[SegmentLine]:
    if not isinstance(raw_segments, list):
        return []
    segments: list[SegmentLine] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            continue
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        speaker = str(segment.get("speaker") or "").strip() or None
        words = words_from_serialized_segment(segment.get("words"))
        segments.append(
            SegmentLine(
                start_seconds=float_or_none(segment.get("start_seconds", segment.get("start"))),
                end_seconds=float_or_none(segment.get("end_seconds", segment.get("end"))),
                text=text,
                speaker=normalize_speaker_label(speaker),
                words=words,
            )
        )
    return segments


def words_from_serialized_segment(raw_words: Any) -> list[WordLine] | None:
    if not isinstance(raw_words, list):
        return None
    words: list[WordLine] = []
    for word in raw_words:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text") or word.get("word") or "").strip()
        if not text:
            continue
        speaker = str(word.get("speaker") or "").strip() or None
        words.append(
            WordLine(
                start_seconds=float_or_none(word.get("start_seconds", word.get("start"))),
                end_seconds=float_or_none(word.get("end_seconds", word.get("end"))),
                text=text,
                speaker=normalize_speaker_label(speaker),
            )
        )
    return words or None


def format_transcript(segments: list[SegmentLine], *, include_timestamps: bool) -> str:
    if not segments:
        return ""

    parts: list[str] = []
    for segment in segments:
        chunk_parts: list[str] = []
        if include_timestamps and segment.start_seconds is not None:
            chunk_parts.append(f"[{format_timestamp(segment.start_seconds)}]")
        if segment.speaker:
            chunk_parts.append(f"{segment.speaker}:")
        chunk_parts.append(segment.text)
        parts.append(" ".join(part for part in chunk_parts if part).strip())
    return " ".join(part for part in parts if part).strip()


def speaker_summary(segments: list[SegmentLine]) -> str | None:
    speakers: list[str] = []
    for segment in segments:
        if segment.speaker and segment.speaker not in speakers:
            speakers.append(segment.speaker)
    if not speakers:
        return None
    return ", ".join(speakers)


def normalize_speaker_label(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.replace("SPEAKER_", "Speaker ").replace("_", " ").strip()
    return normalized or None


def normalize_advanced_settings(value: dict[str, Any] | None) -> AdvancedTranscriptionOptions:
    payload = value if isinstance(value, dict) else {}
    return AdvancedTranscriptionOptions(
        diarization_enabled=bool(payload.get("diarization_enabled", False)),
        include_timestamps=bool(payload.get("include_timestamps", False)),
        beam_size=max(int(payload.get("beam_size", 5) or 5), 1),
        vad_filter=bool(payload.get("vad_filter", True)),
        temperature=max(float(payload.get("temperature", 0.0) or 0.0), 0.0),
        compute_type=str(payload.get("compute_type", "default") or "default"),
        speaker_mode=str(payload.get("speaker_mode", "auto") or "auto"),
        exact_speakers=int_or_none(payload.get("exact_speakers")),
        min_speakers=int_or_none(payload.get("min_speakers")),
        max_speakers=int_or_none(payload.get("max_speakers")),
    )


def int_or_none(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def normalize_optional_text(value: Any) -> str | None:
    normalized = str(value).strip() if value is not None else ""
    return normalized or None
