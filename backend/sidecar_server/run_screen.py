from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .app_paths import (
    default_input_folder,
    default_prompt_output_folder,
    default_transcript_output_folder,
    ensure_app_runtime_directories,
)
from .batch_preparation import (
    default_batch_name,
    normalize_input_source_type,
    normalize_export_formats,
    normalize_output_naming_mode,
    normalize_output_organization,
    normalize_paragraph_options,
    normalize_transcript_layout,
    output_stem_for_file,
    resolve_non_conflicting_stem,
    sanitize_batch_name,
    validate_transcription_paths,
)
from .run_hardware import HardwareSummary, hardware_scan_manager
from .run_scan import ScanExclusion, ScanItem, ScanPreview, scan_input_folder, scan_input_source
from .settings_store import load_settings
from .transcription_models import is_model_cached_locally

DEFAULT_TRANSCRIPTION_MODEL = "small"
TRANSCRIPTION_MODEL_CATALOG = [
    {"value": "small", "label": "small", "bundled": False},
    {"value": "tiny", "label": "tiny", "bundled": False},
    {"value": "base", "label": "base", "bundled": False},
    {"value": "medium", "label": "medium", "bundled": False},
    {"value": "large-v3", "label": "large-v3", "bundled": False},
    {"value": "large-v3-turbo", "label": "large-v3-turbo", "bundled": False},
]


@dataclass(slots=True)
class SuggestedFolders:
    input_folder: str
    transcript_output_folder: str
    prompt_output_folder: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(slots=True)
class PreparedExport:
    format: str
    path: str
    exists: bool
    file_name: str | None = None
    role: str = "transcript"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PreparedBatch:
    batch_name: str
    file_count: int
    total_duration_label: str
    export_targets: list[PreparedExport]
    files: list[ScanItem]
    settings: dict[str, Any]
    exclusions: list[ScanExclusion] = field(default_factory=list)


def build_run_screen_payload() -> dict[str, Any]:
    folders = ensure_default_folders()
    return {
        "suggested_folders": folders.to_dict(),
        "browse_home_folder": str(Path.home()),
        "simple_options": {
            "language": "auto",
            "output_mode": "transcribe",
            "export_formats": ["xlsx"],
            "transcript_layout": "file",
            "paragraph_options": {
                "paragraph_pause_enabled": True,
                "max_pause_seconds": 3.0,
            },
            "model_name": DEFAULT_TRANSCRIPTION_MODEL,
            "acceleration": "cpu",
            "model_options": _build_transcription_model_options(),
        },
        "batch_name": default_batch_name(),
    }


def ensure_default_folders() -> SuggestedFolders:
    ensure_app_runtime_directories()
    input_folder = default_input_folder()
    transcript_output_folder = default_transcript_output_folder()
    prompt_output_folder = default_prompt_output_folder()

    return SuggestedFolders(
        input_folder=str(input_folder),
        transcript_output_folder=str(transcript_output_folder),
        prompt_output_folder=str(prompt_output_folder),
    )


