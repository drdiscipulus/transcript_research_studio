from __future__ import annotations

import contextlib
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .media_utils import probe_media_metadata


IGNORED_FILE_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SUPPORTED_MEDIA_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".avi",
    ".flac",
    ".m4a",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}
MAX_TRANSCRIPTION_FILE_COUNT = 1000
MAX_TRANSCRIPTION_FILE_BYTES = 8 * 1024**3
MAX_TRANSCRIPTION_BATCH_BYTES = 64 * 1024**3


@dataclass(slots=True)
class ScanItem:
    file_name: str
    extension: str
    size_bytes: int
    modified_at: str
    duration_seconds: float | None
    duration_label: str
    file_info: str
    source_path: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ScanExclusion:
    file_name: str
    source_path: str
    extension: str
    size_bytes: int
    code: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ScanPreview:
    input_folder: str
    file_count: int
    total_duration_seconds: float | None
    total_duration_label: str
    duration_status: str
    is_empty: bool
    message: str
    files: list[ScanItem]
    input_source_type: str = "folder"
    input_path: str = ""
    excluded_count: int = 0
    excluded_files: list[ScanExclusion] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["files"] = [item.to_dict() for item in self.files]
        payload["excluded_files"] = [item.to_dict() for item in self.excluded_files]
        return payload


def scan_input_folder(input_folder: str) -> ScanPreview:
    path = Path(input_folder).expanduser()
    if not path.exists():
        return ScanPreview(
            input_folder=str(path),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 files",
            duration_status="empty",
            is_empty=True,
            message="Input folder does not exist yet.",
            files=[],
        )

    if not path.is_dir():
        return ScanPreview(
            input_folder=str(path),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="Unavailable",
            duration_status="invalid",
            is_empty=True,
            message="Selected input path is not a folder.",
            files=[],
        )

    candidates: list[tuple[Path, os.stat_result]] = []
    excluded_files: list[ScanExclusion] = []
    total_size_bytes = 0

    # Fail fast on obviously oversized folders before media probing so users
    # get a clear split-this-up message instead of a long-running scan.
    for entry in sorted(path.iterdir(), key=lambda item: item.name.lower()):
        if should_ignore_entry(entry):
            continue
        if entry.suffix.lower() not in SUPPORTED_MEDIA_EXTENSIONS:
            continue

        try:
            if not entry.is_file():
                continue
            stat_result = entry.stat()
        except OSError:
            excluded_files.append(
                scan_exclusion(
                    entry,
                    size_bytes=0,
                    code="unreadable_file",
                    message="The file could not be read.",
                )
            )
            continue
        file_size = stat_result.st_size
        if file_size > MAX_TRANSCRIPTION_FILE_BYTES:
            return blocked_scan_preview(
                input_folder=path,
                message=(
                    f"{entry.name} is {format_size(file_size)}. "
                    f"The current per-file limit is {format_size(MAX_TRANSCRIPTION_FILE_BYTES)}. "
                    "Split very large recordings before starting transcription."
                ),
            )

        candidates.append((entry, stat_result))
        total_size_bytes += file_size

        if len(candidates) > MAX_TRANSCRIPTION_FILE_COUNT:
            return blocked_scan_preview(
                input_folder=path,
                message=(
                    f"This folder contains more than {MAX_TRANSCRIPTION_FILE_COUNT} supported media files. "
                    "Split the folder into smaller batches before starting transcription."
                ),
            )

        if total_size_bytes > MAX_TRANSCRIPTION_BATCH_BYTES:
            return blocked_scan_preview(
                input_folder=path,
                message=(
                    f"The supported media in this folder add up to more than {format_size(MAX_TRANSCRIPTION_BATCH_BYTES)}. "
                    "Split the folder into smaller batches before starting transcription."
                ),
            )

    files: list[ScanItem] = []
    known_duration_total = 0.0
    missing_duration_count = 0

    # Scan only the top-level folder. The desktop workflow stays deliberately
    # non-recursive so users can predict exactly which files will be processed.
    for entry, stat_result in candidates:
        try:
            media_metadata = probe_media_metadata(entry, stat_result=stat_result)
        except Exception:
            excluded_files.append(
                scan_exclusion(
                    entry,
                    size_bytes=stat_result.st_size,
                    code="media_probe_failed",
                    message="The file could not be validated as media.",
                )
            )
            continue

        validation_error = media_validation_error(media_metadata)
        if validation_error is not None:
            code, message = validation_error
            excluded_files.append(
                scan_exclusion(
                    entry,
                    size_bytes=stat_result.st_size,
                    code=code,
                    message=message,
                )
            )
            continue

        duration_seconds = media_metadata.duration_seconds
        if duration_seconds is None:
            missing_duration_count += 1
        else:
            known_duration_total += duration_seconds

        file_info_label = build_file_info_label(
            path=entry,
            size_bytes=stat_result.st_size,
            media_kind=media_metadata.media_kind,
        )

        files.append(
            ScanItem(
                file_name=entry.name,
                extension=entry.suffix.lower().lstrip("."),
                size_bytes=stat_result.st_size,
                modified_at=datetime.fromtimestamp(stat_result.st_mtime).isoformat(timespec="seconds"),
                duration_seconds=duration_seconds,
                duration_label=format_duration(duration_seconds),
                file_info=file_info_label,
                source_path=str(entry.resolve()),
            )
        )

    if not files:
        if excluded_files:
            return ScanPreview(
                input_folder=str(path),
                file_count=0,
                total_duration_seconds=None,
                total_duration_label=f"0 ready · {len(excluded_files)} excluded",
                duration_status="invalid",
                is_empty=True,
                message="No transcribable media files were found. Review the excluded files.",
                files=[],
                input_source_type="folder",
                input_path=str(path),
                excluded_count=len(excluded_files),
                excluded_files=excluded_files,
            )
        return ScanPreview(
            input_folder=str(path),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 files",
            duration_status="empty",
            is_empty=True,
            message="No media files found in this folder.",
            files=[],
        )

    if missing_duration_count == 0:
        total_duration_seconds: float | None = known_duration_total
        total_duration_label = format_duration(known_duration_total)
        duration_status = "available"
        message = "Folder scanned successfully."
    elif missing_duration_count == len(files):
        total_duration_seconds = None
        total_duration_label = "Duration unavailable"
        duration_status = "unavailable"
        message = "Media files found, but duration could not be read for this set."
    else:
        total_duration_seconds = known_duration_total
        total_duration_label = f"{format_duration(known_duration_total)} known"
        duration_status = "partial"
        message = "Some file durations were detected, but a few files could not be probed yet."

    if excluded_files:
        message = f"{message} {len(excluded_files)} invalid or unusable media file(s) were excluded."

    return ScanPreview(
        input_folder=str(path),
        file_count=len(files),
        total_duration_seconds=total_duration_seconds,
        total_duration_label=total_duration_label,
        duration_status=duration_status,
        is_empty=False,
        message=message,
        files=files,
        input_source_type="folder",
        input_path=str(path),
        excluded_count=len(excluded_files),
        excluded_files=excluded_files,
    )


