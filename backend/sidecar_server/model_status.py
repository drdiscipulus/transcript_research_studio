from __future__ import annotations

from typing import Any

from .pyannote_diarization import pyannote_model_status
from .transcription_models import faster_whisper_model_statuses


def build_models_status_payload() -> dict[str, Any]:
    return {
        "faster_whisper": faster_whisper_model_statuses(),
        "pyannote": pyannote_model_status(),
    }
