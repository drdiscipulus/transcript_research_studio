from __future__ import annotations

import importlib
import os
import unittest
from unittest.mock import patch

from backend.sidecar_server.security import (
    is_loopback_host,
    normalize_loopback_base_url,
    normalize_loopback_bind_host,
)


class SecurityPostureTests(unittest.TestCase):
    def test_loopback_host_detection_accepts_only_local_hosts(self) -> None:
        self.assertTrue(is_loopback_host("localhost"))
        self.assertTrue(is_loopback_host("127.0.0.1"))
        self.assertTrue(is_loopback_host("::1"))
        self.assertFalse(is_loopback_host("0.0.0.0"))
        self.assertFalse(is_loopback_host("192.168.1.20"))
        self.assertFalse(is_loopback_host("example.com"))

    def test_bind_host_falls_back_to_localhost_for_non_loopback_values(self) -> None:
        self.assertEqual(normalize_loopback_bind_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(normalize_loopback_bind_host("0.0.0.0"), "127.0.0.1")
        self.assertEqual(normalize_loopback_bind_host("example.com"), "127.0.0.1")

    def test_provider_base_url_falls_back_when_not_loopback(self) -> None:
        default = "http://127.0.0.1:11434"
        self.assertEqual(normalize_loopback_base_url("http://localhost:11434/", default=default), "http://localhost:11434")
        self.assertEqual(normalize_loopback_base_url("https://127.0.0.1:1234", default=default), "https://127.0.0.1:1234")
        self.assertEqual(normalize_loopback_base_url("http://192.168.1.20:11434", default=default), default)
        self.assertEqual(normalize_loopback_base_url("https://example.com", default=default), default)

    def test_provider_environment_overrides_stay_local_only(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TRANSCRIPT_RESEARCH_STUDIO_OLLAMA_BASE_URL": "https://example.com",
                "TRANSCRIPT_RESEARCH_STUDIO_LM_STUDIO_BASE_URL": "http://0.0.0.0:1234",
            },
        ):
            from backend.sidecar_server import prompting_providers

            module = importlib.reload(prompting_providers)

        self.assertEqual(module.OLLAMA_BASE_URL, "http://127.0.0.1:11434")
        self.assertEqual(module.LM_STUDIO_BASE_URL, "http://127.0.0.1:1234")
        importlib.reload(module)


if __name__ == "__main__":
    unittest.main()
