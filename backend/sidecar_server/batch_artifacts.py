from __future__ import annotations

import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .app_paths import ensure_app_runtime_directories
from .batch_types import BatchRunSnapshot
from .export_writer import write_batch_overview
from .pyannote_diarization import redact_secret
from .run_scan import ScanExclusion
from .run_screen import PreparedBatch, PreparedExport


def create_log_path(*, prepared_batch: PreparedBatch, batch_id: str) -> Path:
    runtime_paths = ensure_app_runtime_directories()
    return runtime_paths["logs"] / f"{prepared_batch.batch_name}_{_safe_timestamp()}_{batch_id[:12]}.log"


def _safe_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def error_code(error: Exception, fallback: str) -> str:
    value = str(getattr(error, "error_code", "") or "").strip().lower()
    return value or fallback


def safe_error_message(error: BaseException) -> str:
    message = redact_secret(str(error)).replace("\r", " ").replace("\n", " ").strip()
    return (message or type(error).__name__)[:2_000]


def write_overview_rows(*, prepared_batch: PreparedBatch, rows: list[dict[str, Any]]) -> list[str]:
    targets = [target for target in prepared_batch.export_targets if target.role == "batch_overview"]
    if not targets:
        return []
    write_batch_overview(path=Path(targets[0].path), rows=rows)
    return [targets[0].path]


def write_overview_for_snapshot(*, prepared_batch: PreparedBatch, snapshot: BatchRunSnapshot) -> list[str]:
    rows = [build_exclusion_overview_row(exclusion) for exclusion in snapshot.exclusions]
    states_by_name = {state.file_name: state for state in snapshot.files}
    committed_paths = {str(Path(output.path)) for output in snapshot.output_files if output.exists}
    for index, file_item in enumerate(prepared_batch.files):
        file_state = states_by_name.get(file_item.file_name)
        if file_state is None:
            continue
        rows.extend(
            build_remaining_overview_rows(
                prepared_batch=prepared_batch,
                start_index=index,
                end_index=index + 1,
                status=file_state.status,
                error_message=file_state.error or "",
                committed_paths=committed_paths,
            )
        )
    return write_overview_rows(prepared_batch=prepared_batch, rows=rows)


