from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from typing import Any


DEFAULT_CONTEXT_WINDOW_TOKENS = 4_096
MIN_CHUNK_CHARACTERS = 2_500
MAX_CHUNK_CHARACTERS = 12_000
CONSERVATIVE_CHARS_PER_TOKEN = 3.5
CHUNK_CONTEXT_SHARE = 0.38
DEFAULT_CHUNK_CHARACTERS = int(DEFAULT_CONTEXT_WINDOW_TOKENS * CHUNK_CONTEXT_SHARE * CONSERVATIVE_CHARS_PER_TOKEN)
CONTEXT_ERROR_PATTERNS = (
    "context length",
    "n_ctx",
    "n_keep",
    "num_ctx",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "maximum context",
)


@dataclass(slots=True)
class ProviderContextPolicy:
    tokens: int
    source: str
    should_request_provider_context: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TaskContext:
    """Runtime settings and provider callback shared by all preprocessing tasks."""

    provider_id: str
    provider_name: str
    model_id: str
    temperature: float
    timeout_seconds: int
    run_timestamp: str
    prompt_runner: Callable[..., str]
    context_window_tokens: int = DEFAULT_CONTEXT_WINDOW_TOKENS
    chunk_max_characters: int = DEFAULT_CHUNK_CHARACTERS
    context_source: str = "fallback_assumed"
    should_request_provider_context: bool = False


def adaptive_chunk_character_budget(context_window_tokens: int | None) -> int:
    """Convert a provider context window into a conservative transcript-text chunk size.

    Local providers reserve part of the window for prompts, JSON instructions, and model output.
    This estimate deliberately prefers more chunks over provider-side context failures.
    """
    try:
        context_tokens = int(context_window_tokens or DEFAULT_CONTEXT_WINDOW_TOKENS)
    except (TypeError, ValueError):
        context_tokens = DEFAULT_CONTEXT_WINDOW_TOKENS
    context_tokens = max(2_048, min(context_tokens, 32_768))
    estimated_characters = int(context_tokens * CHUNK_CONTEXT_SHARE * CONSERVATIVE_CHARS_PER_TOKEN)
    return max(MIN_CHUNK_CHARACTERS, min(MAX_CHUNK_CHARACTERS, estimated_characters))


def shrink_context_for_retry(context: TaskContext) -> TaskContext:
    return replace(
        context,
        chunk_max_characters=max(MIN_CHUNK_CHARACTERS, context.chunk_max_characters // 2),
    )


def is_context_window_error(error: BaseException) -> bool:
    message = str(error).lower()
    return any(pattern in message for pattern in CONTEXT_ERROR_PATTERNS)
