from __future__ import annotations

import http.client
import json
import threading
import unittest
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from backend.sidecar_server.server import AUTH_HEADER_NAME, MAX_JSON_BODY_BYTES, SidecarRequestHandler
from backend.sidecar_server.settings_store import _normalize_advanced_settings


class ServerSecurityTests(unittest.TestCase):
    def test_post_rejects_oversized_json_body_before_reading_body(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            connection.putrequest("POST", "/api/v1/settings")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(MAX_JSON_BODY_BYTES + 1))
            connection.endheaders()
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        self.assertEqual(payload["error"], "Request body is too large.")
        self.assertEqual(payload["error_code"], "payload_too_large")
        self.assertTrue(payload["request_id"])

    def test_post_rejects_invalid_content_length(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            connection.putrequest("POST", "/api/v1/settings")
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", "not-a-number")
            connection.endheaders()
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.status, HTTPStatus.BAD_REQUEST)
        self.assertEqual(payload["error"], "Invalid Content-Length header.")
        self.assertEqual(payload["error_code"], "invalid_request")
        self.assertTrue(payload["request_id"])

    def test_unexpected_model_download_error_returns_json_response(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            with patch(
                "backend.sidecar_server.server.download_faster_whisper_model",
                side_effect=ConnectionError("huggingface unreachable for hf_secretvalue123"),
            ):
                connection.request(
                    "POST",
                    "/api/v1/models/faster-whisper/download",
                    body=json.dumps({"model_name": "small"}),
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))

            connection.request("GET", "/api/v1/models/download-progress")
            progress_response = connection.getresponse()
            progress_payload = json.loads(progress_response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.status, HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(payload["error"], "huggingface unreachable for [redacted-token]")
        self.assertEqual(payload["error_code"], "internal_error")
        self.assertTrue(payload["request_id"])
        self.assertEqual(progress_response.status, HTTPStatus.OK)
        self.assertEqual(progress_payload["downloads"]["fw:small"]["status"], "failed")
        self.assertEqual(progress_payload["downloads"]["fw:small"]["message"], payload["error"])

    def test_unexpected_route_error_returns_json_response(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            with patch(
                "backend.sidecar_server.server.build_models_status_payload",
                side_effect=OSError("status check crashed for hf_secretvalue123"),
            ):
                connection.request("GET", "/api/v1/models/status")
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.status, HTTPStatus.INTERNAL_SERVER_ERROR)
        self.assertEqual(payload["error"], "status check crashed for [redacted-token]")
        self.assertEqual(payload["error_code"], "internal_error")
        self.assertTrue(payload["request_id"])

    def test_current_model_status_and_pyannote_mutation_routes_remain_available(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)
        token = "synthetic-sidecar-token"
        missing_status = {
            "model_id": "pyannote/speaker-diarization-community-1",
            "installed": False,
            "availability": "missing",
        }
        ready_status = {**missing_status, "installed": True, "availability": "ready"}

        try:
            with (
                patch("backend.sidecar_server.server.AUTH_TOKEN", token),
                patch(
                    "backend.sidecar_server.server.build_models_status_payload",
                    return_value={"faster_whisper": [], "pyannote": missing_status},
                ),
                patch("backend.sidecar_server.server.download_pyannote_model", return_value=ready_status),
                patch("backend.sidecar_server.server.delete_pyannote_model", return_value=missing_status),
            ):
                headers = {AUTH_HEADER_NAME: token}
                connection.request("GET", "/api/v1/models/status", headers=headers)
                models_response = connection.getresponse()
                models_payload = json.loads(models_response.read().decode("utf-8"))

                connection.request(
                    "POST",
                    "/api/v1/advanced/pyannote-model/download",
                    body=json.dumps({"token": "synthetic-hf-token"}),
                    headers={**headers, "Content-Type": "application/json"},
                )
                download_response = connection.getresponse()
                download_payload = json.loads(download_response.read().decode("utf-8"))

                connection.request(
                    "POST",
                    "/api/v1/advanced/pyannote-model/delete",
                    body="",
                    headers=headers,
                )
                delete_response = connection.getresponse()
                delete_payload = json.loads(delete_response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(models_response.status, HTTPStatus.OK)
        self.assertEqual(models_payload["pyannote"]["availability"], "missing")
        self.assertEqual(download_response.status, HTTPStatus.OK)
        self.assertEqual(download_payload["availability"], "ready")
        self.assertEqual(delete_response.status, HTTPStatus.OK)
        self.assertEqual(delete_payload["availability"], "missing")

    def test_removed_discovery_routes_return_authenticated_not_found(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)
        token = "synthetic-sidecar-token"

        try:
            with patch("backend.sidecar_server.server.AUTH_TOKEN", token):
                for path in (
                    "/api/v1/app/info",
                    "/api/v1/workflows",
                    "/api/v1/advanced/pyannote-model/status",
                ):
                    with self.subTest(path=path):
                        connection.request("GET", path, headers={AUTH_HEADER_NAME: token})
                        response = connection.getresponse()
                        payload = json.loads(response.read().decode("utf-8"))
                        self.assertEqual(response.status, HTTPStatus.NOT_FOUND)
                        self.assertEqual(payload["error_code"], "not_found")
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_health_exposes_stable_process_identity(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            connection.request("GET", "/health")
            first = json.loads(connection.getresponse().read().decode("utf-8"))
            connection.request("GET", "/health")
            second = json.loads(connection.getresponse().read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertTrue(first["instance_id"])
        self.assertTrue(first["started_at"])
        self.assertEqual(first["instance_id"], second["instance_id"])
        self.assertEqual(first["started_at"], second["started_at"])

    def test_authenticated_health_accepts_only_the_current_product_header(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)
        token = "synthetic-sidecar-token"
        retired_header = "-".join(["X", "AI", "Transcription", "Token"])

        try:
            with patch("backend.sidecar_server.server.AUTH_TOKEN", token):
                connection.request("GET", "/health", headers={AUTH_HEADER_NAME: token})
                authorized = connection.getresponse()
                authorized_payload = json.loads(authorized.read().decode("utf-8"))

                connection.request("GET", "/health")
                missing = connection.getresponse()
                missing_payload = json.loads(missing.read().decode("utf-8"))

                connection.request("GET", "/health", headers={"X-Unrelated-Token": token})
                wrong = connection.getresponse()
                wrong_payload = json.loads(wrong.read().decode("utf-8"))

                connection.request("GET", "/health", headers={retired_header: token})
                retired = connection.getresponse()
                retired_payload = json.loads(retired.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(AUTH_HEADER_NAME, "X-Transcript-Research-Studio-Token")
        self.assertEqual(authorized.status, HTTPStatus.OK)
        self.assertEqual(authorized_payload["status"], "ok")
        self.assertEqual(missing.status, HTTPStatus.UNAUTHORIZED)
        self.assertEqual(wrong.status, HTTPStatus.UNAUTHORIZED)
        self.assertEqual(retired.status, HTTPStatus.UNAUTHORIZED)
        self.assertEqual(missing_payload["error"], "Unauthorized request.")
        self.assertEqual(wrong_payload["error"], "Unauthorized request.")
        self.assertEqual(retired_payload["error"], "Unauthorized request.")
        self.assertNotIn(token, json.dumps(missing_payload))
        self.assertNotIn(token, json.dumps(wrong_payload))
        self.assertNotIn(token, json.dumps(retired_payload))

    def test_hugging_face_token_persistence_routes_are_not_exposed(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), SidecarRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)

        try:
            connection.request("POST", "/api/v1/advanced/hf-token/save", body="{}")
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.status, HTTPStatus.NOT_FOUND)
        self.assertEqual(payload["error_code"], "not_found")

    def test_legacy_token_test_metadata_is_not_persisted_in_settings(self) -> None:
        settings = _normalize_advanced_settings(
            {
                "hf_token_last_tested_at": "2026-07-17T12:00:00",
                "hf_token_last_test_status": "valid",
                "hf_token_last_test_message": "legacy value",
            }
        ).to_dict()

        self.assertFalse(any(key.startswith("hf_token") for key in settings))


if __name__ == "__main__":
    unittest.main()
