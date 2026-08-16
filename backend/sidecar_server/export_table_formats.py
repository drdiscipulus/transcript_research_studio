from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .table_writers import (
    spreadsheet_column_letter,
    utc_timestamp,
    write_csv_rows,
    write_single_sheet_xlsx,
)
from .product_identity import PRODUCT_NAME


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    write_csv_rows(path, fieldnames, rows, stringify=str)


def write_json(
    path: Path,
    prepared_batch: Any,
    rows: list[dict[str, Any]],
    documents: list[dict[str, Any]],
    transcript_layout: str,
) -> None:
    payload = {
        "batch_name": prepared_batch.batch_name,
        "settings": prepared_batch.settings,
        "generated_at": utc_timestamp(),
        "transcript_layout": transcript_layout,
        "rows": rows,
        "documents": documents,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def write_xlsx(path: Path, headers: list[str], rows: list[dict[str, Any]]) -> None:
    write_single_sheet_xlsx(
        path,
        headers,
        rows,
        sheet_name="Transcripts",
        title=f"{PRODUCT_NAME} Export",
        stringify=str,
    )
