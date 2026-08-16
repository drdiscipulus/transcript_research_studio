from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .export_docx import (
    build_docx_paragraphs,
    write_combined_docx_document,
    write_docx_bundle,
    write_docx_document,
)
from .export_rows import (
    FILE_ROW_HEADERS,
    PARAGRAPH_ROW_HEADERS,
    SEGMENT_ROW_HEADERS,
    build_file_rows,
    build_paragraph_rows,
    build_segment_rows,
    build_table_export_rows,
    document_segments,
    format_docx_segment_line,
    format_export_timestamp,
    normalize_transcript_layout,
    paragraph_options,
)
from .export_table_formats import write_csv, write_json, write_xlsx


class ExportWriteError(RuntimeError):
    """An export failed after zero or more earlier formats were committed."""

    error_code = "export_failed"

    def __init__(
        self,
        *,
        export_format: str,
        failed_path: str,
        written_paths: list[str],
        cause: BaseException,
    ) -> None:
        self.export_format = export_format
        self.failed_path = failed_path
        self.written_paths = list(written_paths)
        super().__init__(
            f"The {export_format.upper()} export could not be written ({type(cause).__name__})."
        )


def write_export_files(*, prepared_batch: Any, documents: list[dict[str, Any]]) -> None:
    transcript_layout = normalize_transcript_layout(prepared_batch.settings.get("transcript_layout"))
    headers, table_rows = build_table_export_rows(
        documents,
        transcript_layout=transcript_layout,
        paragraph_options=paragraph_options(prepared_batch),
    )

    written_paths: list[str] = []
    for export_target in prepared_batch.export_targets:
        path = Path(export_target.path)
        try:
            if export_target.format == "docx":
                bundle_paths = write_docx_bundle(
                    path,
                    prepared_batch,
                    documents,
                    transcript_layout,
                )
                written_paths.extend(str(bundle_path) for bundle_path in bundle_paths)
                continue
            written = _write_export_target(
                path=path,
                export_format=export_target.format,
                prepared_batch=prepared_batch,
                documents=documents,
                transcript_layout=transcript_layout,
                headers=headers,
                table_rows=table_rows,
                document=None,
            )
        except Exception as error:  # noqa: BLE001 - preserve already committed output metadata
            raise ExportWriteError(
                export_format=export_target.format,
                failed_path=str(path),
                written_paths=written_paths,
                cause=error,
            ) from error
        if written:
            written_paths.append(str(path))


def write_single_document_exports(
    *,
    prepared_batch: Any,
    document: dict[str, Any],
    export_targets: list[Any],
) -> list[str]:
    transcript_layout = normalize_transcript_layout(prepared_batch.settings.get("transcript_layout"))
    headers, table_rows = build_table_export_rows(
        [document],
        transcript_layout=transcript_layout,
        paragraph_options=paragraph_options(prepared_batch),
    )

    written_paths: list[str] = []
    for export_target in export_targets:
        path = Path(export_target.path)
        try:
            written = _write_export_target(
                path=path,
                export_format=export_target.format,
                prepared_batch=prepared_batch,
                documents=[document],
                transcript_layout=transcript_layout,
                headers=headers,
                table_rows=table_rows,
                document=document,
            )
        except Exception as error:  # noqa: BLE001 - report all outputs committed before this failure
            raise ExportWriteError(
                export_format=export_target.format,
                failed_path=str(path),
                written_paths=written_paths,
                cause=error,
            ) from error
        if written:
            written_paths.append(str(path))
    return written_paths


def write_combined_document_exports(
    *,
    prepared_batch: Any,
    documents: list[dict[str, Any]],
    export_targets: list[Any],
) -> list[str]:
    """Checkpoint all completed documents into one target per selected format."""

    transcript_layout = normalize_transcript_layout(prepared_batch.settings.get("transcript_layout"))
    headers, table_rows = build_table_export_rows(
        documents,
        transcript_layout=transcript_layout,
        paragraph_options=paragraph_options(prepared_batch),
    )

    staged_targets: list[tuple[Any, Path, Path]] = []
    for export_target in export_targets:
        path = Path(export_target.path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = _temporary_export_path(path)
        try:
            written = _write_export_contents(
                path=temporary_path,
                export_format=export_target.format,
                prepared_batch=prepared_batch,
                documents=documents,
                transcript_layout=transcript_layout,
                headers=headers,
                table_rows=table_rows,
                document=None,
            )
        except Exception as error:  # noqa: BLE001 - no combined target has been published yet
            temporary_path.unlink(missing_ok=True)
            for _, _, staged_path in staged_targets:
                staged_path.unlink(missing_ok=True)
            raise ExportWriteError(
                export_format=export_target.format,
                failed_path=str(path),
                written_paths=[],
                cause=error,
            ) from error
        if written:
            staged_targets.append((export_target, path, temporary_path))
        else:
            temporary_path.unlink(missing_ok=True)

    written_paths: list[str] = []
    try:
        for export_target, path, temporary_path in staged_targets:
            try:
                temporary_path.replace(path)
            except Exception as error:  # noqa: BLE001 - report formats already committed
                raise ExportWriteError(
                    export_format=export_target.format,
                    failed_path=str(path),
                    written_paths=written_paths,
                    cause=error,
                ) from error
            written_paths.append(str(path))
    finally:
        for _, _, temporary_path in staged_targets:
            temporary_path.unlink(missing_ok=True)
    return written_paths


def _write_export_target(
    *,
    path: Path,
    export_format: str,
    prepared_batch: Any,
    documents: list[dict[str, Any]],
    transcript_layout: str,
    headers: list[str],
    table_rows: list[dict[str, Any]],
    document: dict[str, Any] | None,
) -> bool:
    """Write one format atomically so a failed writer leaves no partial target."""

    if export_format not in {"csv", "json", "xlsx", "docx"}:
        return False

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = _temporary_export_path(path)
    try:
        written = _write_export_contents(
            path=temporary_path,
            export_format=export_format,
            prepared_batch=prepared_batch,
            documents=documents,
            transcript_layout=transcript_layout,
            headers=headers,
            table_rows=table_rows,
            document=document,
        )
        if not written:
            return False
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return True


def _temporary_export_path(path: Path) -> Path:
    return path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp{path.suffix}")


def _write_export_contents(
    *,
    path: Path,
    export_format: str,
    prepared_batch: Any,
    documents: list[dict[str, Any]],
    transcript_layout: str,
    headers: list[str],
    table_rows: list[dict[str, Any]],
    document: dict[str, Any] | None,
) -> bool:
    if export_format == "csv":
        write_csv(path, headers, table_rows)
    elif export_format == "json":
        write_json(
            path,
            prepared_batch,
            table_rows,
            documents,
            transcript_layout,
        )
    elif export_format == "xlsx":
        write_xlsx(path, headers, table_rows)
    elif export_format == "docx":
        if document is not None:
            write_docx_document(
                path,
                prepared_batch,
                document,
                transcript_layout,
            )
        else:
            write_combined_docx_document(
                path,
                prepared_batch,
                documents,
                transcript_layout,
            )
    else:
        return False
    return True


def write_batch_overview(
    *,
    path: Path,
    rows: list[dict[str, Any]],
) -> None:
    headers = [
        "transcript_id",
        "source_media_file",
        "source_media_path",
        "json_path",
        "docx_path",
        "xlsx_path",
        "csv_path",
        "duration",
        "language",
        "speaker_count",
        "status",
        "error_message",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    write_xlsx(path, headers, rows)
