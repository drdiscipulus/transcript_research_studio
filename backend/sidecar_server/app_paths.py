from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path

APP_DATA_FOLDER_NAME = "Transcript Research Studio"
PORTABLE_ROOT_ENV = "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE_ROOT"
PORTABLE_MODE_ENV = "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE"


def _resolve_app_data_root(
    environment: Mapping[str, str],
    *,
    os_name: str,
    platform_name: str,
    home_directory: Path,
) -> Path:
    portable_root = environment.get(PORTABLE_ROOT_ENV, "").strip()
    if portable_root:
        return Path(portable_root).expanduser()

    if os_name == "nt":
        local_app_data = environment.get("LOCALAPPDATA", "").strip()
        base = Path(local_app_data) if local_app_data else home_directory
        return base / APP_DATA_FOLDER_NAME
    if os_name == "posix" and platform_name == "darwin":
        return home_directory / "Library" / "Application Support" / APP_DATA_FOLDER_NAME
    return home_directory / ".local" / "share" / APP_DATA_FOLDER_NAME


@lru_cache(maxsize=1)
def app_data_root() -> Path:
    return _resolve_app_data_root(
        os.environ,
        os_name=os.name,
        platform_name=sys.platform,
        home_directory=Path.home(),
    )


def config_dir() -> Path:
    return app_data_root() / "config"


def logs_dir() -> Path:
    return app_data_root() / "logs"


def temp_dir() -> Path:
    return app_data_root() / "temp"


def cache_root() -> Path:
    return app_data_root() / "cache"


def huggingface_home() -> Path:
    return cache_root() / "huggingface"


def huggingface_hub_cache() -> Path:
    return huggingface_home() / "hub"


def default_input_folder() -> Path:
    return app_data_root() / "Input"


def default_transcript_output_folder() -> Path:
    return app_data_root() / "Transcript Exports"


def default_prompt_output_folder() -> Path:
    return app_data_root() / "Transcript Analysis Exports"


def ensure_app_runtime_directories() -> dict[str, Path]:
    paths = {
        "root": app_data_root(),
        "config": config_dir(),
        "logs": logs_dir(),
        "temp": temp_dir(),
        "cache": cache_root(),
        "huggingface_home": huggingface_home(),
        "huggingface_hub_cache": huggingface_hub_cache(),
    }
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    return paths


def is_portable_mode() -> bool:
    return bool(os.environ.get(PORTABLE_MODE_ENV, "").strip() or os.environ.get(PORTABLE_ROOT_ENV, "").strip())
