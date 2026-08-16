from __future__ import annotations

import os
import shutil
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .provider_http import http_json, http_json_lines, http_sse_events, parse_sse_event
from .prompting_context import DEFAULT_CONTEXT_WINDOW_TOKENS, ProviderContextPolicy
from .prompting_types import ProviderModel, ProviderStatus
from .prompting_utils import format_size
from .security import normalize_loopback_base_url


LM_STUDIO_BASE_URL = normalize_loopback_base_url(
    os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_LM_STUDIO_BASE_URL"),
    default="http://127.0.0.1:1234",
)
OLLAMA_BASE_URL = normalize_loopback_base_url(
    os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_OLLAMA_BASE_URL"),
    default="http://127.0.0.1:11434",
)
LM_STUDIO_API_TOKEN = os.environ.get("TRANSCRIPT_RESEARCH_STUDIO_LM_STUDIO_API_TOKEN") or os.environ.get(
    "LM_STUDIO_API_TOKEN"
)
PROVIDER_STATUS_CACHE_TTL_SECONDS = 5.0
PROVIDER_STATUS_HTTP_TIMEOUT_SECONDS = 2
PROVIDER_STATUS_PORT_TIMEOUT_SECONDS = 0.35
PROVIDER_PROMPT_HTTP_TIMEOUT_SECONDS = 600

_PROVIDER_STATUS_CACHE_LOCK = threading.Lock()
_PROVIDER_STATUS_CACHE: dict[str, Any] | None = None
_PROVIDER_STATUS_CACHE_CREATED_AT = 0.0


def get_provider_statuses(*, force_refresh: bool = False) -> dict[str, Any]:
    if not force_refresh:
        cached = get_cached_provider_statuses()
        if cached is not None:
            return cached

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="provider-status") as executor:
        ollama_future = executor.submit(detect_ollama)
        lm_studio_future = executor.submit(detect_lm_studio)
        providers = [ollama_future.result(), lm_studio_future.result()]

    payload = {"providers": [provider.to_dict() for provider in providers]}
    store_cached_provider_statuses(payload)
    return payload


def list_provider_models(provider_id: str) -> dict[str, Any]:
    normalized_provider_id = provider_id.strip().lower()
    if normalized_provider_id == "ollama":
        models = list_ollama_models()
        provider_name = "Ollama"
    elif normalized_provider_id == "lmstudio":
        models = list_lm_studio_models()
        provider_name = "LM Studio"
    else:
        raise ValueError("Unsupported prompting provider.")

    return {
        "provider_id": normalized_provider_id,
        "provider_name": provider_name,
        "models": [model.to_dict() for model in models],
    }


def validate_provider_model(provider_id: str, model_id: str) -> dict[str, Any]:
    normalized_provider_id = str(provider_id or "").strip().lower()
    normalized_model_id = str(model_id or "").strip()
    provider_names = {"ollama": "Ollama", "lmstudio": "LM Studio"}
    if normalized_provider_id not in provider_names:
        raise ValueError("Choose either LM Studio or Ollama before starting transcript analysis.")
    if not normalized_model_id:
        raise ValueError("Select a local provider model before starting transcript analysis.")

    provider_name = provider_names[normalized_provider_id]
    try:
        payload = list_provider_models(normalized_provider_id)
    except PermissionError as error:
        raise ValueError(f"{provider_name} requires authentication before this analysis can start.") from error
    except ConnectionError as error:
        raise ValueError(f"{provider_name} is not reachable. Start its local server and try again.") from error
    except TimeoutError as error:
        raise ValueError(f"{provider_name} did not respond while validating the selected model.") from error
    except RuntimeError as error:
        raise ValueError(f"{provider_name} returned an invalid model response. Refresh Providers and try again.") from error

    models = payload.get("models")
    if not isinstance(models, list):
        raise ValueError(f"{provider_name} returned an invalid model list. Refresh Providers and try again.")
    if not any(isinstance(model, dict) and str(model.get("id") or "").strip() == normalized_model_id for model in models):
        raise ValueError(
            f'The selected model "{normalized_model_id}" is no longer available in {provider_name}. '
            "Refresh Providers and choose an available model."
        )
    return payload


