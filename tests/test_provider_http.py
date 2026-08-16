from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.sidecar_server.provider_http import parse_sse_event
from backend.sidecar_server.prompting_providers import validate_provider_model


class ProviderHttpTests(unittest.TestCase):
    def test_parse_sse_event_uses_event_type_and_json_data(self) -> None:
        self.assertEqual(
            parse_sse_event(event_type="message.delta", data_lines=['{"content":"hello"}']),
            {"content": "hello", "type": "message.delta", "data": {"content": "hello"}},
        )

    def test_parse_sse_event_ignores_done_marker(self) -> None:
        self.assertIsNone(parse_sse_event(event_type="message.done", data_lines=["[DONE]"]))

    def test_parse_sse_event_rejects_invalid_json(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "invalid streaming JSON"):
            parse_sse_event(event_type="message.delta", data_lines=["not-json"])

    def test_supported_provider_and_existing_model_pass_validation(self) -> None:
        with patch(
            "backend.sidecar_server.prompting_providers.list_provider_models",
            return_value={"provider_id": "lmstudio", "provider_name": "LM Studio", "models": [{"id": "local-model"}]},
        ):
            payload = validate_provider_model(" LMStudio ", "local-model")
        self.assertEqual(payload["provider_id"], "lmstudio")

    def test_unsupported_provider_fails_without_contacting_a_service(self) -> None:
        with patch("backend.sidecar_server.prompting_providers.list_provider_models") as list_models:
            with self.assertRaisesRegex(ValueError, "Choose either LM Studio or Ollama"):
                validate_provider_model("cloud-provider", "model")
        list_models.assert_not_called()

    def test_provider_connection_and_authentication_failures_are_controlled(self) -> None:
        for error, message in [
            (ConnectionError("offline"), "is not reachable"),
            (PermissionError("blocked"), "requires authentication"),
        ]:
            with self.subTest(error=type(error).__name__):
                with patch(
                    "backend.sidecar_server.prompting_providers.list_provider_models",
                    side_effect=error,
                ):
                    with self.assertRaisesRegex(ValueError, message):
                        validate_provider_model("lmstudio", "local-model")

    def test_provider_timeout_and_malformed_failures_are_controlled(self) -> None:
        for error, message in [
            (TimeoutError("slow"), "did not respond while validating"),
            (RuntimeError("invalid payload"), "returned an invalid model response"),
        ]:
            with self.subTest(error=type(error).__name__):
                with patch(
                    "backend.sidecar_server.prompting_providers.list_provider_models",
                    side_effect=error,
                ):
                    with self.assertRaisesRegex(ValueError, message):
                        validate_provider_model("lmstudio", "local-model")

    def test_structurally_invalid_models_value_is_rejected(self) -> None:
        with patch(
            "backend.sidecar_server.prompting_providers.list_provider_models",
            return_value={"provider_id": "ollama", "provider_name": "Ollama", "models": {"id": "local-model"}},
        ):
            with self.assertRaisesRegex(ValueError, "returned an invalid model list"):
                validate_provider_model("ollama", "local-model")

    def test_missing_model_fails_validation(self) -> None:
        with patch(
            "backend.sidecar_server.prompting_providers.list_provider_models",
            return_value={"provider_id": "ollama", "provider_name": "Ollama", "models": [{"id": "another-model"}]},
        ):
            with self.assertRaisesRegex(ValueError, "is no longer available in Ollama"):
                validate_provider_model("ollama", "missing-model")


if __name__ == "__main__":
    unittest.main()
