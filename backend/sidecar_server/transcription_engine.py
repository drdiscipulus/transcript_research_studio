from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

from .media_utils import probe_media_metadata
from .pyannote_diarization import (
    assign_speakers_to_segments,
    preload_pyannote_pipeline,
    pyannote_model_available,
    redact_secret,
    run_pyannote_diarization,
)
from .runtime_env import configure_ml_runtime_environment
from .runtime_env import detect_runtime_variant, probe_cuda_runtime
from .transcription_formatting import (
    format_transcript as _format_transcript,
    normalize_advanced_settings as _normalize_advanced_settings,
    normalize_optional_text as _normalize_optional_text,
    speaker_summary as _speaker_summary,
)
from .transcription_models import get_or_create_model as _get_or_create_model
from .transcription_types import (
    AdvancedTranscriptionOptions,
    EngineContext,
    SegmentLine,
    TranscriptionConfigurationError,
    TranscriptionResult,
    TranscriptionRuntimeError,
    WordLine,
)


def preload_transcription_runtime(
    *,
    model_name: str,
    device_preference: str,
    advanced_settings: dict[str, Any] | None = None,
) -> EngineContext:
    """Resolve and load one validated local model for a persistent worker session."""
    options = _normalize_advanced_settings(advanced_settings)
    context = build_engine_context(
        model_name=model_name,
        device_preference=device_preference,
        compute_type_override=options.compute_type,
    )
    configure_ml_runtime_environment()
    try:
        faster_whisper = importlib.import_module("faster_whisper")
    except ImportError as error:
        raise TranscriptionConfigurationError(
            "The faster-whisper runtime is not available in this application package."
        ) from error
    _get_or_create_model(
        faster_whisper=faster_whisper,
        model_name=context.whisper_model_name,
        device=context.device,
        compute_type=context.compute_type,
    )
    if options.diarization_enabled and pyannote_model_available():
        try:
            preload_pyannote_pipeline(device=_resolve_pyannote_device(context.device))
        except Exception:
            # A successful ASR run remains valuable. The cached diarization
            # error is surfaced as a per-file warning without retrying the load.
            pass
    return context


def build_engine_context(
    model_name: str = "",
    device_preference: str = "",
    compute_type_override: str = "",
) -> EngineContext:
    """Choose the faster-whisper device and compute type from hardware and user settings."""
    selected_model = model_name.strip().lower() or "small"
    preferred_device = device_preference.strip().lower()
    requested_compute_type = compute_type_override.strip().lower()
    runtime_allows_cuda = detect_runtime_variant() not in {"windows-cpu", "macos-cpu"}
    if (
        (preferred_device == "cuda" or not preferred_device)
        and runtime_allows_cuda
        and probe_cuda_runtime()
    ):
        compute_type = requested_compute_type if requested_compute_type and requested_compute_type != "default" else "float16"
        return EngineContext(
            whisper_model_name=selected_model,
            device="cuda",
            compute_type=compute_type,
        )
    compute_type = requested_compute_type if requested_compute_type and requested_compute_type != "default" else "int8"
    return EngineContext(
        whisper_model_name=selected_model,
        device="cpu",
        compute_type=compute_type,
    )


