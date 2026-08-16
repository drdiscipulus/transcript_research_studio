from __future__ import annotations

import inspect
import re
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .app_paths import app_data_root
from .hf_credentials import DIARIZATION_MODEL_ID, DIARIZATION_MODEL_URL
from .transcription_types import SegmentLine, WordLine


LOCAL_MODEL_FOLDER_NAME = "pyannote-speaker-diarization-community-1"
UNKNOWN_SPEAKER = "Unknown Speaker"
_TOKEN_PATTERN = re.compile(r"\bhf_[A-Za-z0-9_=-]{8,}\b")
_PIPELINE_CACHE: dict[tuple[str, str], Any] = {}
_PIPELINE_LOAD_ERRORS: dict[tuple[str, str], str] = {}
_PIPELINE_CACHE_LOCK = threading.Lock()


@dataclass(slots=True)
class SpeakerSegment:
    start: float
    end: float
    speaker: str


class DiarizationConfigurationError(RuntimeError):
    pass


def default_pyannote_model_dir() -> Path:
    """Return the app-managed directory for the local pyannote model snapshot."""
    return app_data_root() / "models" / LOCAL_MODEL_FOLDER_NAME


def pyannote_model_status() -> dict[str, Any]:
    """Report local pyannote model availability without requiring a Hugging Face token."""
    model_dir = default_pyannote_model_dir()
    available = pyannote_model_available(model_dir)
    availability = "ready" if available else "incomplete" if model_dir.exists() else "missing"
    return {
        "model_id": DIARIZATION_MODEL_ID,
        "model_url": DIARIZATION_MODEL_URL,
        "token_url": "https://huggingface.co/settings/tokens",
        "model_dir": str(model_dir),
        "installed": available,
        "availability": availability,
        "missing_files": [] if available else ["config.yaml"],
    }


def delete_pyannote_model(model_dir: Path | None = None) -> dict[str, Any]:
    """Remove the locally cached pyannote model and return a refreshed status payload."""
    target_dir = model_dir or default_pyannote_model_dir()
    _clear_pipeline_cache(target_dir)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    if model_dir is not None:
        status = pyannote_model_status()
        status["model_dir"] = str(target_dir)
        status["installed"] = pyannote_model_available(target_dir)
        return status
    return pyannote_model_status()


def pyannote_model_available(model_dir: Path | None = None) -> bool:
    """Check for the minimum local model files needed before loading pyannote."""
    root = model_dir or default_pyannote_model_dir()
    config_path = root / "config.yaml"
    try:
        return root.is_dir() and config_path.is_file() and config_path.stat().st_size > 0
    except OSError:
        return False