def resolve_provider_context_window(provider_id: str, model_id: str) -> int | None:
    """Return the active provider context window when the local runtime exposes it."""
    normalized_provider_id = provider_id.strip().lower()
    if normalized_provider_id == "lmstudio":
        payload = http_json(
            "GET",
            f"{LM_STUDIO_BASE_URL}/api/v1/models",
            headers=lm_studio_headers(),
            timeout=8,
        )
        for item in payload.get("models", []):
            if not isinstance(item, dict):
                continue
            if str(item.get("key") or "").strip() != model_id:
                continue
            return active_lm_studio_context_length(item)
    return None


def resolve_provider_context_policy(provider_id: str, model_id: str) -> ProviderContextPolicy:
    normalized_provider_id = provider_id.strip().lower()
    if normalized_provider_id == "lmstudio":
        active_context = resolve_provider_context_window(normalized_provider_id, model_id)
        if active_context:
            return ProviderContextPolicy(
                tokens=active_context,
                source="lmstudio_active",
                should_request_provider_context=False,
            )
        return ProviderContextPolicy(
            tokens=DEFAULT_CONTEXT_WINDOW_TOKENS,
            source="lmstudio_assumed",
            should_request_provider_context=False,
        )
    if normalized_provider_id == "ollama":
        return ProviderContextPolicy(
            tokens=DEFAULT_CONTEXT_WINDOW_TOKENS,
            source="ollama_assumed",
            should_request_provider_context=False,
        )
    return ProviderContextPolicy(
        tokens=DEFAULT_CONTEXT_WINDOW_TOKENS,
        source="fallback_assumed",
        should_request_provider_context=False,
    )


def detect_ollama() -> ProviderStatus:
    installed = ollama_installed()
    if not local_service_reachable(OLLAMA_BASE_URL):
        return ProviderStatus(
            id="ollama",
            name="Ollama",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=OLLAMA_BASE_URL,
            message="Ollama is not responding on the default local API port.",
            model_count=0,
        )
    try:
        payload = http_json("GET", f"{OLLAMA_BASE_URL}/api/tags", timeout=PROVIDER_STATUS_HTTP_TIMEOUT_SECONDS)
        models = payload.get("models", [])
        return ProviderStatus(
            id="ollama",
            name="Ollama",
            installed=installed,
            running=True,
            available=True,
            requires_auth=False,
            base_url=OLLAMA_BASE_URL,
            message="Local Ollama API is reachable.",
            model_count=len(models) if isinstance(models, list) else 0,
        )
    except ConnectionError:
        return ProviderStatus(
            id="ollama",
            name="Ollama",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=OLLAMA_BASE_URL,
            message="Ollama is not responding on the default local API port.",
            model_count=0,
        )
    except RuntimeError as error:
        return ProviderStatus(
            id="ollama",
            name="Ollama",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=OLLAMA_BASE_URL,
            message=str(error),
            model_count=0,
        )


