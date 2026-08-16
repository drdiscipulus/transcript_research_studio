from __future__ import annotations

import json
import os
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .evidence_export_docx import write_combined_coded_report, write_separate_coded_reports
from .evidence_export_model import (
    EXPORT_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION,
    TABLE_DEFINITIONS,
    build_canonical_export,
)
from .evidence_export_qdpx import validate_project_xml, write_qdpx
from .product_identity import PRODUCT_NAME, PRODUCT_VERSION
from .table_writers import write_csv_rows, write_multi_sheet_xlsx


SUPPORTED_PRODUCTS = {"xlsx", "csv", "json", "docx", "qdpx"}
PRODUCT_LABELS = {
    "xlsx": "Analysis Workbook",
    "csv": "Structured CSV Data",
    "json": "Structured JSON",
    "docx": "Coded Transcript Report",
    "qdpx": "QDA Exchange Project (QDPX Beta)",
}


def export_evidence_project_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    project = payload.get("project")
    if not isinstance(project, dict):
        raise ValueError("Coding project payload is required.")
    output_file = resolve_output_file(payload.get("output_file"))
    products = normalize_products(payload.get("products"))
    docx_mode = str(payload.get("docx_mode") or "separate").strip().lower()
    if docx_mode not in {"separate", "combined"}:
        raise ValueError("DOCX mode must be separate or combined.")
    include_local_paths = bool(payload.get("include_local_paths", False))
    include_ai_audit = bool(payload.get("include_ai_audit", False))
    exported_at = utc_timestamp()
    app_version = PRODUCT_VERSION
    canonical = build_canonical_export(
        project,
        exported_at=exported_at,
        app_version=app_version,
        include_local_paths=include_local_paths,
        include_ai_audit=include_ai_audit,
    )
    warnings = export_warnings(products, include_ai_audit=include_ai_audit)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    temporary_zip = output_file.with_name(f".{output_file.name}.{os.getpid()}.tmp")

    try:
        with tempfile.TemporaryDirectory(prefix="transcript-research-coding-export-", dir=str(output_file.parent)) as temporary:
            staging = Path(temporary)
            artifacts = build_products(
                staging,
                canonical,
                products=products,
                docx_mode=docx_mode,
                exported_at=exported_at,
                bundle_stem=output_file.stem.removesuffix("_export"),
            )
            manifest = build_manifest(
                canonical,
                products=products,
                docx_mode=docx_mode,
                include_local_paths=include_local_paths,
                include_ai_audit=include_ai_audit,
                artifacts=artifacts,
                warnings=warnings,
            )
            readme_path = staging / "README.txt"
            readme_path.write_text(build_readme(manifest), encoding="utf-8")
            manifest["artifacts"].extend(
                [
                    {"product": "bundle", "role": "readme", "archive_path": "README.txt", "size": readme_path.stat().st_size},
                    {"product": "bundle", "role": "manifest", "archive_path": "manifest.json"},
                ]
            )
            manifest_path = staging / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            artifacts.extend(
                [
                    artifact_record("bundle", "manifest", manifest_path, staging),
                    artifact_record("bundle", "readme", readme_path, staging),
                ]
            )
            validate_staging(staging, artifacts)
            write_bundle_zip(temporary_zip, staging)
            validate_bundle_zip(temporary_zip, artifacts)
        os.replace(temporary_zip, output_file)
    finally:
        if temporary_zip.exists():
            temporary_zip.unlink()

    return {
        "bundle": {"path": str(output_file), "exists": output_file.is_file(), "size": output_file.stat().st_size},
        "artifacts": artifacts,
        "warnings": warnings,
        "manifest": manifest,
    }