def scan_input_source(input_source_type: str, input_path: str) -> ScanPreview:
    normalized_type = str(input_source_type or "folder").strip().lower()
    if normalized_type == "single_file":
        return scan_input_file(input_path)
    return scan_input_folder(input_path)


def scan_input_file(input_file: str) -> ScanPreview:
    path = Path(input_file).expanduser()
    parent = path.parent if path.parent != Path("") else Path.cwd()
    if not path.exists():
        return ScanPreview(
            input_folder=str(parent),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 files",
            duration_status="empty",
            is_empty=True,
            message="Input media file does not exist yet.",
            files=[],
            input_source_type="single_file",
            input_path=str(path),
        )

    if not path.is_file():
        return ScanPreview(
            input_folder=str(path),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="Unavailable",
            duration_status="invalid",
            is_empty=True,
            message="Selected input path is not a media file.",
            files=[],
            input_source_type="single_file",
            input_path=str(path),
        )

    if should_ignore_entry(path) or path.suffix.lower() not in SUPPORTED_MEDIA_EXTENSIONS:
        return ScanPreview(
            input_folder=str(parent),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 files",
            duration_status="empty",
            is_empty=True,
            message="Selected file is not a supported audio or video file.",
            files=[],
            input_source_type="single_file",
            input_path=str(path),
        )

    try:
        stat_result = path.stat()
    except OSError:
        exclusion = scan_exclusion(
            path,
            size_bytes=0,
            code="unreadable_file",
            message="The file could not be read.",
        )
        return ScanPreview(
            input_folder=str(parent),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 ready · 1 excluded",
            duration_status="invalid",
            is_empty=True,
            message=exclusion.message,
            files=[],
            input_source_type="single_file",
            input_path=str(path),
            excluded_count=1,
            excluded_files=[exclusion],
        )
    if stat_result.st_size > MAX_TRANSCRIPTION_FILE_BYTES:
        return blocked_scan_preview(
            input_folder=parent,
            message=(
                f"{path.name} is {format_size(stat_result.st_size)}. "
                f"The current per-file limit is {format_size(MAX_TRANSCRIPTION_FILE_BYTES)}. "
                "Split very large recordings before starting transcription."
            ),
            input_source_type="single_file",
            input_path=str(path),
        )

    try:
        media_metadata = probe_media_metadata(path, stat_result=stat_result)
    except Exception:
        media_metadata = None

    validation_error = (
        media_validation_error(media_metadata)
        if media_metadata is not None
        else ("media_probe_failed", "The file could not be validated as media.")
    )
    if validation_error is not None:
        code, message = validation_error
        exclusion = scan_exclusion(path, size_bytes=stat_result.st_size, code=code, message=message)
        return ScanPreview(
            input_folder=str(parent),
            file_count=0,
            total_duration_seconds=None,
            total_duration_label="0 ready · 1 excluded",
            duration_status="invalid",
            is_empty=True,
            message=message,
            files=[],
            input_source_type="single_file",
            input_path=str(path),
            excluded_count=1,
            excluded_files=[exclusion],
        )

    assert media_metadata is not None
    duration_seconds = media_metadata.duration_seconds
    file_info_label = build_file_info_label(
        path=path,
        size_bytes=stat_result.st_size,
        media_kind=media_metadata.media_kind,
    )
    scan_item = ScanItem(
        file_name=path.name,
        extension=path.suffix.lower().lstrip("."),
        size_bytes=stat_result.st_size,
        modified_at=datetime.fromtimestamp(stat_result.st_mtime).isoformat(timespec="seconds"),
        duration_seconds=duration_seconds,
        duration_label=format_duration(duration_seconds),
        file_info=file_info_label,
        source_path=str(path.resolve()),
    )
    return ScanPreview(
        input_folder=str(parent),
        file_count=1,
        total_duration_seconds=duration_seconds,
        total_duration_label=format_duration(duration_seconds),
        duration_status="available" if duration_seconds is not None else "unavailable",
        is_empty=False,
        message="Media file selected successfully.",
        files=[scan_item],
        input_source_type="single_file",
        input_path=str(path),
    )


