from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .prompting_outputs import sanitize_file_stem, write_preprocessing_outputs
from .prompting_providers import (
    get_provider_statuses,
    list_provider_models,
    resolve_provider_context_policy,
    run_provider_task_prompt as _run_provider_task_prompt,
    validate_provider_model,
)
from .prompting_runtime import (
    append_prompt_log_event as _append_prompt_log_event,
    ensure_prompting_runtime_paths as _ensure_runtime_paths,
    initialize_prompt_log as _initialize_prompt_log,
    write_prompt_log as _write_prompt_log,
)
from .prompting_context import TaskContext, adaptive_chunk_character_budget
from .prompting_analysis_tasks import (
    AnalysisCancelled,
    normalize_analysis_selection,
    run_selected_analysis,
)
from .prompting_custom_analyses import custom_analysis_by_id
from .prompting_tasks import (
    execute_preprocessing_tasks,
    selected_task_names,
)
from .prompting_transcripts import (
    inspect_prompting_input as _inspect_prompting_input,
    load_selected_transcript_objects,
)
from .prompting_types import PromptRunSnapshot
from .prompting_utils import (
    calculate_progress as _calculate_progress,
    now_iso as _now_iso,
    parse_prompt_timeout_seconds,
    parse_temperature,
    provider_display_name as _provider_display_name,
    safe_timestamp as _safe_timestamp,
)


def inspect_preprocessing_input(request_payload: dict[str, Any]) -> dict[str, Any]:
    return _inspect_prompting_input(request_payload)


class PromptingManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = self._idle_snapshot()
        self._cancel_requested = False

    def _idle_snapshot(self) -> PromptRunSnapshot:
        return PromptRunSnapshot(
            run_id=None,
            status="idle",
            message="No transcript analysis has started yet.",
            progress_percent=0,
            started_at=None,
            finished_at=None,
            provider_id=None,
            provider_name=None,
            model_id=None,
            log_file=None,
            counts={"queued": 0, "processing": 0, "done": 0, "failed": 0, "skipped": 0, "excluded": 0},
            phase="idle",
            input_mode=None,
            input_path=None,
            output_files=[],
            transcripts_completed=0,
            total_transcripts=0,
            current_transcript_id=None,
            current_task=None,
            rows_generated=0,
            error_message=None,
            exclusions=[],
            transcript_outcomes=[],
            warnings=[],
        )

    def get_snapshot(self) -> PromptRunSnapshot:
        with self._lock:
            return self._clone_snapshot(self._state)

    def start_run(self, request_payload: dict[str, Any]) -> PromptRunSnapshot:
        plan = prepare_preprocessing_run(request_payload)

        with self._lock:
            if self._state.status in {"starting", "running", "cancelling"}:
                raise ValueError("Another transcript analysis is already active.")

            run_id = uuid.uuid4().hex
            self._state = PromptRunSnapshot(
                run_id=run_id,
                status="starting",
                message="Starting transcript analysis.",
                progress_percent=0,
                started_at=_now_iso(),
                finished_at=None,
                provider_id=plan["provider_id"],
                provider_name=_provider_display_name(plan["provider_id"]),
                model_id=plan["model_id"],
                log_file=None,
                counts={
                    "queued": len(plan["transcripts"]),
                    "processing": 0,
                    "done": 0,
                    "failed": 0,
                    "skipped": 0,
                    "excluded": len(plan.get("exclusions", [])),
                },
                phase="preparing",
                progress_kind="determinate",
                progress_completed=0,
                progress_total=len(plan["transcripts"]),
                progress_label="Preparing transcript analysis",
                input_mode=plan["input_mode"],
                input_path=plan["input_path"],
                output_files=[],
                transcripts_completed=0,
                total_transcripts=len(plan["transcripts"]),
                current_transcript_id=None,
                current_task=None,
                rows_generated=0,
                error_message=None,
                exclusions=plan.get("exclusions", []),
                transcript_outcomes=[],
                warnings=[],
            )
            self._cancel_requested = False

        worker = threading.Thread(
            target=self._run_preprocessing,
            args=(plan,),
            daemon=True,
            name=f"prompting-runner-{run_id[:8]}",
        )
        worker.start()
        return self.get_snapshot()

    def cancel_current_run(self) -> PromptRunSnapshot:
        with self._lock:
            if self._state.status not in {"starting", "running"}:
                raise ValueError("No transcript analysis run is active.")
            self._cancel_requested = True
            self._state.status = "cancelling"
            self._state.message = "Cancellation requested. Finishing the current task before stopping."
            return self._clone_snapshot(self._state)

    def _run_preprocessing(self, plan: dict[str, Any]) -> None:
        paths = _ensure_runtime_paths()
        timestamp = _safe_timestamp()
        log_file = paths["logs"] / f"{plan['output_basename']}_{timestamp}.prompt.log"
        run_timestamp = _now_iso()

        with self._lock:
            self._state.status = "running"
            self._state.phase = "requesting"
            self._state.message = "Running transcript analysis."
            self._state.progress_label = "Starting analysis"
            self._state.log_file = str(log_file)

        _initialize_prompt_log(log_file=log_file, snapshot=self.get_snapshot(), plan=plan)
        for exclusion in plan.get("exclusions", []):
            _append_prompt_log_event(
                log_file,
                "CANDIDATE EXCLUDED",
                file_name=exclusion.get("file_name"),
                code=exclusion.get("code"),
            )

        result_roles = plan.get("selected_tasks") or ["custom_analysis"]
        results: dict[str, list[dict[str, Any]]] = {role: [] for role in result_roles}
        failures: list[str] = []
        outcomes: list[dict[str, Any]] = []
        warnings: list[str] = []
        context = TaskContext(
            provider_id=plan["provider_id"],
            provider_name=_provider_display_name(plan["provider_id"]),
            model_id=plan["model_id"],
            temperature=plan["temperature"],
            timeout_seconds=plan["timeout_seconds"],
            run_timestamp=run_timestamp,
            prompt_runner=_run_provider_task_prompt,
            context_window_tokens=plan["provider_context"]["tokens"],
            chunk_max_characters=plan["chunk_max_characters"],
            context_source=plan["provider_context"]["source"],
            should_request_provider_context=plan["provider_context"]["should_request_provider_context"],
        )

        for transcript in plan["transcripts"]:
            with self._lock:
                if self._cancel_requested:
                    break
                self._state.current_transcript_id = transcript.transcript_id
                self._state.counts["queued"] = max(0, self._state.counts["queued"] - 1)
                self._state.counts["processing"] = 1

            _append_prompt_log_event(
                log_file,
                "TRANSCRIPT STARTED",
                transcript_id=transcript.transcript_id,
                source_file=Path(transcript.source_file).name,
            )

            try:
                if plan.get("analysis_selection"):
                    partial = run_selected_analysis(
                        transcript,
                        plan["analysis_selection"],
                        context,
                        progress_callback=self._set_analysis_progress,
                        should_cancel=self._is_cancel_requested,
                    )
                else:
                    partial = execute_preprocessing_tasks(
                        transcripts=[transcript],
                        tasks=plan["tasks"],
                        context=context,
                        progress_callback=lambda transcript_id, task_label, rows_generated: self._set_task_progress(
                            transcript_id,
                            task_label,
                            rows_generated + sum(len(rows) for rows in results.values()),
                        ),
                    )
                partial_warnings = partial.pop("_warnings", [])
                for warning in partial_warnings:
                    safe_warning = str(warning).strip()
                    if safe_warning:
                        warnings.append(f"{transcript.transcript_id}: {safe_warning}")
                        _append_prompt_log_event(
                            log_file,
                            "ANALYSIS WARNING",
                            transcript_id=transcript.transcript_id,
                            warning=safe_warning,
                        )
                for key, rows in partial.items():
                    results.setdefault(key, []).extend(rows)
                outcome = {
                    "transcript_id": transcript.transcript_id,
                    "source_file": transcript.source_file,
                    "status": "completed",
                    "result_count": sum(len(rows) for rows in partial.values()),
                    "error": "",
                }
                outcomes.append(outcome)
                _append_prompt_log_event(
                    log_file,
                    "TRANSCRIPT COMPLETED",
                    transcript_id=transcript.transcript_id,
                    results=outcome["result_count"],
                )
                with self._lock:
                    self._state.transcripts_completed += 1
                    self._state.counts["processing"] = 0
                    self._state.counts["done"] += 1
                    self._state.progress_percent = _calculate_progress(
                        completed=self._state.transcripts_completed,
                        total=len(plan["transcripts"]),
                    )
                    self._state.progress_completed = self._state.transcripts_completed
                    self._state.progress_total = len(plan["transcripts"])
                    self._state.progress_label = f"Completed {self._state.transcripts_completed} of {len(plan['transcripts'])} transcripts"
                    self._state.rows_generated = sum(len(rows) for rows in results.values())
                    self._state.transcript_outcomes = list(outcomes)
                    self._state.warnings = list(warnings)
            except AnalysisCancelled:
                _append_prompt_log_event(log_file, "TRANSCRIPT CANCELLED", transcript_id=transcript.transcript_id)
                break
            except Exception as error:  # noqa: BLE001
                failures.append(f"{transcript.transcript_id}: {error}")
                outcomes.append({
                    "transcript_id": transcript.transcript_id,
                    "source_file": transcript.source_file,
                    "status": "failed",
                    "result_count": 0,
                    "error": str(error),
                })
                _append_prompt_log_event(
                    log_file,
                    "TRANSCRIPT FAILED",
                    transcript_id=transcript.transcript_id,
                    error_type=type(error).__name__,
                    error_message=str(error) if isinstance(error, TimeoutError) else "",
                )
                with self._lock:
                    self._state.transcripts_completed += 1
                    self._state.counts["processing"] = 0
                    self._state.counts["failed"] += 1
                    self._state.progress_percent = _calculate_progress(
                        completed=self._state.transcripts_completed,
                        total=len(plan["transcripts"]),
                    )
                    self._state.progress_completed = self._state.transcripts_completed
                    self._state.progress_total = len(plan["transcripts"])
                    self._state.transcript_outcomes = list(outcomes)

        if self._cancel_requested:
            with self._lock:
                self._state.status = "cancelled"
                self._state.phase = "cancelled"
                self._state.current_transcript_id = None
                self._state.current_task = None
                self._state.finished_at = _now_iso()
                self._state.message = "Transcript analysis was cancelled."
                self._state.progress_label = "Cancelled"
                queued = self._state.counts.get("queued", 0)
                self._state.counts["skipped"] += queued
                self._state.counts["queued"] = 0
            _write_prompt_log(log_file=log_file, snapshot=self.get_snapshot(), plan=plan)
            return

        run_info = build_run_info(plan, run_timestamp, failures)
        try:
            with self._lock:
                self._state.phase = "exporting"
                self._state.progress_label = "Writing analysis outputs"
            _append_prompt_log_event(log_file, "EXPORT STARTED", formats=",".join(plan["output_formats"]))
            output_files = write_preprocessing_outputs(
                output_folder=Path(plan["output_folder"]),
                output_basename=plan["output_basename"],
                output_formats=plan["output_formats"],
                results=results,
                run_info=run_info,
            )
        except Exception as error:  # noqa: BLE001
            with self._lock:
                self._state.status = "failed"
                self._state.phase = "failed"
                self._state.finished_at = _now_iso()
                self._state.message = f"Transcript analysis failed while writing output: {error}"
                self._state.error_message = str(error)
            _write_prompt_log(log_file=log_file, snapshot=self.get_snapshot(), plan=plan)
            return

        for output_file in output_files:
            _append_prompt_log_event(
                log_file,
                "OUTPUT CREATED",
                format=output_file.format,
                role=output_file.role,
                file_name=Path(output_file.path).name,
            )

        with self._lock:
            failed_count = len(failures)
            completed_count = self._state.counts.get("done", 0)
            self._state.status = "completed_with_problems" if failed_count and completed_count else ("failed" if failed_count else "completed")
            self._state.phase = "completed" if completed_count else "failed"
            self._state.current_transcript_id = None
            self._state.current_task = None
            self._state.finished_at = _now_iso()
            self._state.progress_percent = 100
            self._state.output_files = [output_file.to_dict() for output_file in output_files]
            self._state.rows_generated = sum(len(rows) for rows in results.values())
            self._state.error_message = "\n".join(failures) if failures else None
            self._state.message = (
                f"Analysis completed with {failed_count} failed transcript{'s' if failed_count != 1 else ''}."
                if failed_count
                else (
                    f"Analysis completed. Created {len(output_files)} output file{'s' if len(output_files) != 1 else ''}."
                    if plan.get("analysis_selection")
                    else f"Preprocessing completed. Created {len(output_files)} output file{'s' if len(output_files) != 1 else ''}."
                )
            )
            self._state.progress_label = self._state.message
            self._state.transcript_outcomes = list(outcomes)
            self._state.warnings = list(warnings)

        _write_prompt_log(log_file=log_file, snapshot=self.get_snapshot(), plan=plan)

    def _is_cancel_requested(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def _set_analysis_progress(
        self,
        transcript_id: str,
        phase: str,
        completed: int,
        total: int,
        label: str,
    ) -> None:
        with self._lock:
            self._state.current_transcript_id = transcript_id
            self._state.current_task = self._state.current_task or "Transcript Analysis"
            self._state.phase = phase
            self._state.progress_kind = "determinate"
            self._state.progress_completed = completed
            self._state.progress_total = total
            self._state.progress_label = label
            self._state.message = f"{label}: {transcript_id}"

    def _set_task_progress(self, transcript_id: str, task_label: str, rows_generated: int) -> None:
        with self._lock:
            self._state.current_transcript_id = transcript_id
            self._state.current_task = task_label
            self._state.rows_generated = rows_generated
            self._state.message = f"{task_label}: {transcript_id}"

    def _clone_snapshot(self, snapshot: PromptRunSnapshot) -> PromptRunSnapshot:
        return PromptRunSnapshot(**snapshot.to_dict())


def prepare_preprocessing_run(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = str(payload.get("input_path") or "").strip()
    input_mode = str(payload.get("input_mode") or "file").strip().lower()
    normalized_payload = {**payload, "input_path": input_path, "input_mode": input_mode}
    transcripts, intake = load_selected_transcript_objects(normalized_payload)

    provider_id = str(payload.get("provider_id", "")).strip().lower()
    if provider_id not in {"ollama", "lmstudio"}:
        raise ValueError("Choose either LM Studio or Ollama before starting transcript analysis.")

    model_id = str(payload.get("model_id", "")).strip()
    if not model_id:
        raise ValueError("Select a local provider model before starting transcript analysis.")
    validate_provider_model(provider_id, model_id)

    temperature = parse_temperature(payload.get("temperature", 0))
    timeout_seconds = parse_prompt_timeout_seconds(payload.get("timeout_seconds"))
    output_folder = str(payload.get("output_folder") or "").strip()
    if not output_folder:
        raise ValueError("Analysis output folder is required.")
    output_path = Path(output_folder).expanduser().resolve()

    tasks = payload.get("tasks") if isinstance(payload.get("tasks"), dict) else {}
    analysis_selection = None
    if isinstance(payload.get("analysis"), dict):
        analysis_selection = normalize_analysis_selection(payload.get("analysis"))
        if analysis_selection["type"] == "custom":
            saved_analysis = custom_analysis_by_id(str(analysis_selection.get("custom_analysis_id") or ""))
            if saved_analysis is None:
                raise ValueError("The selected custom analysis no longer exists.")
            analysis_selection["name"] = saved_analysis["name"]
            analysis_selection["prompt"] = str(payload["analysis"].get("prompt") or saved_analysis["instructions"]).strip()
        selected_tasks = [analysis_selection["output_role"]]
    else:
        selected_tasks = selected_task_names(tasks)
        if not selected_tasks:
            raise ValueError("Choose at least one preprocessing task.")
    provider_context = detect_prompting_context_policy(provider_id, model_id)

    requested_naming_mode = payload.get("output_naming_mode")
    output_naming_mode = str(
        requested_naming_mode
        or ("custom" if payload.get("output_basename") else "input")
    ).strip().lower()
    if output_naming_mode not in {"input", "custom"}:
        output_naming_mode = "input"
    custom_output_basename = str(payload.get("output_basename") or "").strip()
    if analysis_selection and not custom_output_basename:
        input_stem = sanitize_file_stem(Path(input_path).expanduser().resolve().stem)
        analysis_stem = sanitize_file_stem(str(analysis_selection.get("name") or "analysis")).lower()
        output_basename = sanitize_file_stem(f"{input_stem}_{analysis_stem}")
        output_naming_mode = "input"
    elif output_naming_mode == "custom":
        output_basename = custom_output_basename
    else:
        output_basename = sanitize_file_stem(Path(input_path).expanduser().resolve().stem)
    output_formats = [
        str(value).strip().lower()
        for value in payload.get("output_formats", ["xlsx"])
        if str(value).strip()
    ] or ["xlsx"]
    output_path.mkdir(parents=True, exist_ok=True)

    return {
        "provider_id": provider_id,
        "model_id": model_id,
        "input_mode": input_mode,
        "input_path": input_path,
        "transcripts": transcripts,
        "tasks": tasks,
        "analysis_selection": analysis_selection,
        "selected_tasks": selected_tasks,
        "temperature": temperature,
        "timeout_seconds": timeout_seconds,
        "provider_context": provider_context,
        "chunk_max_characters": adaptive_chunk_character_budget(provider_context["tokens"]),
        "output_folder": str(output_path),
        "output_naming_mode": output_naming_mode,
        "output_basename": output_basename,
        "output_formats": output_formats,
        "exclusions": intake.get("excluded", []),
        "candidate_count": intake.get("candidate_count", len(transcripts)),
    }


def build_run_info(plan: dict[str, Any], run_timestamp: str, failures: list[str]) -> dict[str, Any]:
    return {
        "run_timestamp": run_timestamp,
        "input_mode": plan["input_mode"],
        "input_path": plan["input_path"],
        "output_naming_mode": plan.get("output_naming_mode", "input"),
        "selected_tasks": ", ".join(plan["selected_tasks"]),
        "analysis_name": (plan.get("analysis_selection") or {}).get("name", ""),
        "research_focus": (plan.get("analysis_selection") or {}).get("research_focus", ""),
        "provider": _provider_display_name(plan["provider_id"]),
        "model": plan["model_id"],
        "temperature": plan["temperature"],
        "timeout_seconds": plan["timeout_seconds"],
        "context_window_tokens": plan["provider_context"]["tokens"],
        "context_source": plan["provider_context"]["source"],
        "chunk_max_characters": plan["chunk_max_characters"],
        "transcript_count": len(plan["transcripts"]),
        "status": "completed_with_problems" if failures else "completed",
        "error_message": "\n".join(failures),
    }


def detect_prompting_context_policy(provider_id: str, model_id: str) -> dict[str, Any]:
    try:
        return resolve_provider_context_policy(provider_id, model_id).to_dict()
    except Exception:  # noqa: BLE001
        return {
            "tokens": 4_096,
            "source": "fallback_assumed",
            "should_request_provider_context": False,
        }


prompting_manager = PromptingManager()
