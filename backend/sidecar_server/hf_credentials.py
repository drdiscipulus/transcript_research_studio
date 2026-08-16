from __future__ import annotations

from typing import Any

from .runtime_env import configure_ml_runtime_environment

DIARIZATION_MODEL_ID = "pyannote/speaker-diarization-community-1"
DIARIZATION_MODEL_URL = f"https://huggingface.co/{DIARIZATION_MODEL_ID}"


def test_hf_token(token: str | None = None) -> dict[str, Any]:
    configure_ml_runtime_environment()
    cleaned = token.strip() if token else ""
    if not cleaned:
        return {
            "ok": False,
            "status": "missing",
            "message": "Enter a temporary Hugging Face token to test access.",
            "user": None,
            "organizations": [],
        }
    token_to_test = cleaned

    try:
        from huggingface_hub import HfApi
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import GatedRepoError, HfHubHTTPError
    except ImportError as error:
        raise ValueError("huggingface_hub is not installed in the project venv.") from error

    api = HfApi()
    try:
        payload = api.whoami(token=token_to_test)
    except Exception as error:  # noqa: BLE001
        message = str(error) or "Token test failed."
        return {
            "ok": False,
            "status": "invalid",
            "message": message,
            "user": None,
            "organizations": [],
            "checked_model": DIARIZATION_MODEL_ID,
            "model_access_url": DIARIZATION_MODEL_URL,
        }

    auth_payload = payload.get("auth", {}) if isinstance(payload, dict) else {}
    user_name = ""
    organizations: list[str] = []
    if isinstance(payload, dict):
        user_name = str(payload.get("name") or "").strip()
        orgs_value = payload.get("orgs", [])
        if isinstance(orgs_value, list):
          organizations = [str(item.get("name") if isinstance(item, dict) else item).strip() for item in orgs_value]
    role = ""
    if isinstance(auth_payload, dict):
        role = str(auth_payload.get("type") or auth_payload.get("accessToken", {}).get("role") or "").strip()

    try:
        hf_hub_download(DIARIZATION_MODEL_ID, filename="config.yaml", token=token_to_test)
    except GatedRepoError:
        message = (
            f"Token is valid, but access to {DIARIZATION_MODEL_ID} is still restricted. "
            f"Open {DIARIZATION_MODEL_URL} and accept the model access terms first."
        )
        return {
            "ok": False,
            "status": "restricted",
            "message": message,
            "user": user_name or None,
            "organizations": [item for item in organizations if item],
            "checked_model": DIARIZATION_MODEL_ID,
            "model_access_url": DIARIZATION_MODEL_URL,
        }
    except HfHubHTTPError as error:
        status_code = getattr(getattr(error, "response", None), "status_code", None)
        if status_code == 403:
            message = (
                f"Token is valid, but access to {DIARIZATION_MODEL_ID} is still restricted. "
                f"Open {DIARIZATION_MODEL_URL} and accept the model access terms first."
            )
            return {
                "ok": False,
                "status": "restricted",
                "message": message,
                "user": user_name or None,
                "organizations": [item for item in organizations if item],
                "checked_model": DIARIZATION_MODEL_ID,
                "model_access_url": DIARIZATION_MODEL_URL,
            }
        message = str(error) or "Model access check failed."
        return {
            "ok": False,
            "status": "error",
            "message": message,
            "user": user_name or None,
            "organizations": [item for item in organizations if item],
            "checked_model": DIARIZATION_MODEL_ID,
            "model_access_url": DIARIZATION_MODEL_URL,
        }
    except Exception as error:  # noqa: BLE001
        message = str(error) or "Model access check failed."
        return {
            "ok": False,
            "status": "error",
            "message": message,
            "user": user_name or None,
            "organizations": [item for item in organizations if item],
            "checked_model": DIARIZATION_MODEL_ID,
            "model_access_url": DIARIZATION_MODEL_URL,
        }

    message = "Token is valid."
    if role:
        message = f"Token is valid ({role}) and can access {DIARIZATION_MODEL_ID}."
    return {
        "ok": True,
        "status": "valid",
        "message": message,
        "user": user_name or None,
        "organizations": [item for item in organizations if item],
        "checked_model": DIARIZATION_MODEL_ID,
        "model_access_url": DIARIZATION_MODEL_URL,
    }
