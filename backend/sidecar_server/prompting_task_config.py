from __future__ import annotations

from typing import Any

from .prompting_prompt_templates import option_prompt


def selected_components(value: Any, valid_components: tuple[str, ...]) -> list[str]:
    raw = value if isinstance(value, dict) else {}
    return [
        component
        for component in valid_components
        if bool(raw.get(component))
    ]


def prompt_text_for(config: dict[str, Any], task_id: str, option_id: str) -> str:
    overrides = config.get("prompt_overrides")
    if isinstance(overrides, dict):
        option_override = str(overrides.get(option_id) or "").strip()
        if option_override:
            return option_override
        template_override = str(overrides.get(f"{task_id}.{option_id}") or "").strip()
        if template_override:
            return template_override
    return option_prompt(task_id, option_id)
