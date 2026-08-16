from __future__ import annotations

import json
from datetime import datetime
from typing import Any

DEFAULT_PROMPT_TIMEOUT_SECONDS = 180
MIN_PROMPT_TIMEOUT_SECONDS = 10
MAX_PROMPT_TIMEOUT_SECONDS = 3600


def provider_display_name(provider_id: str) -> str:
    return "LM Studio" if provider_id == "lmstudio" else "Ollama"


def parse_temperature(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Temperature must be a number between 0 and 2.") from error
    if parsed < 0 or parsed > 2:
        raise ValueError("Temperature must be between 0 and 2.")
    return round(parsed, 2)


def parse_prompt_timeout_seconds(value: Any) -> int:
    if value is None or str(value).strip() == "":
        return DEFAULT_PROMPT_TIMEOUT_SECONDS
    try:
        parsed = int(float(value))
    except (TypeError, ValueError) as error:
        raise ValueError("Timeout must be a number of seconds.") from error
    if parsed < MIN_PROMPT_TIMEOUT_SECONDS or parsed > MAX_PROMPT_TIMEOUT_SECONDS:
        raise ValueError(
            f"Timeout must be between {MIN_PROMPT_TIMEOUT_SECONDS} and {MAX_PROMPT_TIMEOUT_SECONDS} seconds."
        )
    return parsed


def row_label(row: dict[str, Any], index: int, columns: list[str]) -> str:
    for candidate in ("file_name", "title", "name"):
        value = stringify_cell(row.get(candidate)).strip()
        if value:
            return value
    for column in columns:
        value = stringify_cell(row.get(column)).strip()
        if value:
            return value[:80]
    return f"Row {index + 1}"


def stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def calculate_progress(*, completed: int, total: int) -> int:
    if total <= 0:
        return 0
    return int(round((completed / total) * 100))


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def safe_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def format_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(max(size_bytes, 0))
    unit = units[0]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            break
        value /= 1024
    if unit == "B":
        return f"{int(value)} {unit}"
    return f"{value:.1f} {unit}"


def cell_reference_to_index(reference: str) -> int:
    letters = "".join(character for character in reference if character.isalpha()).upper()
    if not letters:
        return 0
    result = 0
    for character in letters:
        result = result * 26 + (ord(character) - 64)
    return result - 1


def column_letter(index: int) -> str:
    result = ""
    current = index
    while True:
        current, remainder = divmod(current, 26)
        result = chr(65 + remainder) + result
        if current == 0:
            break
        current -= 1
    return result
