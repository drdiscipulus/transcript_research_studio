from __future__ import annotations

import uuid
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .evidence_export_model import transcript_display_name
from .product_identity import PRODUCT_NAME
from .table_writers import xml_safe_text


REFI_NAMESPACE = "urn:QDA-XML:project:1.0"
REFI_XSD_PATH = Path(__file__).parent / "resources" / "refi_qda" / "Project.xsd"
QDPX_NAMESPACE = uuid.UUID("3bc1d16b-8e17-5dc2-972a-8b0131eb647f")

ET.register_namespace("", REFI_NAMESPACE)


def write_qdpx(path: Path, project: dict[str, Any], *, exported_at: str) -> dict[str, Any]:
    root, sources = build_refi_project(project, exported_at=exported_at)
    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    validate_project_xml(xml_bytes)
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.qde", xml_bytes)
        for source_path, source_text in sources.items():
            archive.writestr(source_path, source_text.encode("utf-8"))
    return {
        "project_xml": "project.qde",
        "source_count": len(sources),
        "standard": "REFI-QDA Project 1.0",
    }


def build_refi_project(project: dict[str, Any], *, exported_at: str) -> tuple[ET.Element, dict[str, str]]:
    project_id = str(project.get("project_id") or "project")
    root = element(
        "Project",
        {
            "name": clean(project.get("name") or "Coding Project"),
            "origin": PRODUCT_NAME,
            "creationDateTime": normalized_datetime(project.get("created_at") or exported_at),
            "modifiedDateTime": normalized_datetime(exported_at),
        },
    )
    codes = [item for item in project.get("codes", []) if isinstance(item, dict)]
    themes = [item for item in project.get("themes", []) if isinstance(item, dict)]
    evidence_items = [item for item in project.get("evidence_items", []) if isinstance(item, dict)]
    code_guid = {
        str(code.get("code_id") or ""): stable_guid(project_id, "code", str(code.get("code_id") or ""))
        for code in codes
    }

    notes: list[tuple[str, str, str]] = []
    note_guid_by_key: dict[str, str] = {}
    for code in codes:
        memo = str(code.get("memo") or "").strip()
        if memo:
            key = f"code:{code.get('code_id')}"
            note_guid_by_key[key] = stable_guid(project_id, "note", key)
            notes.append((note_guid_by_key[key], f"Code note: {code.get('name')}", memo))
    for evidence in evidence_items:
        memo = str(evidence.get("memo") or "").strip()
        if memo:
            key = f"evidence:{evidence.get('evidence_id')}"
            note_guid_by_key[key] = stable_guid(project_id, "note", key)
            notes.append((note_guid_by_key[key], f"Evidence note: {evidence.get('evidence_id')}", memo))
    for theme in themes:
        memo = str(theme.get("memo") or "").strip()
        if memo:
            key = f"theme:{theme.get('theme_id')}"
            note_guid_by_key[key] = stable_guid(project_id, "note", key)
            notes.append((note_guid_by_key[key], f"Theme note: {theme.get('name')}", memo))

    if codes:
        code_book = ET.SubElement(root, qname("CodeBook"))
        codes_element = ET.SubElement(code_book, qname("Codes"))
        for code in codes:
            code_id = str(code.get("code_id") or "")
            code_element = ET.SubElement(
                codes_element,
                qname("Code"),
                {
                    "guid": code_guid[code_id],
                    "name": clean(code.get("name") or code_id),
                    "isCodable": "true",
                    "color": normalize_color(code.get("color")),
                },
            )
            description = structured_code_description(code)
            if description:
                ET.SubElement(code_element, qname("Description")).text = clean(description)
            note_guid = note_guid_by_key.get(f"code:{code_id}")
            if note_guid:
                ET.SubElement(code_element, qname("NoteRef"), {"targetGUID": note_guid})

    source_files: dict[str, str] = {}
    evidence_by_transcript: dict[str, list[dict[str, Any]]] = {}
    for evidence in evidence_items:
        evidence_by_transcript.setdefault(str(evidence.get("transcript_id") or ""), []).append(evidence)

    transcripts = [item for item in project.get("transcripts", []) if isinstance(item, dict)]
    sources_element = ET.SubElement(root, qname("Sources")) if transcripts else None
    for transcript_index, transcript in enumerate(transcripts, start=1):
        if not isinstance(transcript, dict):
            continue
        transcript_id = str(transcript.get("transcript_id") or "")
        source_text, text_offsets = build_plain_text_source(transcript)
        source_path = f"sources/{transcript_index:03d}_{safe_source_name(transcript_display_name(transcript))}.txt"
        source_files[source_path] = source_text
        source_element = ET.SubElement(
            sources_element,
            qname("TextSource"),
            {
                "guid": stable_guid(project_id, "transcript", transcript_id),
                "name": clean(transcript_display_name(transcript)),
                "plainTextPath": source_path,
            },
        )
        ET.SubElement(source_element, qname("Description")).text = clean(f"Transcript {transcript_id} exported by {PRODUCT_NAME}.")
        for evidence in evidence_by_transcript.get(transcript_id, []):
            evidence_id = str(evidence.get("evidence_id") or "")
            ranges = evidence.get("segment_ranges") if isinstance(evidence.get("segment_ranges"), dict) else {}
            for part_index, segment_id in enumerate(evidence.get("segment_ids", []), start=1):
                anchor = ranges.get(str(segment_id), {}) if isinstance(ranges, dict) else {}
                base_offset = text_offsets.get(str(segment_id))
                start_offset = anchor.get("start_offset") if isinstance(anchor, dict) else None
                end_offset = anchor.get("end_offset") if isinstance(anchor, dict) else None
                if base_offset is None or not isinstance(start_offset, int) or not isinstance(end_offset, int):
                    continue
                selection_guid = stable_guid(project_id, "evidence-range", f"{evidence_id}:{segment_id}")
                selection = ET.SubElement(
                    source_element,
                    qname("PlainTextSelection"),
                    {
                        "guid": selection_guid,
                        "name": clean(f"{evidence_id} ({part_index}/{len(evidence.get('segment_ids', []))})"),
                        "startPosition": str(base_offset + start_offset),
                        "endPosition": str(base_offset + end_offset),
                    },
                )
                description = f"Evidence {evidence_id}: {str(anchor.get('excerpt') or '')}"
                ET.SubElement(selection, qname("Description")).text = clean(description)
                for code_id in evidence.get("code_ids", []):
                    target_guid = code_guid.get(str(code_id))
                    if not target_guid:
                        continue
                    coding = ET.SubElement(
                        selection,
                        qname("Coding"),
                        {"guid": stable_guid(project_id, "coding", f"{evidence_id}:{segment_id}:{code_id}")},
                    )
                    ET.SubElement(coding, qname("CodeRef"), {"targetGUID": target_guid})
                note_guid = note_guid_by_key.get(f"evidence:{evidence_id}")
                if note_guid:
                    ET.SubElement(selection, qname("NoteRef"), {"targetGUID": note_guid})

    if notes:
        notes_element = ET.SubElement(root, qname("Notes"))
        for note_guid, name, body in notes:
            note = ET.SubElement(notes_element, qname("Note"), {"guid": note_guid, "name": clean(name)})
            ET.SubElement(note, qname("PlainTextContent")).text = clean(body)

    if themes:
        sets_element = ET.SubElement(root, qname("Sets"))
        for theme in themes:
            theme_id = str(theme.get("theme_id") or "")
            theme_set = ET.SubElement(
                sets_element,
                qname("Set"),
                {"guid": stable_guid(project_id, "theme", theme_id), "name": clean(theme.get("name") or theme_id)},
            )
            description_parts = [str(theme.get("description") or "").strip()]
            if theme.get("color"):
                description_parts.append(f"Color: {theme.get('color')}")
            ET.SubElement(theme_set, qname("Description")).text = clean("\n\n".join(part for part in description_parts if part))
            for code_id in theme.get("code_ids", []):
                target_guid = code_guid.get(str(code_id))
                if target_guid:
                    ET.SubElement(theme_set, qname("MemberCode"), {"targetGUID": target_guid})
            note_guid = note_guid_by_key.get(f"theme:{theme_id}")
            if note_guid:
                ET.SubElement(theme_set, qname("MemberNote"), {"targetGUID": note_guid})

    focus = str(project.get("research_focus") or "").strip()
    if focus:
        ET.SubElement(root, qname("Description")).text = clean(f"Research focus: {focus}")
    return root, source_files