def detect_lm_studio() -> ProviderStatus:
    installed = lm_studio_installed()
    if not local_service_reachable(LM_STUDIO_BASE_URL):
        return ProviderStatus(
            id="lmstudio",
            name="LM Studio",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=LM_STUDIO_BASE_URL,
            message="LM Studio is not responding on the default local API port.",
            model_count=0,
        )
    try:
        payload = http_json(
            "GET",
            f"{LM_STUDIO_BASE_URL}/api/v1/models",
            headers=lm_studio_headers(),
            timeout=PROVIDER_STATUS_HTTP_TIMEOUT_SECONDS,
        )
        models = payload.get("models", [])
        return ProviderStatus(
            id="lmstudio",
            name="LM Studio",
            installed=installed,
            running=True,
            available=True,
            requires_auth=False,
            base_url=LM_STUDIO_BASE_URL,
            message="LM Studio local API server is reachable.",
            model_count=len(models) if isinstance(models, list) else 0,
        )
    except PermissionError:
        return ProviderStatus(
            id="lmstudio",
            name="LM Studio",
            installed=installed,
            running=True,
            available=False,
            requires_auth=True,
            base_url=LM_STUDIO_BASE_URL,
            message="LM Studio is running but requires an API token for requests.",
            model_count=0,
        )
    except ConnectionError:
        return ProviderStatus(
            id="lmstudio",
            name="LM Studio",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=LM_STUDIO_BASE_URL,
            message="LM Studio is not responding on the default local API port.",
            model_count=0,
        )
    except RuntimeError as error:
        return ProviderStatus(
            id="lmstudio",
            name="LM Studio",
            installed=installed,
            running=False,
            available=False,
            requires_auth=False,
            base_url=LM_STUDIO_BASE_URL,
            message=str(error),
            model_count=0,
        )


def list_ollama_models() -> list[ProviderModel]:
    payload = http_json("GET", f"{OLLAMA_BASE_URL}/api/tags", timeout=8)
    running_payload = http_json("GET", f"{OLLAMA_BASE_URL}/api/ps", timeout=8)
    if not isinstance(payload.get("models"), list) or not isinstance(running_payload.get("models"), list):
        raise RuntimeError("Ollama returned an invalid model list.")
    running_models = {
        str(item.get("model") or item.get("name") or "")
        for item in running_payload.get("models", [])
        if isinstance(item, dict)
    }
    models: list[ProviderModel] = []
    for item in payload.get("models", []):
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("model") or item.get("name") or "").strip()
        if not model_id:
            continue
        details = item.get("details", {})
        parameter_size = ""
        quantization = ""
        if isinstance(details, dict):
            parameter_size = str(details.get("parameter_size") or "").strip()
            quantization = str(details.get("quantization_level") or "").strip()
        detail_parts = [part for part in [parameter_size, quantization, format_size(int(item.get("size", 0) or 0))] if part]
        models.append(
            ProviderModel(
                id=model_id,
                display_name=str(item.get("name") or model_id),
                details=" • ".join(detail_parts) if detail_parts else "Local Ollama model",
                context_length=None,
                is_loaded=model_id in running_models or str(item.get("name") or "") in running_models,
            )
        )
    return models


def list_lm_studio_models() -> list[ProviderModel]:
    payload = http_json(
        "GET",
        f"{LM_STUDIO_BASE_URL}/api/v1/models",
        headers=lm_studio_headers(),
        timeout=8,
    )
    if not isinstance(payload.get("models"), list):
        raise RuntimeError("LM Studio returned an invalid model list.")
    models: list[ProviderModel] = []
    for item in payload.get("models", []):
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "llm")).lower() != "llm":
            continue
        model_id = str(item.get("key") or "").strip()
        if not model_id:
            continue

        quantization = item.get("quantization", {})
        quantization_label = ""
        if isinstance(quantization, dict):
            quantization_label = str(quantization.get("name") or "").strip()
        params_string = str(item.get("params_string") or "").strip()
        size_bytes = int(item.get("size_bytes") or 0)
        detail_parts = [part for part in [params_string, quantization_label, format_size(size_bytes)] if part]
        loaded_instances = item.get("loaded_instances", [])
        context_length = active_lm_studio_context_length(item) or item.get("max_context_length")
        if not isinstance(context_length, int):
            context_length = None
        models.append(
            ProviderModel(
                id=model_id,
                display_name=str(item.get("display_name") or model_id),
                details=" • ".join(detail_parts) if detail_parts else "Local LM Studio model",
                context_length=context_length,
                is_loaded=bool(loaded_instances),
            )
        )
    return models


