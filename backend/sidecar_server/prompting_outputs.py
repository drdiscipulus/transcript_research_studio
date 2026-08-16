from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .export_docx import write_docx
from .path_utils import first_available_copy_stem, sanitize_path_stem
from .prompting_utils import stringify_cell
from .product_identity import PRODUCT_NAME
from .table_writers import row_headers, write_csv_rows, write_multi_sheet_xlsx


VALID_PROMPT_OUTPUT_FORMATS = {"xlsx", "csv", "json", "docx"}
RESULT_ROLE_ORDER = (
    "overview",
    "research_focus",
    "interview_review",
    "custom_analysis",
    "summary",
    "quotes",
    "diagnostics",
    "custom_prompt",
)
RESULT_ROLE_TITLES = {
    "overview": "Transcript Overview",
    "research_focus": "Research Focus Analysis",
    "interview_review": "Interview Review",
    "custom_analysis": "Custom Analysis",
    "summary": "Summary",
    "quotes": "Quotes",
    "diagnostics": "Diagnostics",
    "custom_prompt": "Custom Prompt",
}


@dataclass(frozen=True, slots=True)
class PromptOutputFile:
    format: str
    path: str
    exists: bool = False
    role: str = "result"

    def to_dict(self) -> dict[str, Any]:
        return {"format": self.format, "path": self.path, "exists": self.exists, "role": self.role}


def write_preprocessing_outputs(
    *,
    output_folder: Path,
    output_basename: str,
    output_formats: list[str],
    results: dict[str, list[dict[str, Any]]],
    run_info: dict[str, Any],
) -> list[PromptOutputFile]:
    """Write one separate preprocessing output package without modifying source transcripts."""
    output_folder.mkdir(parents=True, exist_ok=True)
    formats = normalize_output_formats(output_formats)
    base_stem = sanitize_file_stem(output_basename or "transcript_preprocessing_results")
    stem = conflict_free_stem(output_folder, base_stem, formats, results)
    written: list[PromptOutputFile] = []
    if "xlsx" in formats:
        path = output_folder / f"{stem}.xlsx"
        write_result_xlsx(path, results, run_info)
        written.append(PromptOutputFile(format="xlsx", path=str(path), exists=path.exists(), role="workbook"))
    if "csv" in formats:
        written.extend(write_result_csv_files(output_folder, stem, results, run_info))
    if "json" in formats:
        path = output_folder / f"{stem}.json"
        write_result_json(path, results, run_info)
        written.append(PromptOutputFile(format="json", path=str(path), exists=path.exists(), role="structured"))
    if "docx" in formats:
        path = output_folder / f"{stem}.docx"
        write_result_docx(path, results, run_info)
        written.append(PromptOutputFile(format="docx", path=str(path), exists=path.exists(), role="report"))
    return written


def normalize_output_formats(values: list[str]) -> list[str]:
    formats = []
    for value in values:
        normalized = str(value).strip().lower()
        if normalized in VALID_PROMPT_OUTPUT_FORMATS and normalized not in formats:
            formats.append(normalized)
    return formats or ["xlsx"]


def conflict_free_stem(
    output_folder: Path,
    base_stem: str,
    formats: list[str],
    results: dict[str, list[dict[str, Any]]],
) -> str:
    """Choose one shared copy-suffixed stem across every selected output artifact."""
    return first_available_copy_stem(
        base_stem=base_stem,
        exists=lambda candidate: output_targets_exist(output_folder, candidate, formats, results),
    )


def output_targets_exist(output_folder: Path, stem: str, formats: list[str], results: dict[str, list[dict[str, Any]]]) -> bool:
    """Check every artifact that would be produced for a candidate output stem."""
    if "xlsx" in formats and (output_folder / f"{stem}.xlsx").exists():
        return True
    if "json" in formats and (output_folder / f"{stem}.json").exists():
        return True
    if "docx" in formats and (output_folder / f"{stem}.docx").exists():
        return True
    if "csv" in formats:
        for role in selected_result_roles(results):
            if (output_folder / f"{stem}_{role}.csv").exists():
                return True
    return False


