from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .run_scan import ScanExclusion
from .run_screen import PreparedExport


@dataclass(slots=True)
class BatchFileStatus:
    file_name: str
    duration_label: str
    file_info: str
    status: str
    transcript_preview: str
    error: str | None
    engine: str | None
    warnings: list[str]
    error_code: str | None = None
    device: str | None = None
    used_fallback: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class BatchRunSnapshot:
    batch_id: str | None
    batch_name: str | None
    status: str
    message: str
    progress_percent: int
    files_completed: int
    total_files: int
    current_file_name: str | None
    started_at: str | None
    finished_at: str | None
    output_files: list[PreparedExport]
    files: list[BatchFileStatus]
    counts: dict[str, int]
    log_file: str | None
    warnings: list[str]
    error_code: str | None = None
    exclusions: list[ScanExclusion] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["output_files"] = [output_file.to_dict() for output_file in self.output_files]
        payload["files"] = [file_status.to_dict() for file_status in self.files]
        payload["exclusions"] = [exclusion.to_dict() for exclusion in self.exclusions]
        return payload


def clone_batch_snapshot(snapshot: BatchRunSnapshot) -> BatchRunSnapshot:
    return BatchRunSnapshot(
        batch_id=snapshot.batch_id,
        batch_name=snapshot.batch_name,
        status=snapshot.status,
        message=snapshot.message,
        progress_percent=snapshot.progress_percent,
        files_completed=snapshot.files_completed,
        total_files=snapshot.total_files,
        current_file_name=snapshot.current_file_name,
        started_at=snapshot.started_at,
        finished_at=snapshot.finished_at,
        output_files=[PreparedExport(**output_file.to_dict()) for output_file in snapshot.output_files],
        files=[BatchFileStatus(**file_status.to_dict()) for file_status in snapshot.files],
        counts=dict(snapshot.counts),
        log_file=snapshot.log_file,
        warnings=list(snapshot.warnings),
        error_code=snapshot.error_code,
        exclusions=[ScanExclusion(**exclusion.to_dict()) for exclusion in snapshot.exclusions],
    )


def processing_progress(*, files_completed: int, total_files: int) -> int:
    if total_files <= 0:
        return 100
    return int(round((files_completed / total_files) * 100))
