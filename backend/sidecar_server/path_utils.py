from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Iterable


def sanitize_plain_stem(value: str, *, default: str) -> str:
    """Return a filesystem-friendly stem using the stable filename normalization rules."""
    if not value:
        return default
    cleaned = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in value)
    cleaned = cleaned.strip("_")
    return cleaned or default


def sanitize_path_stem(value: str, *, default: str) -> str:
    """Return a safe output stem derived from a path-like or filename-like value."""
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(value).stem).strip("._-")
    return sanitized or default


def first_available_copy_stem(
    *,
    base_stem: str,
    exists: Callable[[str], bool],
) -> str:
    """Return base_stem or the first deterministic _copyNN stem accepted by exists."""
    if not exists(base_stem):
        return base_stem
    copy_index = 1
    while True:
        candidate = f"{base_stem}_copy{copy_index:02d}"
        if not exists(candidate):
            return candidate
        copy_index += 1


def any_format_target_exists(output_folder: Path, stem: str, formats: Iterable[str]) -> bool:
    return any((output_folder / f"{stem}.{format_name}").exists() for format_name in formats)