def selected_result_roles(results: dict[str, list[dict[str, Any]]]) -> list[str]:
    """Return result tables that should be materialized for multi-file formats such as CSV."""
    roles = [role for role in RESULT_ROLE_ORDER if results.get(role)]
    roles.append("run_info")
    return roles


def write_result_csv_files(
    output_folder: Path,
    stem: str,
    results: dict[str, list[dict[str, Any]]],
    run_info: dict[str, Any],
) -> list[PromptOutputFile]:
    written = []
    for role in RESULT_ROLE_ORDER:
        rows = results.get(role) or []
        if not rows:
            continue
        path = output_folder / f"{stem}_{role}.csv"
        write_prompt_csv_rows(path, rows)
        written.append(PromptOutputFile(format="csv", path=str(path), exists=path.exists(), role=role))
    run_info_path = output_folder / f"{stem}_run_info.csv"
    write_prompt_csv_rows(run_info_path, [run_info])
    written.append(PromptOutputFile(format="csv", path=str(run_info_path), exists=run_info_path.exists(), role="run_info"))
    return written


def write_result_json(path: Path, results: dict[str, list[dict[str, Any]]], run_info: dict[str, Any]) -> None:
    payload: dict[str, Any] = {"run_info": run_info}
    for role in RESULT_ROLE_ORDER:
        if results.get(role):
            payload[role] = results[role]
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def write_result_xlsx(path: Path, results: dict[str, list[dict[str, Any]]], run_info: dict[str, Any]) -> None:
    """Write one workbook with task-specific sheets plus Run Info."""
    sheets: list[tuple[str, list[dict[str, Any]]]] = []
    for role in RESULT_ROLE_ORDER:
        if results.get(role):
            sheets.append((RESULT_ROLE_TITLES[role][:31], results[role]))
    sheets.append(("Run Info", [run_info]))
    write_multi_sheet_xlsx(
        path,
        [(sheet_name, row_headers(rows), rows) for sheet_name, rows in sheets],
        title=f"{PRODUCT_NAME} Transcript Analysis Output",
        stringify=stringify_cell,
    )


def write_result_docx(path: Path, results: dict[str, list[dict[str, Any]]], run_info: dict[str, Any]) -> None:
    """Write the readable report form of the preprocessing output package."""
    paragraphs = [
        "Transcript Analysis Report",
        "",
        "Run Info",
        *[f"{key}: {stringify_cell(value)}" for key, value in run_info.items()],
        "",
    ]
    transcript_ids = sorted(
        {
            str(row.get("transcript_id") or "")
            for role_rows in results.values()
            for row in role_rows
            if row.get("transcript_id")
        }
    )
    for transcript_id in transcript_ids:
        paragraphs.extend([f"Transcript: {transcript_id}", ""])
        for role in RESULT_ROLE_ORDER:
            add_docx_rows(
                paragraphs,
                RESULT_ROLE_TITLES[role],
                [row for row in results.get(role, []) if row.get("transcript_id") == transcript_id],
            )
        paragraphs.append("")
    write_docx(path, paragraphs)


def add_docx_rows(paragraphs: list[str], title: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    paragraphs.append(title)
    for index, row in enumerate(rows, start=1):
        paragraphs.append(f"{index}.")
        for key, value in row.items():
            if key in {"transcript_id", "source_file", "model", "provider", "run_timestamp"}:
                continue
            text_value = stringify_cell(value).strip()
            if text_value:
                paragraphs.append(f"{human_label(key)}: {text_value}")
        paragraphs.append("")


def write_prompt_csv_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = row_headers(rows)
    write_csv_rows(path, headers, rows, stringify=stringify_cell)


def sanitize_file_stem(value: str) -> str:
    return sanitize_path_stem(value, default="transcript_preprocessing_results")


def human_label(value: str) -> str:
    return value.replace("_", " ").strip().title()
