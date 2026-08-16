from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .app_paths import config_dir, ensure_app_runtime_directories


CUSTOM_ANALYSES_FILE = "custom_analyses.json"


def custom_analyses_payload() -> dict[str, Any]:
    return {"analyses": _load_custom_analyses()}


def create_custom_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    analyses = _load_custom_analyses()
    name, instructions = _validated_fields(payload)
    _ensure_unique_name(analyses, name)
    analysis = {
        "id": f"custom_{uuid.uuid4().hex}",
        "name": name,
        "instructions": instructions,
        "output_key": _output_key(name),
    }
    analyses.append(analysis)
    _save_custom_analyses(analyses)
    return {"analysis": analysis, "analyses": analyses}


def update_custom_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    analysis_id = str(payload.get("id") or "").strip()
    if not analysis_id:
        raise ValueError("Custom analysis ID is required.")
    analyses = _load_custom_analyses()
    name, instructions = _validated_fields(payload)
    _ensure_unique_name(analyses, name, except_id=analysis_id)
    for index, analysis in enumerate(analyses):
        if analysis.get("id") != analysis_id:
            continue
        updated = {
            "id": analysis_id,
            "name": name,
            "instructions": instructions,
            "output_key": _output_key(name),
        }
        analyses[index] = updated
        _save_custom_analyses(analyses)
        return {"analysis": updated, "analyses": analyses}
    raise ValueError("Custom analysis was not found.")


def duplicate_custom_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    source_id = str(payload.get("id") or "").strip()
    analyses = _load_custom_analyses()
    source = next((item for item in analyses if item.get("id") == source_id), None)
    if source is None:
        raise ValueError("Custom analysis was not found.")
    base_name = f"{source['name']} Copy"
    name = _available_copy_name(analyses, base_name)
    duplicate = {
        "id": f"custom_{uuid.uuid4().hex}",
        "name": name,
        "instructions": source["instructions"],
        "output_key": _output_key(name),
    }
    analyses.append(duplicate)
    _save_custom_analyses(analyses)
    return {"analysis": duplicate, "analyses": analyses}


def delete_custom_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    analysis_id = str(payload.get("id") or "").strip()
    analyses = _load_custom_analyses()
    retained = [item for item in analyses if item.get("id") != analysis_id]
    if len(retained) == len(analyses):
        raise ValueError("Custom analysis was not found.")
    _save_custom_analyses(retained)
    return {"deleted_id": analysis_id, "analyses": retained}


def custom_analysis_by_id(analysis_id: str) -> dict[str, Any] | None:
    return next((item for item in _load_custom_analyses() if item.get("id") == analysis_id), None)


def _validated_fields(payload: dict[str, Any]) -> tuple[str, str]:
    name = " ".join(str(payload.get("name") or "").split())
    instructions = str(payload.get("instructions") or "").strip()
    if not name:
        raise ValueError("Custom analysis name is required.")
    if len(name) > 100:
        raise ValueError("Custom analysis name must be 100 characters or fewer.")
    if not instructions:
        raise ValueError("Custom analysis instructions are required.")
    if len(instructions) > 20_000:
        raise ValueError("Custom analysis instructions are too long.")
    return name, instructions


def _ensure_unique_name(analyses: list[dict[str, Any]], name: str, *, except_id: str = "") -> None:
    normalized = name.casefold()
    if any(str(item.get("name") or "").casefold() == normalized and item.get("id") != except_id for item in analyses):
        raise ValueError("A custom analysis with this name already exists.")


def _available_copy_name(analyses: list[dict[str, Any]], base_name: str) -> str:
    names = {str(item.get("name") or "").casefold() for item in analyses}
    if base_name.casefold() not in names:
        return base_name
    counter = 2
    while f"{base_name} {counter}".casefold() in names:
        counter += 1
    return f"{base_name} {counter}"


def _output_key(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "_", name.casefold()).strip("_")
    return value[:60] or "custom_analysis"


def _library_path() -> Path:
    ensure_app_runtime_directories()
    return config_dir() / CUSTOM_ANALYSES_FILE


def _load_custom_analyses() -> list[dict[str, Any]]:
    path = _library_path()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    values = payload.get("analyses") if isinstance(payload, dict) else []
    if not isinstance(values, list):
        return []
    normalized: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        analysis_id = str(value.get("id") or "").strip()
        name = " ".join(str(value.get("name") or "").split())
        instructions = str(value.get("instructions") or "").strip()
        if analysis_id and name and instructions:
            normalized.append({
                "id": analysis_id,
                "name": name,
                "instructions": instructions,
                "output_key": str(value.get("output_key") or _output_key(name)),
            })
    return normalized


def _save_custom_analyses(analyses: list[dict[str, Any]]) -> None:
    path = _library_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump({"analyses": analyses}, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        temporary_path = Path(temporary_name)
        if temporary_path.exists():
            temporary_path.unlink()
