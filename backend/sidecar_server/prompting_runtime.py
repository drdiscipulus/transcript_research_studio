from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .app_paths import ensure_app_runtime_directories
from .prompting_types import PromptRunSnapshot


def ensure_prompting_runtime_paths() -> dict[str, Path]:
    runtime_paths = ensure_app_runtime_directories()
    return {
        "root": runtime_paths["root"],
        "logs": runtime_paths["logs"],
    }


def write_prompt_log(
    *,
    log_file: Path,
    snapshot: PromptRunSnapshot,
    plan: dict[str, Any],
) -> None:
    log_lines = [
        "",
        f"[{_timestamp()}] FINAL SUMMARY",
        f"Provider: {snapshot.provider_name}",
        f"Model: {snapshot.model_id}",
        f"Temperature: {plan.get('temperature')}",
        f"Timeout seconds: {plan.get('timeout_seconds')}",
        f"Context window tokens: {(plan.get('provider_context') or {}).get('tokens', '')}",
        f"Context source: {(plan.get('provider_context') or {}).get('source', '')}",
        f"Chunk max characters: {plan.get('chunk_max_characters', '')}",
        f"Status: {snapshot.status}",
        f"Message: {snapshot.message}",
        f"Input mode: {snapshot.input_mode}",
        f"Input path: {snapshot.input_path or ''}",
        f"Output files: {', '.join(item.get('path', '') for item in (snapshot.output_files or []))}",
        f"Transcripts completed: {snapshot.transcripts_completed}/{snapshot.total_transcripts}",
        f"Rows generated: {snapshot.rows_generated}",
        f"Selected tasks: {', '.join(plan.get('selected_tasks', []))}",
        f"Failures: {(snapshot.counts or {}).get('failed', 0)}",
        f"Excluded: {(snapshot.counts or {}).get('excluded', 0)}",
        f"Started at: {snapshot.started_at}",
        f"Finished at: {snapshot.finished_at}",
    ]
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(log_lines) + "\n")


def initialize_prompt_log(*, log_file: Path, snapshot: PromptRunSnapshot, plan: dict[str, Any]) -> None:
    """Create a prompt-free, transcript-text-free log before provider work begins."""
    log_file.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"[{_timestamp()}] RUN STARTED",
        f"Run ID: {_safe(snapshot.run_id)}",
        f"Provider: {_safe(snapshot.provider_name)}",
        f"Model: {_safe(snapshot.model_id)}",
        f"Input mode: {_safe(snapshot.input_mode)}",
        f"Input path: {_safe(snapshot.input_path)}",
        f"Analysis: {_safe((plan.get('analysis_selection') or {}).get('name') or ', '.join(plan.get('selected_tasks', [])))}",
        f"Transcript candidates: {len(plan.get('transcripts', []))}",
        f"Excluded candidates: {len(plan.get('exclusions', []))}",
    ]
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_prompt_log_event(log_file: Path, event: str, **details: Any) -> None:
    """Append structural run events only; callers must not pass transcript or prompt bodies."""
    fields = " · ".join(f"{key}={_safe(value)}" for key, value in details.items() if value not in {None, ""})
    suffix = f" · {fields}" if fields else ""
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(f"[{_timestamp()}] {_safe(event)}{suffix}\n")


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe(value: Any) -> str:
    return str(value or "").replace("\r", " ").replace("\n", " ")[:500]
