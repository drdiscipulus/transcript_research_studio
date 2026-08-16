from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .export_rows import (
    document_paragraphs,
    document_segments,
    format_docx_segment_line,
    normalize_transcript_layout,
    paragraph_options,
)
from .export_table_formats import utc_timestamp
from .path_utils import first_available_copy_stem, sanitize_path_stem
from .product_identity import PRODUCT_NAME

DOCX_PAGE_BREAK = "\f"


def write_docx_bundle(
    base_path: Path,
    prepared_batch: Any,
    documents: list[dict[str, Any]],
    transcript_layout: str,
) -> list[Path]:
    stem = base_path.stem
    include_timestamps = bool(
        (prepared_batch.settings.get("advanced_transcription") or {}).get("include_timestamps", False)
    )
    written_paths: list[Path] = []
    for index, document in enumerate(documents, start=1):
        desired_path = base_path.with_name(
            f"{stem}_{index:03d}_{sanitize_file_stem(str(document.get('file_name') or 'transcript'))}.docx"
        )
        output_path = non_conflicting_docx_path(desired_path)
        paragraphs = build_docx_paragraphs(
            prepared_batch=prepared_batch,
            document=document,
            transcript_layout=transcript_layout,
            include_timestamps=include_timestamps,
        )
        write_docx(output_path, paragraphs)
        written_paths.append(output_path)
    return written_paths


def write_docx_document(
    path: Path,
    prepared_batch: Any,
    document: dict[str, Any],
    transcript_layout: str,
) -> None:
    include_timestamps = bool(
        (prepared_batch.settings.get("advanced_transcription") or {}).get("include_timestamps", False)
    )
    paragraphs = build_docx_paragraphs(
        prepared_batch=prepared_batch,
        document=document,
        transcript_layout=transcript_layout,
        include_timestamps=include_timestamps,
    )
    write_docx(path, paragraphs)


def write_combined_docx_document(
    path: Path,
    prepared_batch: Any,
    documents: list[dict[str, Any]],
    transcript_layout: str,
) -> None:
    include_timestamps = bool(
        (prepared_batch.settings.get("advanced_transcription") or {}).get("include_timestamps", False)
    )
    paragraphs: list[str] = []
    for index, document in enumerate(documents):
        if index:
            paragraphs.append(DOCX_PAGE_BREAK)
        paragraphs.extend(
            build_docx_paragraphs(
                prepared_batch=prepared_batch,
                document=document,
                transcript_layout=transcript_layout,
                include_timestamps=include_timestamps,
            )
        )
    write_docx(path, paragraphs)


def build_docx_paragraphs(
    *,
    prepared_batch: Any,
    document: dict[str, Any],
    transcript_layout: str,
    include_timestamps: bool,
) -> list[str]:
    paragraphs = [str(document.get("file_name") or "Transcript"), ""]
    metadata = [
        f"Duration: {str(document.get('duration') or '')}",
        f"File info: {str(document.get('file_info') or '')}",
        f"Detected language: {str(document.get('detected_language') or '')}",
        f"Task: {str(document.get('task') or prepared_batch.settings.get('output_mode') or '')}",
    ]
    speaker_summary = str(document.get("speaker_summary") or "").strip()
    if speaker_summary:
        metadata.append(f"Speakers: {speaker_summary}")
    paragraphs.extend(metadata)
    paragraphs.append("")

    normalized_layout = normalize_transcript_layout(transcript_layout)
    if normalized_layout == "segment":
        segment_paragraphs = [
            format_docx_segment_line(segment, include_timestamps=include_timestamps)
            for segment in document_segments(document)
        ]
        paragraphs.extend(segment_paragraphs or [str(document.get("transcript") or "[No speech detected]")])
        return paragraphs

    if normalized_layout == "paragraph":
        paragraph_lines = [
            format_docx_segment_line(paragraph, include_timestamps=include_timestamps)
            for paragraph in document_paragraphs(document, paragraph_options=paragraph_options(prepared_batch))
        ]
        paragraphs.extend(paragraph_lines or [str(document.get("transcript") or "[No speech detected]")])
        return paragraphs

    text_block = build_docx_text_block(document, include_timestamps=include_timestamps)
    paragraphs.append(text_block or "[No speech detected]")
    return paragraphs


def write_docx(path: Path, paragraphs: list[str]) -> None:
    document_xml = build_docx_document_xml(paragraphs)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as document:
        document.writestr(
            "[Content_Types].xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>""",
        )
        document.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>""",
        )
        document.writestr("word/document.xml", document_xml)
        document.writestr(
            "docProps/core.xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>{PRODUCT_NAME} Transcript</dc:title>
  <dc:creator>{PRODUCT_NAME}</dc:creator>
  <cp:lastModifiedBy>{PRODUCT_NAME}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{utc_timestamp()}</dcterms:created>
</cp:coreProperties>""",
        )
        document.writestr(
            "docProps/app.xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>{PRODUCT_NAME}</Application>
</Properties>""",
        )


def build_docx_text_block(document: dict[str, Any], *, include_timestamps: bool) -> str:
    segments = document_segments(document)
    if segments:
        return " ".join(
            format_docx_segment_line(segment, include_timestamps=include_timestamps)
            for segment in segments
            if segment.get("text")
        ).strip()
    return str(document.get("transcript") or "").strip()


def build_docx_document_xml(paragraphs: list[str]) -> str:
    body = "".join(docx_paragraph_xml(paragraph) for paragraph in paragraphs)
    return (
        """<?xml version="1.0" encoding="UTF-8"?>"""
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" '
        'w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )


def docx_paragraph_xml(text: str) -> str:
    if text == DOCX_PAGE_BREAK:
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    if not text:
        return "<w:p/>"
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def sanitize_file_stem(value: str) -> str:
    return sanitize_path_stem(value, default="transcript")


def non_conflicting_docx_path(desired_path: Path) -> Path:
    available_stem = first_available_copy_stem(
        base_stem=desired_path.stem,
        exists=lambda candidate: desired_path.with_name(f"{candidate}{desired_path.suffix}").exists(),
    )
    return desired_path.with_name(f"{available_stem}{desired_path.suffix}")
