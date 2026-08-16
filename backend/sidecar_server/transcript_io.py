from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .value_utils import parse_timestamp_seconds

MAX_DOCX_DOCUMENT_XML_BYTES = 64 * 1024**2
MAX_DOCX_DOCUMENT_COMPRESSION_RATIO = 100


def has_any_key(row: dict[str, Any], keys: list[str]) -> bool:
    return any(str(row.get(key) or "").strip() for key in keys)


def first_non_empty(rows: list[dict[str, Any]], keys: list[str]) -> str:
    for row in rows:
        for key in keys:
            value = str(row.get(key) or "").strip()
            if value:
                return value
    return ""


def normalize_speaker_id(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    match = re.search(r"speaker[\s_-]*(\d+)", raw, re.IGNORECASE)
    if match:
        return f"SPEAKER_{int(match.group(1)):02d}"
    if raw.upper().startswith("SPEAKER_"):
        return raw.upper()
    return raw


def read_docx_paragraphs(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as document:
        try:
            document_xml = document.getinfo("word/document.xml")
        except KeyError as error:
            raise ValueError("DOCX transcript is missing word/document.xml.") from error
        if document_xml.file_size > MAX_DOCX_DOCUMENT_XML_BYTES:
            raise ValueError("DOCX transcript document is too large.")
        if (
            document_xml.compress_size > 0
            and document_xml.file_size / document_xml.compress_size > MAX_DOCX_DOCUMENT_COMPRESSION_RATIO
        ):
            raise ValueError("DOCX transcript document is compressed too aggressively.")
        xml_payload = document.read(document_xml)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    root = ET.fromstring(xml_payload)
    paragraphs: list[str] = []
    for paragraph in root.findall(".//w:p", namespace):
        text_parts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
        paragraphs.append("".join(text_parts).strip())
    return paragraphs


DOCX_SEGMENT_PATTERN = re.compile(
    r"^\s*(?:\[(?P<timestamp>\d{1,2}:\d{2}(?::\d{2})?)(?:\s*-\s*(?P<end_timestamp>\d{1,2}:\d{2}(?::\d{2})?))?\]\s*)?"
    r"(?:(?P<speaker>[^:\[\]]{1,80}):\s*)?"
    r"(?P<text>.+?)\s*$"
)


def parse_docx_segment_line(value: str) -> dict[str, Any]:
    match = DOCX_SEGMENT_PATTERN.match(value)
    if not match:
        return {"start": None, "speaker": "", "text": value.strip()}
    return {
        "start": parse_timestamp_seconds(match.group("timestamp")),
        "end": parse_timestamp_seconds(match.group("end_timestamp")),
        "speaker": match.group("speaker") or "",
        "text": (match.group("text") or "").strip(),
    }
