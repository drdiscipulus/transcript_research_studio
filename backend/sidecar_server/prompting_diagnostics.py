from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .prompting_chunking import chunk_transcript_text, segment_by_id, timestamp_label
from .prompting_context import TaskContext
from .prompting_result_rows import base_result_row
from .prompting_task_config import prompt_text_for
from .prompting_text import normalize_match_text
from .prompting_transcripts import TranscriptObject, TranscriptSegment


DIAGNOSTIC_COMPONENTS = (
    "missing_speaker_labels",
    "unknown_speaker_labels",
    "missing_timestamps",
    "empty_text_segments",
    "very_long_segments",
    "very_short_fragments",
    "repeated_text",
    "broken_or_unclear_passages",
    "possible_speaker_inconsistency",
)
LLM_DIAGNOSTIC_COMPONENTS = {"broken_or_unclear_passages", "possible_speaker_inconsistency"}
MAX_LLM_DIAGNOSTIC_ROWS = 50


def run_diagnostics_task(
    transcript: TranscriptObject,
    config: dict[str, Any],
    components: list[str],
    context: TaskContext,
    *,
    json_prompt_runner: Callable[..., Any],
) -> list[dict[str, Any]]:
    """Combine deterministic transcript checks with optional LLM-assisted review suggestions."""
    if not components:
        return []
    rows = deterministic_diagnostics(transcript, components, context, config)
    if LLM_DIAGNOSTIC_COMPONENTS.intersection(components):
        rows.extend(llm_diagnostics(transcript, config, components, context, json_prompt_runner=json_prompt_runner))
    return rows


def deterministic_diagnostics(
    transcript: TranscriptObject,
    components: list[str],
    context: TaskContext,
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    """Run cheap structural checks without calling the local LLM."""
    rows: list[dict[str, Any]] = []
    seen_text: dict[str, str] = {}
    for segment in transcript.segments:
        text = segment.text.strip()
        normalized = normalize_match_text(text)
        if "missing_speaker_labels" in components and not segment.speaker:
            rows.append(diagnostic_row(transcript, context, "missing_speaker_labels", segment, prompt_text_for(config, "diagnostics", "missing_speaker_labels"), "medium", "rule"))
        if "unknown_speaker_labels" in components and is_unknown_speaker_label(segment.speaker):
            rows.append(diagnostic_row(transcript, context, "unknown_speaker_labels", segment, prompt_text_for(config, "diagnostics", "unknown_speaker_labels"), "medium", "rule"))
        if "missing_timestamps" in components and (segment.start is None or segment.end is None):
            rows.append(diagnostic_row(transcript, context, "missing_timestamps", segment, prompt_text_for(config, "diagnostics", "missing_timestamps"), "medium", "rule"))
        if "empty_text_segments" in components and not text:
            rows.append(diagnostic_row(transcript, context, "empty_text_segments", segment, prompt_text_for(config, "diagnostics", "empty_text_segments"), "high", "rule"))
        if "very_long_segments" in components and len(text) > 1_500:
            rows.append(diagnostic_row(transcript, context, "very_long_segments", segment, prompt_text_for(config, "diagnostics", "very_long_segments"), "low", "rule"))
        if "very_short_fragments" in components and 0 < len(text) < 8:
            rows.append(diagnostic_row(transcript, context, "very_short_fragments", segment, prompt_text_for(config, "diagnostics", "very_short_fragments"), "low", "rule"))
        if "repeated_text" in components and normalized:
            previous_id = seen_text.get(normalized)
            if previous_id:
                recommendation = f"{prompt_text_for(config, 'diagnostics', 'repeated_text')} Possible repeated text also appears in {previous_id}."
                rows.append(diagnostic_row(transcript, context, "repeated_text", segment, recommendation, "medium", "rule"))
            else:
                seen_text[normalized] = segment.segment_id
    return rows


def llm_diagnostics(
    transcript: TranscriptObject,
    config: dict[str, Any],
    components: list[str],
    context: TaskContext,
    *,
    json_prompt_runner: Callable[..., Any],
) -> list[dict[str, Any]]:
    """Ask the local LLM for text-interpretive diagnostics across every adaptive chunk."""
    enabled_llm_components = [component for component in components if component in LLM_DIAGNOSTIC_COMPONENTS]
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for chunk_index, chunk_text in enumerate(chunk_transcript_text(transcript, context=context), start=1):
        prompt = (
            "Review this transcript chunk for preprocessing issues only. "
            "Return strict JSON as an array of objects with keys issue_type, segment_id, excerpt, recommendation, severity. "
            "Do not judge audio quality or transcription accuracy. Phrase findings as suggestions for manual review. "
            f"Enabled issue types: {', '.join(enabled_llm_components)}\n\n"
            "Issue instructions:\n"
            f"- broken_or_unclear_passages: {prompt_text_for(config, 'diagnostics', 'broken_or_unclear_passages')}\n"
            f"- possible_speaker_inconsistency: {prompt_text_for(config, 'diagnostics', 'possible_speaker_inconsistency')}\n\n"
            f"Chunk {chunk_index}:\n{chunk_text}"
        )
        parsed = json_prompt_runner(
            context,
            system_prompt="You identify transcript text review suggestions. Return strict JSON only.",
            user_prompt=prompt,
        )
        items = parsed if isinstance(parsed, list) else parsed.get("issues", [])
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            issue_type = str(item.get("issue_type") or "text_review")
            segment_id = str(item.get("segment_id") or "")
            excerpt = str(item.get("excerpt") or "")[:500]
            key = (issue_type, segment_id, normalize_match_text(excerpt))
            if key in seen:
                continue
            seen.add(key)
            segment = segment_by_id(transcript, segment_id)
            rows.append(
                {
                    **base_result_row(transcript, context),
                    "issue_type": issue_type,
                    "segment_id": segment_id,
                    "timestamp": timestamp_label(segment),
                    "excerpt": excerpt,
                    "recommendation": str(item.get("recommendation") or "Review this passage manually."),
                    "severity": str(item.get("severity") or "low"),
                    "detection_method": "llm",
                }
            )
            if len(rows) >= MAX_LLM_DIAGNOSTIC_ROWS:
                return rows
    return rows


def diagnostic_row(
    transcript: TranscriptObject,
    context: TaskContext,
    issue_type: str,
    segment: TranscriptSegment,
    recommendation: str,
    severity: str,
    detection_method: str,
) -> dict[str, Any]:
    return {
        **base_result_row(transcript, context),
        "issue_type": issue_type,
        "segment_id": segment.segment_id,
        "timestamp": timestamp_label(segment),
        "excerpt": segment.text[:500],
        "recommendation": recommendation,
        "severity": severity,
        "detection_method": detection_method,
    }


def is_unknown_speaker_label(value: str) -> bool:
    normalized = normalize_match_text(str(value or ""))
    if not normalized:
        return False
    unknown_values = {
        "unknown",
        "unk",
        "no speaker",
        "no speaker assigned",
        "speaker",
        "speaker unknown",
    }
    return normalized in unknown_values or normalized.startswith("unknown speaker")
