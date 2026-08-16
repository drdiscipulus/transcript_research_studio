from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any


_PROGRESS_LOCK = threading.Lock()
_PROGRESS: dict[str, dict[str, Any]] = {}


def start_model_download(download_id: str, *, label: str) -> None:
    with _PROGRESS_LOCK:
        _PROGRESS[download_id] = {
            "id": download_id,
            "label": label,
            "status": "running",
            "percent": 0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "message": "Starting download...",
            "updated_at": _now_iso(),
        }


def update_model_download(
    download_id: str,
    *,
    downloaded_bytes: int | None = None,
    total_bytes: int | None = None,
    percent: int | None = None,
    message: str | None = None,
) -> None:
    with _PROGRESS_LOCK:
        current = _PROGRESS.get(download_id)
        if current is None:
            current = {
                "id": download_id,
                "label": download_id,
                "status": "running",
                "percent": 0,
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "message": "",
            }
            _PROGRESS[download_id] = current

        if downloaded_bytes is not None:
            current["downloaded_bytes"] = max(int(downloaded_bytes), 0)
        if total_bytes is not None:
            current["total_bytes"] = max(int(total_bytes), 0)
        if percent is not None:
            current["percent"] = _clamp_percent(percent)
        elif current.get("total_bytes"):
            current["percent"] = _clamp_percent(
                round((int(current["downloaded_bytes"]) / int(current["total_bytes"])) * 100)
            )
        if message is not None:
            current["message"] = message
        current["status"] = "running"
        current["updated_at"] = _now_iso()


def finish_model_download(download_id: str, *, message: str = "Download complete.") -> None:
    with _PROGRESS_LOCK:
        current = _PROGRESS.get(download_id)
        if current is None:
            current = {"id": download_id, "label": download_id}
            _PROGRESS[download_id] = current
        current.update(
            {
                "status": "completed",
                "percent": 100,
                "message": message,
                "updated_at": _now_iso(),
            }
        )


def fail_model_download(download_id: str, *, message: str) -> None:
    with _PROGRESS_LOCK:
        current = _PROGRESS.get(download_id)
        if current is None:
            current = {"id": download_id, "label": download_id}
            _PROGRESS[download_id] = current
        current.update(
            {
                "status": "failed",
                "message": message,
                "updated_at": _now_iso(),
            }
        )


def model_download_progress_payload() -> dict[str, Any]:
    with _PROGRESS_LOCK:
        return {"downloads": {download_id: dict(progress) for download_id, progress in _PROGRESS.items()}}


def _clamp_percent(value: int | float) -> int:
    return max(0, min(100, int(round(value))))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