def download_pyannote_model(
    token: str,
    model_dir: Path | None = None,
    progress_callback: Callable[[int, int, str | None], None] | None = None,
) -> dict[str, Any]:
    """Download and validate the local pyannote model using a setup-only Hugging Face token."""
    cleaned_token = token.strip()
    if not cleaned_token:
        raise DiarizationConfigurationError("A Hugging Face token is required to download the pyannote model.")

    target_dir = model_dir or default_pyannote_model_dir()
    _clear_pipeline_cache(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    if progress_callback:
        progress_callback(5, 100, "Preparing pyannote model download")

    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise DiarizationConfigurationError("huggingface_hub is not installed in the project runtime.") from error

    kwargs: dict[str, Any] = {
        "repo_id": DIARIZATION_MODEL_ID,
        "token": cleaned_token,
        "local_dir": str(target_dir),
    }
    if "local_dir_use_symlinks" in inspect.signature(snapshot_download).parameters:
        kwargs["local_dir_use_symlinks"] = False

    try:
        if progress_callback:
            progress_callback(20, 100, "Downloading pyannote model files")
        snapshot_download(**kwargs)
        if progress_callback:
            progress_callback(85, 100, "Validating local pyannote model")
        # Validate the local copy immediately while the user's token is available.
        _load_pipeline(target_dir, device="cpu")
    except Exception as error:  # noqa: BLE001
        raise DiarizationConfigurationError(redact_secret(str(error) or "Pyannote model download failed.")) from error

    if progress_callback:
        progress_callback(100, 100, None)
    return pyannote_model_status()


def run_pyannote_diarization(
    *,
    media_path: Path,
    device: str,
    speaker_mode: str,
    exact_speakers: int | None,
    min_speakers: int | None,
    max_speakers: int | None,
    model_dir: Path | None = None,
) -> list[SpeakerSegment]:
    """Run local speaker diarization and return timestamped speaker turns."""
    local_model_dir = model_dir or default_pyannote_model_dir()
    if not pyannote_model_available(local_model_dir):
        raise DiarizationConfigurationError(
            "Speaker recognition is enabled, but the local pyannote model has not been downloaded yet."
        )

    pipeline = _load_pipeline(local_model_dir, device=device)
    kwargs: dict[str, int] = {}
    if speaker_mode == "exact" and exact_speakers:
        kwargs["num_speakers"] = exact_speakers
    elif speaker_mode == "range":
        if min_speakers:
            kwargs["min_speakers"] = min_speakers
        if max_speakers:
            kwargs["max_speakers"] = max_speakers

    audio = _load_audio_for_pyannote(media_path)
    diarization = _annotation_from_diarization_output(pipeline(audio, **kwargs))
    segments: list[SpeakerSegment] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        start = _float_or_none(getattr(turn, "start", None))
        end = _float_or_none(getattr(turn, "end", None))
        if start is None or end is None or end <= start:
            continue
        segments.append(
            SpeakerSegment(
                start=start,
                end=end,
                speaker=_normalize_speaker_label(str(speaker or "").strip()),
            )
        )
    return segments


def preload_pyannote_pipeline(*, device: str, model_dir: Path | None = None) -> Any:
    """Load and retain the optional diarization pipeline once for this worker process."""
    local_model_dir = model_dir or default_pyannote_model_dir()
    if not pyannote_model_available(local_model_dir):
        raise DiarizationConfigurationError(
            "Speaker recognition is enabled, but the local pyannote model has not been downloaded yet."
        )
    return _load_pipeline(local_model_dir, device=device)


def assign_speakers_to_segments(
    transcript_segments: list[SegmentLine],
    speaker_segments: list[SpeakerSegment],
) -> list[SegmentLine]:
    """Assign diarization speakers to transcript segments by word or segment overlap."""
    if any(segment.words for segment in transcript_segments):
        return _assign_speakers_to_word_segments(transcript_segments, speaker_segments)

    assigned: list[SegmentLine] = []
    for transcript_segment in transcript_segments:
        speaker = _speaker_with_largest_overlap(transcript_segment, speaker_segments)
        assigned.append(
            SegmentLine(
                start_seconds=transcript_segment.start_seconds,
                end_seconds=transcript_segment.end_seconds,
                text=transcript_segment.text,
                speaker=speaker,
            )
        )
    return assigned


def _assign_speakers_to_word_segments(
    transcript_segments: list[SegmentLine],
    speaker_segments: list[SpeakerSegment],
) -> list[SegmentLine]:
    assigned: list[SegmentLine] = []
    for transcript_segment in transcript_segments:
        words = [word for word in transcript_segment.words or [] if word.text.strip()]
        timestamped_words = [
            word
            for word in words
            if word.start_seconds is not None and word.end_seconds is not None and word.end_seconds > word.start_seconds
        ]
        if not timestamped_words:
            assigned.append(
                SegmentLine(
                    start_seconds=transcript_segment.start_seconds,
                    end_seconds=transcript_segment.end_seconds,
                    text=transcript_segment.text,
                    speaker=_speaker_with_largest_overlap(transcript_segment, speaker_segments),
                )
            )
            continue

        split_segments = _split_words_on_speaker_changes(timestamped_words, speaker_segments)
        if split_segments:
            assigned.extend(split_segments)
            continue

        assigned.append(
            SegmentLine(
                start_seconds=transcript_segment.start_seconds,
                end_seconds=transcript_segment.end_seconds,
                text=transcript_segment.text,
                speaker=_speaker_with_largest_overlap(transcript_segment, speaker_segments),
            )
        )
    return assigned


def _split_words_on_speaker_changes(
    words: list[WordLine],
    speaker_segments: list[SpeakerSegment],
) -> list[SegmentLine]:
    grouped_words: list[list[WordLine]] = []
    current_group: list[WordLine] = []
    current_speaker: str | None = None

    for word in words:
        speaker = _speaker_for_word(word, speaker_segments)
        assigned_word = WordLine(
            start_seconds=word.start_seconds,
            end_seconds=word.end_seconds,
            text=word.text,
            speaker=speaker,
        )
        if current_group and speaker != current_speaker:
            grouped_words.append(current_group)
            current_group = []
        current_group.append(assigned_word)
        current_speaker = speaker

    if current_group:
        grouped_words.append(current_group)

    return [_segment_from_words(group) for group in grouped_words if group]


def _segment_from_words(words: list[WordLine]) -> SegmentLine:
    speaker = words[0].speaker
    start_seconds = next((word.start_seconds for word in words if word.start_seconds is not None), None)
    end_seconds = next((word.end_seconds for word in reversed(words) if word.end_seconds is not None), None)
    return SegmentLine(
        start_seconds=start_seconds,
        end_seconds=end_seconds,
        text=_join_word_text(words),
        speaker=speaker,
        words=words,
    )


def _speaker_for_word(word: WordLine, speaker_segments: list[SpeakerSegment]) -> str:
    if word.start_seconds is None or word.end_seconds is None:
        return UNKNOWN_SPEAKER

    best_speaker: str | None = None
    best_overlap = 0.0
    for speaker_segment in speaker_segments:
        value = _overlap(word.start_seconds, word.end_seconds, speaker_segment.start, speaker_segment.end)
        if value > best_overlap:
            best_speaker = speaker_segment.speaker
            best_overlap = value
    return best_speaker or UNKNOWN_SPEAKER


def _join_word_text(words: list[WordLine]) -> str:
    raw_words = [word.text for word in words if word.text]
    if not raw_words:
        return ""
    if any(value[:1].isspace() for value in raw_words):
        return "".join(raw_words).strip()
    return " ".join(value.strip() for value in raw_words if value.strip()).strip()


def redact_secret(value: str) -> str:
    """Remove Hugging Face token-looking values from user-facing errors."""
    return _TOKEN_PATTERN.sub("[redacted-token]", value)


def _load_pipeline(model_dir: Path, *, device: str) -> Any:
    normalized_device = device.strip().lower() or "cpu"
    if normalized_device != "cuda":
        normalized_device = "cpu"
    key = (str(model_dir.resolve()), normalized_device)
    with _PIPELINE_CACHE_LOCK:
        cached = _PIPELINE_CACHE.get(key)
        if cached is not None:
            return cached
        cached_error = _PIPELINE_LOAD_ERRORS.get(key)
        if cached_error:
            raise DiarizationConfigurationError(cached_error)
        try:
            import torch
            from pyannote.audio import Pipeline

            if normalized_device == "cuda" and not torch.cuda.is_available():
                raise DiarizationConfigurationError(
                    "CUDA speaker recognition was requested, but this runtime does not have CUDA-enabled torch."
                )
            pipeline = Pipeline.from_pretrained(str(model_dir))
            pipeline.to(torch.device(normalized_device))
        except ImportError as error:
            message = "pyannote.audio and torch are required for speaker recognition, but they are not installed."
            _PIPELINE_LOAD_ERRORS[key] = message
            raise DiarizationConfigurationError(message) from error
        except Exception as error:  # noqa: BLE001 - remember a broken local snapshot for this batch process
            message = redact_secret(str(error).strip() or "The local pyannote model could not be loaded.")
            _PIPELINE_LOAD_ERRORS[key] = message
            raise DiarizationConfigurationError(message) from error
        _PIPELINE_CACHE[key] = pipeline
        return pipeline


def _clear_pipeline_cache(model_dir: Path) -> None:
    normalized_root = str(model_dir.resolve())
    with _PIPELINE_CACHE_LOCK:
        keys = [key for key in {*_PIPELINE_CACHE, *_PIPELINE_LOAD_ERRORS} if key[0] == normalized_root]
        for key in keys:
            _PIPELINE_CACHE.pop(key, None)
            _PIPELINE_LOAD_ERRORS.pop(key, None)


def _load_audio_for_pyannote(media_path: Path) -> dict[str, Any]:
    """Decode with faster-whisper/PyAV so pyannote does not depend on TorchCodec file decoding."""
    try:
        import torch
        from faster_whisper.audio import decode_audio
    except ImportError as error:
        raise DiarizationConfigurationError(
            "faster-whisper and torch are required to prepare audio for speaker recognition."
        ) from error

    try:
        audio = decode_audio(str(media_path), sampling_rate=16000)
    except Exception as error:  # noqa: BLE001
        raise DiarizationConfigurationError(
            f"Could not decode audio for speaker recognition: {redact_secret(str(error))}"
        ) from error

    waveform = torch.from_numpy(audio).float().unsqueeze(0)
    return {"waveform": waveform, "sample_rate": 16000}


def _annotation_from_diarization_output(output: Any) -> Any:
    exclusive = getattr(output, "exclusive_speaker_diarization", None)
    if exclusive is not None:
        return exclusive
    diarization = getattr(output, "speaker_diarization", None)
    if diarization is not None:
        return diarization
    return output


def _speaker_with_largest_overlap(
    transcript_segment: SegmentLine,
    speaker_segments: list[SpeakerSegment],
) -> str | None:
    if transcript_segment.start_seconds is None or transcript_segment.end_seconds is None:
        return None

    best_speaker: str | None = None
    best_overlap = 0.0
    for speaker_segment in speaker_segments:
        value = _overlap(
            transcript_segment.start_seconds,
            transcript_segment.end_seconds,
            speaker_segment.start,
            speaker_segment.end,
        )
        if value > best_overlap:
            best_speaker = speaker_segment.speaker
            best_overlap = value
    return best_speaker or UNKNOWN_SPEAKER


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _normalize_speaker_label(value: str) -> str:
    normalized = value.replace("SPEAKER_", "Speaker ").replace("_", " ").strip()
    return normalized or UNKNOWN_SPEAKER


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
