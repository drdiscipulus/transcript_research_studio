import unittest
from pathlib import Path
from unittest.mock import patch

from backend.sidecar_server.transcription_engine import _with_optional_pyannote_diarization
from backend.sidecar_server.transcription_types import AdvancedTranscriptionOptions, SegmentLine, TranscriptionResult


def _options() -> AdvancedTranscriptionOptions:
    return AdvancedTranscriptionOptions(
        diarization_enabled=True,
        include_timestamps=True,
        beam_size=5,
        vad_filter=True,
        temperature=0.0,
        compute_type="int8",
        speaker_mode="auto",
        exact_speakers=None,
        min_speakers=None,
        max_speakers=None,
    )


def _result() -> TranscriptionResult:
    return TranscriptionResult(
        transcript="[00:00:00] Hello. [00:00:01] Hi.",
        detected_language="en",
        engine="faster-whisper",
        model="small",
        device="cuda",
        used_fallback=False,
        note=None,
        speaker_summary=None,
        segments=[
            SegmentLine(start_seconds=0.0, end_seconds=1.0, text="Hello."),
            SegmentLine(start_seconds=1.0, end_seconds=2.0, text="Hi."),
        ],
    )


class SpeakerRuntimeTests(unittest.TestCase):
    def test_pyannote_uses_cpu_fallback_when_torch_cuda_is_unavailable(self) -> None:
        with (
            patch("backend.sidecar_server.transcription_engine._resolve_pyannote_device", return_value="cpu"),
            patch("backend.sidecar_server.transcription_engine.run_pyannote_diarization", return_value=[]) as diarize,
        ):
            result = _with_optional_pyannote_diarization(
                media_path=Path(__file__),
                result=_result(),
                diarization_device="cuda",
                include_timestamps=True,
                options=_options(),
            )

        diarize.assert_called_once()
        self.assertEqual(diarize.call_args.kwargs["device"], "cpu")
        self.assertIn("Speaker recognition ran on CPU.", result.note or "")
        self.assertIn("fell back to CPU", result.note or "")

    def test_pyannote_skip_is_returned_as_warning(self) -> None:
        with (
            patch("backend.sidecar_server.transcription_engine._resolve_pyannote_device", return_value="cpu"),
            patch("backend.sidecar_server.transcription_engine.run_pyannote_diarization", side_effect=RuntimeError("missing pyannote")),
        ):
            result = _with_optional_pyannote_diarization(
                media_path=Path(__file__),
                result=_result(),
                diarization_device="cuda",
                include_timestamps=True,
                options=_options(),
            )

        self.assertEqual(result.engine, "faster-whisper")
        self.assertEqual(result.speaker_summary, None)
        self.assertTrue(result.warnings)
        self.assertIn("Speaker recognition skipped", result.warnings[0])
        self.assertIn("missing pyannote", result.warnings[0])


if __name__ == "__main__":
    unittest.main()
