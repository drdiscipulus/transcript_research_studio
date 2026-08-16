from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from .table_writers import utc_timestamp
from .transcript_editor import inspect_transcript, load_transcript

EVIDENCE_PROJECT_SCHEMA_VERSION = "1.1"
EVIDENCE_PROJECT_EXTENSION = ".evidence.json"
MAX_EVIDENCE_PROJECT_BYTES = 128 * 1024**2
MAX_PROJECT_TRANSCRIPTS = 500
MAX_PROJECT_SEGMENTS = 100_000
SUPPORTED_TRANSCRIPT_EXTENSIONS = {".json", ".csv", ".xlsx", ".docx"}
PROJECT_COLLECTION_IDS = {
    "transcripts": "transcript_id",
    "evidence_items": "evidence_id",
    "codes": "code_id",
    "themes": "theme_id",
    "report_drafts": "draft_id",
    "suggestion_decisions": "decision_id",
    "ai_runs": "run_id",
}
_REVISION_CACHE_LOCK = threading.Lock()
_REVISION_CACHE: tuple[str, str, bytes] | None = None
_PROJECT_WRITE_LOCK = threading.RLock()


class EvidenceProjectConflictError(ValueError):
    """Raised when a file-backed mutation targets a stale project revision."""

    def __init__(self, message: str, *, current_revision: str = "") -> None:
        super().__init__(message)
        self.current_revision = current_revision


class EvidenceProjectOperationError(ValueError):
    """Raised for stable, user-actionable coding-project failures."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def create_evidence_project(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = payload if isinstance(payload, dict) else {}
    now = utc_timestamp()
    project_file = str(raw.get("project_file") or "").strip()
    path = resolve_project_file(project_file, must_exist=False) if project_file else None
    requested_name = str(raw.get("name") or "").strip()
    derived_name = path.name[: -len(EVIDENCE_PROJECT_EXTENSION)] if path else "Untitled Coding Project"
    name = requested_name or derived_name or "Untitled Coding Project"
    project = {
        "schema_version": EVIDENCE_PROJECT_SCHEMA_VERSION,
        "project_id": f"project_{uuid.uuid4().hex}",
        "name": name,
        "created_at": now,
        "updated_at": now,
        "research_focus": str(raw.get("research_focus") or "").strip(),
        "ai_settings": normalize_ai_settings(raw.get("ai_settings")),
        "transcripts": [],
        "evidence_items": [],
        "codes": [],
        "themes": [],
        "report_drafts": [],
        "suggestion_decisions": [],
        "ai_runs": [],
        "settings": default_project_settings(),
        "id_counters": default_id_counters(),
    }
    if path is None:
        return {
            "project": project,
            "project_file": None,
            "project_id": project["project_id"],
            "revision": "",
        }

    saved_project, revision = write_evidence_project_atomic(path, project)
    return project_payload(saved_project, path, revision)


def load_evidence_project(payload: dict[str, Any]) -> dict[str, Any]:
    path = resolve_project_file(payload.get("project_file"), must_exist=True)
    project, revision = read_evidence_project_file(path)
    remember_evidence_project_revision(path, revision, path.read_bytes())
    return project_payload(project, path, revision)


def read_evidence_project_file(path: Path) -> tuple[dict[str, Any], str]:
    try:
        file_size = path.stat().st_size
    except OSError as error:
        raise ValueError("Could not read coding project file metadata.") from error
    if file_size > MAX_EVIDENCE_PROJECT_BYTES:
        raise ValueError("Coding project file is too large.")
    try:
        raw_project = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("Coding project JSON is not valid.") from error
    project = normalize_evidence_project(raw_project)
    return project, evidence_project_revision(path)


def save_evidence_project(payload: dict[str, Any]) -> dict[str, Any]:
    return save_file_backed_project_updates(payload)


def save_file_backed_project_updates(payload: dict[str, Any]) -> dict[str, Any]:
    source_path = resolve_project_file(
        payload.get("source_project_file") or payload.get("project_file"),
        must_exist=False,
    )
    target_path = resolve_project_file(payload.get("project_file"), must_exist=False)
    expected_revision = str(payload.get("expected_revision") or "").strip()
    if not expected_revision:
        raise ValueError("Expected coding project revision is required.")
    if source_path.is_file():
        original_project, current_revision = read_evidence_project_file(source_path)
    else:
        current_revision = ""
        cached_project = cached_evidence_project_revision(source_path, expected_revision)
        if cached_project is None or source_path == target_path:
            raise EvidenceProjectConflictError(
                "The coding project file was removed. Save a copy to preserve local work.",
                current_revision="",
            )
        original_project = cached_project
    if current_revision != expected_revision:
        if source_path == target_path:
            raise EvidenceProjectConflictError(
                "The coding project changed outside the app. Reload it or save a copy.",
                current_revision=current_revision,
            )
        cached_project = cached_evidence_project_revision(source_path, expected_revision)
        if cached_project is None:
            raise EvidenceProjectConflictError(
                "The previous project revision is no longer available. Reload it before saving a copy.",
                current_revision=current_revision,
            )
        original_project = cached_project
    requested_project_id = str(payload.get("project_id") or "").strip()
    if requested_project_id != original_project["project_id"]:
        raise EvidenceProjectConflictError(
            "The selected file belongs to a different coding project. Reload it or save a copy.",
            current_revision=current_revision,
        )

    updates = payload.get("project_updates") if isinstance(payload.get("project_updates"), dict) else {}
    next_project = copy.deepcopy(original_project)
    for key in ("name", "research_focus", "ai_settings", "settings"):
        if key in updates:
            next_project[key] = copy.deepcopy(updates[key])
    next_project = normalize_evidence_project(next_project)

    if source_path != target_path and current_revision == expected_revision:
        latest_source_revision = evidence_project_revision(source_path)
        if latest_source_revision != expected_revision:
            cached_project = cached_evidence_project_revision(source_path, expected_revision)
            if cached_project is None:
                raise EvidenceProjectConflictError(
                    "The previous project revision is no longer available. Reload it before saving a copy.",
                    current_revision=latest_source_revision,
                )
            original_project = cached_project
            next_project = copy.deepcopy(original_project)
            for key in ("name", "research_focus", "ai_settings", "settings"):
                if key in updates:
                    next_project[key] = copy.deepcopy(updates[key])
            next_project = normalize_evidence_project(next_project)
    saved_project, revision = write_evidence_project_atomic(
        target_path,
        next_project,
        expected_revision=expected_revision if source_path == target_path else None,
    )
    return {
        "project_file": str(target_path),
        "project_id": saved_project["project_id"],
        "revision": revision,
        "project_patch": build_evidence_project_patch(original_project, saved_project),
    }


def project_payload(project: dict[str, Any], path: Path, revision: str) -> dict[str, Any]:
    return {
        "project": project,
        "project_file": str(path),
        "project_id": str(project.get("project_id") or ""),
        "revision": revision,
    }


def evidence_project_revision(path: Path) -> str:
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise ValueError("Could not read coding project file.") from error
    return digest


def write_evidence_project_atomic(
    path: Path,
    project: dict[str, Any],
    *,
    expected_revision: str | None = None,
) -> tuple[dict[str, Any], str]:
    with _PROJECT_WRITE_LOCK:
        return _write_evidence_project_atomic_unlocked(
            path,
            project,
            expected_revision=expected_revision,
        )


def _write_evidence_project_atomic_unlocked(
    path: Path,
    project: dict[str, Any],
    *,
    expected_revision: str | None = None,
) -> tuple[dict[str, Any], str]:
    """Persist a schema-1.1 project atomically and retain one previous-file backup."""

    path.parent.mkdir(parents=True, exist_ok=True)
    if expected_revision is not None:
        current_revision = evidence_project_revision(path) if path.is_file() else ""
        if current_revision != expected_revision:
            raise EvidenceProjectConflictError(
                "The coding project changed outside the app. Reload it or save a copy.",
                current_revision=current_revision,
            )

    next_project = copy.deepcopy(normalize_evidence_project(project))
    next_project["updated_at"] = utc_timestamp()
    serialized = json.dumps(next_project, indent=2, ensure_ascii=False).encode("utf-8")
    if len(serialized) > MAX_EVIDENCE_PROJECT_BYTES:
        raise ValueError("Coding project file is too large.")

    temporary_path: Path | None = None
    backup_temporary_path: Path | None = None
    try:
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())

        if path.is_file():
            backup_path = path.with_name(f"{path.name}.bak")
            backup_descriptor, backup_temporary_name = tempfile.mkstemp(
                prefix=f".{backup_path.name}.",
                suffix=".tmp",
                dir=path.parent,
            )
            backup_temporary_path = Path(backup_temporary_name)
            with os.fdopen(backup_descriptor, "wb") as backup_handle:
                backup_handle.write(path.read_bytes())
                backup_handle.flush()
                os.fsync(backup_handle.fileno())
            os.replace(backup_temporary_path, backup_path)
            backup_temporary_path = None

        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        for pending_path in (temporary_path, backup_temporary_path):
            if pending_path is not None:
                try:
                    pending_path.unlink(missing_ok=True)
                except OSError:
                    pass

    revision = hashlib.sha256(serialized).hexdigest()
    remember_evidence_project_revision(path, revision, serialized)
    return next_project, revision


def remember_evidence_project_revision(path: Path, revision: str, serialized: bytes) -> None:
    global _REVISION_CACHE
    with _REVISION_CACHE_LOCK:
        _REVISION_CACHE = (os.path.normcase(str(path)), revision, serialized)


def cached_evidence_project_revision(path: Path, revision: str) -> dict[str, Any] | None:
    with _REVISION_CACHE_LOCK:
        cached = _REVISION_CACHE
    if cached is None or cached[0] != os.path.normcase(str(path)) or cached[1] != revision:
        return None
    try:
        return normalize_evidence_project(json.loads(cached[2].decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None


def run_evidence_project_mutation(
    payload: dict[str, Any],
    operation: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Run a mutation from a validated compact file handle."""

    prepared, path, original_project, expected_revision = prepare_file_backed_payload(payload)
    result = operation(prepared)
    next_project = normalize_evidence_project(result.get("project"))
    saved_project, revision = write_evidence_project_atomic(
        path,
        next_project,
        expected_revision=expected_revision,
    )
    response = {key: value for key, value in result.items() if key != "project"}
    response.update(
        {
            "project_file": str(path),
            "project_id": saved_project["project_id"],
            "revision": revision,
            "project_patch": build_evidence_project_patch(original_project, saved_project),
        }
    )
    return response


