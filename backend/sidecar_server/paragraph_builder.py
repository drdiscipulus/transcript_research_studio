from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .value_utils import float_or_none


DEFAULT_MAX_PAUSE_SECONDS = 3.0


@dataclass(slots=True)
class _NormalizedSegment:
    start_seconds: float | None
    end_seconds: float | None
    speaker: str | None
    text: str


def build_paragraphs(
    segments: list[dict[str, Any]],
    *,
    max_pause_seconds: float | None = DEFAULT_MAX_PAUSE_SECONDS,
) -> list[dict[str, Any]]:
    normalized_segments = [_normalize_segment(segment) for segment in segments]
    normalized_segments = [segment for segment in normalized_segments if segment is not None]
    if not normalized_segments:
        return []

    paragraphs: list[dict[str, Any]] = []
    current = _start_paragraph(normalized_segments[0])

    for segment in normalized_segments[1:]:
        joined_text = _join_text(str(current.get("text") or ""), segment.text)
        if _can_merge(
            current=current,
            next_segment=segment,
            max_pause_seconds=max_pause_seconds,
        ):
            current["text"] = joined_text
            current["end_seconds"] = _latest_available_time(current.get("end_seconds"), segment.end_seconds)
            current["source_segment_count"] = int(current.get("source_segment_count") or 0) + 1
            continue

        paragraphs.append(current)
        current = _start_paragraph(segment)

    paragraphs.append(current)
    for index, paragraph in enumerate(paragraphs, start=1):
        paragraph["paragraph_index"] = index
    return paragraphs


def _normalize_segment(segment: dict[str, Any]) -> _NormalizedSegment | None:
    if not isinstance(segment, dict):
        return None
    text = str(segment.get("text") or "").strip()
    if not text:
        return None
    speaker = str(segment.get("speaker") or "").strip() or None
    return _NormalizedSegment(
        start_seconds=float_or_none(segment.get("start_seconds", segment.get("start"))),
        end_seconds=float_or_none(segment.get("end_seconds", segment.get("end"))),
        speaker=speaker,
        text=text,
    )


def _start_paragraph(segment: _NormalizedSegment) -> dict[str, Any]:
    return {
        "paragraph_index": 0,
        "start_seconds": segment.start_seconds,
        "end_seconds": segment.end_seconds,
        "speaker": segment.speaker,
        "text": segment.text,
        "source_segment_count": 1,
    }


def _can_merge(
    *,
    current: dict[str, Any],
    next_segment: _NormalizedSegment,
    max_pause_seconds: float | None,
) -> bool:
    if current.get("speaker") != next_segment.speaker:
        return False
    if max_pause_seconds is None:
        return True

    current_end = float_or_none(current.get("end_seconds"))
    if current_end is None or next_segment.start_seconds is None:
        return False

    pause_seconds = next_segment.start_seconds - current_end
    return pause_seconds <= max_pause_seconds


def _join_text(left: str, right: str) -> str:
    return " ".join(part.strip() for part in (left, right) if part and part.strip()).strip()


def _latest_available_time(left: Any, right: Any) -> float | None:
    parsed_right = float_or_none(right)
    if parsed_right is not None:
        return parsed_right
    return float_or_none(left)
