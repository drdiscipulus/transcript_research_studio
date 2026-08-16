from __future__ import annotations

import contextlib
import fnmatch
import importlib
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .app_paths import huggingface_hub_cache
from .transcription_types import ModelDownloadCancelled, TranscriptionConfigurationError


_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_MODEL_CACHE_LOCK = threading.Lock()
_HF_DOWNLOAD_PATCH_LOCK = threading.Lock()
_MODEL_REPOSITORIES = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}
_MODEL_LABELS = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large-v3": "large-v3",
    "large-v3-turbo": "large-v3-turbo",
}
_MODEL_ALLOW_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]
_REQUIRED_MODEL_FILES = ("config.json", "model.bin", "tokenizer.json")


@dataclass(frozen=True, slots=True)
class ModelSnapshotStatus:
    availability: str
    missing_files: tuple[str, ...]
    snapshot_path: Path | None


def ensure_faster_whisper_model_available(
    model_name: str,
    progress_callback: Callable[[int, int, str | None], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
) -> None:
    normalized_model = model_name.strip().lower() or "small"
    raise_if_model_download_cancelled(cancel_requested)
    if is_model_cached_locally(normalized_model):
        if progress_callback:
            progress_callback(1, 1, None)
        return

    repo_id = _MODEL_REPOSITORIES.get(normalized_model)
    if repo_id is None:
        raise TranscriptionConfigurationError(f"Unsupported faster-whisper model: {normalized_model}")

    huggingface_hub = importlib.import_module("huggingface_hub")
    importlib.import_module("tqdm.auto")
    dry_run_entries = snapshot_download_dry_run(
        huggingface_hub=huggingface_hub,
        repo_id=repo_id,
    )
    if dry_run_entries is None:
        metadata_entries = model_download_entries_from_metadata(
            huggingface_hub=huggingface_hub,
            repo_id=repo_id,
        )
        if metadata_entries:
            download_model_with_metadata_progress(
                huggingface_hub=huggingface_hub,
                repo_id=repo_id,
                entries=metadata_entries,
                progress_callback=progress_callback,
                cancel_requested=cancel_requested,
            )
            _require_downloaded_model_ready(normalized_model)
            return
        huggingface_hub.snapshot_download(repo_id, allow_patterns=_MODEL_ALLOW_PATTERNS)
        if progress_callback:
            progress_callback(1, 1, None)
        _require_downloaded_model_ready(normalized_model)
        return
    pending_entries = [entry for entry in dry_run_entries if getattr(entry, "will_download", False)]
    total_bytes = sum(max(int(getattr(entry, "file_size", 0) or 0), 0) for entry in pending_entries)

    if total_bytes <= 0:
        huggingface_hub.snapshot_download(repo_id, allow_patterns=_MODEL_ALLOW_PATTERNS)
        if progress_callback:
            progress_callback(1, 1, None)
        _require_downloaded_model_ready(normalized_model)
        return

    downloaded_bytes = 0

    for entry in pending_entries:
        raise_if_model_download_cancelled(cancel_requested)
        filename = str(getattr(entry, "filename", "model.bin"))
        expected_size = max(int(getattr(entry, "file_size", 0) or 0), 1)
        downloaded_bytes = download_model_file(
            huggingface_hub=huggingface_hub,
            repo_id=repo_id,
            filename=filename,
            file_size=expected_size,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            progress_callback=progress_callback,
            cancel_requested=cancel_requested,
        )

    if progress_callback:
        progress_callback(total_bytes, total_bytes, None)
    _require_downloaded_model_ready(normalized_model)


def get_or_create_model(*, faster_whisper: Any, model_name: str, device: str, compute_type: str) -> Any:
    cache_key = (model_name, device, compute_type)
    with _MODEL_CACHE_LOCK:
        model = _MODEL_CACHE.get(cache_key)
        if model is None:
            snapshot_path = resolve_faster_whisper_model_snapshot(model_name)
            model = faster_whisper.WhisperModel(
                str(snapshot_path),
                device=device,
                compute_type=compute_type,
                local_files_only=True,
            )
            _MODEL_CACHE[cache_key] = model
        return model


def is_model_cached_locally(model_name: str) -> bool:
    return inspect_faster_whisper_model(model_name).availability == "ready"


def inspect_faster_whisper_model(model_name: str) -> ModelSnapshotStatus:
    normalized_model = model_name.strip().lower()
    if normalized_model not in _MODEL_REPOSITORIES:
        return ModelSnapshotStatus("missing", _REQUIRED_MODEL_FILES + ("vocabulary.*",), None)

    candidates: list[Path] = []
    for model_root in faster_whisper_model_roots(normalized_model):
        snapshots_dir = model_root / "snapshots"
        if not snapshots_dir.is_dir():
            continue
        with contextlib.suppress(OSError):
            candidates.extend(path for path in snapshots_dir.iterdir() if path.is_dir())

    if not candidates:
        return ModelSnapshotStatus("missing", _REQUIRED_MODEL_FILES + ("vocabulary.*",), None)

    def modified_at(path: Path) -> int:
        with contextlib.suppress(OSError):
            return path.stat().st_mtime_ns
        return 0

    best_missing: tuple[str, ...] = _REQUIRED_MODEL_FILES + ("vocabulary.*",)
    best_path: Path | None = None
    for snapshot in sorted(candidates, key=modified_at, reverse=True):
        missing = _missing_snapshot_files(snapshot)
        if not missing:
            return ModelSnapshotStatus("ready", (), snapshot.resolve())
        if best_path is None or len(missing) < len(best_missing):
            best_path = snapshot
            best_missing = missing
    return ModelSnapshotStatus("incomplete", best_missing, best_path.resolve() if best_path else None)


def resolve_faster_whisper_model_snapshot(model_name: str) -> Path:
    status = inspect_faster_whisper_model(model_name)
    if status.availability != "ready" or status.snapshot_path is None:
        detail = f" Missing: {', '.join(status.missing_files)}." if status.missing_files else ""
        raise TranscriptionConfigurationError(
            f"The faster-whisper model '{model_name}' is {status.availability}.{detail} Open Models and download or repair it."
        )
    return status.snapshot_path


def _missing_snapshot_files(snapshot: Path) -> tuple[str, ...]:
    missing = [name for name in _REQUIRED_MODEL_FILES if not _non_empty_file(snapshot / name)]
    vocabulary_ready = False
    with contextlib.suppress(OSError):
        vocabulary_ready = any(_non_empty_file(path) for path in snapshot.glob("vocabulary.*"))
    if not vocabulary_ready:
        missing.append("vocabulary.*")
    return tuple(missing)


def _non_empty_file(path: Path) -> bool:
    with contextlib.suppress(OSError):
        return path.is_file() and path.stat().st_size > 0
    return False


def _require_downloaded_model_ready(model_name: str) -> None:
    status = inspect_faster_whisper_model(model_name)
    if status.availability == "ready":
        return
    raise TranscriptionConfigurationError(
        f"The downloaded model '{model_name}' is incomplete. Missing: {', '.join(status.missing_files)}. Use Repair to finish the download."
    )


def faster_whisper_model_statuses() -> list[dict[str, Any]]:
    return [
        faster_whisper_model_status(model_name)
        for model_name in _MODEL_REPOSITORIES
    ]


def download_faster_whisper_model(
    model_name: str,
    progress_callback: Callable[[int, int, str | None], None] | None = None,
) -> dict[str, Any]:
    normalized_model = model_name.strip().lower()
    if normalized_model not in _MODEL_REPOSITORIES:
        raise ValueError(f"Unsupported faster-whisper model: {normalized_model}")

    ensure_faster_whisper_model_available(normalized_model, progress_callback=progress_callback)
    return {"model": faster_whisper_model_status(normalized_model)}


def delete_faster_whisper_model(model_name: str) -> dict[str, Any]:
    normalized_model = model_name.strip().lower()
    if normalized_model not in _MODEL_REPOSITORIES:
        raise ValueError(f"Unsupported faster-whisper model: {normalized_model}")

    deleted_paths: list[str] = []
    for model_root in faster_whisper_model_roots(normalized_model):
        if not model_root.exists():
            continue
        shutil.rmtree(model_root)
        deleted_paths.append(str(model_root))

    with _MODEL_CACHE_LOCK:
        stale_keys = [cache_key for cache_key in _MODEL_CACHE if cache_key[0] == normalized_model]
        for cache_key in stale_keys:
            _MODEL_CACHE.pop(cache_key, None)

    return {
        "model": faster_whisper_model_status(normalized_model),
        "deleted_paths": deleted_paths,
    }


def faster_whisper_model_status(model_name: str) -> dict[str, Any]:
    repo_id = _MODEL_REPOSITORIES[model_name]
    snapshot_status = inspect_faster_whisper_model(model_name)
    return {
        "value": model_name,
        "label": _MODEL_LABELS.get(model_name, model_name),
        "repo_id": repo_id,
        "installed": snapshot_status.availability == "ready",
        "availability": snapshot_status.availability,
        "missing_files": list(snapshot_status.missing_files),
    }


def faster_whisper_model_roots(model_name: str) -> list[Path]:
    repo_id = _MODEL_REPOSITORIES.get(model_name)
    if not repo_id:
        return []
    owner, name = repo_id.split("/", 1)
    cache_folder_name = f"models--{owner}--{name}"
    return [cache_root / cache_folder_name for cache_root in huggingface_cache_roots()]


def snapshot_download_dry_run(*, huggingface_hub: Any, repo_id: str) -> list[Any] | None:
    try:
        return huggingface_hub.snapshot_download(
            repo_id,
            allow_patterns=_MODEL_ALLOW_PATTERNS,
            dry_run=True,
        )
    except TypeError:
        # Older huggingface_hub builds do not support dry_run. Fall back to the
        # real download path without byte-level progress rather than blocking
        # explicit model downloads in packaged runtimes.
        return None


def model_download_entries_from_metadata(*, huggingface_hub: Any, repo_id: str) -> list[dict[str, Any]]:
    api_type = getattr(huggingface_hub, "HfApi", None)
    if api_type is None:
        return []
    try:
        info = api_type().model_info(repo_id, files_metadata=True)
    except Exception:
        return []
    siblings = getattr(info, "siblings", None)
    if not isinstance(siblings, list):
        return []

    entries: list[dict[str, Any]] = []
    for sibling in siblings:
        filename = str(getattr(sibling, "rfilename", "") or "").strip()
        if not filename:
            continue
        if not any(fnmatch.fnmatch(filename, pattern) for pattern in _MODEL_ALLOW_PATTERNS):
            continue
        entries.append(
            {
                "filename": filename,
                "size": max(int(getattr(sibling, "size", 0) or 0), 0),
            }
        )
    return entries


def download_model_with_metadata_progress(
    *,
    huggingface_hub: Any,
    repo_id: str,
    entries: list[dict[str, Any]],
    progress_callback: Callable[[int, int, str | None], None] | None,
    cancel_requested: Callable[[], bool] | None,
) -> None:
    total_bytes = sum(max(int(entry.get("size", 0) or 0), 0) for entry in entries)
    downloaded_bytes = 0

    for entry in entries:
        raise_if_model_download_cancelled(cancel_requested)
        filename = str(entry.get("filename") or "model.bin")
        file_size = max(int(entry.get("size", 0) or 0), 0)
        downloaded_bytes = download_model_file(
            huggingface_hub=huggingface_hub,
            repo_id=repo_id,
            filename=filename,
            file_size=file_size,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
            progress_callback=progress_callback,
            cancel_requested=cancel_requested,
        )

    if progress_callback:
        progress_callback(total_bytes, total_bytes, None)


def download_model_file(
    *,
    huggingface_hub: Any,
    repo_id: str,
    filename: str,
    file_size: int,
    downloaded_bytes: int,
    total_bytes: int,
    progress_callback: Callable[[int, int, str | None], None] | None,
    cancel_requested: Callable[[], bool] | None,
) -> int:
    current_file_bytes = 0

    if progress_callback:
        progress_callback(downloaded_bytes, total_bytes, filename)

    def handle_chunk_progress(chunk_size: int) -> None:
        nonlocal current_file_bytes
        current_file_bytes += max(int(chunk_size), 0)
        if progress_callback:
            capped_bytes = current_file_bytes if file_size <= 0 else min(current_file_bytes, file_size)
            progress_callback(downloaded_bytes + capped_bytes, total_bytes, filename)

    progress_bar = CancellationAwareProgressBar(
        on_progress=handle_chunk_progress,
        cancel_requested=cancel_requested,
    )

    with patched_hf_download_progress(huggingface_hub=huggingface_hub, progress_bar=progress_bar):
        huggingface_hub.hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            force_download=False,
        )

    final_file_bytes = file_size if file_size > 0 else current_file_bytes
    final_downloaded_bytes = downloaded_bytes + final_file_bytes
    if progress_callback:
        progress_callback(final_downloaded_bytes, total_bytes, filename)
    return final_downloaded_bytes