def build_plain_text_source(transcript: dict[str, Any]) -> tuple[str, dict[str, int]]:
    parts: list[str] = []
    offsets: dict[str, int] = {}
    current = 0
    for segment in transcript.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment_id = str(segment.get("segment_id") or segment.get("id") or "")
        speaker = str(segment.get("speaker") or "Speaker")
        heading = f"[{format_time(segment.get('start'))} - {format_time(segment.get('end'))}] {speaker}\n"
        text = str(segment.get("text") or "")
        parts.append(heading)
        current += len(heading)
        offsets[segment_id] = current
        parts.append(text)
        parts.append("\n\n")
        current += len(text) + 2
    return "".join(parts), offsets


def validate_project_xml(xml_bytes: bytes) -> None:
    try:
        import xmlschema
    except ImportError as error:  # pragma: no cover - release dependency guard
        raise RuntimeError("QDPX export requires the bundled xmlschema runtime dependency.") from error
    if not REFI_XSD_PATH.is_file():
        raise RuntimeError("The bundled REFI-QDA Project XSD is missing.")
    schema = xmlschema.XMLSchema(str(REFI_XSD_PATH))
    errors = list(schema.iter_errors(xml_bytes))
    if errors:
        summary = "; ".join(str(error.reason or error.message) for error in errors[:3])
        raise ValueError(f"Generated QDPX project XML failed REFI-QDA validation: {summary}")


def element(name: str, attributes: dict[str, str] | None = None) -> ET.Element:
    return ET.Element(qname(name), attributes or {})


def qname(name: str) -> str:
    return f"{{{REFI_NAMESPACE}}}{name}"


def stable_guid(project_id: str, entity_type: str, entity_id: str) -> str:
    return str(uuid.uuid5(QDPX_NAMESPACE, f"{project_id}:{entity_type}:{entity_id}"))


def structured_code_description(code: dict[str, Any]) -> str:
    fields = [
        ("Definition", code.get("description")),
        ("Inclusion Criteria", code.get("inclusion_note")),
        ("Exclusion Criteria", code.get("exclusion_note")),
        ("Example Evidence IDs", ", ".join(str(value) for value in code.get("example_evidence_ids", []))),
    ]
    return "\n\n".join(f"{label}: {str(value).strip()}" for label, value in fields if str(value or "").strip())


def normalize_color(value: Any) -> str:
    color = str(value or "#0f766e")
    return color if len(color) == 7 and color.startswith("#") else "#0f766e"


def clean(value: Any) -> str:
    return xml_safe_text(str(value or ""))


def normalized_datetime(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "1970-01-01T00:00:00Z"
    return text.replace("+00:00", "Z")


def safe_source_name(value: str) -> str:
    stem = Path(value).stem
    result = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in stem)
    return result.strip("_") or "transcript"


def format_time(value: Any) -> str:
    try:
        seconds = max(0, int(float(value)))
    except (TypeError, ValueError):
        return "--:--"
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"
