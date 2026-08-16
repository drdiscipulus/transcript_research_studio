from __future__ import annotations

import json
from typing import Any

from .prompting_context import DEFAULT_CONTEXT_WINDOW_TOKENS, TaskContext, adaptive_chunk_character_budget
from .prompting_transcripts import TranscriptObject, TranscriptSegment


CHUNK_OVERLAP_SEGMENTS = 1


def chunk_transcript_text(
    transcript: TranscriptObject,
    max_characters: int | None = None,
    *,
    context: TaskContext | None = None,
) -> list[str]:
    """Split long transcripts into segment-aligned chunks for local model context limits."""
    if max_characters is None:
        max_characters = context.chunk_max_characters if context else adaptive_chunk_character_budget(DEFAULT_CONTEXT_WINDOW_TOKENS)
    if len(transcript.full_text) <= max_characters:
        return [transcript.full_text]
    chunks: list[str] = []
    current_segments: list[TranscriptSegment] = []
    current_length = 0
    for segment in transcript.segments:
        segment_text = segment_line(segment)
        if len(segment_text) > max_characters:
            if current_segments:
                chunks.append("\n".join(segment_line(item) for item in current_segments))
                current_segments = []
                current_length = 0
            chunks.extend(split_oversized_segment_line(segment, max_characters))
            continue
        if current_segments and current_length + len(segment_text) > max_characters:
            chunks.append("\n".join(segment_line(item) for item in current_segments))
            current_segments = current_segments[-CHUNK_OVERLAP_SEGMENTS:] if CHUNK_OVERLAP_SEGMENTS else []
            current_length = sum(len(segment_line(item)) for item in current_segments)
        current_segments.append(segment)
        current_length += len(segment_text)
    if current_segments:
        chunks.append("\n".join(segment_line(item) for item in current_segments))
    return chunks or [transcript.full_text]


def split_oversized_segment_line(segment: TranscriptSegment, max_characters: int) -> list[str]:
    prefix = segment_line(TranscriptSegment(segment_id=segment.segment_id, speaker=segment.speaker, start=segment.start, end=segment.end, text=""))
    prefix = prefix[:-2] if prefix.endswith(": ") else prefix
    available = max(500, max_characters - len(prefix) - 2)
    pieces = split_text_by_character_budget(segment.text, available)
    return [f"{prefix}: {piece}" if prefix else piece for piece in pieces]


def split_text_by_character_budget(text: str, max_characters: int) -> list[str]:
    words = text.split()
    if not words:
        return [text[:max_characters]]
    chunks: list[str] = []
    current: list[str] = []
    current_length = 0
    for word in words:
        word_length = len(word) + (1 if current else 0)
        if current and current_length + word_length > max_characters:
            chunks.append(" ".join(current))
            current = []
            current_length = 0
        current.append(word)
        current_length += len(word) + (1 if current_length else 0)
    if current:
        chunks.append(" ".join(current))
    return chunks


def pack_items_by_character_budget(items: list[Any], max_characters: int) -> list[list[Any]]:
    batches: list[list[Any]] = []
    current: list[Any] = []
    current_length = 0
    for item in items:
        item_length = len(json.dumps(item, ensure_ascii=False)) if not isinstance(item, str) else len(item)
        if current and current_length + item_length > max_characters:
            batches.append(current)
            current = []
            current_length = 0
        current.append(item)
        current_length += item_length
    if current:
        batches.append(current)
    return batches or [[]]


def segment_line(segment: TranscriptSegment) -> str:
    timestamp = timestamp_label(segment)
    prefix_parts = [part for part in [segment.segment_id, timestamp, segment.speaker] if part]
    prefix = " | ".join(prefix_parts)
    return f"{prefix}: {segment.text}" if prefix else segment.text


def timestamp_label(segment: TranscriptSegment | None) -> str:
    if not segment:
        return ""
    if segment.start is None and segment.end is None:
        return ""
    if segment.start is not None and segment.end is not None:
        return f"{format_seconds(segment.start)} - {format_seconds(segment.end)}"
    return format_seconds(segment.start if segment.start is not None else segment.end)


def format_seconds(value: float | None) -> str:
    if value is None:
        return ""
    total = max(0, int(round(value)))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def transcript_preview_with_segments(transcript: TranscriptObject, *, max_characters: int) -> str:
    lines = []
    total = 0
    for segment in transcript.segments:
        line = segment_line(segment)
        if total + len(line) > max_characters:
            break
        lines.append(line)
        total += len(line)
    return "\n".join(lines)


def segment_by_id(transcript: TranscriptObject, segment_id: str) -> TranscriptSegment | None:
    for segment in transcript.segments:
        if segment.segment_id == segment_id:
            return segment
    return None
