from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class WordLine:
    start_seconds: float | None
    end_seconds: float | None
    text: str
    speaker: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "start_seconds": self.start_seconds,
            "end_seconds": self.end_seconds,
            "text": self.text,
            "speaker": self.speaker,
        }


@dataclass(slots=True)
class SegmentLine:
    start_seconds: float | None
    end_seconds: float | None
    text: str
    speaker: str | None = None
    words: list[WordLine] | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "start_seconds": self.start_seconds,
            "end_seconds": self.end_seconds,
            "text": self.text,
            "speaker": self.speaker,
        }
        if self.words:
            payload["words"] = [word.to_dict() for word in self.words]
        return payload


@dataclass(slots=True)
class TranscriptionResult:
    transcript: str
    detected_language: str
    engine: str
    model: str
    device: str
    used_fallback: bool
    note: str | None
    speaker_summary: str | None
    segments: list[SegmentLine]
    warnings: list[str] | None = None


@dataclass(slots=True)
class EngineContext:
    whisper_model_name: str
    device: str
    compute_type: str


@dataclass(slots=True)
class AdvancedTranscriptionOptions:
    diarization_enabled: bool
    include_timestamps: bool
    beam_size: int
    vad_filter: bool
    temperature: float
    compute_type: str
    speaker_mode: str
    exact_speakers: int | None
    min_speakers: int | None
    max_speakers: int | None


class TranscriptionConfigurationError(RuntimeError):
    """A safe configuration failure that preserves its machine-readable code."""

    def __init__(self, message: str, *, error_code: str = "model_not_ready") -> None:
        super().__init__(message)
        self.error_code = error_code


class TranscriptionRuntimeError(RuntimeError):
    """A safe, classified transcription failure that can cross process/API boundaries."""

    def __init__(self, message: str, *, error_code: str = "asr_failed") -> None:
        super().__init__(message)
        self.error_code = error_code


class TranscriptionWorkerError(TranscriptionRuntimeError):
    pass


class ModelDownloadCancelled(RuntimeError):
    pass
