from __future__ import annotations

import io
import queue
import subprocess
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.sidecar_server.transcription_session import (
    _PROCESS_POLL_INTERVAL_SECONDS,
    TranscriptionWorkerSession,
)
from backend.sidecar_server.transcription_types import (
    TranscriptionConfigurationError,
    TranscriptionWorkerError,
)
from backend.transcription_protocol import TRANSCRIPTION_PROTOCOL_VERSION


class _FakeProcess:
    def __init__(self, exit_code: int | None = None, stdout: io.StringIO | None = None) -> None:
        self.exit_code = exit_code
        self.stdout = stdout

    def poll(self) -> int | None:
        return self.exit_code

    def terminate(self) -> None:
        self.exit_code = -15

    def kill(self) -> None:
        self.exit_code = -9

    def wait(self, *, timeout: float) -> int:
        return self.exit_code or 0


class _CrashDuringWaitQueue:
    def __init__(self, process: _FakeProcess) -> None:
        self.process = process
        self.waits: list[float] = []

    def get_nowait(self):
        raise queue.Empty

    def get(self, *, timeout: float):
        self.waits.append(timeout)
        self.process.exit_code = 17
        raise queue.Empty


class _AdvancingEmptyQueue:
    def __init__(self, clock: "_FakeClock") -> None:
        self.clock = clock
        self.waits: list[float] = []

    def get_nowait(self):
        raise queue.Empty

    def get(self, *, timeout: float):
        self.waits.append(timeout)
        self.clock.value += timeout
        raise queue.Empty


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def _session() -> TranscriptionWorkerSession:
    return TranscriptionWorkerSession(
        batch_name="test",
        model_name="small",
        device_preference="cpu",
        advanced_settings=None,
    )


