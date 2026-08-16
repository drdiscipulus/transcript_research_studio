from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .app_paths import config_dir, ensure_app_runtime_directories


PromptTemplate = dict[str, str]


DEFAULT_PROMPT_TEMPLATES: dict[str, dict[str, Any]] = {
    "summary": {
        "label": "Summary & Orientation",
        "options": {
            "short_summary": {
                "label": "Short Summary",
                "help_text": "Creates a concise transcript-level overview for orientation before manual analysis.",
                "default_prompt": "Write a concise short summary of the transcript content. Focus on what was discussed and avoid interpretation beyond the text.",
            },
            "main_topics": {
                "label": "Main Topics",
                "help_text": "Lists the main topics or themes discussed in the transcript.",
                "default_prompt": "List the main topics discussed in the transcript. Use short, research-friendly labels.",
            },
            "keywords": {
                "label": "Keywords / Search Terms",
                "help_text": "Suggests useful search terms for finding passages later in qualitative tools.",
                "default_prompt": "Suggest keywords and search terms that would help a researcher find important passages later.",
            },
            "actors_organizations_places": {
                "label": "Actors, Organizations, Places",
                "help_text": "Extracts named people, groups, organizations, locations, and places when present.",
                "default_prompt": "Identify actors, organizations, groups, locations, and places mentioned in the transcript. Leave uncertain items out.",
            },
            "chronological_outline": {
                "label": "Chronological Outline",
                "help_text": "Creates a rough ordered outline of how the discussion unfolds.",
                "default_prompt": "Create a chronological outline of the transcript in the order topics or events appear.",
            },
            "notable_passages": {
                "label": "Notable Passages",
                "help_text": "Flags passages that may deserve manual review without treating them as coded findings.",
                "default_prompt": "Identify notable passages for manual review and briefly explain why each passage may be useful to inspect.",
            },
        },
    },
    "quotes": {
        "label": "Quote Finder",
        "options": {
            "quote_candidates": {
                "label": "Quote Candidates",
                "help_text": "Finds exact quote candidates for the selected topic or focus.",
                "default_prompt": "Find exact quote candidates that are relevant to the topic. Quotes must be copied from the transcript, not paraphrased.",
            },
            "include_speaker_timestamp": {
                "label": "Speaker / Timestamp",
                "help_text": "Asks the model to include speaker and timestamp metadata when available.",
                "default_prompt": "For each quote, include speaker and timestamp information when it is available in the transcript chunk.",
            },
            "verify_quote_text": {
                "label": "Verify Quote Text",
                "help_text": "Keeps deterministic quote verification enabled and reminds the model not to invent quotes.",
                "default_prompt": "Only propose quote text that appears verbatim in the transcript. The app will verify every proposed quote against the source text.",
            },
        },
    },
    "diagnostics": {
        "label": "Transcript Diagnostics",
        "options": {
            "missing_speaker_labels": {
                "label": "Missing Speaker Labels",
                "help_text": "Flags segments where no speaker label is assigned.",
                "default_prompt": "Add or confirm a speaker label for this segment.",
            },
            "unknown_speaker_labels": {
                "label": "Unknown Speaker Labels",
                "help_text": "Flags speaker labels that look generic, unknown, or unresolved.",
                "default_prompt": "Review this speaker label and replace it with a clearer speaker name if possible.",
            },
            "missing_timestamps": {
                "label": "Missing Timestamps",
                "help_text": "Flags segments without usable start or end timestamps.",
                "default_prompt": "Review timestamps before timestamp-based playback or citation.",
            },
            "empty_text_segments": {
                "label": "Empty Text Segments",
                "help_text": "Flags segments that contain no transcript text.",
                "default_prompt": "Delete this empty segment or fill it with the missing transcript text.",
            },
            "very_long_segments": {
                "label": "Very Long Segments",
                "help_text": "Flags long segments that may be hard to review or quote.",
                "default_prompt": "Consider splitting this long segment for easier reading and review.",
            },
            "very_short_fragments": {
                "label": "Very Short Fragments",
                "help_text": "Flags tiny text fragments that may need merging or review.",
                "default_prompt": "Check whether this short fragment should be merged with a neighboring segment.",
            },
            "repeated_text": {
                "label": "Repeated Text",
                "help_text": "Flags repeated segment text that may indicate export or transcription cleanup issues.",
                "default_prompt": "Review this possible repeated text and remove duplication if it is accidental.",
            },
            "broken_or_unclear_passages": {
                "label": "Broken Or Unclear Passages",
                "help_text": "Uses the local model to suggest passages that look broken, unclear, or hard to interpret.",
                "default_prompt": "Find passages that look broken, unclear, or difficult to understand. Phrase findings as manual review suggestions.",
            },
            "possible_speaker_inconsistency": {
                "label": "Possible Speaker Inconsistency",
                "help_text": "Uses the local model to flag possible speaker-label inconsistencies for manual checking.",
                "default_prompt": "Find possible speaker-label inconsistencies. Do not claim certainty; phrase findings as manual review suggestions.",
            },
        },
    },
}