def build_remaining_overview_rows(
    *,
    prepared_batch: PreparedBatch,
    start_index: int,
    status: str,
    error_message: str,
    end_index: int | None = None,
    committed_paths: set[str] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    stop_index = len(prepared_batch.files) if end_index is None else min(end_index, len(prepared_batch.files))
    for file_item in prepared_batch.files[start_index:stop_index]:
        export_targets = transcript_targets_for_file(prepared_batch=prepared_batch, file_name=file_item.file_name)
        if committed_paths is not None:
            export_targets = [target for target in export_targets if str(Path(target.path)) in committed_paths]
        elif status != "done":
            export_targets = []
        rows.append(
            build_overview_row(
                transcript_id=Path(export_targets[0].path).stem if export_targets else Path(file_item.file_name).stem,
                file_item=file_item,
                source_path=file_item.source_path,
                export_targets=export_targets,
                document=None,
                status=status,
                error_message=error_message,
            )
        )
    return rows


def transcript_targets_for_file(*, prepared_batch: PreparedBatch, file_name: str) -> list[PreparedExport]:
    if prepared_batch.settings.get("output_organization") == "combined_file":
        return [target for target in prepared_batch.export_targets if target.role == "combined_transcript"]
    return [
        target
        for target in prepared_batch.export_targets
        if target.role == "transcript" and target.file_name == file_name
    ]


def build_exclusion_overview_row(exclusion: ScanExclusion) -> dict[str, Any]:
    return {
        "transcript_id": Path(exclusion.file_name).stem,
        "source_media_file": exclusion.file_name,
        "source_media_path": exclusion.source_path,
        "json_path": "",
        "docx_path": "",
        "xlsx_path": "",
        "csv_path": "",
        "duration": "",
        "language": "",
        "speaker_count": "",
        "status": "excluded",
        "error_message": f"{exclusion.code}: {exclusion.message}",
    }


def mark_output_files_written(snapshot: BatchRunSnapshot, written_paths: list[str]) -> None:
    normalized_paths = {str(Path(path)) for path in written_paths}
    for output_file in snapshot.output_files:
        if str(Path(output_file.path)) in normalized_paths:
            output_file.exists = True


def written_paths_from_error(error: BaseException) -> list[str]:
    value = getattr(error, "written_paths", None)
    if not isinstance(value, (list, tuple)):
        return []
    return [str(path) for path in value if isinstance(path, (str, Path))]


def merge_written_paths(*path_groups: list[str]) -> list[str]:
    merged_paths: list[str] = []
    seen_paths: set[str] = set()
    for path_group in path_groups:
        for path in path_group:
            normalized_path = str(Path(path))
            if normalized_path in seen_paths:
                continue
            seen_paths.add(normalized_path)
            merged_paths.append(path)
    return merged_paths


def matching_export_targets(
    export_targets: list[PreparedExport],
    written_paths: list[str],
) -> list[PreparedExport]:
    normalized_paths = {str(Path(path)) for path in written_paths}
    return [target for target in export_targets if str(Path(target.path)) in normalized_paths]


def count_written_outputs(snapshot: BatchRunSnapshot) -> int:
    return sum(1 for output_file in snapshot.output_files if output_file.exists)


def build_overview_row(
    *,
    transcript_id: str,
    file_item: Any,
    source_path: str,
    export_targets: list[PreparedExport],
    document: dict[str, Any] | None,
    status: str,
    error_message: str,
) -> dict[str, Any]:
    paths_by_format = {
        target.format: target.path
        for target in export_targets
        if target.role in {"transcript", "combined_transcript"}
    }
    return {
        "transcript_id": transcript_id,
        "source_media_file": file_item.file_name,
        "source_media_path": source_path,
        "json_path": paths_by_format.get("json", ""),
        "docx_path": paths_by_format.get("docx", ""),
        "xlsx_path": paths_by_format.get("xlsx", ""),
        "csv_path": paths_by_format.get("csv", ""),
        "duration": file_item.duration_label,
        "language": str((document or {}).get("detected_language") or ""),
        "speaker_count": _speaker_count(document),
        "status": status,
        "error_message": error_message,
    }


def _speaker_count(document: dict[str, Any] | None) -> str:
    if not document:
        return ""
    speakers = {
        str(segment.get("speaker") or "").strip()
        for segment in document.get("segments", [])
        if isinstance(segment, dict) and str(segment.get("speaker") or "").strip()
    }
    if speakers:
        return str(len(speakers))
    return "1" if str(document.get("speaker_summary") or "").strip() else ""


def write_log(*, log_file: Path, snapshot: BatchRunSnapshot, prepared_batch: PreparedBatch) -> None:
    log_lines = [
        f"Batch name: {_safe_log_value(snapshot.batch_name)}",
        f"Status: {_safe_log_value(snapshot.status)}",
        f"Message: {_safe_log_value(snapshot.message)}",
        f"Error code: {_safe_log_value(snapshot.error_code or '-')}",
        f"Warnings: {_safe_log_value(' | '.join(snapshot.warnings) if snapshot.warnings else '-')}",
        f"Started at: {_safe_log_value(snapshot.started_at)}",
        f"Finished at: {_safe_log_value(snapshot.finished_at)}",
        f"Files completed: {snapshot.files_completed}/{snapshot.total_files}",
        f"Excluded files: {snapshot.counts.get('excluded', len(snapshot.exclusions))}",
        f"Output folder: {_safe_log_value(prepared_batch.settings.get('transcript_output_folder', ''))}",
        f"Export formats: {_safe_log_value(', '.join(str(value) for value in prepared_batch.settings.get('export_formats', [])))}",
        f"Transcript layout: {_safe_log_value(prepared_batch.settings.get('transcript_layout', 'file'))}",
    ]
    for exclusion in snapshot.exclusions:
        log_lines.append(
            "Excluded: "
            f"{_safe_log_value(exclusion.file_name)} | code={_safe_log_value(exclusion.code)} | "
            f"size_bytes={exclusion.size_bytes} | message={_safe_log_value(exclusion.message)}"
        )
    for file_status in snapshot.files:
        log_lines.append(
            f"File: {_safe_log_value(file_status.file_name)} | status={_safe_log_value(file_status.status)} | "
            f"engine={_safe_log_value(file_status.engine or '-')} | device={_safe_log_value(file_status.device or '-')} | "
            f"used_fallback={file_status.used_fallback} | error_code={_safe_log_value(file_status.error_code or '-')} | "
            f"error={_safe_log_value(file_status.error or '-')} | "
            f"warnings={_safe_log_value(' | '.join(file_status.warnings) if file_status.warnings else '-')}"
        )
    for output_file in snapshot.output_files:
        if output_file.exists:
            log_lines.append(f"Created output: {_safe_log_value(output_file.path)}")
    payload = "\n".join(log_lines) + "\n"
    temporary_log_file = log_file.with_name(f".{log_file.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary_log_file.open("x", encoding="utf-8", newline="\n") as file_handle:
            file_handle.write(payload)
            file_handle.flush()
            os.fsync(file_handle.fileno())
        os.replace(temporary_log_file, log_file)
    finally:
        try:
            temporary_log_file.unlink(missing_ok=True)
        except OSError:
            pass


def _safe_log_value(value: Any) -> str:
    return redact_secret(str(value)).replace("\r", " ").replace("\n", " ").strip()[:4_000]
