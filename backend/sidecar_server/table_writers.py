from __future__ import annotations

import csv
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from xml.sax.saxutils import escape

from .product_identity import PRODUCT_NAME

FORMULA_PREFIXES = ("=", "+", "-", "@")
EXCEL_CELL_CHARACTER_LIMIT = 32_767
EXCEL_SPLIT_PAYLOAD_SIZE = EXCEL_CELL_CHARACTER_LIMIT - 128


def safe_csv_cell(value: str) -> str:
    stripped = value.lstrip(" \t\r\n")
    if stripped.startswith(FORMULA_PREFIXES):
        return f"'{value}"
    return value


def write_csv_rows(
    path: Path,
    headers: list[str],
    rows: list[dict[str, Any]],
    *,
    stringify: Callable[[Any], str] = str,
) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({header: safe_csv_cell(stringify(row.get(header, ""))) for header in headers})


def write_single_sheet_xlsx(
    path: Path,
    headers: list[str],
    rows: list[dict[str, Any]],
    *,
    sheet_name: str = "Transcripts",
    title: str = f"{PRODUCT_NAME} Export",
    stringify: Callable[[Any], str] = str,
) -> None:
    write_multi_sheet_xlsx(
        path,
        [(sheet_name, headers, rows)],
        title=title,
        stringify=stringify,
    )