def blocked_scan_preview(
    *,
    input_folder: Path,
    message: str,
    input_source_type: str = "folder",
    input_path: str = "",
) -> ScanPreview:
    return ScanPreview(
        input_folder=str(input_folder),
        file_count=0,
        total_duration_seconds=None,
        total_duration_label="Guardrail triggered",
        duration_status="blocked",
        is_empty=True,
        message=message,
        files=[],
        input_source_type=input_source_type,
        input_path=input_path,
    )


def should_ignore_entry(entry: Path) -> bool:
    name = entry.name
    if name in IGNORED_FILE_NAMES or name.startswith("."):
        return True

    if os.name == "nt":
        with contextlib.suppress(AttributeError, OSError):
            stat_result = entry.stat()
            hidden_flag = getattr(stat_result, "st_file_attributes", 0) & 2
            if hidden_flag:
                return True
    return False


def media_validation_error(media_metadata: Any) -> tuple[str, str] | None:
    media_kind = str(getattr(media_metadata, "media_kind", "media") or "media")
    has_audio = bool(getattr(media_metadata, "has_audio", media_kind in {"audio", "audio/video"}))
    is_valid = bool(getattr(media_metadata, "is_valid", True))
    if is_valid and has_audio:
        return None

    code = str(getattr(media_metadata, "error_code", "") or "").strip()
    message = str(getattr(media_metadata, "error_message", "") or "").strip()
    if not has_audio and not code:
        code = "no_audio_stream"
    if not message:
        message = (
            "The media file does not contain an audio stream."
            if code == "no_audio_stream"
            else "The file could not be opened as supported media."
        )
    return code or "unreadable_media", message


def scan_exclusion(
    path: Path,
    *,
    size_bytes: int,
    code: str,
    message: str,
) -> ScanExclusion:
    return ScanExclusion(
        file_name=path.name,
        source_path=str(path.resolve(strict=False)),
        extension=path.suffix.lower().lstrip("."),
        size_bytes=max(0, int(size_bytes)),
        code=code,
        message=message,
    )


def format_duration(value: float | None) -> str:
    if value is None:
        return "Unavailable"
    total_seconds = max(0, int(round(value)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:d}:{seconds:02d}"


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(size_bytes)
    unit = units[0]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            break
        value /= 1024
    if unit == "B":
        return f"{int(value)} {unit}"
    return f"{value:.1f} {unit}"


def build_file_info_label(*, path: Path, size_bytes: int, media_kind: str) -> str:
    extension_label = path.suffix.lower().lstrip(".").upper()
    if media_kind == "media":
        return f"{extension_label} • {format_size(size_bytes)}"
    return f"{extension_label} {media_kind} • {format_size(size_bytes)}"
