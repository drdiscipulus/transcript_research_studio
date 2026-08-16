from __future__ import annotations

import ipaddress
from urllib.parse import urlparse


DEFAULT_BACKEND_HOST = "127.0.0.1"


def is_loopback_host(host: str | None) -> bool:
    value = (host or "").strip().strip("[]").lower()
    if not value:
        return False
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def normalize_loopback_bind_host(value: str | None, *, default: str = DEFAULT_BACKEND_HOST) -> str:
    candidate = (value or "").strip()
    return candidate if is_loopback_host(candidate) else default


def normalize_loopback_base_url(value: str | None, *, default: str) -> str:
    candidate = (value or "").strip() or default
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not is_loopback_host(parsed.hostname):
        return default
    return candidate.rstrip("/")
