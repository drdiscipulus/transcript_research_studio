from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any, Iterable
from xml.sax.saxutils import escape

from .evidence_export_model import resolve_speaker_name, transcript_display_name
from .table_writers import xml_safe_text


def write_separate_coded_reports(output_dir: Path, project: dict[str, Any], *, exported_at: str) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    written = [output_dir / "codebook.docx"]
    write_research_docx(written[0], codebook_document_blocks(project, exported_at=exported_at))
    transcript_dir = output_dir / "transcripts"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    for index, transcript in enumerate(project.get("transcripts", []), start=1):
        if not isinstance(transcript, dict):
            continue
        path = transcript_dir / f"{index:03d}_{safe_stem(transcript_display_name(transcript))}.docx"
        blocks = project_overview_blocks(project, exported_at=exported_at)
        blocks.extend(transcript_document_blocks(project, transcript))
        write_research_docx(path, blocks)
        written.append(path)
    return written


def write_combined_coded_report(path: Path, project: dict[str, Any], *, exported_at: str) -> None:
    blocks = project_overview_blocks(project, exported_at=exported_at)
    blocks.extend(codebook_blocks(project))
    for transcript in project.get("transcripts", []):
        if not isinstance(transcript, dict):
            continue
        blocks.append({"type": "page_break"})
        blocks.extend(transcript_document_blocks(project, transcript))
    write_research_docx(path, blocks)


def codebook_document_blocks(project: dict[str, Any], *, exported_at: str) -> list[dict[str, Any]]:
    blocks = project_overview_blocks(project, exported_at=exported_at)
    blocks.extend(codebook_blocks(project))
    return blocks


def project_overview_blocks(project: dict[str, Any], *, exported_at: str) -> list[dict[str, Any]]:
    blocks = [
        heading(str(project.get("name") or "Coding Project"), 1),
        paragraph("Coding Project Export", style="Subtitle"),
    ]
    focus = str(project.get("research_focus") or "").strip()
    if focus:
        blocks.extend([heading("Research Focus", 2), paragraph(focus)])
    blocks.append(
        paragraph(
            f"Exported {exported_at}. {len(project.get('transcripts', []))} transcript(s), "
            f"{len(project.get('evidence_items', []))} evidence item(s), {len(project.get('codes', []))} code(s), "
            f"and {len(project.get('themes', []))} theme(s).",
            style="Metadata",
        )
    )
    return blocks


