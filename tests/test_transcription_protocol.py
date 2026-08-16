from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

from backend.transcription_protocol import TRANSCRIPTION_PROTOCOL_VERSION
from backend.transcription_worker import worker


def _message(message_type: str, request_id: str, **values: object) -> dict[str, object]:
    return {
        "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
        "request_id": request_id,
        "type": message_type,
        **values,
    }


def _run_session(messages: list[object], *, transcription_error: Exception | None = None):
    stdin = io.StringIO("".join(json.dumps(message) + "\n" for message in messages))
    stdout = io.StringIO()
    with (
        patch.object(worker.sys, "stdin", stdin),
        patch.object(worker.sys, "stdout", stdout),
        patch.object(worker, "preload_transcription_runtime") as preload,
        patch.object(worker, "_run_transcription") as transcribe,
    ):
        preload.return_value.whisper_model_name = "small"
        preload.return_value.device = "cpu"
        preload.return_value.compute_type = "int8"
        if transcription_error is not None:
            transcribe.side_effect = transcription_error
        exit_code = worker.session_main()
    responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
    return exit_code, responses, preload, transcribe


class TranscriptionProtocolTests(unittest.TestCase):
    def test_protocol_version_is_version_two(self) -> None:
        self.assertEqual(TRANSCRIPTION_PROTOCOL_VERSION, 2)

    def test_v1_and_missing_versions_are_rejected(self) -> None:
        _exit_code, responses, preload, _transcribe = _run_session(
            [
                {"protocol_version": 1, "request_id": "old", "type": "init"},
                {"request_id": "missing", "type": "init"},
            ]
        )

        self.assertEqual([response["error_code"] for response in responses], ["worker_protocol_error"] * 2)
        self.assertEqual([response["request_id"] for response in responses], ["old", "missing"])
        preload.assert_not_called()

    def test_missing_and_empty_request_ids_are_rejected(self) -> None:
        _exit_code, responses, preload, _transcribe = _run_session(
            [
                {"protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "type": "init"},
                {"protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "request_id": "", "type": "init"},
            ]
        )

        self.assertEqual(len(responses), 2)
        self.assertTrue(all(response["request_id"] == "unknown" for response in responses))
        self.assertTrue(all(response["error_code"] == "worker_protocol_error" for response in responses))
        preload.assert_not_called()

    def test_second_init_is_rejected_without_reloading_model(self) -> None:
        _exit_code, responses, preload, _transcribe = _run_session(
            [
                _message("init", "first"),
                _message("init", "second"),
                _message("shutdown", "stop"),
            ]
        )

        self.assertEqual(preload.call_count, 1)
        self.assertEqual(responses[0]["type"], "ready")
        self.assertEqual(responses[1]["error_code"], "worker_protocol_error")
        self.assertEqual(responses[2]["type"], "stopped")

    def test_transcribe_before_init_is_rejected(self) -> None:
        _exit_code, responses, preload, transcribe = _run_session(
            [_message("transcribe", "early", media_path="sample.wav")]
        )

        self.assertEqual(responses[0]["error_code"], "worker_protocol_error")
        preload.assert_not_called()
        transcribe.assert_not_called()

    def test_unsupported_message_type_is_rejected_after_init(self) -> None:
        _exit_code, responses, _preload, _transcribe = _run_session(
            [_message("init", "init"), _message("inspect", "bad"), _message("shutdown", "stop")]
        )

        self.assertEqual(responses[1]["type"], "error")
        self.assertEqual(responses[1]["error_code"], "worker_protocol_error")
        self.assertEqual(responses[2]["type"], "stopped")

    def test_worker_errors_are_redacted_flattened_and_bounded(self) -> None:
        secret = "hf_secretvalue123"
        long_error = RuntimeError(f"failed\nwith {secret} " + ("x" * 4_000))
        _exit_code, responses, _preload, _transcribe = _run_session(
            [
                _message("init", "init"),
                _message("transcribe", "file", media_path="sample.wav"),
                _message("shutdown", "stop"),
            ],
            transcription_error=long_error,
        )

        error_response = responses[1]
        self.assertEqual(error_response["error_code"], "internal_error")
        self.assertNotIn(secret, error_response["message"])
        self.assertNotIn("\n", error_response["message"])
        self.assertLessEqual(len(error_response["message"]), 2_000)

    def test_every_response_has_the_canonical_envelope(self) -> None:
        _exit_code, responses, _preload, _transcribe = _run_session(
            [_message("init", "init"), _message("shutdown", "stop")]
        )

        for response in responses:
            self.assertEqual(response["protocol_version"], TRANSCRIPTION_PROTOCOL_VERSION)
            self.assertIsInstance(response["request_id"], str)
            self.assertTrue(response["request_id"])
            self.assertIsInstance(response["type"], str)
            self.assertTrue(response["type"])


if __name__ == "__main__":
    unittest.main()