class TranscriptionWorkerSessionWaitTests(unittest.TestCase):
    def test_start_rejects_an_exited_owned_process_without_spawning_a_replacement(self) -> None:
        session = _session()
        exited_process = MagicMock()
        exited_process.poll.return_value = 23
        exited_process.stdin = MagicMock()
        exited_process.stdout = MagicMock()
        exited_process.stderr = MagicMock()
        session._process = exited_process

        with (
            patch("backend.sidecar_server.transcription_session.subprocess.Popen") as popen,
            self.assertRaises(TranscriptionWorkerError) as context,
        ):
            session.start()

        self.assertEqual(context.exception.error_code, "worker_crashed")
        self.assertIsNone(session._process)
        popen.assert_not_called()
        exited_process.stdin.close.assert_called_once_with()
        exited_process.stdout.close.assert_called_once_with()
        exited_process.stderr.close.assert_called_once_with()

    def test_stdout_reader_start_failure_terminates_without_sending_init(self) -> None:
        session = _session()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        stdout_reader = MagicMock()
        stderr_reader = MagicMock()
        stdout_reader.start.side_effect = RuntimeError("stdout reader unavailable")

        with (
            patch("backend.sidecar_server.transcription_session.subprocess.Popen", return_value=process),
            patch(
                "backend.sidecar_server.transcription_session.threading.Thread",
                side_effect=[stdout_reader, stderr_reader],
            ),
            patch.object(session, "_send") as send,
            patch.object(session, "_await_response") as await_response,
            self.assertRaisesRegex(RuntimeError, "stdout reader unavailable"),
        ):
            session.start()

        self.assertIsNone(session._process)
        send.assert_not_called()
        await_response.assert_not_called()
        process.terminate.assert_called_once_with()
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_stderr_reader_start_failure_cleans_up_started_stdout_reader_before_init(self) -> None:
        session = _session()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        stdout_reader = MagicMock()
        stderr_reader = MagicMock()
        stderr_reader.start.side_effect = RuntimeError("stderr reader unavailable")

        with (
            patch("backend.sidecar_server.transcription_session.subprocess.Popen", return_value=process),
            patch(
                "backend.sidecar_server.transcription_session.threading.Thread",
                side_effect=[stdout_reader, stderr_reader],
            ),
            patch.object(session, "_send") as send,
            patch.object(session, "_await_response") as await_response,
            self.assertRaisesRegex(RuntimeError, "stderr reader unavailable"),
        ):
            session.start()

        stdout_reader.start.assert_called_once_with()
        self.assertIsNone(session._process)
        send.assert_not_called()
        await_response.assert_not_called()
        process.terminate.assert_called_once_with()
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_terminate_suppresses_a_second_wait_timeout_after_kill(self) -> None:
        session = _session()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        process.wait.side_effect = [subprocess.TimeoutExpired("worker", 5), subprocess.TimeoutExpired("worker", 5)]
        session._process = process

        session.terminate()

        self.assertIsNone(session._process)
        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_terminate_kills_after_the_first_wait_timeout_and_closes_once(self) -> None:
        session = _session()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        process.wait.side_effect = [subprocess.TimeoutExpired("worker", 5), 0]
        session._process = process

        session.terminate()
        session.terminate()

        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_termination_before_process_assignment_prevents_initialization(self) -> None:
        session = _session()
        popen_entered = threading.Event()
        release_popen = threading.Event()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        start_errors: list[BaseException] = []

        def create_process(*_args, **_kwargs):
            popen_entered.set()
            release_popen.wait(timeout=2)
            return process

        def start_session() -> None:
            try:
                session.start()
            except BaseException as error:  # pragma: no cover - assertion reports the error
                start_errors.append(error)

        with patch("backend.sidecar_server.transcription_session.subprocess.Popen", side_effect=create_process):
            start_thread = threading.Thread(target=start_session)
            start_thread.start()
            self.assertTrue(popen_entered.wait(timeout=2))
            session.terminate()
            release_popen.set()
            start_thread.join(timeout=2)

        self.assertFalse(start_thread.is_alive())
        self.assertEqual(len(start_errors), 1)
        self.assertIsInstance(start_errors[0], TranscriptionWorkerError)
        self.assertEqual(start_errors[0].error_code, "worker_crashed")
        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)
        process.stdin.close.assert_called_once_with()
        process.stdout.close.assert_called_once_with()
        process.stderr.close.assert_called_once_with()

    def test_terminate_and_pipe_cleanup_are_idempotent_for_all_process_states(self) -> None:
        no_process_session = _session()
        no_process_session.terminate()
        no_process_session.terminate()
        with (
            patch("backend.sidecar_server.transcription_session.subprocess.Popen") as popen,
            self.assertRaises(TranscriptionWorkerError),
        ):
            no_process_session.start()
        popen.assert_not_called()

        live_session = _session()
        live_process = MagicMock()
        live_process.poll.return_value = None
        live_process.stdin = MagicMock()
        live_process.stdout = MagicMock()
        live_process.stderr = MagicMock()
        live_session._process = live_process
        live_session.terminate()
        live_session.terminate()
        live_process.terminate.assert_called_once_with()
        live_process.wait.assert_called_once_with(timeout=5)
        live_process.stdin.close.assert_called_once_with()
        live_process.stdout.close.assert_called_once_with()
        live_process.stderr.close.assert_called_once_with()

        exited_session = _session()
        exited_process = MagicMock()
        exited_process.poll.return_value = 0
        exited_process.stdin = MagicMock()
        exited_process.stdout = MagicMock()
        exited_process.stderr = MagicMock()
        exited_session._process = exited_process
        exited_session.terminate()
        exited_session.terminate()
        exited_process.terminate.assert_not_called()
        exited_process.wait.assert_not_called()
        exited_process.stdin.close.assert_called_once_with()
        exited_process.stdout.close.assert_called_once_with()
        exited_process.stderr.close.assert_called_once_with()

    def test_termination_interrupts_wait_for_initial_ready_response(self) -> None:
        session = _session()
        wait_entered = threading.Event()
        process = MagicMock()
        process.poll.return_value = None
        process.stdin = MagicMock()
        process.stdout = MagicMock()
        process.stderr = MagicMock()

        class TerminationAwareQueue:
            def get_nowait(self):
                raise queue.Empty

            def get(self, *, timeout: float):
                wait_entered.set()
                session._termination_requested.wait(timeout=timeout + 1)
                raise queue.Empty

        session._process = process
        session._messages = TerminationAwareQueue()  # type: ignore[assignment]
        wait_errors: list[BaseException] = []

        def wait_for_ready() -> None:
            try:
                session._await_response("init", timeout_seconds=300)
            except BaseException as error:  # pragma: no cover - assertion reports the error
                wait_errors.append(error)

        waiter = threading.Thread(target=wait_for_ready)
        waiter.start()
        self.assertTrue(wait_entered.wait(timeout=2))
        session.terminate()
        waiter.join(timeout=2)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(len(wait_errors), 1)
        self.assertIsInstance(wait_errors[0], TranscriptionWorkerError)
        self.assertEqual(wait_errors[0].error_code, "worker_crashed")

    def test_process_crash_is_detected_after_one_short_queue_wait(self) -> None:
        session = _session()
        process = _FakeProcess()
        messages = _CrashDuringWaitQueue(process)
        session._process = process  # type: ignore[assignment]
        session._messages = messages  # type: ignore[assignment]

        with self.assertRaises(TranscriptionWorkerError) as context:
            session._await_response("request", timeout_seconds=3600)

        self.assertEqual(context.exception.error_code, "worker_crashed")
        self.assertIn("exit code 17", str(context.exception))
        self.assertEqual(len(messages.waits), 1)
        self.assertLessEqual(messages.waits[0], _PROCESS_POLL_INTERVAL_SECONDS)

    def test_live_worker_uses_absolute_deadline_and_raises_timeout(self) -> None:
        session = _session()
        clock = _FakeClock()
        messages = _AdvancingEmptyQueue(clock)
        session._process = _FakeProcess()  # type: ignore[assignment]
        session._messages = messages  # type: ignore[assignment]

        with (
            patch("backend.sidecar_server.transcription_session.time.monotonic", clock),
            self.assertRaises(TimeoutError),
        ):
            session._await_response("request", timeout_seconds=1)

        self.assertTrue(messages.waits)
        self.assertLessEqual(max(messages.waits), _PROCESS_POLL_INTERVAL_SECONDS)
        self.assertGreaterEqual(clock.value, 1.0)

    def test_transcribe_preserves_structured_worker_timeout_error(self) -> None:
        session = _session()
        session._process = _FakeProcess()  # type: ignore[assignment]

        with (
            patch.object(session, "_send"),
            patch.object(session, "_await_response", side_effect=TimeoutError("deadline")),
            patch.object(session, "terminate") as terminate,
            self.assertRaises(TranscriptionWorkerError) as context,
        ):
            session.transcribe(
                media_path=Path("recording.wav"),
                output_mode="transcribe",
                language="auto",
                timeout_seconds=300,
            )

        self.assertEqual(context.exception.error_code, "worker_timeout")
        self.assertIn("recording.wav", str(context.exception))
        terminate.assert_called_once_with()

    def test_invalid_json_stdout_fails_current_request_immediately(self) -> None:
        session = _session()
        messages: queue.Queue = queue.Queue()
        process = _FakeProcess(stdout=io.StringIO("not-json\n"))
        session._process = process  # type: ignore[assignment]
        session._messages = messages
        session._read_stdout(process, messages)  # type: ignore[arg-type]

        with self.assertRaises(TranscriptionWorkerError) as context:
            session._await_response("request", timeout_seconds=3600)

        self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_non_object_stdout_fails_current_request_immediately(self) -> None:
        session = _session()
        messages: queue.Queue = queue.Queue()
        process = _FakeProcess(stdout=io.StringIO("[]\n"))
        session._process = process  # type: ignore[assignment]
        session._messages = messages
        session._read_stdout(process, messages)  # type: ignore[arg-type]

        with self.assertRaises(TranscriptionWorkerError) as context:
            session._await_response("request", timeout_seconds=3600)

        self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_mismatched_response_id_is_a_protocol_error(self) -> None:
        session = _session()
        session._process = _FakeProcess()  # type: ignore[assignment]
        session._messages.put(
            {
                "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
                "request_id": "other",
                "type": "result",
            }
        )

        with self.assertRaises(TranscriptionWorkerError) as context:
            session._await_response("expected", timeout_seconds=300)

        self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_missing_or_old_response_identity_is_a_protocol_error(self) -> None:
        for response in (
            {"request_id": "request", "type": "result"},
            {"protocol_version": 1, "request_id": "request", "type": "result"},
            {"protocol_version": TRANSCRIPTION_PROTOCOL_VERSION, "type": "result"},
        ):
            with self.subTest(response=response):
                session = _session()
                session._process = _FakeProcess()  # type: ignore[assignment]
                session._messages.put(response)
                with self.assertRaises(TranscriptionWorkerError) as context:
                    session._await_response("request", timeout_seconds=300)
                self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_ready_response_cannot_satisfy_transcription_request(self) -> None:
        session = _session()
        session._process = _FakeProcess()  # type: ignore[assignment]
        response = {
            "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
            "request_id": "request",
            "type": "ready",
            "status": "ok",
        }
        with (
            patch("backend.sidecar_server.transcription_session.uuid.uuid4") as request_uuid,
            patch.object(session, "_send"),
            patch.object(session, "_await_response", return_value=response),
            self.assertRaises(TranscriptionWorkerError) as context,
        ):
            request_uuid.return_value.hex = "request"
            session.transcribe(
                media_path=Path("recording.wav"),
                output_mode="transcribe",
                language="auto",
                timeout_seconds=300,
            )

        self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_invalid_success_payload_cannot_create_empty_transcript(self) -> None:
        session = _session()
        session._process = _FakeProcess()  # type: ignore[assignment]
        response = {
            "protocol_version": TRANSCRIPTION_PROTOCOL_VERSION,
            "request_id": "request",
            "type": "result",
            "status": "ok",
            "transcript": None,
            "segments": {},
        }
        with (
            patch("backend.sidecar_server.transcription_session.uuid.uuid4") as request_uuid,
            patch.object(session, "_send"),
            patch.object(session, "_await_response", return_value=response),
            self.assertRaises(TranscriptionWorkerError) as context,
        ):
            request_uuid.return_value.hex = "request"
            session.transcribe(
                media_path=Path("recording.wav"),
                output_mode="transcribe",
                language="auto",
                timeout_seconds=300,
            )

        self.assertEqual(context.exception.error_code, "worker_protocol_error")

    def test_structured_worker_error_code_is_preserved(self) -> None:
        session = _session()
        with self.assertRaises(TranscriptionWorkerError) as context:
            session._raise_for_error(
                {
                    "status": "error",
                    "type": "error",
                    "error_kind": "runtime",
                    "error_code": "cuda_runtime_failed",
                    "message": "CUDA failed safely.",
                }
            )

        self.assertEqual(context.exception.error_code, "cuda_runtime_failed")

    def test_configuration_error_code_is_preserved(self) -> None:
        session = _session()
        with self.assertRaises(TranscriptionConfigurationError) as context:
            session._raise_for_error(
                {
                    "status": "error",
                    "type": "error",
                    "error_kind": "configuration",
                    "error_code": "model_snapshot_incomplete",
                    "message": "The model snapshot is incomplete.",
                }
            )

        self.assertEqual(context.exception.error_code, "model_snapshot_incomplete")


if __name__ == "__main__":
    unittest.main()