def transcribe_media_direct(
    *,
    media_path: Path,
    output_mode: str,
    language: str,
    batch_name: str,
    model_name: str = "",
    device_preference: str = "",
    advanced_settings: dict[str, Any] | None = None,
) -> TranscriptionResult:
    """Run faster-whisper directly and never turn an ASR failure into transcript text."""
    options = _normalize_advanced_settings(advanced_settings)
    context = build_engine_context(
        model_name=model_name,
        device_preference=device_preference,
        compute_type_override=options.compute_type,
    )
    requested_language = None if language == "auto" else language
    task = "translate" if output_mode == "translate" else "transcribe"

    try:
        result = _transcribe_with_faster_whisper(
            media_path=media_path,
            model_name=context.whisper_model_name,
            device=context.device,
            compute_type=context.compute_type,
            language=requested_language,
            task=task,
            include_timestamps=options.include_timestamps,
            beam_size=options.beam_size,
            vad_filter=options.vad_filter,
            temperature=options.temperature,
            word_timestamps=options.diarization_enabled,
        )
        return _with_optional_pyannote_diarization(
            result=result,
            media_path=media_path,
            diarization_device=context.device,
            include_timestamps=options.include_timestamps,
            options=options,
        )
    except TranscriptionConfigurationError:
        raise
    except Exception as error:  # noqa: BLE001 - classified below for the worker boundary
        if context.device != "cuda" or not _is_cuda_runtime_error(error):
            raise _as_transcription_error(error, context=context) from error

        try:
            result = _transcribe_with_faster_whisper(
                media_path=media_path,
                model_name=context.whisper_model_name,
                device="cpu",
                compute_type="int8",
                language=requested_language,
                task=task,
                include_timestamps=options.include_timestamps,
                beam_size=options.beam_size,
                vad_filter=options.vad_filter,
                temperature=options.temperature,
                word_timestamps=options.diarization_enabled,
            )
            cpu_result = _with_optional_pyannote_diarization(
                result=result,
                media_path=media_path,
                diarization_device="cpu",
                include_timestamps=options.include_timestamps,
                options=options,
            )
            warning = "CUDA transcription failed; this file was completed on CPU."
            return TranscriptionResult(
                transcript=cpu_result.transcript,
                detected_language=cpu_result.detected_language,
                engine=cpu_result.engine,
                model=cpu_result.model,
                device="cpu",
                used_fallback=True,
                note=_combine_notes(cpu_result.note, warning),
                speaker_summary=cpu_result.speaker_summary,
                segments=cpu_result.segments,
                warnings=[*(cpu_result.warnings or []), warning],
            )
        except Exception as cpu_error:  # noqa: BLE001
            raise TranscriptionRuntimeError(
                f"CUDA transcription failed and the CPU retry also failed for {media_path.name}: "
                f"{redact_secret(str(cpu_error)) or type(cpu_error).__name__}",
                error_code="asr_failed",
            ) from cpu_error


def _transcribe_with_faster_whisper(
    *,
    media_path: Path,
    model_name: str,
    device: str,
    compute_type: str,
    language: str | None,
    task: str,
    include_timestamps: bool,
    beam_size: int,
    vad_filter: bool,
    temperature: float,
    word_timestamps: bool,
) -> TranscriptionResult:
    configure_ml_runtime_environment()
    try:
        faster_whisper = importlib.import_module("faster_whisper")
    except ImportError as error:
        raise TranscriptionConfigurationError(
            "The faster-whisper runtime is not available in this application package."
        ) from error
    whisper_model = _get_or_create_model(
        faster_whisper=faster_whisper,
        model_name=model_name,
        device=device,
        compute_type=compute_type,
    )
    segments_iter, info = whisper_model.transcribe(
        str(media_path),
        language=language,
        task=task,
        beam_size=beam_size,
        vad_filter=vad_filter,
        temperature=temperature,
        condition_on_previous_text=False,
        word_timestamps=word_timestamps,
    )
    segments = [
        SegmentLine(
            start_seconds=getattr(segment, "start", None),
            end_seconds=getattr(segment, "end", None),
            text=segment.text.strip(),
            words=_words_from_faster_whisper_segment(segment) if word_timestamps else None,
        )
        for segment in segments_iter
        if segment.text.strip()
    ]
    transcript = _format_transcript(segments, include_timestamps=include_timestamps)
    warnings = ["no_speech_detected: No speech was detected in this recording."] if not segments else None
    return TranscriptionResult(
        transcript=transcript,
        detected_language=getattr(info, "language", language or "unknown"),
        engine="faster-whisper",
        model=model_name,
        device=device,
        used_fallback=False,
        note=None,
        speaker_summary=None,
        segments=segments,
        warnings=warnings,
    )


def _is_cuda_runtime_error(error: Exception) -> bool:
    message = str(error).lower()
    cuda_markers = (
        "cudnn",
        "cublas",
        "nvcuda",
        "cuda_error",
        "cuda error",
        "cuda runtime",
        "cuda driver",
        "cuda failed",
        "cuda failure",
        "cuda out of memory",
        "out of memory",
        "compute capability",
        "no kernel image",
        "driver version is insufficient",
        "invalid device ordinal",
        "device-side assert",
    )
    return any(marker in message for marker in cuda_markers)


