from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .prompting_chunking import chunk_transcript_text, pack_items_by_character_budget
from .prompting_context import (
    MIN_CHUNK_CHARACTERS,
    TaskContext,
    adaptive_chunk_character_budget,
    is_context_window_error,
    shrink_context_for_retry,
)
from .prompting_diagnostics import DIAGNOSTIC_COMPONENTS, run_diagnostics_task as _run_diagnostics_task
from .prompting_result_rows import base_result_row
from .prompting_task_config import prompt_text_for, selected_components
from .prompting_text import verify_quote
from .prompting_transcripts import TranscriptObject


SUMMARY_COMPONENTS = (
    "short_summary",
    "main_topics",
    "keywords",
    "actors_organizations_places",
    "chronological_outline",
    "notable_passages",
)


def execute_preprocessing_tasks(
    *,
    transcripts: list[TranscriptObject],
    tasks: dict[str, Any],
    context: TaskContext,
    progress_callback: Callable[[str, str, int], None] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Run selected preprocessing tasks sequentially and collect result tables by role."""
    results: dict[str, list[dict[str, Any]]] = {
        "summary": [],
        "quotes": [],
        "diagnostics": [],
        "custom_prompt": [],
    }
    total_rows = 0
    for transcript in transcripts:
        if summary_task_enabled(tasks):
            notify(progress_callback, transcript.transcript_id, "Summary & Orientation", total_rows)
            rows = run_task_with_context_retry(
                "Summary & Orientation",
                run_summary_task,
                transcript,
                tasks.get("summary") or {},
                context,
            )
            results["summary"].extend(rows)
            total_rows += len(rows)
        if quote_task_enabled(tasks):
            notify(progress_callback, transcript.transcript_id, "Quote Finder", total_rows)
            rows = run_task_with_context_retry(
                "Quote Finder",
                run_quote_task,
                transcript,
                tasks.get("quotes") or {},
                context,
            )
            results["quotes"].extend(rows)
            total_rows += len(rows)
        if diagnostics_task_enabled(tasks):
            notify(progress_callback, transcript.transcript_id, "Transcript Diagnostics", total_rows)
            rows = run_task_with_context_retry(
                "Transcript Diagnostics",
                run_diagnostics_task,
                transcript,
                tasks.get("diagnostics") or {},
                context,
            )
            results["diagnostics"].extend(rows)
            total_rows += len(rows)
        if custom_task_enabled(tasks):
            notify(progress_callback, transcript.transcript_id, "Custom Prompt", total_rows)
            rows = run_task_with_context_retry(
                "Custom Prompt",
                run_custom_prompt_task,
                transcript,
                tasks.get("custom_prompt") or {},
                context,
            )
            results["custom_prompt"].extend(rows)
            total_rows += len(rows)
    return results


def run_task_with_context_retry(
    task_label: str,
    task_runner: Callable[[TranscriptObject, dict[str, Any], TaskContext], list[dict[str, Any]]],
    transcript: TranscriptObject,
    config: dict[str, Any],
    context: TaskContext,
) -> list[dict[str, Any]]:
    try:
        return task_runner(transcript, config, context)
    except Exception as error:  # noqa: BLE001
        if not is_context_window_error(error) or context.chunk_max_characters <= MIN_CHUNK_CHARACTERS:
            raise
        retry_context = shrink_context_for_retry(context)
        try:
            return task_runner(transcript, config, retry_context)
        except Exception as retry_error:  # noqa: BLE001
            if is_context_window_error(retry_error):
                raise RuntimeError(
                    f"{task_label} exceeded the local model context window. "
                    "The app retried with smaller transcript chunks, but the provider still rejected the prompt. "
                    "Try a larger provider context window, a smaller task combination, or a shorter transcript."
                ) from retry_error
            raise


def notify(callback: Callable[[str, str, int], None] | None, transcript_id: str, task_label: str, rows_generated: int) -> None:
    if callback:
        callback(transcript_id, task_label, rows_generated)


def selected_task_names(tasks: dict[str, Any]) -> list[str]:
    """Return task result roles in the same order used by output package writers."""
    names = []
    if summary_task_enabled(tasks):
        names.append("summary")
    if quote_task_enabled(tasks):
        names.append("quotes")
    if diagnostics_task_enabled(tasks):
        names.append("diagnostics")
    if custom_task_enabled(tasks):
        names.append("custom_prompt")
    return names


def summary_task_enabled(tasks: dict[str, Any]) -> bool:
    config = tasks.get("summary") or {}
    return bool(config.get("enabled")) and bool(selected_components(config.get("components"), SUMMARY_COMPONENTS))


def quote_task_enabled(tasks: dict[str, Any]) -> bool:
    config = tasks.get("quotes") or {}
    components = config.get("components") if isinstance(config.get("components"), dict) else {}
    return (
        bool(config.get("enabled"))
        and bool(str(config.get("topic") or "").strip())
        and bool(components.get("quote_candidates"))
    )


def diagnostics_task_enabled(tasks: dict[str, Any]) -> bool:
    config = tasks.get("diagnostics") or {}
    return bool(config.get("enabled")) and bool(selected_components(config.get("components"), DIAGNOSTIC_COMPONENTS))


def custom_task_enabled(tasks: dict[str, Any]) -> bool:
    config = tasks.get("custom_prompt") or {}
    prompts = config.get("prompts")
    if isinstance(prompts, list):
        return any(
            bool(prompt.get("enabled", True)) and bool(str(prompt.get("prompt_text") or "").strip())
            for prompt in prompts
            if isinstance(prompt, dict)
        )
    return bool(config.get("enabled")) and bool(str(config.get("prompt_text") or "").strip())


def run_summary_task(transcript: TranscriptObject, config: dict[str, Any], context: TaskContext) -> list[dict[str, Any]]:
    """Run selected summary components and collapse chunk notes to one transcript-level row."""
    components = selected_components(config.get("components"), SUMMARY_COMPONENTS)
    if not components:
        return []
    component_instructions = {
        component: prompt_text_for(config, "summary", component)
        for component in components
    }
    chunk_summaries = []
    for chunk_index, chunk_text in enumerate(chunk_transcript_text(transcript, context=context), start=1):
        prompt = (
            "Summarize this transcript chunk for qualitative transcript preprocessing. "
            f"Return strict JSON with keys: {', '.join(components)}. "
            "Use concise, research-oriented wording. Do not invent facts.\n\n"
            f"Component instructions:\n{json.dumps(component_instructions, ensure_ascii=False)}\n\n"
            f"Chunk {chunk_index}:\n{chunk_text}"
        )
        chunk_summaries.append(
            run_json_prompt(
                context,
                system_prompt="You are a careful local transcript preprocessing assistant. Return strict JSON only.",
                user_prompt=prompt,
            )
        )

    result = synthesize_summary_chunks(context, components, component_instructions, chunk_summaries)
    if not isinstance(result, dict):
        result = {"short_summary": stringify_result_value(result)}

    row = base_result_row(transcript, context)
    for component in components:
        row[component] = stringify_result_value(result.get(component, ""))
    return [row]


def run_quote_task(transcript: TranscriptObject, config: dict[str, Any], context: TaskContext) -> list[dict[str, Any]]:
    """Find quote candidates for one transcript and mark each quote with source-text verification status."""
    topic = str(config.get("topic") or "").strip()
    quote_options = config.get("components") if isinstance(config.get("components"), dict) else {}
    if not topic or not bool(quote_options.get("quote_candidates")):
        return []
    quote_count = max(1, min(int(config.get("quote_count") or 5), 25))
    quote_length = str(config.get("quote_length") or "medium").strip().lower()
    include_context = bool(quote_options.get("include_speaker_timestamp", config.get("include_speaker_timestamp", True)))
    verify_quote_text = bool(quote_options.get("verify_quote_text", config.get("verify_quote_text", True)))
    option_instructions = [
        prompt_text_for(config, "quotes", "quote_candidates"),
    ]
    if include_context:
        option_instructions.append(prompt_text_for(config, "quotes", "include_speaker_timestamp"))
    if verify_quote_text:
        option_instructions.append(prompt_text_for(config, "quotes", "verify_quote_text"))
    option_instruction_text = "\n- ".join(option_instructions)
    candidates: list[dict[str, Any]] = []
    for chunk_index, chunk_text in enumerate(chunk_transcript_text(transcript, context=context), start=1):
        prompt = (
            "Find exact quote candidates in this transcript chunk for the requested topic. "
            "Return strict JSON as an array of objects with keys quote, speaker, timestamp, reason. "
            "Quote text must be copied from the transcript, not paraphrased. "
            f"Topic: {topic}\n"
            f"Desired quote length: {quote_length}\n"
            f"Include speaker/timestamp if present: {include_context}\n\n"
            f"Option instructions:\n- {option_instruction_text}\n\n"
            f"Chunk {chunk_index}:\n{chunk_text}"
        )
        parsed = run_json_prompt(
            context,
            system_prompt="You find quote candidates. Return strict JSON only.",
            user_prompt=prompt,
        )
        if isinstance(parsed, list):
            candidates.extend(candidate for candidate in parsed if isinstance(candidate, dict))
        elif isinstance(parsed.get("quotes"), list):
            candidates.extend(candidate for candidate in parsed["quotes"] if isinstance(candidate, dict))

    rows: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates[: quote_count * 3], start=1):
        quote = str(candidate.get("quote") or "").strip()
        if not quote:
            continue
        verification_status = verify_quote(quote, transcript.full_text) if verify_quote_text else "not_checked"
        rows.append(
            {
                **base_result_row(transcript, context),
                "topic": topic,
                "quote_id": f"quote_{len(rows) + 1:03d}",
                "quote": quote,
                "speaker": str(candidate.get("speaker") or "").strip(),
                "timestamp": str(candidate.get("timestamp") or "").strip(),
                "reason": str(candidate.get("reason") or "").strip(),
                "verification_status": verification_status,
            }
        )
        if len(rows) >= quote_count:
            break
    return rows


def run_diagnostics_task(transcript: TranscriptObject, config: dict[str, Any], context: TaskContext) -> list[dict[str, Any]]:
    components = selected_components(config.get("components"), DIAGNOSTIC_COMPONENTS)
    return _run_diagnostics_task(
        transcript,
        config,
        components,
        context,
        json_prompt_runner=run_json_prompt,
    )


def run_custom_prompt_task(transcript: TranscriptObject, config: dict[str, Any], context: TaskContext) -> list[dict[str, Any]]:
    """Run all enabled custom transcript-level prompts for one normalized transcript."""
    prompt_configs = normalized_custom_prompt_configs(config)
    rows: list[dict[str, Any]] = []
    for prompt_config in prompt_configs:
        rows.append(run_one_custom_prompt(transcript, prompt_config, context))
    return rows


def run_one_custom_prompt(
    transcript: TranscriptObject,
    prompt_config: dict[str, Any],
    context: TaskContext,
) -> dict[str, Any]:
    """Apply one custom prompt with chunk-and-synthesize handling for long transcripts."""
    prompt_text = str(prompt_config.get("prompt_text") or "").strip()
    result_label = str(prompt_config.get("result_label") or prompt_config.get("label") or "custom_prompt_result").strip() or "custom_prompt_result"
    prompt_label = str(prompt_config.get("label") or result_label).strip() or result_label
    chunk_outputs = []
    for chunk_index, chunk_text in enumerate(chunk_transcript_text(transcript, context=context), start=1):
        prompt = (
            f"{prompt_text}\n\n"
            "Apply the instructions to this transcript chunk. Return only the requested result for this chunk.\n\n"
            f"Chunk {chunk_index}:\n{chunk_text}"
        )
        chunk_outputs.append(
            context.prompt_runner(
                provider_id=context.provider_id,
                model_id=context.model_id,
                system_prompt="You process transcript text for local preprocessing.",
                user_prompt=prompt,
                temperature=context.temperature,
                timeout_seconds=context.timeout_seconds,
                context_window_tokens=context.context_window_tokens,
                should_request_provider_context=context.should_request_provider_context,
            ).strip()
        )
    if len(chunk_outputs) == 1:
        result = chunk_outputs[0]
    else:
        result = synthesize_custom_prompt_chunks(context, prompt_text, chunk_outputs)
    return {
        **base_result_row(transcript, context),
        "custom_prompt_label": prompt_label,
        "custom_prompt": prompt_text,
        "result_label": result_label,
        "custom_result": result,
    }


def normalized_custom_prompt_configs(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize current multi-prompt payloads while preserving the earlier single-prompt shape."""
    prompts = config.get("prompts")
    if isinstance(prompts, list):
        return [
            prompt
            for prompt in prompts
            if isinstance(prompt, dict)
            and bool(prompt.get("enabled", True))
            and str(prompt.get("prompt_text") or "").strip()
        ]
    if bool(config.get("enabled")) and str(config.get("prompt_text") or "").strip():
        return [
            {
                "id": "custom_001",
                "label": str(config.get("result_label") or "Custom Prompt"),
                "result_label": str(config.get("result_label") or "custom_prompt_result"),
                "prompt_text": str(config.get("prompt_text") or ""),
                "enabled": True,
            }
        ]
    return []


def append_additional_instructions(prompt: str, config: dict[str, Any]) -> str:
    additional = str(config.get("additional_instructions") or "").strip()
    if not additional:
        return prompt
    return f"{prompt}\n\nAdditional user instructions:\n{additional}"


def run_json_prompt(context: TaskContext, *, system_prompt: str, user_prompt: str) -> Any:
    raw = context.prompt_runner(
        provider_id=context.provider_id,
        model_id=context.model_id,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        temperature=context.temperature,
        timeout_seconds=context.timeout_seconds,
        context_window_tokens=context.context_window_tokens,
        should_request_provider_context=context.should_request_provider_context,
    )
    return parse_json_response(raw)


def parse_json_response(value: str) -> Any:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start_candidates = [index for index in [text.find("{"), text.find("[")] if index >= 0]
        if not start_candidates:
            return {"text": value.strip()}
        start = min(start_candidates)
        end = max(text.rfind("}"), text.rfind("]"))
        if end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    return {"text": value.strip()}


def synthesize_summary_chunks(
    context: TaskContext,
    components: list[str],
    component_instructions: dict[str, str],
    chunk_summaries: list[Any],
) -> Any:
    if len(chunk_summaries) == 1:
        return chunk_summaries[0]
    notes = synthesize_json_batches(
        context,
        chunk_summaries,
        build_prompt=lambda batch: (
            "Synthesize these chunk-level notes into one transcript-level orientation. "
            f"Return strict JSON with keys: {', '.join(components)}.\n\n"
            f"Component instructions:\n{json.dumps(component_instructions, ensure_ascii=False)}\n\n"
            f"Chunk notes:\n{json.dumps(batch, ensure_ascii=False)}"
        ),
        system_prompt="You synthesize transcript preprocessing notes. Return strict JSON only.",
    )
    return notes[0] if len(notes) == 1 else synthesize_summary_chunks(context, components, component_instructions, notes)


def synthesize_custom_prompt_chunks(context: TaskContext, prompt_text: str, chunk_outputs: list[str]) -> str:
    notes = synthesize_text_batches(
        context,
        chunk_outputs,
        build_prompt=lambda batch: (
            f"{prompt_text}\n\n"
            "Synthesize the following chunk-level outputs into one transcript-level answer. "
            "Return only the final answer.\n\n"
            + "\n\n".join(f"Chunk {index + 1} output:\n{value}" for index, value in enumerate(batch))
        ),
        system_prompt="You synthesize chunk-level transcript preprocessing outputs.",
    )
    if len(notes) == 1:
        return notes[0]
    return synthesize_custom_prompt_chunks(context, prompt_text, notes)


def synthesize_json_batches(
    context: TaskContext,
    items: list[Any],
    *,
    build_prompt: Callable[[list[Any]], str],
    system_prompt: str,
) -> list[Any]:
    return [
        run_json_prompt(context, system_prompt=system_prompt, user_prompt=build_prompt(batch))
        for batch in pack_items_by_character_budget(items, context.chunk_max_characters)
    ]


def synthesize_text_batches(
    context: TaskContext,
    items: list[str],
    *,
    build_prompt: Callable[[list[str]], str],
    system_prompt: str,
) -> list[str]:
    return [
        context.prompt_runner(
            provider_id=context.provider_id,
            model_id=context.model_id,
            system_prompt=system_prompt,
            user_prompt=build_prompt(batch),
            temperature=context.temperature,
            timeout_seconds=context.timeout_seconds,
            context_window_tokens=context.context_window_tokens,
            should_request_provider_context=context.should_request_provider_context,
        ).strip()
        for batch in pack_items_by_character_budget(items, context.chunk_max_characters)
    ]


def stringify_result_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "; ".join(stringify_result_value(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)
