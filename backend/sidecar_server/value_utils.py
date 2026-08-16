from __future__ import annotations

from typing import Any


def float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def float_or_default(value: Any, default: float, *, minimum: float = 0) -> float:
    parsed = float_or_none(value)
    if parsed is None or parsed < minimum:
        return default
    return parsed


def format_timestamp_hhmmss(value: float | None) -> str:
    if value is None:
        return ""
    hours, minutes, seconds = _rounded_time_parts(value)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def format_timestamp_mmss_or_hhmmss(value: float | None) -> str:
    if value is None:
        return ""
    hours, minutes, seconds = _rounded_time_parts(value)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def parse_timestamp_seconds(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip()
    if not raw:
        return None
    parts = raw.split(":")
    if len(parts) not in {2, 3}:
        return float_or_none(raw)
    try:
        parsed_parts = [int(part) for part in parts]
    except ValueError:
        return None
    if len(parsed_parts) == 2:
        minutes, seconds = parsed_parts
        return float(minutes * 60 + seconds)
    hours, minutes, seconds = parsed_parts
    return float(hours * 3600 + minutes * 60 + seconds)


def timestamp_range_label(start: Any, end: Any) -> str:
    start_label = format_timestamp_hhmmss(float_or_none(start))
    end_label = format_timestamp_hhmmss(float_or_none(end))
    if start_label and end_label:
        return f"{start_label} - {end_label}"
    return start_label or end_label


def _rounded_time_parts(value: float) -> tuple[int, int, int]:
    total_seconds = max(0, int(round(value)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return hours, minutes, seconds
