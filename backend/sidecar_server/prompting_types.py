from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(slots=True)
class ProviderStatus:
    id: str
    name: str
    installed: bool
    running: bool
    available: bool
    requires_auth: bool
    base_url: str
    message: str
    model_count: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ProviderModel:
    id: str
    display_name: str
    details: str
    context_length: int | None
    is_loaded: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PromptRunSnapshot:
    run_id: str | None
    status: str
    message: str
    progress_percent: int
    started_at: str | None
    finished_at: str | None
    provider_id: str | None
    provider_name: str | None
    model_id: str | None
    log_file: str | None
    counts: dict[str, int]
    phase: str = "idle"
    progress_kind: str = "determinate"
    progress_completed: int = 0
    progress_total: int = 0
    progress_label: str = ""
    input_mode: str | None = None
    input_path: str | None = None
    output_files: list[dict[str, Any]] | None = None
    transcripts_completed: int = 0
    total_transcripts: int = 0
    current_transcript_id: str | None = None
    current_task: str | None = None
    rows_generated: int = 0
    error_message: str | None = None
    exclusions: list[dict[str, Any]] | None = None
    transcript_outcomes: list[dict[str, Any]] | None = None
    warnings: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