def _as_transcription_error(error: Exception, *, context: EngineContext) -> TranscriptionRuntimeError:
    message = redact_secret(str(error)).strip() or type(error).__name__
    return TranscriptionRuntimeError(
        f"Transcription failed with {context.whisper_model_name} on {context.device.upper()}: {message}",
        error_code="asr_failed",
    )


def _words_from_faster_whisper_segment(segment: Any) -> list[WordLine] | None:
    raw_words = getattr(segment, "words", None)
    if not raw_words:
        return None

    words: list[WordLine] = []
    for word in raw_words:
        text = str(getattr(word, "word", "") or "")
        if not text.strip():
            continue
        words.append(
            WordLine(
                start_seconds=getattr(word, "start", None),
                end_seconds=getattr(word, "end", None),
                text=text,
            )
        )
    return words or None


def transcription_worker_timeout_seconds(media_path: Path) -> int:
    metadata = probe_media_metadata(media_path)
    duration_seconds = metadata.duration_seconds or 0
    if duration_seconds <= 0:
        return 900
    scaled_timeout = int(duration_seconds * 4)
    return max(300, min(3600, scaled_timeout))


def _with_optional_pyannote_diarization(
    *,
    media_path: Path,
    result: TranscriptionResult,
    diarization_device: str,
    include_timestamps: bool,
    options: AdvancedTranscriptionOptions,
) -> TranscriptionResult:
    """Run pyannote after ASR when enabled, falling back to a warning result on setup/runtime issues."""
    if not options.diarization_enabled:
        return result

    requested_diarization_device = diarization_device
    diarization_device = _resolve_pyannote_device(diarization_device)
    try:
        speaker_segments = run_pyannote_diarization(
            media_path=media_path,
            device=diarization_device,
            speaker_mode=options.speaker_mode,
            exact_speakers=options.exact_speakers,
            min_speakers=options.min_speakers,
            max_speakers=options.max_speakers,
        )
    except Exception as error:  # noqa: BLE001 - diarization must not discard a successful transcript
        warning = f"Speaker recognition skipped after transcription: {redact_secret(str(error))}"
        note = _combine_notes(
            result.note,
            warning,
        )
        return TranscriptionResult(
            transcript=result.transcript,
            detected_language=result.detected_language,
            engine=result.engine,
            model=result.model,
            device=result.device,
            used_fallback=result.used_fallback,
            note=note,
            speaker_summary=result.speaker_summary,
            segments=result.segments,
            warnings=[*(result.warnings or []), warning],
        )

    segments = assign_speakers_to_segments(result.segments, speaker_segments)
    transcript = _format_transcript(segments, include_timestamps=include_timestamps)
    fallback_note = (
        " Speaker recognition fell back to CPU because CUDA-enabled PyTorch is not available."
        if requested_diarization_device == "cuda" and diarization_device == "cpu"
        else ""
    )
    return TranscriptionResult(
        transcript=transcript or result.transcript,
        detected_language=result.detected_language,
        engine="faster-whisper+pyannote",
        model=result.model,
        device=result.device,
        used_fallback=result.used_fallback,
        note=_combine_notes(result.note, f"Speaker recognition ran on {diarization_device.upper()}.{fallback_note}"),
        speaker_summary=_speaker_summary(segments),
        segments=segments,
        warnings=result.warnings,
    )


def _combine_notes(*notes: str | None) -> str | None:
    cleaned = [note.strip() for note in notes if note and note.strip()]
    if not cleaned:
        return None
    return " ".join(cleaned)


def _resolve_pyannote_device(requested_device: str) -> str:
    """Choose pyannote's device from the PyTorch runtime, not faster-whisper's CTranslate2 device."""
    normalized = requested_device.strip().lower()
    if normalized != "cuda":
        return "cpu"
    configure_ml_runtime_environment()
    try:
        import torch
    except Exception:
        return "cpu"
    try:
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"
