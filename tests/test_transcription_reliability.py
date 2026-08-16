from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.sidecar_server.transcription_engine import (
    _transcribe_with_faster_whisper,
    transcribe_media_direct,
)
from backend.sidecar_server.transcription_types import (
    EngineContext,
    SegmentLine,
    TranscriptionResult,
    TranscriptionRuntimeError,
)


def _result(*, device: str = "cpu") -> TranscriptionResult:
    return TranscriptionResult(
        transcript="Hello",
        detected_language="en",
        engine="faster-whisper",
        model="small",
        device=device,
        used_fallback=False,
        note=None,
        speaker_summary=None,
        segments=[SegmentLine(start_seconds=0.0, end_seconds=1.0, text="Hello")],
        warnings=None,
    )


class TranscriptionReliabilityTests(unittest.TestCase):
    def test_no_speech_is_empty_completed_result_with_coded_warning(self) -> None:
        model = SimpleNamespace(
            transcribe=lambda *_args, **_kwargs: (iter(()), SimpleNamespace(language="en"))
        )
        with (
            patch("backend.sidecar_server.transcription_engine.configure_ml_runtime_environment"),
            patch("backend.sidecar_server.transcription_engine._get_or_create_model", return_value=model),
            patch("backend.sidecar_server.transcription_engine.importlib.import_module"),
        ):
            result = _transcribe_with_faster_whisper(
                media_path=Path("silent.wav"),
                model_name="small",
                device="cpu",
                compute_type="int8",
                language=None,
                task="transcribe",
                include_timestamps=False,
                beam_size=5,
                vad_filter=True,
                temperature=0.0,
                word_timestamps=False,
            )

        self.assertEqual(result.transcript, "")
        self.assertEqual(result.segments, [])
        self.assertEqual(
            result.warnings,
            ["no_speech_detected: No speech was detected in this recording."],
        )

    def test_generic_cuda_asr_error_does_not_trigger_cpu_retry(self) -> None:
        with (
            patch(
                "backend.sidecar_server.transcription_engine.build_engine_context",
                return_value=EngineContext("small", "cuda", "float16"),
            ),
            patch(
                "backend.sidecar_server.transcription_engine._transcribe_with_faster_whisper",
                side_effect=RuntimeError("decoder rejected malformed audio"),
            ) as transcribe,
        ):
            with self.assertRaises(TranscriptionRuntimeError) as raised:
                transcribe_media_direct(
                    media_path=Path("bad.wav"),
                    output_mode="transcribe",
                    language="auto",
                    batch_name="batch",
                    model_name="small",
                    device_preference="cuda",
                )

        self.assertEqual(raised.exception.error_code, "asr_failed")
        self.assertEqual(transcribe.call_count, 1)

    def test_incidental_cuda_word_does_not_trigger_cpu_retry(self) -> None:
        with (
            patch(
                "backend.sidecar_server.transcription_engine.build_engine_context",
                return_value=EngineContext("small", "cuda", "float16"),
            ),
            patch(
                "backend.sidecar_server.transcription_engine._transcribe_with_faster_whisper",
                side_effect=RuntimeError("decoder rejected a file whose title contains CUDA"),
            ) as transcribe,
        ):
            with self.assertRaises(TranscriptionRuntimeError):
                transcribe_media_direct(
                    media_path=Path("bad.wav"),
                    output_mode="transcribe",
                    language="auto",
                    batch_name="batch",
                    model_name="small",
                    device_preference="cuda",
                )

        self.assertEqual(transcribe.call_count, 1)

    def test_recognized_cuda_runtime_error_retries_once_on_cpu(self) -> None:
        with (
            patch(
                "backend.sidecar_server.transcription_engine.build_engine_context",
                return_value=EngineContext("small", "cuda", "float16"),
            ),
            patch(
                "backend.sidecar_server.transcription_engine._transcribe_with_faster_whisper",
                side_effect=[RuntimeError("cuDNN failed to initialize"), _result(device="cpu")],
            ) as transcribe,
        ):
            result = transcribe_media_direct(
                media_path=Path("sample.wav"),
                output_mode="transcribe",
                language="auto",
                batch_name="batch",
                model_name="small",
                device_preference="cuda",
            )

        self.assertEqual(transcribe.call_count, 2)
        self.assertEqual(transcribe.call_args_list[1].kwargs["device"], "cpu")
        self.assertEqual(result.device, "cpu")
        self.assertTrue(result.used_fallback)
        self.assertTrue(any("CUDA transcription failed" in warning for warning in result.warnings or []))


if __name__ == "__main__":
    unittest.main()