class CancellationAwareProgressBar:
    def __init__(
        self,
        *,
        on_progress: Callable[[int], None],
        cancel_requested: Callable[[], bool] | None,
    ) -> None:
        self._on_progress = on_progress
        self._cancel_requested = cancel_requested

    def update(self, n: int = 1) -> None:
        raise_if_model_download_cancelled(self._cancel_requested)
        self._on_progress(n)

    def close(self) -> None:
        return


@contextlib.contextmanager
def patched_hf_download_progress(*, huggingface_hub: Any, progress_bar: CancellationAwareProgressBar):
    file_download = importlib.import_module("huggingface_hub.file_download")
    original_http_get = file_download.http_get
    original_xet_get = getattr(file_download, "xet_get", None)

    def patched_http_get(url: str, temp_file: Any, **kwargs: Any) -> Any:
        kwargs["_tqdm_bar"] = progress_bar
        return original_http_get(url, temp_file, **kwargs)

    def patched_xet_get(**kwargs: Any) -> Any:
        if original_xet_get is None:
            raise RuntimeError("xet_get is not available in this Hugging Face runtime.")
        kwargs["_tqdm_bar"] = progress_bar
        return original_xet_get(**kwargs)

    with _HF_DOWNLOAD_PATCH_LOCK:
        file_download.http_get = patched_http_get
        if original_xet_get is not None:
            file_download.xet_get = patched_xet_get
        try:
            yield
        finally:
            file_download.http_get = original_http_get
            if original_xet_get is not None:
                file_download.xet_get = original_xet_get


def raise_if_model_download_cancelled(cancel_requested: Callable[[], bool] | None) -> None:
    if cancel_requested and cancel_requested():
        raise ModelDownloadCancelled("Model download was cancelled by the user.")


def huggingface_cache_roots() -> list[Path]:
    return [huggingface_hub_cache()]