def run_provider_task_prompt(
    *,
    provider_id: str,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    timeout_seconds: int = PROVIDER_PROMPT_HTTP_TIMEOUT_SECONDS,
    context_window_tokens: int | None = None,
    should_request_provider_context: bool = False,
) -> str:
    if provider_id == "ollama":
        options: dict[str, Any] = {"temperature": temperature}
        if should_request_provider_context and context_window_tokens:
            options["num_ctx"] = context_window_tokens
        content = collect_ollama_chat_stream(
            body={
                "model": model_id,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "stream": True,
                "think": False,
                "options": options,
            },
            timeout=timeout_seconds,
        )
        if content:
            return content
        raise RuntimeError("Ollama returned no assistant content.")

    if provider_id == "lmstudio":
        content = collect_lm_studio_chat_completion(
            body={
                "model": model_id,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "stream": False,
                "reasoning_effort": "none",
                "temperature": temperature,
            },
            timeout=timeout_seconds,
        )
        if content:
            return content
        raise RuntimeError("LM Studio returned no message content.")

    raise ValueError("Unsupported prompting provider.")


def collect_ollama_chat_stream(*, body: dict[str, Any], timeout: int = PROVIDER_PROMPT_HTTP_TIMEOUT_SECONDS) -> str:
    chunks: list[str] = []
    chunk_count = 0
    thinking_chunk_count = 0
    done_reason = ""
    try:
        for payload in http_json_lines(
            "POST",
            f"{OLLAMA_BASE_URL}/api/chat",
            body=body,
            timeout=timeout,
        ):
            chunk_count += 1
            message = payload.get("message", {})
            if isinstance(message, dict):
                content = str(message.get("content") or "")
                if content:
                    chunks.append(content)
                if str(message.get("thinking") or ""):
                    thinking_chunk_count += 1
            if payload.get("done") is True:
                done_reason = str(payload.get("done_reason") or "")
                break
    except TimeoutError:
        if not chunks:
            raise
    content = "".join(chunks).strip()
    if content:
        return content
    if thinking_chunk_count:
        raise RuntimeError(
            "Ollama produced reasoning but no final answer. Try a non-thinking model or a smaller prompt. "
            f"Metadata: chunks={chunk_count}, thinking_chunks={thinking_chunk_count}, done_reason={done_reason or 'unknown'}."
        )
    raise RuntimeError(
        "Ollama returned no assistant content. "
        f"Metadata: chunks={chunk_count}, thinking_chunks=0, done_reason={done_reason or 'unknown'}."
    )


def collect_lm_studio_chat_stream(*, body: dict[str, Any], timeout: int = PROVIDER_PROMPT_HTTP_TIMEOUT_SECONDS) -> str:
    chunks: list[str] = []
    final_content = ""
    try:
        for event in http_sse_events(
            "POST",
            f"{LM_STUDIO_BASE_URL}/api/v1/chat",
            headers=lm_studio_headers(),
            body=body,
            timeout=timeout,
        ):
            event_type = str(event.get("type") or "")
            data = event.get("data", {})
            if event_type == "message.delta" and isinstance(data, dict):
                content = str(data.get("content") or data.get("delta") or "")
                if content:
                    chunks.append(content)
                continue
            if event_type == "error":
                message = ""
                if isinstance(data, dict):
                    message = str(data.get("message") or data.get("error") or "").strip()
                raise RuntimeError(message or "LM Studio streaming request failed.")
            if event_type == "chat.end" and isinstance(data, dict):
                final_content = extract_lm_studio_message_content(data.get("result", data))
                break
    except TimeoutError:
        if not chunks and not final_content:
            raise

    content = "".join(chunks).strip()
    return content or final_content.strip()


