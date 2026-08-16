from __future__ import annotations

import copy
from pathlib import Path
from typing import Any


EXPORT_SCHEMA_VERSION = "1.0"
MANIFEST_SCHEMA_VERSION = "1.0"


TABLE_DEFINITIONS: list[tuple[str, str, list[str]]] = [
    ("Overview", "overview", ["Field", "Value"]),
    (
        "Transcripts",
        "transcripts",
        ["Transcript ID", "Transcript", "Source", "Document ID", "Segments", "Evidence Items"],
    ),
    (
        "Segments",
        "segments",
        ["Transcript ID", "Transcript", "Segment ID", "Position", "Start", "End", "Speaker", "Text"],
    ),
    (
        "Evidence",
        "evidence",
        [
            "Evidence ID",
            "Transcript ID",
            "Transcript",
            "Selected Text",
            "Speaker",
            "Start",
            "End",
            "Segment IDs",
            "Codes",
            "Themes",
            "Note",
            "Created At",
            "Updated At",
        ],
    ),
    (
        "Evidence-Segments",
        "evidence_segments",
        [
            "Evidence ID",
            "Transcript ID",
            "Transcript",
            "Segment ID",
            "Segment Position",
            "Start Offset",
            "End Offset",
            "Excerpt",
        ],
    ),
    (
        "Codes",
        "codes",
        [
            "Code ID",
            "Code",
            "Color",
            "Definition",
            "Inclusion Criteria",
            "Exclusion Criteria",
            "Example Evidence IDs",
            "Note",
            "Created At",
            "Updated At",
        ],
    ),
    (
        "Themes",
        "themes",
        ["Theme ID", "Theme", "Color", "Description", "Codes", "Related Evidence Items", "Note", "Created At", "Updated At"],
    ),
    ("Evidence-Codes", "evidence_codes", ["Evidence ID", "Transcript ID", "Code ID", "Code"]),
    ("Theme-Codes", "theme_codes", ["Theme ID", "Theme", "Code ID", "Code"]),
    ("Report Drafts", "report_drafts", ["Draft ID", "Title", "Body", "Created At", "Updated At"]),
    (
        "AI Runs",
        "ai_runs",
        ["Run ID", "Task", "Scope", "Context References", "Researcher Prompt", "Provider", "Model", "Temperature", "Timeout", "Maximum Suggestions", "Created At"],
    ),
    (
        "AI Decisions",
        "ai_decisions",
        ["Decision ID", "Run ID", "Suggestion ID", "Task", "Target", "Decision", "Resulting Entity IDs", "Created At"],
    ),
]


def build_canonical_export(
    project: dict[str, Any],
    *,
    exported_at: str,
    app_version: str,
    include_local_paths: bool,
    include_ai_audit: bool,
) -> dict[str, Any]:
    sanitized_project = sanitize_project(
        project,
        include_local_paths=include_local_paths,
        include_ai_audit=include_ai_audit,
    )
    tables = build_export_tables(
        sanitized_project,
        exported_at=exported_at,
        app_version=app_version,
        include_local_paths=include_local_paths,
        include_ai_audit=include_ai_audit,
    )
    return {
        "export_schema_version": EXPORT_SCHEMA_VERSION,
        "metadata": {
            "project_id": str(project.get("project_id") or ""),
            "project_name": str(project.get("name") or "Untitled Coding Project"),
            "research_focus": str(project.get("research_focus") or ""),
            "project_schema_version": str(project.get("schema_version") or ""),
            "exported_at": exported_at,
            "app_version": app_version,
            "include_local_paths": include_local_paths,
            "include_ai_audit": include_ai_audit,
        },
        "project": sanitized_project,
        "relationships": {
            "evidence_segments": relationship_records(tables["evidence_segments"]),
            "evidence_codes": relationship_records(tables["evidence_codes"]),
            "theme_codes": relationship_records(tables["theme_codes"]),
        },
        "tables": tables,
    }


