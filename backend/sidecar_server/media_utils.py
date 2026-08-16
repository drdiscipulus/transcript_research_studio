from __future__ import annotations

import contextlib
import importlib
import os
import wave
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(slots=True)
class MediaMetadata:
    duration_seconds: float | None
    media_kind: str
    container_format: str | None
    is_valid: bool = True
    has_audio: bool = True
    error_code: str | None = None
    error_message: str | None = None


def probe_media_metadata(path: Path, *, stat_result: os.stat_result | None = None) -> MediaMetadata:
    normalized_path = path.expanduser()
    cache_key = _metadata_cache_key(normalized_path, stat_result)
    if cache_key is None:
        return _probe_media_metadata_uncached(normalized_path)

    (
        duration_seconds,
        media_kind,
        container_format,
        is_valid,
        has_audio,
        error_code,
        error_message,
    ) = _probe_media_metadata_cached(*cache_key)
    return MediaMetadata(
        duration_seconds=duration_seconds,
        media_kind=media_kind,
        container_format=container_format,
        is_valid=is_valid,
        has_audio=has_audio,
        error_code=error_code,
        error_message=error_message,
    )


def _metadata_cache_key(
    path: Path,
    stat_result: os.stat_result | None,
) -> tuple[str, int, int] | None:
    current_stat = stat_result
    if current_stat is None:
        with contextlib.suppress(OSError):
            current_stat = path.stat()

    if current_stat is None:
        return None

    modified_at_ns = getattr(current_stat, "st_mtime_ns", int(current_stat.st_mtime * 1_000_000_000))
    return (str(path.resolve(strict=False)), int(modified_at_ns), int(current_stat.st_size))


@lru_cache(maxsize=2048)
def _probe_media_metadata_cached(
    path_value: str,
    modified_at_ns: int,
    size_bytes: int,
) -> tuple[float | None, str, str | None, bool, bool, str | None, str | None]:
    # The cache key includes file size and modified time so repeated scans over
    # unchanged media files can reuse the same probe result safely.
    _ = modified_at_ns, size_bytes
    metadata = _probe_media_metadata_uncached(Path(path_value))
    return (
        metadata.duration_seconds,
        metadata.media_kind,
        metadata.container_format,
        metadata.is_valid,
        metadata.has_audio,
        metadata.error_code,
        metadata.error_message,
    )


def _probe_media_metadata_uncached(path: Path) -> MediaMetadata:
    try:
        if path.stat().st_size == 0:
            return _invalid_media("empty_file", "The file is empty and cannot be transcribed.")
    except OSError:
        return _invalid_media("unreadable_file", "The file could not be read.")

    metadata, pyav_available = _probe_with_pyav(path)
    if metadata is not None:
        return metadata

    if path.suffix.lower() == ".wav":
        return _probe_wave_metadata(path)

    if not pyav_available:
        return _invalid_media(
            "media_probe_unavailable",
            "Media validation is unavailable because the bundled media reader could not be loaded.",
        )
    return _invalid_media("unreadable_media", "The file could not be opened as supported media.")


def _probe_with_pyav(path: Path) -> tuple[MediaMetadata | None, bool]:
    try:
        av = importlib.import_module("av")
    except (ImportError, OSError):
        return None, False

    try:
        with av.open(str(path)) as container:
            duration_seconds = _container_duration_seconds(container)
            stream_types = {stream.type for stream in container.streams}
            media_kind = _media_kind_label(stream_types)
            container_format = getattr(getattr(container, "format", None), "name", None)
            has_audio = "audio" in stream_types
            return MediaMetadata(
                duration_seconds=duration_seconds,
                media_kind=media_kind,
                container_format=container_format,
                is_valid=has_audio,
                has_audio=has_audio,
                error_code=None if has_audio else "no_audio_stream",
                error_message=None if has_audio else "The media file does not contain an audio stream.",
            ), True
    except Exception:
        # Media libraries use several exception families for malformed and
        # truncated containers (including EOFError). A probe result must never
        # be allowed to abort a whole folder scan.
        return None, True


def _container_duration_seconds(container: object) -> float | None:
    duration = getattr(container, "duration", None)
    if duration is not None:
        with contextlib.suppress(TypeError, ValueError):
            return float(duration / 1_000_000)

    streams = getattr(container, "streams", [])
    stream_durations: list[float] = []
    for stream in streams:
        stream_duration = getattr(stream, "duration", None)
        time_base = getattr(stream, "time_base", None)
        if stream_duration is None or time_base is None:
            continue
        with contextlib.suppress(TypeError, ValueError, ZeroDivisionError):
            stream_durations.append(float(stream_duration * time_base))

    if stream_durations:
        return max(stream_durations)
    return None


def _media_kind_label(stream_types: set[str]) -> str:
    has_audio = "audio" in stream_types
    has_video = "video" in stream_types
    if has_audio and has_video:
        return "audio/video"
    if has_video:
        return "video"
    if has_audio:
        return "audio"
    return "media"


def _probe_wave_metadata(path: Path) -> MediaMetadata:
    try:
        with wave.open(str(path), "rb") as wav_file:
            frame_rate = wav_file.getframerate()
            duration_seconds = wav_file.getnframes() / float(frame_rate) if frame_rate else None
            return MediaMetadata(
                duration_seconds=duration_seconds,
                media_kind="audio",
                container_format="wav",
                is_valid=True,
                has_audio=True,
            )
    except Exception:
        return _invalid_media("unreadable_media", "The file could not be opened as supported media.")
def _invalid_media(code: str, message: str) -> MediaMetadata:
    return MediaMetadata(
        duration_seconds=None,
        media_kind="media",
        container_format=None,
        is_valid=False,
        has_audio=False,
        error_code=code,
        error_message=message,
    )