def write_multi_sheet_xlsx(
    path: Path,
    sheets: list[tuple[str, list[str], list[dict[str, Any]]]],
    *,
    title: str,
    stringify: Callable[[Any], str] = str,
) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as workbook:
        worksheet_overrides = "\n".join(
            f'  <Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, len(sheets) + 1)
        )
        workbook.writestr(
            "[Content_Types].xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
{worksheet_overrides}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>""",
        )
        workbook.writestr(
            "_rels/.rels",
            """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>""",
        )
        workbook.writestr("xl/workbook.xml", workbook_xml(sheets))
        workbook.writestr("xl/_rels/workbook.xml.rels", workbook_relationships_xml(len(sheets)))
        workbook.writestr("xl/styles.xml", workbook_styles_xml())
        for index, (_, headers, rows) in enumerate(sheets, start=1):
            workbook.writestr(f"xl/worksheets/sheet{index}.xml", build_sheet_xml_from_rows(headers, rows, stringify=stringify))
        workbook.writestr("docProps/core.xml", core_properties_xml(title))
        workbook.writestr("docProps/app.xml", app_properties_xml())


def build_sheet_xml_from_rows(
    headers: list[str],
    rows: list[dict[str, Any]],
    *,
    stringify: Callable[[Any], str] = str,
) -> str:
    sheet_rows = [headers] + [[stringify(row.get(header, "")) for header in headers] for row in rows]
    return build_sheet_xml(sheet_rows)


def build_sheet_xml(rows: list[list[str]]) -> str:
    expanded_rows: list[list[str]] = []
    for row in rows:
        expanded_rows.extend(expand_excel_row([xml_safe_text(str(value)) for value in row]))

    xml_rows: list[str] = []
    for row_index, row in enumerate(expanded_rows, start=1):
        cells: list[str] = []
        for column_index, value in enumerate(row):
            column_letter = spreadsheet_column_letter(column_index)
            cell_reference = f"{column_letter}{row_index}"
            style = ' s="1"' if row_index == 1 else ""
            cells.append(f'<c r="{cell_reference}"{style} t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        xml_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    column_count = max((len(row) for row in expanded_rows), default=0)
    row_count = len(expanded_rows)
    dimension = f"A1:{spreadsheet_column_letter(max(column_count - 1, 0))}{max(row_count, 1)}"
    columns = "".join(
        f'<col min="{index + 1}" max="{index + 1}" width="{column_width(expanded_rows, index)}" customWidth="1"/>'
        for index in range(column_count)
    )
    auto_filter = f'<autoFilter ref="A1:{spreadsheet_column_letter(column_count - 1)}{row_count}"/>' if column_count and row_count else ""
    return (
        """<?xml version="1.0" encoding="UTF-8"?>"""
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="{dimension}"/>'
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>'
        f"<cols>{columns}</cols>"
        f"<sheetData>{''.join(xml_rows)}</sheetData>"
        f"{auto_filter}"
        "</worksheet>"
    )


def column_width(rows: list[list[str]], column_index: int) -> float:
    values = [row[column_index] for row in rows[:501] if column_index < len(row)]
    longest_line = max((len(line) for value in values for line in str(value).splitlines() or [""]), default=8)
    return float(min(max(longest_line + 2, 10), 60))


def expand_excel_row(row: list[str]) -> list[list[str]]:
    """Split oversized cells into continuation rows without changing columns.

    Values that fit in one cell are repeated on every continuation row so
    identifying metadata (for example, the source filename) remains attached
    to each text fragment. Split cells carry a visible part marker and are
    blank once their own fragments are exhausted.
    """
    cell_parts = [split_excel_cell(value) for value in row]
    continuation_count = max((len(parts) for parts in cell_parts), default=1)
    if continuation_count == 1:
        return [row]

    expanded: list[list[str]] = []
    for part_index in range(continuation_count):
        expanded.append(
            [
                parts[0] if len(parts) == 1 else (parts[part_index] if part_index < len(parts) else "")
                for parts in cell_parts
            ]
        )
    return expanded


def split_excel_cell(value: str) -> list[str]:
    if len(value) <= EXCEL_CELL_CHARACTER_LIMIT:
        return [value]

    chunks = [
        value[offset : offset + EXCEL_SPLIT_PAYLOAD_SIZE]
        for offset in range(0, len(value), EXCEL_SPLIT_PAYLOAD_SIZE)
    ]
    total = len(chunks)
    parts = [f"[Excel cell split: part {index}/{total}]\n{chunk}" for index, chunk in enumerate(chunks, start=1)]
    # The fixed reserve above is intentionally generous, but keep this
    # invariant explicit if the marker wording changes later.
    if any(len(part) > EXCEL_CELL_CHARACTER_LIMIT for part in parts):
        raise ValueError("Excel continuation marker exceeds the cell character limit.")
    return parts


def xml_safe_text(value: str) -> str:
    """Return text containing only XML 1.0 characters."""
    return "".join(character for character in value if is_xml_10_character(ord(character)))


def escape_xml_attribute(value: str) -> str:
    return escape(xml_safe_text(value), {'"': "&quot;"})


def is_xml_10_character(codepoint: int) -> bool:
    return (
        codepoint in {0x09, 0x0A, 0x0D}
        or 0x20 <= codepoint <= 0xD7FF
        or 0xE000 <= codepoint <= 0xFFFD
        or 0x10000 <= codepoint <= 0x10FFFF
    )


def spreadsheet_column_letter(index: int) -> str:
    result = ""
    current = index
    while True:
        current, remainder = divmod(current, 26)
        result = chr(65 + remainder) + result
        if current == 0:
            break
        current -= 1
    return result


def row_headers(rows: list[dict[str, Any]]) -> list[str]:
    headers: list[str] = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    return headers or ["message"]


def workbook_xml(sheets: list[tuple[str, list[str], list[dict[str, Any]]]]) -> str:
    sheet_entries = "\n".join(
        f'    <sheet name="{escape_xml_attribute(sheet_name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, (sheet_name, _, _) in enumerate(sheets, start=1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
{sheet_entries}
  </sheets>
</workbook>"""


def workbook_relationships_xml(sheet_count: int) -> str:
    relationships = "\n".join(
        f'  <Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, sheet_count + 1)
    )
    styles_relationship_id = sheet_count + 1
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
{relationships}
  <Relationship Id="rId{styles_relationship_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""


def workbook_styles_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def core_properties_xml(title: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>{escape(xml_safe_text(title))}</dc:title>
  <dc:creator>{PRODUCT_NAME}</dc:creator>
  <cp:lastModifiedBy>{PRODUCT_NAME}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{utc_timestamp()}</dcterms:created>
</cp:coreProperties>"""


def app_properties_xml() -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>{PRODUCT_NAME}</Application>
</Properties>"""


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