def codebook_blocks(project: dict[str, Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [heading("Codebook", 1)]
    theme_by_code: dict[str, list[str]] = {}
    for theme in project.get("themes", []):
        if not isinstance(theme, dict):
            continue
        for code_id in theme.get("code_ids", []):
            theme_by_code.setdefault(str(code_id), []).append(str(theme.get("name") or ""))
    codes = [item for item in project.get("codes", []) if isinstance(item, dict)]
    if not codes:
        blocks.append(paragraph("No codes defined.", style="Metadata"))
    for code in codes:
        code_id = str(code.get("code_id") or "")
        blocks.append(heading(str(code.get("name") or code_id), 2))
        blocks.append(paragraph(f"{code_id} · {code.get('color', '')}", style="Metadata"))
        add_labeled_text(blocks, "Definition", code.get("description"))
        add_labeled_text(blocks, "Inclusion Criteria", code.get("inclusion_note"))
        add_labeled_text(blocks, "Exclusion Criteria", code.get("exclusion_note"))
        add_labeled_text(blocks, "Note", code.get("memo"))
        if theme_by_code.get(code_id):
            add_labeled_text(blocks, "Themes", "; ".join(theme_by_code[code_id]))

    blocks.append(heading("Themes", 1))
    code_by_id = {
        str(code.get("code_id") or ""): str(code.get("name") or code.get("code_id") or "")
        for code in codes
    }
    themes = [item for item in project.get("themes", []) if isinstance(item, dict)]
    if not themes:
        blocks.append(paragraph("No themes defined.", style="Metadata"))
    for theme in themes:
        blocks.append(heading(str(theme.get("name") or theme.get("theme_id") or "Theme"), 2))
        blocks.append(paragraph(f"{theme.get('theme_id', '')} · {theme.get('color', '')}", style="Metadata"))
        add_labeled_text(blocks, "Description", theme.get("description"))
        add_labeled_text(blocks, "Codes", "; ".join(code_by_id.get(str(value), str(value)) for value in theme.get("code_ids", [])))
        add_labeled_text(blocks, "Note", theme.get("memo"))
    return blocks


def transcript_document_blocks(project: dict[str, Any], transcript: dict[str, Any]) -> list[dict[str, Any]]:
    transcript_id = str(transcript.get("transcript_id") or "")
    evidence_items = [
        item
        for item in project.get("evidence_items", [])
        if isinstance(item, dict) and str(item.get("transcript_id") or "") == transcript_id
    ]
    code_by_id = {
        str(item.get("code_id") or ""): item
        for item in project.get("codes", [])
        if isinstance(item, dict)
    }
    theme_by_code: dict[str, list[str]] = {}
    for theme in project.get("themes", []):
        if not isinstance(theme, dict):
            continue
        for code_id in theme.get("code_ids", []):
            theme_by_code.setdefault(str(code_id), []).append(str(theme.get("name") or ""))

    blocks: list[dict[str, Any]] = [heading(transcript_display_name(transcript), 1)]
    blocks.append(paragraph(f"Transcript ID: {transcript_id}", style="Metadata"))
    evidence_by_segment: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for evidence in evidence_items:
        ranges = evidence.get("segment_ranges") if isinstance(evidence.get("segment_ranges"), dict) else {}
        for segment_id, anchor in ranges.items():
            if isinstance(anchor, dict):
                evidence_by_segment.setdefault(str(segment_id), []).append((evidence, anchor))

    for segment in transcript.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment_id = str(segment.get("segment_id") or segment.get("id") or "")
        speaker = resolve_speaker_name(transcript, str(segment.get("speaker") or "")) or "Speaker"
        time = format_range(segment.get("start"), segment.get("end"))
        blocks.append(paragraph(f"{speaker} · {time}", style="SegmentHeader"))
        blocks.append(highlighted_segment_paragraph(str(segment.get("text") or ""), evidence_by_segment.get(segment_id, [])))

    if evidence_items:
        blocks.append(heading("Evidence Annotations", 1))
        for evidence in evidence_items:
            evidence_id = str(evidence.get("evidence_id") or "")
            code_names = [
                str(code_by_id.get(str(code_id), {}).get("name") or code_id)
                for code_id in evidence.get("code_ids", [])
            ]
            themes = sorted({name for code_id in evidence.get("code_ids", []) for name in theme_by_code.get(str(code_id), [])})
            blocks.append(heading(evidence_id, 2))
            blocks.append(paragraph(str(evidence.get("selected_text") or ""), style="EvidenceQuote"))
            blocks.append(
                paragraph(
                    " · ".join(
                        value
                        for value in [
                            resolve_speaker_name(transcript, str(evidence.get("speaker") or "")),
                            format_range(evidence.get("start"), evidence.get("end")),
                        ]
                        if value
                    ),
                    style="Metadata",
                )
            )
            add_labeled_text(blocks, "Codes", "; ".join(code_names))
            add_labeled_text(blocks, "Themes", "; ".join(themes))
            add_labeled_text(blocks, "Note", evidence.get("memo"))
    return blocks


def highlighted_segment_paragraph(
    text: str,
    anchored_evidence: list[tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, Any]:
    boundaries = {0, len(text)}
    valid: list[tuple[dict[str, Any], int, int]] = []
    for evidence, anchor in anchored_evidence:
        start = anchor.get("start_offset")
        end = anchor.get("end_offset")
        if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(text):
            boundaries.update({start, end})
            valid.append((evidence, start, end))
    ordered = sorted(boundaries)
    runs: list[dict[str, Any]] = []
    for left, right in zip(ordered, ordered[1:]):
        references = [str(evidence.get("evidence_id") or "") for evidence, start, end in valid if start <= left and right <= end]
        runs.append({"text": text[left:right], "highlight": bool(references), "references": references})
    return {"type": "runs", "style": "TranscriptText", "runs": runs}


def write_research_docx(path: Path, blocks: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    document_xml = document_xml_from_blocks(blocks)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as document:
        document.writestr(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>""",
        )
        document.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        )
        document.writestr(
            "word/_rels/document.xml.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>""",
        )
        document.writestr("word/document.xml", document_xml)
        document.writestr("word/styles.xml", styles_xml())


def document_xml_from_blocks(blocks: Iterable[dict[str, Any]]) -> str:
    body = "".join(block_xml(block) for block in blocks)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" '
        'w:bottom="1080" w:left="1080" w:header="540" w:footer="540" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )


def block_xml(block: dict[str, Any]) -> str:
    kind = block.get("type")
    if kind == "page_break":
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    style = str(block.get("style") or "BodyText")
    ppr = f'<w:pPr><w:pStyle w:val="{escape(style)}"/></w:pPr>'
    if kind == "runs":
        runs = "".join(run_xml(run) for run in block.get("runs", []))
        return f"<w:p>{ppr}{runs}</w:p>"
    return f"<w:p>{ppr}{run_xml({'text': str(block.get('text') or '')})}</w:p>"


def run_xml(run: dict[str, Any]) -> str:
    text = escape(xml_safe_text(str(run.get("text") or "")))
    properties = "<w:rPr>"
    if run.get("bold"):
        properties += "<w:b/>"
    if run.get("italic"):
        properties += "<w:i/>"
    if run.get("highlight"):
        properties += '<w:highlight w:val="lightGray"/>'
    properties += "</w:rPr>"
    return f'<w:r>{properties}<w:t xml:space="preserve">{text}</w:t></w:r>'


def styles_xml() -> str:
    # Compact reference-guide preset: dense, readable Aptos body copy with a
    # restrained blue accent and clear hierarchy for long research reports.
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="20"/><w:color w:val="222222"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="BodyText"><w:name w:val="Body Text"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="BodyText"/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F4E79"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="BodyText"/><w:outlineLvl w:val="0"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1F4E79"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="BodyText"/><w:outlineLvl w:val="1"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="2F5597"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="BodyText"/><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Metadata"><w:name w:val="Metadata"/><w:basedOn w:val="BodyText"/><w:rPr><w:sz w:val="18"/><w:color w:val="666666"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="SegmentHeader"><w:name w:val="Segment Header"/><w:basedOn w:val="BodyText"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TranscriptText"><w:name w:val="Transcript Text"/><w:basedOn w:val="BodyText"/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="EvidenceQuote"><w:name w:val="Evidence Quote"/><w:basedOn w:val="BodyText"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="80"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>"""


def heading(text: str, level: int) -> dict[str, Any]:
    return {"type": "paragraph", "style": "Heading1" if level == 1 else "Heading2", "text": text}


def paragraph(text: str, *, style: str = "BodyText") -> dict[str, Any]:
    return {"type": "paragraph", "style": style, "text": text}


def add_labeled_text(blocks: list[dict[str, Any]], label: str, value: Any) -> None:
    text = str(value or "").strip()
    if text:
        blocks.append(paragraph(f"{label}: {text}"))


def format_range(start: Any, end: Any) -> str:
    return f"{format_time(start)}–{format_time(end)}"


def format_time(value: Any) -> str:
    try:
        seconds = max(0, int(float(value)))
    except (TypeError, ValueError):
        return "—"
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def safe_stem(value: str) -> str:
    stem = Path(value).stem
    cleaned = "".join(character if character.isalnum() or character in {"-", "_", " "} else "_" for character in stem)
    return cleaned.strip(" ._") or "transcript"