def build_products(
    staging: Path,
    canonical: dict[str, Any],
    *,
    products: list[str],
    docx_mode: str,
    exported_at: str,
    bundle_stem: str,
) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    project = canonical["project"]
    tables = canonical["tables"]
    include_ai = bool(canonical["metadata"]["include_ai_audit"])
    selected_tables = [
        definition
        for definition in TABLE_DEFINITIONS
        if definition[1] not in {"report_drafts", "ai_runs", "ai_decisions"}
        or (definition[1] == "report_drafts" and bool(tables[definition[1]]))
        or (include_ai and definition[1] in {"ai_runs", "ai_decisions"})
    ]

    if "xlsx" in products:
        path = staging / "analysis_workbook.xlsx"
        write_multi_sheet_xlsx(
            path,
            [(sheet_name, headers, tables[key]) for sheet_name, key, headers in selected_tables],
            title=f"{project.get('name', 'Coding Project')} Analysis Workbook",
            stringify=stringify_cell,
        )
        artifacts.append(artifact_record("xlsx", "analysis_workbook", path, staging))

    if "csv" in products:
        csv_dir = staging / "csv"
        csv_dir.mkdir(parents=True, exist_ok=True)
        for _, key, headers in selected_tables:
            path = csv_dir / f"{key}.csv"
            write_csv_rows(path, headers, tables[key], stringify=stringify_cell)
            artifacts.append(artifact_record("csv", key, path, staging))
        dictionary_path = csv_dir / "data_dictionary.csv"
        dictionary_rows = data_dictionary_rows(selected_tables)
        write_csv_rows(
            dictionary_path,
            ["Table", "Column", "Description"],
            dictionary_rows,
            stringify=stringify_cell,
        )
        artifacts.append(artifact_record("csv", "data_dictionary", dictionary_path, staging))

    if "json" in products:
        path = staging / "structured_project.json"
        path.write_text(json.dumps(canonical, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        artifacts.append(artifact_record("json", "structured_project", path, staging))

    if "docx" in products:
        document_dir = staging / "documents"
        if docx_mode == "combined":
            path = document_dir / "coded_project.docx"
            write_combined_coded_report(path, project, exported_at=exported_at)
            artifacts.append(artifact_record("docx", "coded_project", path, staging))
        else:
            for path in write_separate_coded_reports(document_dir, project, exported_at=exported_at):
                role = "codebook" if path.name == "codebook.docx" else "coded_transcript"
                artifacts.append(artifact_record("docx", role, path, staging))

    if "qdpx" in products:
        qda_dir = staging / "qda_exchange"
        path = qda_dir / f"{safe_basename(bundle_stem)}.qdpx"
        write_qdpx(path, project, exported_at=exported_at)
        artifacts.append(artifact_record("qdpx", "refi_qda_project", path, staging))
    return artifacts


def build_manifest(
    canonical: dict[str, Any],
    *,
    products: list[str],
    docx_mode: str,
    include_local_paths: bool,
    include_ai_audit: bool,
    artifacts: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, Any]:
    project = canonical["project"]
    return {
        "manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "export_schema_version": EXPORT_SCHEMA_VERSION,
        "project": {
            "id": project.get("project_id", ""),
            "name": project.get("name", ""),
            "schema_version": project.get("schema_version", ""),
        },
        "export": {
            "app_version": canonical["metadata"]["app_version"],
            "exported_at": canonical["metadata"]["exported_at"],
            "products": products,
            "docx_mode": docx_mode,
            "include_local_paths": include_local_paths,
            "include_ai_audit": include_ai_audit,
        },
        "counts": {
            "transcripts": len(project.get("transcripts", [])),
            "segments": sum(len(item.get("segments", [])) for item in project.get("transcripts", []) if isinstance(item, dict)),
            "evidence_items": len(project.get("evidence_items", [])),
            "codes": len(project.get("codes", [])),
            "themes": len(project.get("themes", [])),
            "report_drafts": len(project.get("report_drafts", [])),
        },
        "artifacts": [dict(artifact) for artifact in artifacts],
        "warnings": warnings,
        "known_limitations": known_limitations(products),
    }


def build_readme(manifest: dict[str, Any]) -> str:
    product_lines = "\n".join(
        f"- {PRODUCT_LABELS.get(product, product)}"
        for product in manifest["export"]["products"]
    )
    limitations = "\n".join(f"- {item}" for item in manifest["known_limitations"])
    privacy = (
        f"Local source paths included: {'yes' if manifest['export']['include_local_paths'] else 'no'}\n"
        f"AI audit included: {'yes' if manifest['export']['include_ai_audit'] else 'no'}"
    )
    return f"""{PRODUCT_NAME} — Coding Project Export
================================================

Project: {manifest['project']['name']}
Exported: {manifest['export']['exported_at']}
Export schema: {manifest['export_schema_version']}

Selected products
-----------------
{product_lines}

Privacy
-------
{privacy}

The editable coding-project file remains the .evidence.json file. Files in
this ZIP are downstream analysis, reporting, or interchange copies and should
not be used as replacement working copies.

Known limitations
-----------------
{limitations or '- None recorded.'}
"""


def validate_staging(staging: Path, artifacts: list[dict[str, Any]]) -> None:
    for artifact in artifacts:
        archive_path = safe_archive_path(str(artifact["archive_path"]))
        path = staging / archive_path
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Export artifact was not created correctly: {archive_path}")
        suffix = path.suffix.lower()
        if suffix in {".xlsx", ".docx", ".qdpx"}:
            with zipfile.ZipFile(path, "r") as archive:
                if archive.testzip() is not None:
                    raise ValueError(f"Export artifact is corrupt: {archive_path}")
                if suffix == ".xlsx" and "xl/workbook.xml" not in archive.namelist():
                    raise ValueError("Analysis workbook is missing its workbook definition.")
                if suffix == ".docx" and "word/document.xml" not in archive.namelist():
                    raise ValueError("Coded transcript report is missing its document definition.")
                if suffix == ".qdpx":
                    validate_project_xml(archive.read("project.qde"))
        elif suffix == ".json":
            json.loads(path.read_text(encoding="utf-8"))


def write_bundle_zip(path: Path, staging: Path) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(item for item in staging.rglob("*") if item.is_file()):
            archive.write(file_path, safe_archive_path(file_path.relative_to(staging).as_posix()))


def validate_bundle_zip(path: Path, artifacts: list[dict[str, Any]]) -> None:
    with zipfile.ZipFile(path, "r") as archive:
        if archive.testzip() is not None:
            raise ValueError("The completed export bundle is corrupt.")
        names = set(archive.namelist())
        required = {str(item["archive_path"]) for item in artifacts}
        missing = sorted(required - names)
        if missing:
            raise ValueError(f"The completed export bundle is missing: {', '.join(missing)}")
        for name in names:
            safe_archive_path(name)


def artifact_record(product: str, role: str, path: Path, staging: Path) -> dict[str, Any]:
    return {
        "product": product,
        "role": role,
        "archive_path": safe_archive_path(path.relative_to(staging).as_posix()),
        "size": path.stat().st_size,
    }


def data_dictionary_rows(table_definitions: list[tuple[str, str, list[str]]]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for sheet_name, key, headers in table_definitions:
        for header in headers:
            rows.append({"Table": key, "Column": header, "Description": dictionary_description(sheet_name, header)})
    return rows


def dictionary_description(table: str, column: str) -> str:
    if column.endswith(" ID") or column in {"Evidence ID", "Code ID", "Theme ID", "Transcript ID", "Segment ID"}:
        return f"Stable {column.lower()} used to join normalized export tables."
    return f"{column} value in the {table} export table."


def stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def resolve_output_file(value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Export ZIP file is required.")
    path = Path(raw).expanduser().resolve()
    return path if path.suffix.lower() == ".zip" else path.with_suffix(".zip")


def normalize_products(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError("Choose at least one export product.")
    products: list[str] = []
    for item in value:
        product = str(item).strip().lower()
        if product not in SUPPORTED_PRODUCTS:
            raise ValueError(f"Unsupported export product: {product or 'missing'}")
        if product not in products:
            products.append(product)
    if not products:
        raise ValueError("Choose at least one export product.")
    return products


def safe_archive_path(value: str) -> str:
    path = value.replace("\\", "/").lstrip("/")
    parts = [part for part in path.split("/") if part]
    if not parts or any(part in {".", ".."} for part in parts):
        raise ValueError("Unsafe export archive path.")
    return "/".join(parts)


def safe_basename(value: str) -> str:
    cleaned = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in value)
    return cleaned.strip("_") or "coding_project"


def export_warnings(products: list[str], *, include_ai_audit: bool) -> list[str]:
    warnings: list[str] = []
    if "qdpx" in products:
        warnings.append(
            "QDPX export is beta. Linked media is excluded and application-specific features may be modified by QDA software during import."
        )
    if include_ai_audit:
        warnings.append("AI audit data includes researcher prompts and provider/model metadata. Review it before sharing the bundle.")
    return warnings


def known_limitations(products: list[str]) -> list[str]:
    limitations = ["Export files are downstream copies; the bundle cannot be reopened as an editable coding project."]
    if "docx" in products:
        limitations.append("DOCX highlighting is a readable report representation, not a native QDA project format.")
    if "qdpx" in products:
        limitations.extend(
            [
                "QDPX export does not include linked audio/video media or absolute source paths.",
                f"{PRODUCT_NAME} exports QDPX but does not import or round-trip QDPX projects.",
                "MAXQDA, ATLAS.ti, and other QDA applications may modify application-specific features during import.",
            ]
        )
    return limitations



def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
