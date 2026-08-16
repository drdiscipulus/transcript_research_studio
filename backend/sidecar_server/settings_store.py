from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .app_paths import config_dir


DEFAULT_THEME_OVERRIDE = "light"
ALLOWED_THEME_OVERRIDES = {"system", "light", "dark"}
DEFAULT_SPEAKER_MODE = "auto"
ALLOWED_SPEAKER_MODES = {"auto", "exact", "range"}
DEFAULT_BEAM_SIZE = 5
DEFAULT_TEMPERATURE = 0.0
DEFAULT_COMPUTE_TYPE = "int8"
ALLOWED_COMPUTE_TYPES = {"int8", "float16", "float32"}
@dataclass(slots=True)
class AdvancedTranscriptionSettings:
    diarization_enabled: bool = False
    include_timestamps: bool = False
    beam_size: int = DEFAULT_BEAM_SIZE
    vad_filter: bool = True
    temperature: float = DEFAULT_TEMPERATURE
    compute_type: str = DEFAULT_COMPUTE_TYPE
    speaker_mode: str = DEFAULT_SPEAKER_MODE
    exact_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AppSettings:
    theme_override: str = DEFAULT_THEME_OVERRIDE
    advanced_transcription: AdvancedTranscriptionSettings = field(default_factory=AdvancedTranscriptionSettings)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["advanced_transcription"] = self.advanced_transcription.to_dict()
        return payload


def load_settings() -> AppSettings:
    path = _settings_file_path()
    if not path.exists():
        return AppSettings()

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return AppSettings()

    if not isinstance(payload, dict):
        return AppSettings()

    advanced_payload = payload.get("advanced_transcription", {})
    return AppSettings(
        theme_override=_normalize_theme_override(payload.get("theme_override")),
        advanced_transcription=_normalize_advanced_settings(advanced_payload),
    )


def save_settings(request_payload: dict[str, Any]) -> AppSettings:
    current = load_settings()
    settings = AppSettings(
        theme_override=_normalize_theme_override(request_payload.get("theme_override", current.theme_override)),
        advanced_transcription=_normalize_advanced_settings(
            request_payload.get("advanced_transcription", current.advanced_transcription.to_dict())
        ),
    )
    path = _settings_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings.to_dict(), indent=2), encoding="utf-8")
    return settings


def reset_settings() -> AppSettings:
    settings = AppSettings()
    path = _settings_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings.to_dict(), indent=2), encoding="utf-8")
    return settings


def _normalize_theme_override(value: Any) -> str:
    normalized = str(value or DEFAULT_THEME_OVERRIDE).strip().lower()
    if normalized not in ALLOWED_THEME_OVERRIDES:
        return DEFAULT_THEME_OVERRIDE
    return normalized


def _normalize_advanced_settings(value: Any) -> AdvancedTranscriptionSettings:
    payload = value if isinstance(value, dict) else {}
    speaker_mode = _normalize_speaker_mode(payload.get("speaker_mode"))
    exact_speakers = _normalize_positive_int(payload.get("exact_speakers"))
    min_speakers = _normalize_positive_int(payload.get("min_speakers"))
    max_speakers = _normalize_positive_int(payload.get("max_speakers"))
    if speaker_mode != "exact":
        exact_speakers = None
    if speaker_mode != "range":
        min_speakers = None
        max_speakers = None
    if speaker_mode == "range" and min_speakers and max_speakers and min_speakers > max_speakers:
        min_speakers, max_speakers = max_speakers, min_speakers

    return AdvancedTranscriptionSettings(
        diarization_enabled=bool(payload.get("diarization_enabled", False)),
        include_timestamps=bool(payload.get("include_timestamps", False)),
        beam_size=_normalize_beam_size(payload.get("beam_size")),
        vad_filter=bool(payload.get("vad_filter", True)),
        temperature=_normalize_temperature(payload.get("temperature")),
        compute_type=_normalize_compute_type(payload.get("compute_type")),
        speaker_mode=speaker_mode,
        exact_speakers=exact_speakers,
        min_speakers=min_speakers,
        max_speakers=max_speakers,
    )


def _normalize_speaker_mode(value: Any) -> str:
    normalized = str(value or DEFAULT_SPEAKER_MODE).strip().lower()
    if normalized not in ALLOWED_SPEAKER_MODES:
        return DEFAULT_SPEAKER_MODE
    return normalized


def _normalize_beam_size(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return DEFAULT_BEAM_SIZE
    return parsed if parsed > 0 else DEFAULT_BEAM_SIZE


def _normalize_temperature(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TEMPERATURE
    return min(max(parsed, 0.0), 1.0)


def _normalize_compute_type(value: Any) -> str:
    normalized = str(value or DEFAULT_COMPUTE_TYPE).strip().lower()
    if normalized not in ALLOWED_COMPUTE_TYPES:
        return DEFAULT_COMPUTE_TYPE
    return normalized


def _normalize_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _settings_file_path() -> Path:
    return config_dir() / "settings.json"
