from __future__ import annotations

import csv
import json
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .prompting_utils import cell_reference_to_index, format_size


SUPPORTED_TABLE_EXTENSIONS = {".csv", ".json", ".xlsx"}
MAX_PROMPT_SOURCE_FILE_BYTES = 64 * 1024**2
MAX_PROMPT_SOURCE_ROWS = 20_000


def load_table(path: Path) -> dict[str, Any]:
    resolved_path = path.expanduser().resolve()
    if not resolved_path.exists() or not resolved_path.is_file():
        raise ValueError("Selected source table file does not exist.")

    extension = resolved_path.suffix.lower()
    if extension not in SUPPORTED_TABLE_EXTENSIONS:
        raise ValueError("Only CSV, JSON, and XLSX transcript tables are supported in prompting.")
    file_size = resolved_path.stat().st_size
    if file_size > MAX_PROMPT_SOURCE_FILE_BYTES:
        raise ValueError(
            "Selected source table is too large for one prompting run. "
            f"The current size limit is {format_size(MAX_PROMPT_SOURCE_FILE_BYTES)}."
        )

    if extension == ".csv":
        rows = read_csv_table(resolved_path)
        format_name = "csv"
    elif extension == ".json":
        rows = read_json_table(resolved_path)
        format_name = "json"
    else:
        rows = read_xlsx_table(resolved_path)
        format_name = "xlsx"

    if len(rows) > MAX_PROMPT_SOURCE_ROWS:
        raise ValueError(
            "Selected source table has too many rows for one prompting run. "
            f"The current row limit is {MAX_PROMPT_SOURCE_ROWS:,} rows."
        )

    columns = table_columns(rows)
    return {
        "path": resolved_path,
        "format": format_name,
        "rows": rows,
        "columns": columns,
    }


def read_csv_table(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader]


def read_json_table(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("JSON table file does not contain a row list.")
    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            normalized_rows.append(dict(row))
    return normalized_rows


def read_xlsx_table(path: Path) -> list[dict[str, Any]]:
    # Read only the first worksheet because the app treats one source file as
    # one logical input table for prompting.
    with zipfile.ZipFile(path) as workbook:
        shared_strings = read_shared_strings(workbook)
        worksheet_name = first_worksheet_name(workbook)
        sheet_xml = workbook.read(worksheet_name)

    namespace = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    root = ET.fromstring(sheet_xml)
    row_map: dict[int, dict[int, str]] = {}
    max_column_index = -1

    for row_element in root.findall(".//main:sheetData/main:row", namespace):
        row_number = int(row_element.attrib.get("r", "0") or 0)
        cells: dict[int, str] = {}
        for cell in row_element.findall("main:c", namespace):
            reference = cell.attrib.get("r", "")
            column_index = cell_reference_to_index(reference)
            if column_index > max_column_index:
                max_column_index = column_index
            value = read_xlsx_cell_value(cell, namespace, shared_strings)
            cells[column_index] = value
        row_map[row_number] = cells

    if not row_map:
        return []

    headers = [row_map[min(row_map)].get(index, "") for index in range(max_column_index + 1)]
    rows: list[dict[str, Any]] = []
    for row_number in sorted(row_map):
        if row_number == min(row_map):
            continue
        cells = row_map[row_number]
        row = {
            headers[index]: cells.get(index, "")
            for index in range(len(headers))
            if headers[index]
        }
        rows.append(row)
    return rows


def read_shared_strings(workbook: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in workbook.namelist():
        return []

    namespace = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for item in root.findall("main:si", namespace):
        text_parts = [node.text or "" for node in item.findall(".//main:t", namespace)]
        values.append("".join(text_parts))
    return values


def first_worksheet_name(workbook: zipfile.ZipFile) -> str:
    worksheet_names = sorted(
        name for name in workbook.namelist() if name.startswith("xl/worksheets/") and name.endswith(".xml")
    )
    if not worksheet_names:
        raise ValueError("XLSX table file does not contain a worksheet.")
    return worksheet_names[0]


def read_xlsx_cell_value(
    cell: ET.Element,
    namespace: dict[str, str],
    shared_strings: list[str],
) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        text_nodes = cell.findall(".//main:t", namespace)
        return "".join(node.text or "" for node in text_nodes)
    value_node = cell.find("main:v", namespace)
    if value_node is None or value_node.text is None:
        return ""
    raw_value = value_node.text
    if cell_type == "s":
        with_value = int(raw_value)
        if 0 <= with_value < len(shared_strings):
            return shared_strings[with_value]
    return raw_value


def table_columns(rows: list[dict[str, Any]]) -> list[str]:
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    return columns