def prompt_templates_payload() -> dict[str, Any]:
    overrides = _load_overrides()
    tasks: dict[str, Any] = {}
    for task_id, task in DEFAULT_PROMPT_TEMPLATES.items():
        options: dict[str, Any] = {}
        for option_id, option in task["options"].items():
            template_id = f"{task_id}.{option_id}"
            default_prompt = str(option["default_prompt"])
            current_prompt = str(overrides.get(template_id) or default_prompt)
            options[option_id] = {
                "id": option_id,
                "template_id": template_id,
                "label": option["label"],
                "help_text": option["help_text"],
                "default_prompt": default_prompt,
                "current_prompt": current_prompt,
                "has_permanent_override": template_id in overrides,
            }
        tasks[task_id] = {
            "id": task_id,
            "label": task["label"],
            "options": options,
        }
    return {"tasks": tasks}


def save_prompt_template_override(payload: dict[str, Any]) -> dict[str, Any]:
    template_id = _normalize_template_id(payload.get("template_id"))
    prompt_text = str(payload.get("prompt_text") or "").strip()
    if not prompt_text:
        raise ValueError("Prompt text is required.")
    _ensure_known_template(template_id)
    overrides = _load_overrides()
    overrides[template_id] = prompt_text
    _write_overrides(overrides)
    return prompt_templates_payload()


def revert_prompt_template_override(payload: dict[str, Any]) -> dict[str, Any]:
    template_id = _normalize_template_id(payload.get("template_id"))
    _ensure_known_template(template_id)
    overrides = _load_overrides()
    overrides.pop(template_id, None)
    _write_overrides(overrides)
    return prompt_templates_payload()


def default_prompt_for(template_id: str) -> str:
    task_id, option_id = _split_template_id(template_id)
    option = DEFAULT_PROMPT_TEMPLATES.get(task_id, {}).get("options", {}).get(option_id)
    return str((option or {}).get("default_prompt") or "")


def prompt_for(template_id: str, overrides: dict[str, Any] | None = None) -> str:
    if overrides and str(overrides.get(template_id) or "").strip():
        return str(overrides[template_id]).strip()
    return str(_load_overrides().get(template_id) or default_prompt_for(template_id)).strip()


def option_prompt(task_id: str, option_id: str, overrides: dict[str, Any] | None = None) -> str:
    return prompt_for(f"{task_id}.{option_id}", overrides)


def _normalize_template_id(value: Any) -> str:
    template_id = str(value or "").strip()
    if not template_id:
        raise ValueError("Prompt template id is required.")
    return template_id


def _ensure_known_template(template_id: str) -> None:
    task_id, option_id = _split_template_id(template_id)
    if task_id not in DEFAULT_PROMPT_TEMPLATES or option_id not in DEFAULT_PROMPT_TEMPLATES[task_id]["options"]:
        raise ValueError(f"Unknown prompt template: {template_id}")


def _split_template_id(template_id: str) -> tuple[str, str]:
    parts = template_id.split(".", 1)
    if len(parts) != 2:
        raise ValueError(f"Unknown prompt template: {template_id}")
    return parts[0], parts[1]


def _overrides_path() -> Path:
    ensure_app_runtime_directories()
    return config_dir() / "prompt_templates.json"


def _load_overrides() -> dict[str, str]:
    path = _overrides_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in payload.items()
        if str(key).strip() and str(value).strip()
    }


def _write_overrides(overrides: dict[str, str]) -> None:
    path = _overrides_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(overrides, indent=2, ensure_ascii=False), encoding="utf-8")