def prepare_batch(request_payload: dict[str, Any]) -> PreparedBatch:
    input_source_type = normalize_input_source_type(request_payload.get("input_source_type"))
    input_path = str(request_payload.get("input_path") or "").strip()
    transcript_output_folder = str(request_payload.get("transcript_output_folder", "")).strip()
    output_naming_mode = normalize_output_naming_mode(request_payload.get("output_naming_mode"))
    output_organization = normalize_output_organization(request_payload.get("output_organization"))
    if input_source_type != "folder":
        output_organization = "separate_files"
    output_basename = sanitize_batch_name(str(request_payload.get("output_basename") or "").strip())
    batch_name = (
        output_basename
        if output_organization == "combined_file" or output_naming_mode == "override"
        else default_batch_name()
    )
    language = str(request_payload.get("language", "auto")).strip() or "auto"
    output_mode = str(request_payload.get("output_mode", "transcribe")).strip() or "transcribe"
    transcript_layout = normalize_transcript_layout(request_payload.get("transcript_layout"))
    paragraph_options = normalize_paragraph_options(request_payload.get("paragraph_options"))
    model_name = _normalize_transcription_model_name(request_payload.get("model_name"))
    acceleration = _normalize_acceleration_choice(
        request_payload.get("acceleration"),
        hardware_scan_manager.ready_summary(),
    )
    export_formats = normalize_export_formats(request_payload.get("export_formats", ["xlsx"]))
    validation_messages = validate_transcription_paths(
        input_source_type=input_source_type,
        input_path=input_path,
        transcript_output_folder=transcript_output_folder,
    )
    if validation_messages:
        raise ValueError(" ".join(validation_messages))

    transcript_output_path = Path(transcript_output_folder).expanduser()
    transcript_output_path.mkdir(parents=True, exist_ok=True)

    # Re-scan when the run starts so the execution plan always matches the
    # current input source instead of relying on stale frontend state.
    scan_preview = scan_input_source(input_source_type, input_path)
    if scan_preview.is_empty:
        raise ValueError(scan_preview.message)

    export_targets: list[PreparedExport] = []
    planned_stems: set[str] = set()
    if output_organization == "combined_file":
        output_stem = _reserve_non_conflicting_stem(
            transcript_output_path,
            output_basename,
            export_formats,
            planned_stems,
        )
        for format_name in export_formats:
            output_path = (transcript_output_path / f"{output_stem}.{format_name}").resolve()
            export_targets.append(
                PreparedExport(
                    format=format_name,
                    path=str(output_path),
                    exists=output_path.exists(),
                    file_name=None,
                    role="combined_transcript",
                )
            )
    else:
        for file_index, file_item in enumerate(scan_preview.files, start=1):
            desired_stem = output_stem_for_file(
                file_name=file_item.file_name,
                file_index=file_index,
                total_files=scan_preview.file_count,
                naming_mode=output_naming_mode,
                output_basename=output_basename,
            )
            output_stem = _reserve_non_conflicting_stem(
                transcript_output_path,
                desired_stem,
                export_formats,
                planned_stems,
            )
            for format_name in export_formats:
                output_path = (transcript_output_path / f"{output_stem}.{format_name}").resolve()
                export_targets.append(
                    PreparedExport(
                        format=format_name,
                        path=str(output_path),
                        exists=output_path.exists(),
                        file_name=file_item.file_name,
                        role="transcript",
                    )
                )
    overview_stem = _reserve_non_conflicting_stem(
        transcript_output_path,
        f"run_overview_{datetime.now().astimezone().strftime('%Y-%m-%d_%H%M%S')}",
        ["xlsx"],
        planned_stems,
    )
    overview_path = (transcript_output_path / f"{overview_stem}.xlsx").resolve()
    export_targets.append(
        PreparedExport(
            format="xlsx",
            path=str(overview_path),
            exists=overview_path.exists(),
            file_name=None,
            role="batch_overview",
        )
    )
    selected_model_option = _transcription_model_option(model_name)
    if not selected_model_option or not selected_model_option["installed"]:
        raise ValueError(
            f"Download the {model_name} faster-whisper model on the Models page before starting transcription."
        )
    app_settings = load_settings()

    return PreparedBatch(
        batch_name=batch_name,
        file_count=scan_preview.file_count,
        total_duration_label=scan_preview.total_duration_label,
        export_targets=export_targets,
        files=scan_preview.files,
        settings={
            "language": language,
            "output_mode": output_mode,
            "export_formats": export_formats,
            "transcript_layout": transcript_layout,
            "paragraph_options": paragraph_options,
            "input_source_type": input_source_type,
            "input_path": input_path,
            "output_organization": output_organization,
            "output_naming_mode": output_naming_mode,
            "output_basename": output_basename,
            "model_name": model_name,
            "model_installed": bool(selected_model_option["installed"]) if selected_model_option else False,
            "acceleration": acceleration,
            "input_folder": scan_preview.input_folder,
            "transcript_output_folder": transcript_output_folder,
            "advanced_transcription": app_settings.advanced_transcription.to_dict(),
        },
        exclusions=scan_preview.excluded_files,
    )


def _reserve_non_conflicting_stem(
    output_folder: Path,
    desired_stem: str,
    export_formats: list[str],
    planned_stems: set[str],
) -> str:
    candidate = resolve_non_conflicting_stem(output_folder, desired_stem, export_formats)
    if candidate not in planned_stems:
        planned_stems.add(candidate)
        return candidate
    copy_index = 1
    while True:
        next_candidate = f"{candidate}_copy{copy_index:02d}"
        if next_candidate not in planned_stems and not any(
            (output_folder / f"{next_candidate}.{format_name}").exists() for format_name in export_formats
        ):
            planned_stems.add(next_candidate)
            return next_candidate
        copy_index += 1


def _build_transcription_model_options() -> list[dict[str, Any]]:
    return [
        {
            "value": option["value"],
            "label": option["label"],
            "installed": option["bundled"] or is_model_cached_locally(option["value"]),
            "bundled": option["bundled"],
        }
        for option in TRANSCRIPTION_MODEL_CATALOG
    ]


def _transcription_model_option(model_name: str) -> dict[str, Any] | None:
    for option in _build_transcription_model_options():
        if option["value"] == model_name:
            return option
    return None


def _normalize_transcription_model_name(value: Any) -> str:
    normalized = str(value or DEFAULT_TRANSCRIPTION_MODEL).strip().lower()
    allowed_values = {option["value"] for option in TRANSCRIPTION_MODEL_CATALOG}
    if normalized not in allowed_values:
        return DEFAULT_TRANSCRIPTION_MODEL
    return normalized


def _normalize_acceleration_choice(value: Any, hardware: HardwareSummary | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "cuda":
        if hardware is not None and hardware.asr_cuda_available:
            return "cuda"
        # Reject stale UI selections explicitly so the backend remains the
        # source of truth for whether CUDA is actually usable.
        raise ValueError("NVIDIA / CUDA is not available on this machine.")
    return "cpu"