def run_evidence_project_read(
    payload: dict[str, Any],
    operation: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Hydrate a read request from disk without sending the whole project over HTTP."""

    prepared, path, project, expected_revision = prepare_file_backed_payload(payload)
    result = operation(prepared)
    response = {key: value for key, value in result.items() if key != "project"}
    response.update(
        {
            "project_file": str(path),
            "project_id": project["project_id"],
            "revision": expected_revision,
        }
    )
    return response


def prepare_file_backed_payload(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], Path, dict[str, Any], str]:
    path = resolve_project_file(payload.get("project_file"), must_exist=False)
    if not path.is_file():
        raise EvidenceProjectConflictError(
            "The coding project file was removed. Reload it or save a copy.",
            current_revision="",
        )
    project, current_revision = read_evidence_project_file(path)
    expected_revision = str(payload.get("expected_revision") or "").strip()
    if not expected_revision:
        raise ValueError("Expected coding project revision is required.")
    if expected_revision != current_revision:
        raise EvidenceProjectConflictError(
            "The coding project changed outside the app. Reload it or save a copy.",
            current_revision=current_revision,
        )
    requested_project_id = str(payload.get("project_id") or "").strip()
    if not requested_project_id:
        raise ValueError("Coding project ID is required.")
    if requested_project_id != project["project_id"]:
        raise EvidenceProjectConflictError(
            "The selected file belongs to a different coding project. Reload it or save a copy.",
            current_revision=current_revision,
        )
    prepared = dict(payload)
    prepared["project"] = project
    return prepared, path, project, expected_revision


def build_evidence_project_patch(
    original_project: dict[str, Any],
    next_project: dict[str, Any],
) -> dict[str, Any]:
    set_values: dict[str, Any] = {}
    upsert: dict[str, list[dict[str, Any]]] = {}
    remove: dict[str, list[str]] = {}

    for key, value in next_project.items():
        if key in PROJECT_COLLECTION_IDS:
            continue
        if original_project.get(key) != value:
            set_values[key] = copy.deepcopy(value)

    for collection_name, id_field in PROJECT_COLLECTION_IDS.items():
        original_records = {
            str(record.get(id_field) or ""): record
            for record in original_project.get(collection_name, [])
            if isinstance(record, dict) and str(record.get(id_field) or "")
        }
        next_records = {
            str(record.get(id_field) or ""): record
            for record in next_project.get(collection_name, [])
            if isinstance(record, dict) and str(record.get(id_field) or "")
        }
        changed_records = [
            copy.deepcopy(record)
            for record_id, record in next_records.items()
            if original_records.get(record_id) != record
        ]
        removed_ids = [record_id for record_id in original_records if record_id not in next_records]
        if changed_records:
            upsert[collection_name] = changed_records
        if removed_ids:
            remove[collection_name] = removed_ids

    return {"set": set_values, "upsert": upsert, "remove": remove}


def preview_transcript_import(payload: dict[str, Any]) -> dict[str, Any]:
    """Inspect transcript inputs without mutating the project."""

    project = normalize_evidence_project(payload.get("project"))
    paths = transcript_import_paths(payload)
    candidates: list[dict[str, Any]] = []
    existing_fingerprints = {
        transcript_content_fingerprint(transcript)
        for transcript in project.get("transcripts", [])
        if isinstance(transcript, dict)
    }

    for path in paths:
        try:
            inspection = inspect_transcript({"transcript_file": str(path)})
            documents = [document for document in inspection.get("documents", []) if isinstance(document, dict)]
            if not documents:
                raise ValueError("No transcript documents were found in this file.")
            for document_index, document in enumerate(documents):
                document_id = str(document.get("id") or f"doc_{document_index + 1:06d}")
                try:
                    snapshot = build_transcript_snapshot(copy.deepcopy(project), path, document_id)
                    fingerprint = transcript_content_fingerprint(snapshot)
                    exact_duplicate = transcript_exists(project, str(path), document_id)
                    content_duplicate = bool(fingerprint and fingerprint in existing_fingerprints)
                    candidates.append(
                        import_candidate(
                            path,
                            document_id,
                            document_index,
                            snapshot,
                            fingerprint,
                            status="already_imported" if exact_duplicate or content_duplicate else "ready",
                            preferred=not (exact_duplicate or content_duplicate),
                            reason=(
                                "This transcript document is already in the coding project."
                                if exact_duplicate
                                else "Equivalent transcript content is already in the coding project."
                                if content_duplicate
                                else "Ready to import."
                            ),
                        )
                    )
                except Exception as error:  # noqa: BLE001 - one bad candidate must not abort the preview
                    candidates.append(problem_import_candidate(path, document_id, document_index, str(error)))
        except Exception as error:  # noqa: BLE001 - report per-file parser failures
            candidates.append(problem_import_candidate(path, "", 0, str(error)))

    mark_alternate_import_formats(candidates)
    return {
        "project": project,
        "candidates": candidates,
        "counts": import_preview_counts(candidates),
        "non_recursive": bool(payload.get("transcript_folder")),
    }


def import_transcript_candidates(payload: dict[str, Any]) -> dict[str, Any]:
    """Import selected preview candidates in one atomic project mutation."""

    project = normalize_evidence_project(payload.get("project"))
    selections = payload.get("candidates") if isinstance(payload.get("candidates"), list) else []
    if not selections:
        raise ValueError("Choose at least one transcript candidate to import.")

    imported: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for raw_selection in selections:
        if not isinstance(raw_selection, dict):
            continue
        source_path = Path(str(raw_selection.get("source_path") or "")).expanduser().resolve()
        document_id = str(raw_selection.get("source_document_id") or "").strip()
        candidate_id = str(raw_selection.get("candidate_id") or "").strip()
        allow_duplicate = bool(raw_selection.get("allow_duplicate"))
        result_stub = {
            "candidate_id": candidate_id,
            "source_path": str(source_path),
            "source_document_id": document_id,
        }
        try:
            validate_import_candidate_id(source_path, document_id, candidate_id)
            if transcript_exists(project, str(source_path), document_id):
                skipped.append({**result_stub, "reason": "already_imported"})
                continue
            snapshot = build_transcript_snapshot(project, source_path, document_id)
            fingerprint = transcript_content_fingerprint(snapshot)
            content_duplicate = any(
                transcript_content_fingerprint(transcript) == fingerprint
                for transcript in project.get("transcripts", [])
                if isinstance(transcript, dict)
            )
            if content_duplicate and not allow_duplicate:
                skipped.append({**result_stub, "reason": "equivalent_content"})
                continue
            ensure_transcript_guardrails(project, snapshot)
            project["transcripts"].append(snapshot)
            imported.append(snapshot)
        except Exception as error:  # noqa: BLE001 - commit valid candidates and report individual failures
            failed.append({**result_stub, "reason": str(error)})
    return {"project": project, "imported": imported, "skipped": skipped, "failed": failed}


def remove_project_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    transcript_id = str(payload.get("transcript_id") or "").strip()
    transcript = find_transcript(project, transcript_id)
    evidence_ids = [
        str(evidence.get("evidence_id") or "")
        for evidence in project.get("evidence_items", [])
        if isinstance(evidence, dict) and str(evidence.get("transcript_id") or "") == transcript_id
    ]
    if evidence_ids:
        raise EvidenceProjectOperationError(
            "transcript_has_evidence",
            f"This transcript has {len(evidence_ids)} evidence item(s). Remove those evidence items before removing the transcript.",
        )
    project["transcripts"] = [
        item
        for item in project.get("transcripts", [])
        if not (isinstance(item, dict) and str(item.get("transcript_id") or "") == transcript_id)
    ]
    return {"project": project, "transcript_id": transcript_id, "label": str(transcript.get("label") or transcript_id)}


def create_evidence_item(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    transcript_id = str(payload.get("transcript_id") or "").strip()
    selected_text = str(payload.get("selected_text") or "").strip()
    segment_ids = [
        str(segment_id).strip()
        for segment_id in payload.get("segment_ids", [])
        if str(segment_id).strip()
    ]
    if not transcript_id:
        raise ValueError("Transcript ID is required.")
    if not selected_text:
        raise ValueError("Evidence text is required.")
    if not segment_ids:
        raise ValueError("At least one source segment is required.")

    transcript = find_transcript(project, transcript_id)
    segments = [
        segment
        for segment in transcript.get("segments", [])
        if isinstance(segment, dict) and str(segment.get("segment_id") or "") in segment_ids
    ]
    found_segment_ids = {str(segment.get("segment_id") or "") for segment in segments}
    if not segments or found_segment_ids != set(segment_ids):
        raise ValueError("Evidence source segments were not found.")

    segment_lookup = {str(segment.get("segment_id") or ""): segment for segment in segments}
    segment_ranges = normalize_segment_ranges(payload.get("segment_ranges"), segment_ids, segment_lookup)

    created_codes: list[dict[str, Any]] = []
    for new_code in payload.get("new_codes") or []:
        if not isinstance(new_code, dict):
            raise ValueError("New evidence codes must be objects.")
        created = create_code(
            {
                "project": project,
                "name": new_code.get("name"),
                "color": new_code.get("color"),
                "description": new_code.get("description"),
                "inclusion_note": new_code.get("inclusion_note"),
                "exclusion_note": new_code.get("exclusion_note"),
                "example_evidence_ids": new_code.get("example_evidence_ids"),
                "memo": new_code.get("memo"),
            }
        )
        project = created["project"]
        created_code = created["code"]
        created_codes.append({**created_code, "client_id": str(new_code.get("client_id") or "")})

    requested_code_ids = [
        *normalize_id_list(payload.get("code_ids")),
        *[str(code["code_id"]) for code in created_codes],
    ]

    now = utc_timestamp()
    evidence = {
        "evidence_id": next_project_id(project, "evidence", "E"),
        "transcript_id": transcript_id,
        "source_file": str(transcript.get("source_file") or ""),
        "source_document_id": str(transcript.get("source_document_id") or ""),
        "segment_ids": [str(segment.get("segment_id") or "") for segment in segments],
        "speaker": common_speaker_label(segments),
        "start": first_number(segment.get("start") for segment in segments),
        "end": last_number(segment.get("end") for segment in segments),
        "selected_text": selected_text,
        "segment_ranges": segment_ranges,
        "code_ids": normalize_existing_code_ids(project, requested_code_ids),
        "memo": str(payload.get("memo") or ""),
        "created_at": now,
        "updated_at": now,
    }
    project["evidence_items"].append(evidence)
    for raw_code, created_code in zip(payload.get("new_codes") or [], created_codes):
        if isinstance(raw_code, dict) and raw_code.get("use_current_evidence_as_example"):
            code = find_code(project, str(created_code.get("code_id") or ""))
            code["example_evidence_ids"] = normalize_existing_evidence_ids(
                project,
                [*normalize_id_list(code.get("example_evidence_ids")), evidence["evidence_id"]],
            )
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=evidence["evidence_id"],
        result_ids=[evidence["evidence_id"], *[str(code["code_id"]) for code in created_codes]],
    )
    return {
        "project": project,
        "evidence": evidence,
        "created_codes": created_codes,
        "ai_decisions": recorded_decisions,
    }


def update_evidence_item(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    evidence_id = str(payload.get("evidence_id") or "").strip()
    find_evidence_item(project, evidence_id)

    created_codes: list[dict[str, Any]] = []
    for new_code in payload.get("new_codes") or []:
        if not isinstance(new_code, dict):
            raise ValueError("New evidence codes must be objects.")
        created = create_code(
            {
                "project": project,
                "name": new_code.get("name"),
                "color": new_code.get("color"),
                "description": new_code.get("description"),
                "inclusion_note": new_code.get("inclusion_note"),
                "exclusion_note": new_code.get("exclusion_note"),
                "example_evidence_ids": new_code.get("example_evidence_ids"),
                "memo": new_code.get("memo"),
            }
        )
        project = created["project"]
        created_code = created["code"]
        created_codes.append({**created_code, "client_id": str(new_code.get("client_id") or "")})

    evidence = find_evidence_item(project, evidence_id)
    if "selected_text" in payload:
        selected_text = str(payload.get("selected_text") or "").strip()
        if not selected_text:
            raise ValueError("Evidence text is required.")
        evidence["selected_text"] = selected_text
    if "memo" in payload:
        evidence["memo"] = str(payload.get("memo") or "")
    if "code_ids" in payload or created_codes:
        evidence["code_ids"] = normalize_existing_code_ids(
            project,
            [
                *normalize_id_list(payload.get("code_ids", evidence.get("code_ids"))),
                *[str(code["code_id"]) for code in created_codes],
            ],
        )
    for raw_code, created_code in zip(payload.get("new_codes") or [], created_codes):
        if isinstance(raw_code, dict) and raw_code.get("use_current_evidence_as_example"):
            code = find_code(project, str(created_code.get("code_id") or ""))
            code["example_evidence_ids"] = normalize_existing_evidence_ids(
                project,
                [*normalize_id_list(code.get("example_evidence_ids")), evidence_id],
            )
    evidence["updated_at"] = utc_timestamp()
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=evidence_id,
        result_ids=[evidence_id, *[str(code["code_id"]) for code in created_codes]],
    )
    return {
        "project": project,
        "evidence": evidence,
        "created_codes": created_codes,
        "ai_decisions": recorded_decisions,
    }


def append_staged_ai_decisions(
    project: dict[str, Any],
    value: Any,
    *,
    target_reference: str,
    result_ids: list[str],
) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("AI decisions must be a list.")
    run_lookup = {
        str(run.get("run_id") or ""): run
        for run in project.get("ai_runs", [])
        if isinstance(run, dict)
    }
    recorded: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("AI decisions must contain objects.")
        run_id = str(raw.get("run_id") or "").strip()
        suggestion_id = str(raw.get("suggestion_id") or "").strip()
        decision = str(raw.get("decision") or "").strip().lower()
        if run_id not in run_lookup:
            raise ValueError("The AI run for this decision was not found in the project.")
        if not suggestion_id:
            raise ValueError("AI suggestion ID is required.")
        if decision not in {"accepted", "edited", "rejected"}:
            raise ValueError("AI decision must be accepted, edited, or rejected.")
        run = run_lookup[run_id]
        record = normalize_suggestion_decision_record(
            {
                "decision_id": f"decision_{uuid.uuid4().hex}",
                "run_id": run_id,
                "suggestion_id": suggestion_id,
                "task": str(raw.get("task") or run.get("task") or ""),
                "target_reference": str(raw.get("target_reference") or target_reference),
                "decision": decision,
                "result_ids": normalize_id_list(raw.get("result_ids")) or result_ids,
                "note": str(raw.get("note") or ""),
                "provider_id": str(run.get("provider_id") or ""),
                "model_id": str(run.get("model_id") or ""),
                "created_at": utc_timestamp(),
            }
        )
        project["suggestion_decisions"].append(record)
        recorded.append(record)
    return recorded


def delete_evidence_item(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    evidence_id = str(payload.get("evidence_id") or "").strip()
    if not evidence_id:
        raise ValueError("Evidence ID is required.")
    evidence_items = project.get("evidence_items", [])
    next_items = [
        evidence
        for evidence in evidence_items
        if not (isinstance(evidence, dict) and str(evidence.get("evidence_id") or "") == evidence_id)
    ]
    if len(next_items) == len(evidence_items):
        raise ValueError("Evidence item was not found.")
    project["evidence_items"] = next_items
    for code in project.get("codes", []):
        if not isinstance(code, dict):
            continue
        current_examples = normalize_id_list(code.get("example_evidence_ids"))
        code["example_evidence_ids"] = [
            existing_id
            for existing_id in current_examples
            if existing_id != evidence_id
        ]
        if code["example_evidence_ids"] != current_examples:
            code["updated_at"] = utc_timestamp()
    return {"project": project, "evidence_id": evidence_id}


def create_code(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Code name is required.")
    ensure_unique_code_name(project, name)
    now = utc_timestamp()
    code = {
        "code_id": next_project_id(project, "code", "C"),
        "name": name,
        "description": str(payload.get("description") or "").strip(),
        "inclusion_note": str(payload.get("inclusion_note") or "").strip(),
        "exclusion_note": str(payload.get("exclusion_note") or "").strip(),
        "example_evidence_ids": normalize_existing_evidence_ids(project, payload.get("example_evidence_ids")),
        "color": normalize_code_color(payload.get("color")),
        "memo": str(payload.get("memo") or ""),
        "created_at": now,
        "updated_at": now,
    }
    project["codes"].append(code)
    example_ids = set(code["example_evidence_ids"])
    for evidence in project.get("evidence_items", []):
        if not isinstance(evidence, dict) or str(evidence.get("evidence_id") or "") not in example_ids:
            continue
        current_code_ids = normalize_id_list(evidence.get("code_ids"))
        evidence["code_ids"] = normalize_id_list([*current_code_ids, code["code_id"]])
        if evidence["code_ids"] != current_code_ids:
            evidence["updated_at"] = now
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=code["code_id"],
        result_ids=[code["code_id"]],
    )
    return {"project": project, "code": code, "ai_decisions": recorded_decisions}


def update_code(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    code = find_code(project, str(payload.get("code_id") or "").strip())
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("Code name is required.")
        ensure_unique_code_name(project, name, ignore_code_id=str(code.get("code_id") or ""))
        code["name"] = name
    if "description" in payload:
        code["description"] = str(payload.get("description") or "").strip()
    if "inclusion_note" in payload:
        code["inclusion_note"] = str(payload.get("inclusion_note") or "").strip()
    if "exclusion_note" in payload:
        code["exclusion_note"] = str(payload.get("exclusion_note") or "").strip()
    if "example_evidence_ids" in payload:
        code["example_evidence_ids"] = normalize_existing_evidence_ids(project, payload.get("example_evidence_ids"))
        example_ids = set(code["example_evidence_ids"])
        for evidence in project.get("evidence_items", []):
            if not isinstance(evidence, dict) or str(evidence.get("evidence_id") or "") not in example_ids:
                continue
            current_code_ids = normalize_id_list(evidence.get("code_ids"))
            evidence["code_ids"] = normalize_id_list([*current_code_ids, code["code_id"]])
            if evidence["code_ids"] != current_code_ids:
                evidence["updated_at"] = utc_timestamp()
    if "color" in payload:
        code["color"] = normalize_code_color(payload.get("color"))
    if "memo" in payload:
        code["memo"] = str(payload.get("memo") or "")
    code["updated_at"] = utc_timestamp()
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=str(code.get("code_id") or ""),
        result_ids=[str(code.get("code_id") or "")],
    )
    return {"project": project, "code": code, "ai_decisions": recorded_decisions}


def delete_code(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    code_id = str(payload.get("code_id") or "").strip()
    if not code_id:
        raise ValueError("Code ID is required.")
    find_code(project, code_id)
    project["codes"] = [
        code
        for code in project.get("codes", [])
        if not (isinstance(code, dict) and str(code.get("code_id") or "") == code_id)
    ]
    for evidence in project.get("evidence_items", []):
        if not isinstance(evidence, dict):
            continue
        evidence["code_ids"] = [existing_id for existing_id in normalize_id_list(evidence.get("code_ids")) if existing_id != code_id]
    for theme in project.get("themes", []):
        if not isinstance(theme, dict):
            continue
        theme["code_ids"] = [existing_id for existing_id in normalize_id_list(theme.get("code_ids")) if existing_id != code_id]
    return {"project": project, "code_id": code_id}


def merge_code(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    source_code_id = str(payload.get("source_code_id") or "").strip()
    target_code_id = str(payload.get("target_code_id") or "").strip()
    if not source_code_id or not target_code_id:
        raise ValueError("Source and target code IDs are required.")
    if source_code_id == target_code_id:
        raise ValueError("Choose two different codes to merge.")
    source_code = find_code(project, source_code_id)
    target_code = find_code(project, target_code_id)
    now = utc_timestamp()

    for evidence in project.get("evidence_items", []):
        if not isinstance(evidence, dict):
            continue
        current_code_ids = normalize_id_list(evidence.get("code_ids"))
        evidence["code_ids"] = replace_id(current_code_ids, source_code_id, target_code_id)
        if evidence["code_ids"] != current_code_ids:
            evidence["updated_at"] = now
    for theme in project.get("themes", []):
        if not isinstance(theme, dict):
            continue
        current_code_ids = normalize_id_list(theme.get("code_ids"))
        theme["code_ids"] = replace_id(current_code_ids, source_code_id, target_code_id)
        if theme["code_ids"] != current_code_ids:
            theme["updated_at"] = now
    target_code["example_evidence_ids"] = normalize_existing_evidence_ids(
        project,
        [
            *normalize_id_list(target_code.get("example_evidence_ids")),
            *normalize_id_list(source_code.get("example_evidence_ids")),
        ],
    )
    for field in ["description", "inclusion_note", "exclusion_note", "memo"]:
        if field in payload:
            target_code[field] = str(payload.get(field) or "")
    project["codes"] = [
        code
        for code in project.get("codes", [])
        if not (isinstance(code, dict) and str(code.get("code_id") or "") == source_code_id)
    ]
    target_code["updated_at"] = now
    return {"project": project, "source_code_id": source_code_id, "target_code": target_code}


def create_theme(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Theme name is required.")
    ensure_unique_theme_name(project, name)
    now = utc_timestamp()
    theme = {
        "theme_id": next_project_id(project, "theme", "TH"),
        "name": name,
        "description": str(payload.get("description") or "").strip(),
        "color": normalize_code_color(payload.get("color")),
        "code_ids": normalize_existing_code_ids(project, payload.get("code_ids")),
        "memo": str(payload.get("memo") or ""),
        "created_at": now,
        "updated_at": now,
    }
    project["themes"].append(theme)
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=theme["theme_id"],
        result_ids=[theme["theme_id"]],
    )
    return {"project": project, "theme": theme, "ai_decisions": recorded_decisions}


def update_theme(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    theme = find_theme(project, str(payload.get("theme_id") or "").strip())
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("Theme name is required.")
        ensure_unique_theme_name(project, name, ignore_theme_id=str(theme.get("theme_id") or ""))
        theme["name"] = name
    if "description" in payload:
        theme["description"] = str(payload.get("description") or "").strip()
    if "color" in payload:
        theme["color"] = normalize_code_color(payload.get("color"))
    if "code_ids" in payload:
        theme["code_ids"] = normalize_existing_code_ids(project, payload.get("code_ids"))
    if "memo" in payload:
        theme["memo"] = str(payload.get("memo") or "")
    theme["updated_at"] = utc_timestamp()
    recorded_decisions = append_staged_ai_decisions(
        project,
        payload.get("ai_decisions"),
        target_reference=str(theme.get("theme_id") or ""),
        result_ids=[str(theme.get("theme_id") or "")],
    )
    return {"project": project, "theme": theme, "ai_decisions": recorded_decisions}


def delete_theme(payload: dict[str, Any]) -> dict[str, Any]:
    project = normalize_evidence_project(payload.get("project"))
    theme_id = str(payload.get("theme_id") or "").strip()
    if not theme_id:
        raise ValueError("Theme ID is required.")
    find_theme(project, theme_id)
    project["themes"] = [
        theme
        for theme in project.get("themes", [])
        if not (isinstance(theme, dict) and str(theme.get("theme_id") or "") == theme_id)
    ]
    return {"project": project, "theme_id": theme_id}


def normalize_evidence_project(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Coding project payload is required.")
    schema_version = str(value.get("schema_version") or "").strip()
    if schema_version != EVIDENCE_PROJECT_SCHEMA_VERSION:
        raise ValueError(f"Unsupported coding project schema version: {schema_version or 'missing'}.")

    project_id = str(value.get("project_id") or "").strip()
    if not project_id:
        raise ValueError("Coding project is missing project_id.")

    project = copy.deepcopy(value)
    project["name"] = str(project.get("name") or "Untitled Coding Project").strip() or "Untitled Coding Project"
    project["created_at"] = str(project.get("created_at") or "").strip() or utc_timestamp()
    project["updated_at"] = str(project.get("updated_at") or "").strip() or project["created_at"]
    project["research_focus"] = str(project.get("research_focus") or "")
    project["ai_settings"] = normalize_ai_settings(project.get("ai_settings"))
    project["settings"] = normalize_project_settings(project.get("settings"))
    project["id_counters"] = normalize_id_counters(project.get("id_counters"))

    for collection_name in ["transcripts", "evidence_items", "codes", "themes", "report_drafts", "suggestion_decisions", "ai_runs"]:
        collection = project.get(collection_name)
        if collection is None:
            project[collection_name] = []
            continue
        if not isinstance(collection, list):
            raise ValueError(f"Coding project field must be a list: {collection_name}.")

    transcript_lookup = {
        str(transcript.get("transcript_id") or ""): transcript
        for transcript in project["transcripts"]
        if isinstance(transcript, dict)
    }
    project["evidence_items"] = [
        normalize_evidence_record(evidence, transcript_lookup)
        for evidence in project["evidence_items"]
        if isinstance(evidence, dict)
    ]
    project["codes"] = [normalize_code_record(code) for code in project["codes"] if isinstance(code, dict)]
    project["themes"] = [normalize_theme_record(theme) for theme in project["themes"] if isinstance(theme, dict)]
    code_ids = {str(code.get("code_id") or "") for code in project["codes"]}
    evidence_by_id = {
        str(evidence.get("evidence_id") or ""): evidence
        for evidence in project["evidence_items"]
    }
    for evidence in project["evidence_items"]:
        evidence["code_ids"] = [code_id for code_id in normalize_id_list(evidence.get("code_ids")) if code_id in code_ids]
    for code in project["codes"]:
        code_id = str(code.get("code_id") or "")
        valid_examples = [
            evidence_id
            for evidence_id in normalize_id_list(code.get("example_evidence_ids"))
            if evidence_id in evidence_by_id
        ]
        code["example_evidence_ids"] = valid_examples
        for evidence_id in valid_examples:
            evidence = evidence_by_id[evidence_id]
            evidence["code_ids"] = normalize_id_list([*normalize_id_list(evidence.get("code_ids")), code_id])
    for theme in project["themes"]:
        theme["code_ids"] = [code_id for code_id in normalize_id_list(theme.get("code_ids")) if code_id in code_ids]
    project["report_drafts"] = [
        normalize_report_draft_record(report_draft)
        for report_draft in project["report_drafts"]
        if isinstance(report_draft, dict)
    ]
    project["ai_runs"] = [
        normalize_ai_run_record(run)
        for run in project["ai_runs"]
        if isinstance(run, dict)
    ]
    project["suggestion_decisions"] = [
        normalize_suggestion_decision_record(decision)
        for decision in project["suggestion_decisions"]
        if isinstance(decision, dict)
    ]

    return project


def normalize_segment_ranges(
    value: Any,
    segment_ids: list[str],
    segment_lookup: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ValueError("Evidence segment ranges are required.")
    ranges: dict[str, dict[str, Any]] = {}
    for raw_segment_id, raw_anchor in value.items():
        segment_id = str(raw_segment_id).strip()
        if not segment_id or not isinstance(raw_anchor, dict):
            raise ValueError("Evidence segment ranges must contain valid segment anchors.")
        start_offset = raw_anchor.get("start_offset")
        end_offset = raw_anchor.get("end_offset")
        if isinstance(start_offset, bool) or not isinstance(start_offset, int):
            raise ValueError(f"Evidence start offset must be an integer: {segment_id}")
        if isinstance(end_offset, bool) or not isinstance(end_offset, int):
            raise ValueError(f"Evidence end offset must be an integer: {segment_id}")
        segment = segment_lookup.get(segment_id)
        if segment is None:
            raise ValueError(f"Evidence source segment was not found: {segment_id}")
        segment_text = str(segment.get("text") or "")
        excerpt = str(raw_anchor.get("excerpt") or "")
        if start_offset < 0 or end_offset <= start_offset or end_offset > len(segment_text):
            raise ValueError(f"Evidence segment range is outside the source segment: {segment_id}")
        if not excerpt or segment_text[start_offset:end_offset] != excerpt:
            raise ValueError(f"Evidence segment range does not match source text: {segment_id}")
        ranges[segment_id] = {
            "start_offset": start_offset,
            "end_offset": end_offset,
            "excerpt": excerpt,
        }
    if list(ranges) != segment_ids:
        raise ValueError("Evidence segment ranges must match the ordered source segment IDs.")
    return ranges


def normalize_evidence_record(
    value: dict[str, Any],
    transcript_lookup: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    evidence = copy.deepcopy(value)
    transcript_id = str(evidence.get("transcript_id") or "").strip()
    transcript = transcript_lookup.get(transcript_id)
    if transcript is None:
        raise ValueError(f"Evidence transcript was not found: {transcript_id or 'missing'}")
    segment_ids = normalize_id_list(evidence.get("segment_ids"))
    segment_lookup = {
        str(segment.get("segment_id") or ""): segment
        for segment in transcript.get("segments", [])
        if isinstance(segment, dict)
    }
    evidence["segment_ids"] = segment_ids
    evidence["segment_ranges"] = normalize_segment_ranges(
        evidence.get("segment_ranges"),
        segment_ids,
        segment_lookup,
    )
    evidence["selected_text"] = str(evidence.get("selected_text") or "").strip()
    if not evidence["selected_text"]:
        raise ValueError("Evidence text is required.")
    evidence["code_ids"] = normalize_id_list(evidence.get("code_ids"))
    evidence["memo"] = str(evidence.get("memo") or "")
    return evidence


def find_evidence_item(project: dict[str, Any], evidence_id: str) -> dict[str, Any]:
    if not evidence_id:
        raise ValueError("Evidence ID is required.")
    for evidence in project.get("evidence_items", []):
        if isinstance(evidence, dict) and str(evidence.get("evidence_id") or "") == evidence_id:
            return evidence
    raise ValueError("Evidence item was not found.")


def find_code(project: dict[str, Any], code_id: str) -> dict[str, Any]:
    if not code_id:
        raise ValueError("Code ID is required.")
    for code in project.get("codes", []):
        if isinstance(code, dict) and str(code.get("code_id") or "") == code_id:
            return code
    raise ValueError("Code was not found.")


def find_theme(project: dict[str, Any], theme_id: str) -> dict[str, Any]:
    if not theme_id:
        raise ValueError("Theme ID is required.")
    for theme in project.get("themes", []):
        if isinstance(theme, dict) and str(theme.get("theme_id") or "") == theme_id:
            return theme
    raise ValueError("Theme was not found.")


def ensure_unique_code_name(project: dict[str, Any], name: str, *, ignore_code_id: str = "") -> None:
    normalized_name = name.casefold()
    for code in project.get("codes", []):
        if not isinstance(code, dict):
            continue
        if ignore_code_id and str(code.get("code_id") or "") == ignore_code_id:
            continue
        if str(code.get("name") or "").strip().casefold() == normalized_name:
            raise ValueError("A code with this name already exists.")


def ensure_unique_theme_name(project: dict[str, Any], name: str, *, ignore_theme_id: str = "") -> None:
    normalized_name = name.casefold()
    for theme in project.get("themes", []):
        if not isinstance(theme, dict):
            continue
        if ignore_theme_id and str(theme.get("theme_id") or "") == ignore_theme_id:
            continue
        if str(theme.get("name") or "").strip().casefold() == normalized_name:
            raise ValueError("A theme with this name already exists.")


def normalize_existing_code_ids(project: dict[str, Any], value: Any) -> list[str]:
    code_ids = normalize_id_list(value)
    existing_ids = {
        str(code.get("code_id") or "")
        for code in project.get("codes", [])
        if isinstance(code, dict)
    }
    missing_ids = [code_id for code_id in code_ids if code_id not in existing_ids]
    if missing_ids:
        raise ValueError(f"Code was not found: {missing_ids[0]}.")
    return code_ids


def normalize_existing_evidence_ids(project: dict[str, Any], value: Any) -> list[str]:
    evidence_ids = normalize_id_list(value)
    existing_ids = {
        str(evidence.get("evidence_id") or "")
        for evidence in project.get("evidence_items", [])
        if isinstance(evidence, dict)
    }
    missing_ids = [evidence_id for evidence_id in evidence_ids if evidence_id not in existing_ids]
    if missing_ids:
        raise ValueError(f"Evidence item was not found: {missing_ids[0]}.")
    return evidence_ids


def normalize_code_record(value: dict[str, Any]) -> dict[str, Any]:
    code = copy.deepcopy(value)
    code["code_id"] = str(code.get("code_id") or "")
    code["name"] = str(code.get("name") or "").strip()
    code["description"] = str(code.get("description") or "").strip()
    code["inclusion_note"] = str(code.get("inclusion_note") or "").strip()
    code["exclusion_note"] = str(code.get("exclusion_note") or "").strip()
    code["example_evidence_ids"] = normalize_id_list(code.get("example_evidence_ids"))
    code["color"] = normalize_code_color(code.get("color"))
    code["memo"] = str(code.get("memo") or "")
    code["created_at"] = str(code.get("created_at") or "")
    code["updated_at"] = str(code.get("updated_at") or code.get("created_at") or "")
    return code


def normalize_theme_record(value: dict[str, Any]) -> dict[str, Any]:
    theme = copy.deepcopy(value)
    theme["theme_id"] = str(theme.get("theme_id") or "")
    theme["name"] = str(theme.get("name") or "").strip()
    theme["description"] = str(theme.get("description") or "").strip()
    theme["color"] = normalize_code_color(theme.get("color"))
    theme["code_ids"] = normalize_id_list(theme.get("code_ids"))
    theme["memo"] = str(theme.get("memo") or "")
    theme["created_at"] = str(theme.get("created_at") or "")
    theme["updated_at"] = str(theme.get("updated_at") or theme.get("created_at") or "")
    return theme


def normalize_report_draft_record(value: dict[str, Any]) -> dict[str, Any]:
    draft = copy.deepcopy(value)
    draft["draft_id"] = str(draft.get("draft_id") or "")
    draft["title"] = str(draft.get("title") or "").strip()
    draft["body"] = str(draft.get("body") or "")
    draft["source_suggestion_id"] = str(draft.get("source_suggestion_id") or "")
    draft["created_at"] = str(draft.get("created_at") or "")
    draft["updated_at"] = str(draft.get("updated_at") or draft.get("created_at") or "")
    return draft


def normalize_code_color(value: Any) -> str:
    color = str(value or "#0f766e").strip()
    if len(color) == 7 and color.startswith("#"):
        digits = color[1:]
        if all(character in "0123456789abcdefABCDEF" for character in digits):
            return f"#{digits.lower()}"
    return "#0f766e"


def find_transcript(project: dict[str, Any], transcript_id: str) -> dict[str, Any]:
    for transcript in project.get("transcripts", []):
        if isinstance(transcript, dict) and str(transcript.get("transcript_id") or "") == transcript_id:
            return transcript
    raise ValueError("Transcript was not found in this coding project.")


def common_speaker_label(segments: list[dict[str, Any]]) -> str:
    speakers = {
        str(segment.get("speaker") or "").strip()
        for segment in segments
        if str(segment.get("speaker") or "").strip()
    }
    if len(speakers) == 1:
        return next(iter(speakers))
    return ""


def first_number(values: Any) -> float | None:
    numbers = [number for number in (float_or_none(value) for value in values) if number is not None]
    return min(numbers) if numbers else None


def last_number(values: Any) -> float | None:
    numbers = [number for number in (float_or_none(value) for value in values) if number is not None]
    return max(numbers) if numbers else None


def normalize_id_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    ids: list[str] = []
    for raw_id in value:
        normalized = str(raw_id).strip()
        if normalized and normalized not in ids:
            ids.append(normalized)
    return ids


def replace_id(ids: list[str], source_id: str, target_id: str) -> list[str]:
    replaced: list[str] = []
    for existing_id in ids:
        next_id = target_id if existing_id == source_id else existing_id
        if next_id and next_id not in replaced:
            replaced.append(next_id)
    return replaced


def build_transcript_snapshot(
    project: dict[str, Any],
    path: Path,
    document_id: str,
    *,
    existing_transcript_id: str | None = None,
    imported_at: str = "",
) -> dict[str, Any]:
    loaded = load_transcript({"transcript_file": str(path), "document_id": document_id})
    now = utc_timestamp()
    transcript_id = existing_transcript_id or next_project_id(project, "transcript", "T")
    metadata = loaded.get("metadata") if isinstance(loaded.get("metadata"), dict) else {}
    label = str(metadata.get("file_name") or path.name).strip() or path.name
    return {
        "transcript_id": transcript_id,
        "label": label,
        "source_file": str(path),
        "source_document_id": str(loaded.get("source_document_id") or document_id),
        "imported_at": imported_at or now,
        "refreshed_at": now if existing_transcript_id else None,
        "language": str(loaded.get("language") or ""),
        "speakers": normalize_transcript_speakers(loaded.get("speakers")),
        "segments": normalize_transcript_segments(loaded.get("segments")),
        "metadata": metadata,
        "validation_issues": loaded.get("validation_issues") if isinstance(loaded.get("validation_issues"), list) else [],
    }


def normalize_transcript_speakers(value: Any) -> list[dict[str, str]]:
    speakers: list[dict[str, str]] = []
    if not isinstance(value, list):
        return speakers
    for raw_speaker in value:
        if not isinstance(raw_speaker, dict):
            continue
        speaker_id = str(raw_speaker.get("id") or "").strip()
        if not speaker_id:
            continue
        speakers.append({"id": speaker_id, "name": str(raw_speaker.get("name") or speaker_id).strip() or speaker_id})
    return speakers


def normalize_transcript_segments(value: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    if not isinstance(value, list):
        return segments
    for index, raw_segment in enumerate(value, start=1):
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "segment_id": str(raw_segment.get("id") or f"seg_{index:06d}"),
                "start": raw_segment.get("start") if raw_segment.get("start") is not None else None,
                "end": raw_segment.get("end") if raw_segment.get("end") is not None else None,
                "speaker": str(raw_segment.get("speaker") or ""),
                "text": text,
            }
        )
    return segments


def transcript_exists(project: dict[str, Any], source_file: str, document_id: str) -> bool:
    normalized_source = str(Path(source_file).expanduser().resolve())
    for transcript in project.get("transcripts", []):
        if not isinstance(transcript, dict):
            continue
        try:
            existing_source = str(Path(str(transcript.get("source_file") or "")).expanduser().resolve())
        except OSError:
            existing_source = str(transcript.get("source_file") or "")
        if existing_source == normalized_source and str(transcript.get("source_document_id") or "") == document_id:
            return True
    return False


def transcript_import_paths(payload: dict[str, Any]) -> list[Path]:
    transcript_file = str(payload.get("transcript_file") or "").strip()
    transcript_folder = str(payload.get("transcript_folder") or "").strip()
    if bool(transcript_file) == bool(transcript_folder):
        raise ValueError("Choose either one transcript file or one transcript folder.")
    if transcript_file:
        path = Path(transcript_file).expanduser().resolve()
        if not path.is_file():
            raise ValueError("Transcript file does not exist.")
        if path.suffix.lower() not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
            raise ValueError("Only JSON, CSV, XLSX, and DOCX transcripts are supported.")
        return [path]
    folder = Path(transcript_folder).expanduser().resolve()
    if not folder.is_dir():
        raise ValueError("Transcript folder does not exist.")
    return [
        path.resolve()
        for path in sorted(folder.iterdir(), key=lambda candidate: candidate.name.lower())
        if path.is_file() and path.suffix.lower() in SUPPORTED_TRANSCRIPT_EXTENSIONS
    ]
def import_candidate(
    path: Path,
    document_id: str,
    document_index: int,
    snapshot: dict[str, Any],
    fingerprint: str,
    *,
    status: str,
    preferred: bool,
    reason: str,
) -> dict[str, Any]:
    return {
        "candidate_id": transcript_import_candidate_id(path, document_id),
        "source_path": str(path),
        "source_document_id": document_id,
        "document_index": document_index,
        "format": path.suffix.lower().lstrip("."),
        "logical_fingerprint": fingerprint,
        "logical_group": transcript_logical_group(path, document_index),
        "title": str(snapshot.get("label") or path.name),
        "segment_count": len(snapshot.get("segments") or []),
        "status": status,
        "preferred": preferred,
        "reason": reason,
    }


def problem_import_candidate(path: Path, document_id: str, document_index: int, reason: str) -> dict[str, Any]:
    return {
        "candidate_id": transcript_import_candidate_id(path, document_id),
        "source_path": str(path),
        "source_document_id": document_id,
        "document_index": document_index,
        "format": path.suffix.lower().lstrip("."),
        "logical_fingerprint": "",
        "logical_group": transcript_logical_group(path, document_index),
        "title": path.name,
        "segment_count": 0,
        "status": "problem",
        "preferred": False,
        "reason": reason or "Transcript could not be read.",
    }


def transcript_import_candidate_id(path: Path, document_id: str) -> str:
    try:
        stat = path.stat()
        identity = f"{path}|{document_id}|{stat.st_size}|{stat.st_mtime_ns}"
    except OSError:
        identity = f"{path}|{document_id}|missing"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def validate_import_candidate_id(path: Path, document_id: str, candidate_id: str) -> None:
    if not candidate_id or candidate_id != transcript_import_candidate_id(path, document_id):
        raise ValueError("Transcript candidate changed after preview. Preview the import again.")
    if not path.is_file() or path.suffix.lower() not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
        raise ValueError("Transcript candidate is no longer available.")


def transcript_content_fingerprint(transcript: dict[str, Any]) -> str:
    normalized = [
        normalize_comparable_text(str(segment.get("text") or ""))
        for segment in transcript.get("segments", [])
        if isinstance(segment, dict) and str(segment.get("text") or "").strip()
    ]
    if not normalized:
        return ""
    return hashlib.sha256("\n".join(normalized).encode("utf-8")).hexdigest()


def normalize_comparable_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def transcript_logical_group(path: Path, document_index: int) -> str:
    normalized_parent = os.path.normcase(str(path.parent))
    normalized_stem = re.sub(r"[^a-z0-9]+", "_", path.stem.casefold()).strip("_")
    return f"{normalized_parent}|{normalized_stem}|{document_index}"


def mark_alternate_import_formats(candidates: list[dict[str, Any]]) -> None:
    format_priority = {"json": 0, "xlsx": 1, "csv": 2, "docx": 3}
    groups: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        if candidate.get("status") != "ready":
            continue
        group_key = str(candidate.get("logical_fingerprint") or candidate.get("logical_group") or candidate.get("candidate_id"))
        groups.setdefault(group_key, []).append(candidate)
    for grouped_candidates in groups.values():
        if len(grouped_candidates) <= 1:
            continue
        ordered = sorted(
            grouped_candidates,
            key=lambda candidate: (
                format_priority.get(str(candidate.get("format") or ""), 99),
                str(candidate.get("source_path") or "").casefold(),
            ),
        )
        for candidate in ordered[1:]:
            candidate["status"] = "alternate_format"
            candidate["preferred"] = False
            candidate["reason"] = f"Equivalent to the preferred {str(ordered[0].get('format') or '').upper()} transcript."


def import_preview_counts(candidates: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "ready": sum(1 for candidate in candidates if candidate.get("status") == "ready"),
        "already_imported": sum(1 for candidate in candidates if candidate.get("status") == "already_imported"),
        "alternate_format": sum(1 for candidate in candidates if candidate.get("status") == "alternate_format"),
        "problem": sum(1 for candidate in candidates if candidate.get("status") == "problem"),
    }


def ensure_transcript_guardrails(project: dict[str, Any], next_transcript: dict[str, Any]) -> None:
    if len(project.get("transcripts", [])) + 1 > MAX_PROJECT_TRANSCRIPTS:
        raise ValueError(f"Coding projects can contain up to {MAX_PROJECT_TRANSCRIPTS} transcripts.")
    current_segments = sum(
        len(transcript.get("segments") or [])
        for transcript in project.get("transcripts", [])
        if isinstance(transcript, dict)
    )
    next_segments = len(next_transcript.get("segments") or [])
    if current_segments + next_segments > MAX_PROJECT_SEGMENTS:
        raise ValueError(f"Coding projects can contain up to {MAX_PROJECT_SEGMENTS} transcript segments.")


def next_project_id(project: dict[str, Any], counter_name: str, prefix: str) -> str:
    counters = normalize_id_counters(project.get("id_counters"))
    counters[counter_name] = counters.get(counter_name, 0) + 1
    project["id_counters"] = counters
    return f"{prefix}{counters[counter_name]:06d}"


def resolve_project_file(value: Any, *, must_exist: bool) -> Path:
    raw_path = str(value or "").strip()
    if not raw_path:
        raise ValueError("Coding project file is required.")
    path = Path(raw_path).expanduser()
    if path.suffix.lower() == ".json" and not path.name.lower().endswith(EVIDENCE_PROJECT_EXTENSION):
        path = path.with_name(f"{path.stem}.evidence.json")
    elif not path.name.lower().endswith(EVIDENCE_PROJECT_EXTENSION):
        path = path.with_name(f"{path.name}{EVIDENCE_PROJECT_EXTENSION}")
    path = path.resolve()
    if must_exist and not path.is_file():
        raise ValueError("Coding project file does not exist.")
    if must_exist and not path.name.lower().endswith(EVIDENCE_PROJECT_EXTENSION):
        raise ValueError("Coding project files must use the .evidence.json extension.")
    return path


def normalize_ai_settings(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    raw_prompts = raw.get("prompt_overrides") if isinstance(raw.get("prompt_overrides"), dict) else {}
    return {
        "provider_id": str(raw.get("provider_id") or "").strip().lower(),
        "model_id": str(raw.get("model_id") or "").strip(),
        "temperature": clamp_float(raw.get("temperature"), default=0.0, minimum=0.0, maximum=2.0),
        "timeout_seconds": clamp_int(raw.get("timeout_seconds"), default=180, minimum=10, maximum=3600),
        "suggestion_language": normalize_suggestion_language(raw.get("suggestion_language")),
        "prompt_overrides": {
            task: str(raw_prompts.get(task) or "").strip()
            for task in ("evidence", "codes", "note", "codebook", "themes")
        },
    }


def normalize_ai_run_record(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    scope = raw.get("scope") if isinstance(raw.get("scope"), dict) else {}
    context = raw.get("context") if isinstance(raw.get("context"), dict) else {}
    return {
        "run_id": str(raw.get("run_id") or "").strip(),
        "task": str(raw.get("task") or "").strip().lower(),
        "scope": copy.deepcopy(scope),
        "context": copy.deepcopy(context),
        "researcher_prompt": str(raw.get("researcher_prompt") or ""),
        "system_prompt_version": str(raw.get("system_prompt_version") or "codes-ai-v1"),
        "provider_id": str(raw.get("provider_id") or "").strip().lower(),
        "model_id": str(raw.get("model_id") or "").strip(),
        "temperature": clamp_float(raw.get("temperature"), default=0.0, minimum=0.0, maximum=2.0),
        "timeout_seconds": clamp_int(raw.get("timeout_seconds"), default=180, minimum=10, maximum=3600),
        "maximum_suggestions": clamp_int(raw.get("maximum_suggestions"), default=10, minimum=1, maximum=25),
        "created_at": str(raw.get("created_at") or "").strip() or utc_timestamp(),
    }


def normalize_suggestion_decision_record(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    return {
        **copy.deepcopy(raw),
        "decision_id": str(raw.get("decision_id") or "").strip(),
        "run_id": str(raw.get("run_id") or "").strip(),
        "suggestion_id": str(raw.get("suggestion_id") or "").strip(),
        "task": str(raw.get("task") or "").strip().lower(),
        "target_reference": str(raw.get("target_reference") or "").strip(),
        "decision": str(raw.get("decision") or "").strip().lower(),
        "result_ids": normalize_id_list(raw.get("result_ids")),
        "note": str(raw.get("note") or ""),
        "provider_id": str(raw.get("provider_id") or "").strip().lower(),
        "model_id": str(raw.get("model_id") or "").strip(),
        "created_at": str(raw.get("created_at") or "").strip() or utc_timestamp(),
    }


def default_project_settings() -> dict[str, Any]:
    return {
        "case_definition": "transcript",
        "theme_assignment": "multiple",
        "memo_format": "plain_text",
        "transcript_folder_import": "non_recursive",
        "ai_audit": "decisions_only",
    }


def normalize_project_settings(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    settings = default_project_settings()
    for key in settings:
        if key in raw:
            settings[key] = raw[key]
    settings["case_definition"] = "transcript"
    settings["theme_assignment"] = "multiple"
    settings["memo_format"] = "plain_text"
    settings["transcript_folder_import"] = "non_recursive"
    settings["ai_audit"] = "decisions_only"
    return settings


def default_id_counters() -> dict[str, int]:
    return {
        "transcript": 0,
        "evidence": 0,
        "code": 0,
        "theme": 0,
        "suggestion": 0,
        "report_draft": 0,
    }


def normalize_id_counters(value: Any) -> dict[str, int]:
    raw = value if isinstance(value, dict) else {}
    counters = default_id_counters()
    for key in counters:
        counters[key] = max(0, int_or_default(raw.get(key), 0))
    return counters


def normalize_suggestion_language(value: Any) -> str:
    normalized = str(value or "auto").strip().lower()
    if normalized in {"auto", "english", "german"}:
        return normalized
    return "auto"


def clamp_float(value: Any, *, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return min(max(number, minimum), maximum)


def clamp_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    return min(max(int_or_default(value, default), minimum), maximum)


def float_or_none(value: Any) -> float | None:
    try:
        if value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
