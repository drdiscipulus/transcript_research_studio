from __future__ import annotations

import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from . import batch_artifacts as artifacts
from .batch_types import BatchFileStatus, BatchRunSnapshot, clone_batch_snapshot, processing_progress
from .export_writer import (
    write_combined_document_exports,
    write_single_document_exports,
)
from .run_screen import PreparedBatch, prepare_batch
from .transcription_engine import transcription_worker_timeout_seconds
from .transcription_session import TranscriptionWorkerSession
from .transcription_types import TranscriptionWorkerError


class BatchManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = BatchRunSnapshot(
            batch_id=None,
            batch_name=None,
            status="idle",
            message="No batch has started yet.",
            progress_percent=0,
            files_completed=0,
            total_files=0,
            current_file_name=None,
            started_at=None,
            finished_at=None,
            output_files=[],
            files=[],
            counts={"queued": 0, "processing": 0, "done": 0, "failed": 0, "excluded": 0, "skipped": 0},
            log_file=None,
            warnings=[],
            error_code=None,
            exclusions=[],
        )
        self._cancel_requested = False
        self._start_reserved = False
        self._worker_thread: threading.Thread | None = None
        self._active_session: TranscriptionWorkerSession | None = None

    def get_snapshot(self) -> BatchRunSnapshot:
        """Return a cloned run snapshot so callers cannot mutate shared manager state."""
        with self._lock:
            snapshot = clone_batch_snapshot(self._state)
            worker = self._worker_thread
        if (
            snapshot.status not in {"idle", "starting", "running", "cancelling"}
            and worker is not None
            and worker is not threading.current_thread()
            and worker.is_alive()
        ):
            worker.join()
            with self._lock:
                snapshot = clone_batch_snapshot(self._state)
        return snapshot

    def start_batch(self, request_payload: dict[str, Any]) -> BatchRunSnapshot:
        """Prepare and start one sequential transcription run from the raw API payload."""
        with self._lock:
            if self._start_reserved or self._state.status in {"running", "starting", "cancelling"}:
                raise ValueError("Another transcription batch is already running.")
            self._start_reserved = True
            previous_worker = self._worker_thread

        batch_id: str | None = None
        previous_snapshot: BatchRunSnapshot | None = None
        try:
            if (
                previous_worker is not None
                and previous_worker is not threading.current_thread()
                and previous_worker.is_alive()
            ):
                previous_worker.join()

            with self._lock:
                previous_snapshot = clone_batch_snapshot(self._state)
                batch_id = uuid.uuid4().hex
                self._state = BatchRunSnapshot(
                    batch_id=batch_id,
                    batch_name=None,
                    status="starting",
                    message="Preparing transcription batch.",
                    progress_percent=0,
                    files_completed=0,
                    total_files=0,
                    current_file_name=None,
                    started_at=_now_iso(),
                    finished_at=None,
                    output_files=[],
                    files=[],
                    counts={"queued": 0, "processing": 0, "done": 0, "failed": 0, "excluded": 0, "skipped": 0},
                    log_file=None,
                    warnings=[],
                    error_code=None,
                    exclusions=[],
                )
                self._cancel_requested = False

            try:
                prepared_batch = prepare_batch(request_payload)
                with self._lock:
                    if self._state.batch_id != batch_id:
                        raise RuntimeError("The transcription batch reservation was replaced unexpectedly.")
                    cancellation_requested = self._cancel_requested
                    file_states = [
                        BatchFileStatus(
                            file_name=file_item.file_name,
                            duration_label=file_item.duration_label,
                            file_info=file_item.file_info,
                            status="queued",
                            transcript_preview="",
                            error=None,
                            engine=None,
                            warnings=[],
                            error_code=None,
                            device=None,
                            used_fallback=False,
                        )
                        for file_item in prepared_batch.files
                    ]
                    self._state = BatchRunSnapshot(
                        batch_id=batch_id,
                        batch_name=prepared_batch.batch_name,
                        status="cancelling" if cancellation_requested else "starting",
                        message=(
                            "Cancellation requested. The prepared queue will be skipped."
                            if cancellation_requested
                            else (
                                f"Starting transcription batch: {prepared_batch.file_count} ready"
                                f" · {len(prepared_batch.exclusions)} excluded."
                            )
                        ),
                        progress_percent=0,
                        files_completed=0,
                        total_files=prepared_batch.file_count,
                        current_file_name=None,
                        started_at=self._state.started_at,
                        finished_at=None,
                        output_files=prepared_batch.export_targets,
                        files=file_states,
                        counts={
                            "queued": prepared_batch.file_count,
                            "processing": 0,
                            "done": 0,
                            "failed": 0,
                            "excluded": len(prepared_batch.exclusions),
                            "skipped": 0,
                        },
                        log_file=None,
                        warnings=(
                            [
                                f"{len(prepared_batch.exclusions)} unusable input file(s) "
                                "were excluded before the run started."
                            ]
                            if prepared_batch.exclusions
                            else []
                        ),
                        error_code=None,
                        exclusions=list(prepared_batch.exclusions),
                    )
                    worker = threading.Thread(
                        target=self._run_batch_guarded,
                        args=(prepared_batch,),
                        daemon=True,
                        name=f"batch-runner-{batch_id[:8]}",
                    )
                    self._worker_thread = worker
            except Exception:
                with self._lock:
                    if batch_id is not None and self._state.batch_id == batch_id:
                        self._state = previous_snapshot
                        self._worker_thread = previous_worker
                        self._cancel_requested = False
                raise

            try:
                worker.start()
            except Exception as error:  # noqa: BLE001 - thread startup must leave a terminal snapshot
                error_message = artifacts.safe_error_message(error)
                with self._lock:
                    if self._state.batch_id == batch_id:
                        for file_state in self._state.files:
                            file_state.status = "failed"
                            file_state.error = error_message
                            file_state.error_code = "batch_thread_start_failed"
                        self._state.counts["queued"] = 0
                        self._state.counts["failed"] = len(self._state.files)
                        self._state.files_completed = len(self._state.files)
                        self._state.status = "failed"
                        self._state.message = f"Batch thread could not start: {error_message}"
                        self._state.error_code = "batch_thread_start_failed"
                        self._state.current_file_name = None
                        self._state.finished_at = _now_iso()
                        self._state.progress_percent = 100
                        self._worker_thread = None
                        self._cancel_requested = False
                        return clone_batch_snapshot(self._state)
                raise
            return self.get_snapshot()
        finally:
            with self._lock:
                self._start_reserved = False

    def cancel_current_batch(self) -> BatchRunSnapshot:
        """Request cooperative cancellation for the current run and return the latest snapshot."""
        with self._lock:
            if self._state.status not in {"starting", "running"}:
                raise ValueError("No active batch is running.")
            was_starting = self._state.status == "starting"
            setup_cancellation = was_starting and self._state.current_file_name is None
            self._cancel_requested = True
            self._state.status = "cancelling"
            session = (
                self._active_session
                if setup_cancellation
                else None
            )
            self._state.message = (
                "Cancellation requested. Stopping batch setup."
                if setup_cancellation
                else "Cancellation requested. Finishing the current file before stopping."
            )
            snapshot = clone_batch_snapshot(self._state)
        if session is not None:
            session.terminate()
        return snapshot

    def _run_batch_guarded(self, prepared_batch: PreparedBatch) -> None:
        log_file: Path | None = None
        try:
            with self._lock:
                batch_id = self._state.batch_id or uuid.uuid4().hex
            log_file = artifacts.create_log_path(prepared_batch=prepared_batch, batch_id=batch_id)
            self._run_batch(prepared_batch, log_file=log_file)
        except Exception as error:  # noqa: BLE001 - a started batch must always become terminal
            error_code = artifacts.error_code(error, "internal_error")
            error_message = artifacts.safe_error_message(error)
            with self._lock:
                for file_state in self._state.files:
                    if file_state.status in {"queued", "processing"}:
                        if file_state.status == "queued":
                            self._state.counts["queued"] = max(self._state.counts["queued"] - 1, 0)
                        else:
                            self._state.counts["processing"] = 0
                        file_state.status = "failed"
                        file_state.error = error_message
                        file_state.error_code = error_code
                        self._state.counts["failed"] += 1
                        self._state.files_completed += 1
                self._state.status = "failed"
                self._state.message = f"Batch stopped after an internal error: {error_message}"
                self._state.error_code = error_code
                self._state.current_file_name = None
                self._state.finished_at = _now_iso()
                self._state.progress_percent = 100
                self._state.log_file = str(log_file) if log_file is not None else None
            try:
                written_paths = artifacts.write_overview_for_snapshot(
                    prepared_batch=prepared_batch,
                    snapshot=self.get_snapshot(),
                )
                with self._lock:
                    artifacts.mark_output_files_written(self._state, written_paths)
            except Exception:  # noqa: BLE001 - preserve the original terminal failure
                pass
            if log_file is not None:
                try:
                    artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
                except Exception:  # noqa: BLE001 - terminal state must survive logging failure
                    pass
        finally:
            with self._lock:
                session = self._active_session
                self._active_session = None
            if session is not None:
                session.close()

    def _run_batch(self, prepared_batch: PreparedBatch, *, log_file: Path) -> None:

        overview_rows: list[dict[str, Any]] = [
            artifacts.build_exclusion_overview_row(exclusion) for exclusion in prepared_batch.exclusions
        ]
        run_warnings: list[str] = (
            [f"{len(prepared_batch.exclusions)} unusable input file(s) were excluded before transcription."]
            if prepared_batch.exclusions
            else []
        )

        with self._lock:
            cancellation_requested = self._cancel_requested
            self._state.log_file = str(log_file)
            self._state.warnings = list(run_warnings)

        artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)

        if cancellation_requested or self._is_cancel_requested():
            self._finalize_cancelled_batch(
                prepared_batch=prepared_batch,
                log_file=log_file,
                overview_rows=overview_rows,
                run_warnings=run_warnings,
            )
            return

        effective_device_preference = str(prepared_batch.settings.get("acceleration", "cpu"))
        session = self._new_worker_session(
            prepared_batch,
            device_preference=effective_device_preference,
        )
        with self._lock:
            self._active_session = session
        try:
            session.start()
        except Exception as error:  # noqa: BLE001 - initialization failure applies to the run
            if self._is_cancel_requested():
                self._finalize_cancelled_batch(
                    prepared_batch=prepared_batch,
                    log_file=log_file,
                    overview_rows=overview_rows,
                    run_warnings=run_warnings,
                )
                return
            error_message = artifacts.safe_error_message(error)
            self._fail_remaining_files(
                error=error,
                error_code=artifacts.error_code(error, "model_not_ready"),
            )
            with self._lock:
                self._state.status = "failed"
                self._state.message = f"Transcription worker could not start: {error_message}"
                self._state.error_code = artifacts.error_code(error, "model_not_ready")
                self._state.current_file_name = None
                self._state.finished_at = _now_iso()
                self._state.progress_percent = 100
            try:
                written_paths = artifacts.write_overview_for_snapshot(
                    prepared_batch=prepared_batch,
                    snapshot=self.get_snapshot(),
                )
                with self._lock:
                    artifacts.mark_output_files_written(self._state, written_paths)
            except Exception:  # noqa: BLE001 - the worker failure remains the primary error
                pass
            artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
            return

        with self._lock:
            cancellation_requested = self._cancel_requested
            if not cancellation_requested:
                self._state.status = "running"
                self._state.message = (
                    f"Running transcription batch: {prepared_batch.file_count} ready"
                    f" · {len(prepared_batch.exclusions)} excluded."
                )
        if cancellation_requested:
            self._finalize_cancelled_batch(
                prepared_batch=prepared_batch,
                log_file=log_file,
                overview_rows=overview_rows,
                run_warnings=run_warnings,
            )
            return
        artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)

        worker_restart_used = False
        combined_output = prepared_batch.settings.get("output_organization") == "combined_file"
        completed_documents: list[dict[str, Any]] = []

        # Keep one row per media file and attach export-only metadata here so every
        # selected format can be written from the same normalized in-memory table.
        for index, file_item in enumerate(prepared_batch.files):
            with self._lock:
                if self._cancel_requested:
                    break
                file_state = self._state.files[index]
                file_state.status = "processing"
                self._state.current_file_name = file_item.file_name
                self._state.counts["queued"] -= 1
                self._state.counts["processing"] = 1
                self._state.message = f"Processing {file_item.file_name}"

            artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)

            media_path = Path(file_item.source_path) if file_item.source_path else Path(prepared_batch.settings["input_folder"]) / file_item.file_name
            file_export_targets = artifacts.transcript_targets_for_file(
                prepared_batch=prepared_batch,
                file_name=file_item.file_name,
            )
            file_written_paths: list[str] = []
            try:
                result = session.transcribe(
                    media_path=media_path,
                    output_mode=str(prepared_batch.settings["output_mode"]),
                    language=str(prepared_batch.settings["language"]),
                    timeout_seconds=transcription_worker_timeout_seconds(media_path),
                )
                if result.used_fallback and str(result.device or "").strip().lower() == "cpu":
                    effective_device_preference = "cpu"
                row = {
                    "file_name": file_item.file_name,
                    "duration": file_item.duration_label,
                    "file_info": file_item.file_info,
                    "transcript": result.transcript,
                    "detected_language": result.detected_language,
                    "task": prepared_batch.settings["output_mode"],
                    "speaker_summary": result.speaker_summary,
                    "engine": result.engine,
                    "model": result.model,
                    "device": result.device,
                    "engine_note": result.note,
                    "warnings": result.warnings or [],
                    "segments": [segment.to_dict() for segment in result.segments],
                }
                if combined_output:
                    file_written_paths = write_combined_document_exports(
                        prepared_batch=prepared_batch,
                        documents=[*completed_documents, row],
                        export_targets=file_export_targets,
                    )
                    completed_documents.append(row)
                else:
                    file_written_paths = write_single_document_exports(
                        prepared_batch=prepared_batch,
                        document=row,
                        export_targets=file_export_targets,
                    )
                with self._lock:
                    artifacts.mark_output_files_written(self._state, file_written_paths)
                overview_rows.append(
                    artifacts.build_overview_row(
                        transcript_id=Path(file_item.file_name).stem if combined_output else (
                            Path(file_export_targets[0].path).stem
                            if file_export_targets
                            else Path(file_item.file_name).stem
                        ),
                        file_item=file_item,
                        source_path=str(media_path),
                        export_targets=artifacts.matching_export_targets(
                            file_export_targets,
                            file_written_paths,
                        ),
                        document=row,
                        status="done",
                        error_message="",
                    )
                )
                if result.warnings:
                    run_warnings.extend(f"{file_item.file_name}: {warning}" for warning in result.warnings)

                with self._lock:
                    file_state = self._state.files[index]
                    file_state.status = "done"
                    file_state.transcript_preview = result.transcript[:120]
                    file_state.engine = result.engine
                    file_state.warnings = result.warnings or []
                    file_state.device = result.device
                    file_state.used_fallback = result.used_fallback
                    self._state.files_completed += 1
                    self._state.counts["processing"] = 0
                    self._state.counts["done"] += 1
                    self._state.progress_percent = processing_progress(
                        files_completed=self._state.files_completed,
                        total_files=self._state.total_files,
                    )
            except Exception as error:  # noqa: BLE001 - one file must not terminate the batch thread
                error_code = artifacts.error_code(error, "internal_error")
                error_message = artifacts.safe_error_message(error)
                file_written_paths = artifacts.merge_written_paths(
                    file_written_paths,
                    artifacts.written_paths_from_error(error),
                )
                with self._lock:
                    artifacts.mark_output_files_written(self._state, file_written_paths)
                overview_rows.append(
                    artifacts.build_overview_row(
                        transcript_id=Path(file_item.file_name).stem if combined_output else (
                            Path(file_export_targets[0].path).stem
                            if file_export_targets
                            else Path(file_item.file_name).stem
                        ),
                        file_item=file_item,
                        source_path=str(media_path),
                        export_targets=artifacts.matching_export_targets(
                            file_export_targets,
                            file_written_paths,
                        ),
                        document=None,
                        status="failed",
                        error_message=error_message,
                    )
                )
                with self._lock:
                    file_state = self._state.files[index]
                    file_state.status = "failed"
                    file_state.error = error_message
                    file_state.error_code = error_code
                    self._state.files_completed += 1
                    self._state.counts["processing"] = 0
                    self._state.counts["failed"] += 1
                    self._state.progress_percent = processing_progress(
                        files_completed=self._state.files_completed,
                        total_files=self._state.total_files,
                    )
                artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
                if isinstance(error, TranscriptionWorkerError) and error_code == "worker_protocol_error":
                    self._close_owned_session(session)
                    self._fail_remaining_files(error=error, error_code=error_code)
                    overview_rows.extend(
                        artifacts.build_remaining_overview_rows(
                            prepared_batch=prepared_batch,
                            start_index=index + 1,
                            status="failed",
                            error_message=error_message,
                        )
                    )
                    artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
                    break
                if isinstance(error, TranscriptionWorkerError) and error_code in {"worker_crashed", "worker_timeout"}:
                    self._close_owned_session(session)
                    if self._is_cancel_requested():
                        break
                    if worker_restart_used:
                        terminal_error = TranscriptionWorkerError(
                            "The transcription worker failed again after its automatic restart.",
                            error_code="worker_crashed",
                        )
                        self._fail_remaining_files(
                            error=terminal_error,
                            error_code="worker_crashed",
                        )
                        overview_rows.extend(
                            artifacts.build_remaining_overview_rows(
                                prepared_batch=prepared_batch,
                                start_index=index + 1,
                                status="failed",
                                error_message=artifacts.safe_error_message(terminal_error),
                            )
                        )
                        artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
                        break
                    worker_restart_used = True
                    try:
                        session = self._new_worker_session(
                            prepared_batch,
                            device_preference=effective_device_preference,
                        )
                        with self._lock:
                            self._active_session = session
                        session.start()
                        run_warnings.append("The transcription worker was restarted after an unexpected stop.")
                        with self._lock:
                            self._state.warnings = list(run_warnings)
                    except Exception as restart_error:  # noqa: BLE001
                        self._fail_remaining_files(
                            error=restart_error,
                            error_code=artifacts.error_code(restart_error, "worker_crashed"),
                        )
                        overview_rows.extend(
                            artifacts.build_remaining_overview_rows(
                                prepared_batch=prepared_batch,
                                start_index=index + 1,
                                status="failed",
                                error_message=artifacts.safe_error_message(restart_error),
                            )
                        )
                        artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)
                        break

            artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)

        if self._is_cancel_requested():
            self._finalize_cancelled_batch(
                prepared_batch=prepared_batch,
                log_file=log_file,
                overview_rows=overview_rows,
                run_warnings=run_warnings,
            )
            return

        try:
            written_paths = artifacts.write_overview_rows(prepared_batch=prepared_batch, rows=overview_rows)
            with self._lock:
                artifacts.mark_output_files_written(self._state, written_paths)
        except Exception as error:
            error_message = artifacts.safe_error_message(error)
            with self._lock:
                self._state.status = "failed"
                self._state.message = f"Batch failed while writing overview: {error_message}"
                self._state.error_code = "overview_export_failed"
                self._state.current_file_name = None
                self._state.finished_at = _now_iso()
            artifacts.write_log(
                log_file=log_file,
                snapshot=self.get_snapshot(),
                prepared_batch=prepared_batch,
            )
            return

        with self._lock:
            failed_count = self._state.counts.get("failed", 0)
            if failed_count:
                self._state.status = "completed_with_warnings" if self._state.counts.get("done", 0) else "failed"
                self._state.message = f"Run finished with {failed_count} failed file{'s' if failed_count != 1 else ''}."
            else:
                self._state.status = "completed_with_warnings" if run_warnings else "completed"
                self._state.message = (
                    f"Run completed with warnings. {run_warnings[0]}"
                    if run_warnings
                    else f"Run successful. Created {artifacts.count_written_outputs(self._state)} output files."
                )
            self._state.current_file_name = None
            self._state.finished_at = _now_iso()
            self._state.progress_percent = 100
            self._state.warnings = list(run_warnings)

        artifacts.write_log(
            log_file=log_file,
            snapshot=self.get_snapshot(),
            prepared_batch=prepared_batch,
        )

    def _finalize_cancelled_batch(
        self,
        *,
        prepared_batch: PreparedBatch,
        log_file: Path,
        overview_rows: list[dict[str, Any]],
        run_warnings: list[str],
    ) -> None:
        skipped_indices: list[int] = []
        with self._lock:
            for file_index, file_state in enumerate(self._state.files):
                if file_state.status == "queued":
                    file_state.status = "skipped"
                    self._state.counts["queued"] = max(self._state.counts["queued"] - 1, 0)
                    self._state.counts["skipped"] += 1
                    self._state.files_completed += 1
                    skipped_indices.append(file_index)
            self._state.status = "cancelled"
            self._state.message = "Batch was cancelled before all files finished."
            self._state.current_file_name = None
            self._state.finished_at = _now_iso()
            self._state.progress_percent = 100
            self._state.warnings = list(run_warnings)
        for file_index in skipped_indices:
            overview_rows.extend(
                artifacts.build_remaining_overview_rows(
                    prepared_batch=prepared_batch,
                    start_index=file_index,
                    end_index=file_index + 1,
                    status="skipped",
                    error_message="The file was queued when the batch was cancelled.",
                )
            )
        try:
            written_paths = artifacts.write_overview_rows(prepared_batch=prepared_batch, rows=overview_rows)
            with self._lock:
                artifacts.mark_output_files_written(self._state, written_paths)
        except Exception as error:  # noqa: BLE001
            with self._lock:
                self._state.warnings.append(
                    f"The run overview could not be written: {artifacts.safe_error_message(error)}"
                )
        artifacts.write_log(log_file=log_file, snapshot=self.get_snapshot(), prepared_batch=prepared_batch)

    def _new_worker_session(
        self,
        prepared_batch: PreparedBatch,
        *,
        device_preference: str | None = None,
    ) -> TranscriptionWorkerSession:
        return TranscriptionWorkerSession(
            batch_name=prepared_batch.batch_name,
            model_name=str(prepared_batch.settings.get("model_name", "small")),
            device_preference=(
                device_preference
                if device_preference is not None
                else str(prepared_batch.settings.get("acceleration", "cpu"))
            ),
            advanced_settings=prepared_batch.settings.get("advanced_transcription"),
        )

    def _is_cancel_requested(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def _close_owned_session(self, session: TranscriptionWorkerSession) -> None:
        with self._lock:
            if self._active_session is session:
                self._active_session = None
        session.close()

    def _fail_remaining_files(self, *, error: Exception, error_code: str) -> None:
        error_message = artifacts.safe_error_message(error)
        with self._lock:
            for file_state in self._state.files:
                if file_state.status != "queued":
                    continue
                file_state.status = "failed"
                file_state.error = error_message
                file_state.error_code = error_code
                self._state.counts["queued"] = max(self._state.counts["queued"] - 1, 0)
                self._state.counts["failed"] += 1
                self._state.files_completed += 1
            self._state.progress_percent = processing_progress(
                files_completed=self._state.files_completed,
                total_files=self._state.total_files,
            )


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


batch_manager = BatchManager()
