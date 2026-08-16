from __future__ import annotations

import contextlib
import ctypes
import importlib
import importlib.util
import os
import json
import platform
import sys
import threading
from functools import lru_cache
from pathlib import Path

from .app_paths import ensure_app_runtime_directories

_DLL_DIRECTORY_HANDLES: list[object] = []
_RUNTIME_ENV_CONFIGURED = False
_RUNTIME_ENV_LOCK = threading.Lock()


def configure_ml_runtime_environment() -> None:
    global _RUNTIME_ENV_CONFIGURED
    if _RUNTIME_ENV_CONFIGURED:
        return
    # Hardware detection and normal requests may initialize ML concurrently.
    # The configured flag is published only after the complete environment is usable.
    with _RUNTIME_ENV_LOCK:
        if _RUNTIME_ENV_CONFIGURED:
            return

        runtime_paths = ensure_app_runtime_directories()
        os.environ["HF_HOME"] = str(runtime_paths["huggingface_home"])
        os.environ["HF_HUB_CACHE"] = str(runtime_paths["huggingface_hub_cache"])

        for directory in _runtime_dll_directories():
            _activate_windows_dll_directory(directory)

        _RUNTIME_ENV_CONFIGURED = True


def _runtime_dll_directories() -> list[Path]:
    return _candidate_windows_dll_directories() if os.name == "nt" else []


@lru_cache(maxsize=1)
def probe_cuda_runtime() -> bool:
    configure_ml_runtime_environment()
    try:
        ctranslate2 = importlib.import_module("ctranslate2")
    except Exception:
        return False

    get_device_count = getattr(ctranslate2, "get_cuda_device_count", None)
    if not callable(get_device_count):
        return False

    try:
        if int(get_device_count()) < 1:
            return False
    except Exception:
        return False

    if os.name == "nt":
        try:
            ctypes.WinDLL("cublas64_12.dll")
            ctypes.WinDLL("cublasLt64_12.dll")
        except OSError:
            return False

    return True


@lru_cache(maxsize=1)
def probe_speaker_runtime() -> dict[str, bool | str]:
    configure_ml_runtime_environment()
    torch_available = False
    pyannote_available = False
    torch_cuda_available = False
    torch_cuda_version = ""
    try:
        torch = importlib.import_module("torch")
        torch_available = True
        torch_cuda_available = bool(torch.cuda.is_available())
        torch_cuda_version = str(getattr(getattr(torch, "version", None), "cuda", "") or "")
    except Exception:
        torch = None

    # Importing pyannote.audio loads its complete audio stack, including
    # TorchCodec discovery. Hardware detection only needs to know whether the
    # qualified runtime contains pyannote; the diarization workflow performs
    # the authoritative import when it is actually used.
    try:
        pyannote_available = importlib.util.find_spec("pyannote.audio") is not None
    except (ImportError, AttributeError, ValueError):
        pyannote_available = False

    return {
        "torch_available": torch_available,
        "pyannote_available": pyannote_available,
        "torch_cuda_available": torch_cuda_available,
        "torch_cuda_version": torch_cuda_version,
    }


@lru_cache(maxsize=1)
def detect_runtime_variant() -> str:
    configured = os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_RUNTIME_VARIANT", "").strip().lower()
    if configured in {"windows-cpu", "windows-gpu", "macos-cpu", "dev"}:
        return configured

    manifest = _read_bundle_manifest()
    windows_variant = str(manifest.get("windows_runtime_variant") or "").strip().lower()
    if windows_variant == "cpu":
        return "windows-cpu"
    if windows_variant in {"cuda", "gpu"}:
        return "windows-gpu"
    if platform.system() == "Darwin" and manifest:
        return "macos-cpu"
    return "dev"


def _read_bundle_manifest() -> dict[str, object]:
    resource_dir = os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_RESOURCE_DIR", "").strip()
    if not resource_dir:
        return {}
    manifest_path = Path(resource_dir) / "bundle-manifest.json"
    if not manifest_path.is_file():
        return {}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _candidate_windows_dll_directories() -> list[Path]:
    candidates: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        normalized = str(path.resolve())
        if normalized in seen or not path.is_dir():
            return
        seen.add(normalized)
        candidates.append(path)

    for site_packages_root in _site_packages_roots():
        add(site_packages_root / "torch" / "lib")

    with contextlib.suppress(Exception):
        spec = importlib.util.find_spec("ctranslate2")
        origin = getattr(spec, "origin", None)
        if origin:
            add(Path(origin).resolve().parent)

    for site_packages_root in _site_packages_roots():
        nvidia_root = site_packages_root / "nvidia"
        add(nvidia_root / "cublas" / "bin")
        add(nvidia_root / "cuda_nvrtc" / "bin")
        add(nvidia_root / "cuda_runtime" / "bin")
        add(nvidia_root / "cudnn" / "bin")

    return candidates


def _site_packages_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        normalized = str(path.resolve())
        if normalized in seen or not path.is_dir():
            return
        seen.add(normalized)
        roots.append(path)

    for entry in sys.path:
        if not entry:
            continue
        with contextlib.suppress(OSError):
            path = Path(entry).resolve()
            if path.name.lower() == "site-packages":
                add(path)

    add(Path(sys.prefix) / "Lib" / "site-packages")
    return roots


def _activate_windows_dll_directory(path: Path) -> None:
    current_path = os.environ.get("PATH", "")
    path_parts = [part for part in current_path.split(os.pathsep) if part]
    normalized_parts = {part.lower() for part in path_parts}
    directory = str(path)

    if directory.lower() not in normalized_parts:
        os.environ["PATH"] = directory if not current_path else f"{directory}{os.pathsep}{current_path}"

    add_dll_directory = getattr(os, "add_dll_directory", None)
    if callable(add_dll_directory):
        with contextlib.suppress(OSError):
            _DLL_DIRECTORY_HANDLES.append(add_dll_directory(directory))