def sanitize_project(
    project: dict[str, Any],
    *,
    include_local_paths: bool,
    include_ai_audit: bool,
) -> dict[str, Any]:
    sanitized = copy.deepcopy(project)
    for transcript in sanitized.get("transcripts", []):
        if not isinstance(transcript, dict):
            continue
        source_file = str(transcript.get("source_file") or "")
        transcript["source_file"] = source_file if include_local_paths else Path(source_file).name

    if not include_ai_audit:
        sanitized.pop("ai_settings", None)
        sanitized.pop("ai_runs", None)
        sanitized.pop("suggestion_decisions", None)
    else:
        ai_settings = sanitized.get("ai_settings")
        if isinstance(ai_settings, dict):
            # Only researcher-controlled analytical prompts are exportable. The
            # protected system prompts never live in the project file.
            sanitized["ai_settings"] = {
                key: value
                for key, value in ai_settings.items()
                if key in {"provider_id", "model_id", "temperature", "timeout_seconds", "suggestion_language", "prompt_overrides"}
            }
    return sanitized


def build_export_tables(
    project: dict[str, Any],
    *,
    exported_at: str,
    app_version: str,
    include_local_paths: bool,
    include_ai_audit: bool,
) -> dict[str, list[dict[str, Any]]]:
    transcripts = [item for item in project.get("transcripts", []) if isinstance(item, dict)]
    evidence_items = [item for item in project.get("evidence_items", []) if isinstance(item, dict)]
    codes = [item for item in project.get("codes", []) if isinstance(item, dict)]
    themes = [item for item in project.get("themes", []) if isinstance(item, dict)]
    transcript_by_id = {str(item.get("transcript_id") or ""): item for item in transcripts}
    code_by_id = {str(item.get("code_id") or ""): item for item in codes}
    theme_by_code: dict[str, list[dict[str, Any]]] = {}
    for theme in themes:
        for code_id in theme.get("code_ids", []):
            theme_by_code.setdefault(str(code_id), []).append(theme)

    evidence_by_transcript: dict[str, list[dict[str, Any]]] = {}
    for evidence in evidence_items:
        evidence_by_transcript.setdefault(str(evidence.get("transcript_id") or ""), []).append(evidence)

    overview = [
        {"Field": "Project Name", "Value": project.get("name", "")},
        {"Field": "Research Focus", "Value": project.get("research_focus", "")},
        {"Field": "Project ID", "Value": project.get("project_id", "")},
        {"Field": "Project Schema Version", "Value": project.get("schema_version", "")},
        {"Field": "Export Schema Version", "Value": EXPORT_SCHEMA_VERSION},
        {"Field": "Exported At (UTC)", "Value": exported_at},
        {"Field": "App Version", "Value": app_version},
        {"Field": "Transcripts", "Value": len(transcripts)},
        {"Field": "Segments", "Value": sum(len(item.get("segments", [])) for item in transcripts)},
        {"Field": "Evidence Items", "Value": len(evidence_items)},
        {"Field": "Codes", "Value": len(codes)},
        {"Field": "Themes", "Value": len(themes)},
        {"Field": "Local Source Paths Included", "Value": include_local_paths},
        {"Field": "AI Audit Included", "Value": include_ai_audit},
    ]

    transcript_rows: list[dict[str, Any]] = []
    segment_rows: list[dict[str, Any]] = []
    segment_position_by_id: dict[tuple[str, str], int] = {}
    for transcript in transcripts:
        transcript_id = str(transcript.get("transcript_id") or "")
        transcript_name = transcript_display_name(transcript)
        segments = [item for item in transcript.get("segments", []) if isinstance(item, dict)]
        transcript_rows.append(
            {
                "Transcript ID": transcript_id,
                "Transcript": transcript_name,
                "Source": transcript.get("source_file", ""),
                "Document ID": transcript.get("source_document_id", ""),
                "Segments": len(segments),
                "Evidence Items": len(evidence_by_transcript.get(transcript_id, [])),
            }
        )
        for position, segment in enumerate(segments, start=1):
            segment_id = str(segment.get("segment_id") or segment.get("id") or "")
            segment_position_by_id[(transcript_id, segment_id)] = position
            segment_rows.append(
                {
                    "Transcript ID": transcript_id,
                    "Transcript": transcript_name,
                    "Segment ID": segment_id,
                    "Position": position,
                    "Start": segment.get("start"),
                    "End": segment.get("end"),
                    "Speaker": resolve_speaker_name(transcript, str(segment.get("speaker") or "")),
                    "Text": segment.get("text", ""),
                }
            )

    evidence_rows: list[dict[str, Any]] = []
    evidence_segment_rows: list[dict[str, Any]] = []
    evidence_code_rows: list[dict[str, Any]] = []
    for evidence in evidence_items:
        evidence_id = str(evidence.get("evidence_id") or "")
        transcript_id = str(evidence.get("transcript_id") or "")
        transcript = transcript_by_id.get(transcript_id, {})
        code_ids = [str(value) for value in evidence.get("code_ids", [])]
        evidence_themes = unique_in_order(
            str(theme.get("name") or "")
            for code_id in code_ids
            for theme in theme_by_code.get(code_id, [])
        )
        evidence_rows.append(
            {
                "Evidence ID": evidence_id,
                "Transcript ID": transcript_id,
                "Transcript": transcript_display_name(transcript),
                "Selected Text": evidence.get("selected_text", ""),
                "Speaker": resolve_speaker_name(transcript, str(evidence.get("speaker") or "")),
                "Start": evidence.get("start"),
                "End": evidence.get("end"),
                "Segment IDs": "; ".join(str(value) for value in evidence.get("segment_ids", [])),
                "Codes": "; ".join(str(code_by_id.get(code_id, {}).get("name") or code_id) for code_id in code_ids),
                "Themes": "; ".join(evidence_themes),
                "Note": evidence.get("memo", ""),
                "Created At": evidence.get("created_at", ""),
                "Updated At": evidence.get("updated_at", ""),
            }
        )
        ranges = evidence.get("segment_ranges") if isinstance(evidence.get("segment_ranges"), dict) else {}
        for segment_id in evidence.get("segment_ids", []):
            anchor = ranges.get(str(segment_id), {}) if isinstance(ranges, dict) else {}
            evidence_segment_rows.append(
                {
                    "Evidence ID": evidence_id,
                    "Transcript ID": transcript_id,
                    "Transcript": transcript_display_name(transcript),
                    "Segment ID": segment_id,
                    "Segment Position": segment_position_by_id.get((transcript_id, str(segment_id)), ""),
                    "Start Offset": anchor.get("start_offset", "") if isinstance(anchor, dict) else "",
                    "End Offset": anchor.get("end_offset", "") if isinstance(anchor, dict) else "",
                    "Excerpt": anchor.get("excerpt", "") if isinstance(anchor, dict) else "",
                }
            )
        for code_id in code_ids:
            evidence_code_rows.append(
                {
                    "Evidence ID": evidence_id,
                    "Transcript ID": transcript_id,
                    "Code ID": code_id,
                    "Code": code_by_id.get(code_id, {}).get("name", ""),
                }
            )

    code_rows = [
        {
            "Code ID": code.get("code_id", ""),
            "Code": code.get("name", ""),
            "Color": code.get("color", ""),
            "Definition": code.get("description", ""),
            "Inclusion Criteria": code.get("inclusion_note", ""),
            "Exclusion Criteria": code.get("exclusion_note", ""),
            "Example Evidence IDs": "; ".join(str(value) for value in code.get("example_evidence_ids", [])),
            "Note": code.get("memo", ""),
            "Created At": code.get("created_at", ""),
            "Updated At": code.get("updated_at", ""),
        }
        for code in codes
    ]
    theme_code_rows: list[dict[str, Any]] = []
    theme_rows: list[dict[str, Any]] = []
    for theme in themes:
        theme_id = str(theme.get("theme_id") or "")
        theme_name = str(theme.get("name") or "")
        code_ids = [str(value) for value in theme.get("code_ids", [])]
        theme_rows.append(
            {
                "Theme ID": theme_id,
                "Theme": theme_name,
                "Color": theme.get("color", ""),
                "Description": theme.get("description", ""),
                "Codes": "; ".join(str(code_by_id.get(code_id, {}).get("name") or code_id) for code_id in code_ids),
                "Related Evidence Items": len(
                    {
                        str(item.get("Evidence ID") or "")
                        for item in evidence_code_rows
                        if str(item.get("Code ID") or "") in set(code_ids)
                    }
                ),
                "Note": theme.get("memo", ""),
                "Created At": theme.get("created_at", ""),
                "Updated At": theme.get("updated_at", ""),
            }
        )
        for code_id in code_ids:
            theme_code_rows.append(
                {"Theme ID": theme_id, "Theme": theme_name, "Code ID": code_id, "Code": code_by_id.get(code_id, {}).get("name", "")}
            )

    report_rows = [
        {
            "Draft ID": item.get("draft_id", ""),
            "Title": item.get("title", ""),
            "Body": item.get("body", ""),
            "Created At": item.get("created_at", ""),
            "Updated At": item.get("updated_at", ""),
        }
        for item in project.get("report_drafts", [])
        if isinstance(item, dict)
    ]
    ai_run_rows = []
    ai_decision_rows = []
    if include_ai_audit:
        ai_run_rows = [
            {
                "Run ID": item.get("run_id", ""),
                "Task": item.get("task", ""),
                "Scope": item.get("scope", ""),
                "Context References": item.get("context", {}),
                "Researcher Prompt": item.get("researcher_prompt", ""),
                "Provider": item.get("provider_id", ""),
                "Model": item.get("model_id", ""),
                "Temperature": item.get("temperature", ""),
                "Timeout": item.get("timeout_seconds", ""),
                "Maximum Suggestions": item.get("maximum_suggestions", ""),
                "Created At": item.get("created_at", ""),
            }
            for item in project.get("ai_runs", [])
            if isinstance(item, dict)
        ]
        ai_decision_rows = [
            {
                "Decision ID": item.get("decision_id", ""),
                "Run ID": item.get("run_id", ""),
                "Suggestion ID": item.get("suggestion_id", ""),
                "Task": item.get("task", ""),
                "Target": item.get("target_reference", item.get("target_id", "")),
                "Decision": item.get("decision", ""),
                "Resulting Entity IDs": item.get("result_ids", []),
                "Created At": item.get("created_at", ""),
            }
            for item in project.get("suggestion_decisions", [])
            if isinstance(item, dict)
        ]

    return {
        "overview": overview,
        "transcripts": transcript_rows,
        "segments": segment_rows,
        "evidence": evidence_rows,
        "evidence_segments": evidence_segment_rows,
        "codes": code_rows,
        "themes": theme_rows,
        "evidence_codes": evidence_code_rows,
        "theme_codes": theme_code_rows,
        "report_drafts": report_rows,
        "ai_runs": ai_run_rows,
        "ai_decisions": ai_decision_rows,
    }


def transcript_display_name(transcript: dict[str, Any]) -> str:
    return str(
        transcript.get("name")
        or transcript.get("file_name")
        or Path(str(transcript.get("source_file") or "Transcript")).name
        or "Transcript"
    )


def resolve_speaker_name(transcript: dict[str, Any], speaker_id: str) -> str:
    for speaker in transcript.get("speakers", []):
        if isinstance(speaker, dict) and str(speaker.get("id") or "") == speaker_id:
            return str(speaker.get("name") or speaker_id)
    return speaker_id


def unique_in_order(values: Any) -> list[str]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def relationship_records(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{snake_case_key(key): value for key, value in row.items()} for row in rows]


def snake_case_key(value: str) -> str:
    return value.lower().replace("–", "_").replace("-", "_").replace(" ", "_")