def collect_lm_studio_chat_completion(*, body: dict[str, Any], timeout: int = PROVIDER_PROMPT_HTTP_TIMEOUT_SECONDS) -> str:
    payload = http_json(
        "POST",
        f"{LM_STUDIO_BASE_URL}/v1/chat/completions",
        headers=lm_studio_headers(),
        body=body,
        timeout=timeout,
    )
    choices = payload.get("choices")
    first_choice = choices[0] if isinstance(choices, list) and choices else {}
    message = first_choice.get("message") if isinstance(first_choice, dict) else {}
    content = str(message.get("content") or "").strip() if isinstance(message, dict) else ""
    if content:
        return content

    finish_reason = str(first_choice.get("finish_reason") or "unknown") if isinstance(first_choice, dict) else "unknown"
    if isinstance(message, dict) and str(message.get("reasoning") or message.get("reasoning_content") or message.get("thinking") or ""):
        raise RuntimeError(
            "LM Studio produced reasoning but no final answer. Try a non-thinking model or a smaller prompt. "
            f"Metadata: finish_reason={finish_reason}."
        )
    raise RuntimeError(f"LM Studio returned no message content. Metadata: finish_reason={finish_reason}.")


def extract_lm_studio_message_content(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    output_items = payload.get("output", [])
    parts: list[str] = []
    if isinstance(output_items, list):
        for item in output_items:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "") == "message":
                content = str(item.get("content") or "").strip()
                if content:
                    parts.append(content)
    return "\n".join(parts).strip()


def active_lm_studio_context_length(model_payload: dict[str, Any]) -> int | None:
    """Read LM Studio's loaded context window, which may be lower than model maximum."""
    instances = model_payload.get("loaded_instances", [])
    if not isinstance(instances, list):
        return None
    for instance in instances:
        if not isinstance(instance, dict):
            continue
        config = instance.get("config", {})
        if not isinstance(config, dict):
            continue
        context_length = config.get("context_length")
        if isinstance(context_length, int) and context_length > 0:
            return context_length
    return None


def get_cached_provider_statuses() -> dict[str, Any] | None:
    with _PROVIDER_STATUS_CACHE_LOCK:
        if _PROVIDER_STATUS_CACHE is None:
            return None
        if (datetime.now().timestamp() - _PROVIDER_STATUS_CACHE_CREATED_AT) > PROVIDER_STATUS_CACHE_TTL_SECONDS:
            return None
        return {
            "providers": [dict(provider) for provider in _PROVIDER_STATUS_CACHE.get("providers", [])],
        }


def store_cached_provider_statuses(payload: dict[str, Any]) -> None:
    with _PROVIDER_STATUS_CACHE_LOCK:
        global _PROVIDER_STATUS_CACHE
        global _PROVIDER_STATUS_CACHE_CREATED_AT
        _PROVIDER_STATUS_CACHE = {
            "providers": [dict(provider) for provider in payload.get("providers", []) if isinstance(provider, dict)]
        }
        _PROVIDER_STATUS_CACHE_CREATED_AT = datetime.now().timestamp()


def local_service_reachable(base_url: str) -> bool:
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").strip()
    if not host:
        return False

    if parsed.port is not None:
        port = parsed.port
    elif parsed.scheme == "https":
        port = 443
    else:
        port = 80

    try:
        with socket.create_connection((host, port), timeout=PROVIDER_STATUS_PORT_TIMEOUT_SECONDS):
            return True
    except OSError:
        return False


def lm_studio_headers() -> dict[str, str]:
    if not LM_STUDIO_API_TOKEN:
        return {}
    return {"Authorization": f"Bearer {LM_STUDIO_API_TOKEN}"}


def ollama_installed() -> bool:
    if shutil.which("ollama"):
        return True
    candidate_paths = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Ollama" / "ollama.exe",
        Path("/Applications/Ollama.app"),
    ]
    return any(path.exists() for path in candidate_paths if str(path))


def lm_studio_installed() -> bool:
    if shutil.which("lms"):
        return True
    candidate_paths = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "LM Studio" / "LM Studio.exe",
        Path("/Applications/LM Studio.app"),
    ]
    return any(path.exists() for path in candidate_paths if str(path))
