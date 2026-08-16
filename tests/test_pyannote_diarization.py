from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

from backend.sidecar_server.pyannote_diarization import (
    SpeakerSegment,
    _load_audio_for_pyannote,
    _annotation_from_diarization_output,
    assign_speakers_to_segments,
    pyannote_model_available,
    redact_secret,
    run_pyannote_diarization,
)
from backend.sidecar_server.transcription_types import SegmentLine, WordLine


class PyannoteDiarizationTests(unittest.TestCase):
    def test_assigns_speaker_with_largest_overlap(self) -> None:
        segments = [
            SegmentLine(start_seconds=0.0, end_seconds=5.0, text="Hello"),
            SegmentLine(start_seconds=5.0, end_seconds=10.0, text="World"),
        ]
        speakers = [
            SpeakerSegment(start=0.0, end=4.0, speaker="Speaker 00"),
            SpeakerSegment(start=4.0, end=10.0, speaker="Speaker 01"),
        ]

        assigned = assign_speakers_to_segments(segments, speakers)

        self.assertEqual(assigned[0].speaker, "Speaker 00")
        self.assertEqual(assigned[1].speaker, "Speaker 01")

    def test_assigns_unknown_when_no_speaker_overlaps(self) -> None:
        assigned = assign_speakers_to_segments(
            [SegmentLine(start_seconds=10.0, end_seconds=12.0, text="Alone")],
            [SpeakerSegment(start=0.0, end=5.0, speaker="Speaker 00")],
        )

        self.assertEqual(assigned[0].speaker, "Unknown Speaker")

    def test_preserves_transcript_text_and_timestamps(self) -> None:
        segment = SegmentLine(start_seconds=1.0, end_seconds=3.0, text="Keep me")

        assigned = assign_speakers_to_segments(
            [segment],
            [SpeakerSegment(start=0.0, end=4.0, speaker="Speaker 00")],
        )

        self.assertEqual(assigned[0].start_seconds, 1.0)
        self.assertEqual(assigned[0].end_seconds, 3.0)
        self.assertEqual(assigned[0].text, "Keep me")

    def test_word_timestamps_split_segment_on_speaker_change(self) -> None:
        segments = [
            SegmentLine(
                start_seconds=0.0,
                end_seconds=4.0,
                text="Hello there Yes",
                words=[
                    WordLine(start_seconds=0.0, end_seconds=1.0, text="Hello"),
                    WordLine(start_seconds=1.0, end_seconds=2.0, text="there"),
                    WordLine(start_seconds=2.0, end_seconds=3.0, text="Yes"),
                ],
            )
        ]
        speakers = [
            SpeakerSegment(start=0.0, end=2.0, speaker="Speaker 00"),
            SpeakerSegment(start=2.0, end=4.0, speaker="Speaker 01"),
        ]

        assigned = assign_speakers_to_segments(segments, speakers)

        self.assertEqual(len(assigned), 2)
        self.assertEqual(assigned[0].speaker, "Speaker 00")
        self.assertEqual(assigned[0].text, "Hello there")
        self.assertEqual(assigned[0].start_seconds, 0.0)
        self.assertEqual(assigned[0].end_seconds, 2.0)
        self.assertEqual(assigned[1].speaker, "Speaker 01")
        self.assertEqual(assigned[1].text, "Yes")
        self.assertEqual(assigned[1].start_seconds, 2.0)
        self.assertEqual(assigned[1].end_seconds, 3.0)

    def test_word_timestamps_preserve_leading_space_tokens(self) -> None:
        segments = [
            SegmentLine(
                start_seconds=0.0,
                end_seconds=2.0,
                text="Hello, world",
                words=[
                    WordLine(start_seconds=0.0, end_seconds=0.5, text=" Hello"),
                    WordLine(start_seconds=0.5, end_seconds=1.0, text=","),
                    WordLine(start_seconds=1.0, end_seconds=2.0, text=" world"),
                ],
            )
        ]
        speakers = [SpeakerSegment(start=0.0, end=2.0, speaker="Speaker 00")]

        assigned = assign_speakers_to_segments(segments, speakers)

        self.assertEqual(len(assigned), 1)
        self.assertEqual(assigned[0].text, "Hello, world")

    def test_redacts_hugging_face_tokens(self) -> None:
        message = "Download failed for hf_1234567890abcdefTOKEN"

        self.assertEqual(redact_secret(message), "Download failed for [redacted-token]")

    def test_local_model_detection_requires_config_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            self.assertFalse(pyannote_model_available(model_dir))
            (model_dir / "config.yaml").write_text("pipeline:\n", encoding="utf-8")
            self.assertTrue(pyannote_model_available(model_dir))

    def test_run_pyannote_uses_predecoded_audio(self) -> None:
        class FakeDiarization:
            def itertracks(self, yield_label: bool = False):
                self.yield_label = yield_label
                return iter([])

        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            (model_dir / "config.yaml").write_text("pipeline:\n", encoding="utf-8")
            pipeline = Mock(return_value=FakeDiarization())
            audio_payload = {"waveform": object(), "sample_rate": 16000}

            with (
                patch("backend.sidecar_server.pyannote_diarization._load_pipeline", return_value=pipeline),
                patch("backend.sidecar_server.pyannote_diarization._load_audio_for_pyannote", return_value=audio_payload),
            ):
                run_pyannote_diarization(
                    media_path=Path("interview.m4a"),
                    device="cpu",
                    speaker_mode="auto",
                    exact_speakers=None,
                    min_speakers=None,
                    max_speakers=None,
                    model_dir=model_dir,
                )

        pipeline.assert_called_once_with(audio_payload)

    def test_audio_boundary_uses_decoder_and_tensor_contract_without_ml_dependencies(self) -> None:
        media_path = Path("research recording.wav")
        decoded_audio = object()
        waveform = object()
        tensor = Mock()
        float_tensor = Mock()
        tensor.float.return_value = float_tensor
        float_tensor.unsqueeze.return_value = waveform

        decode_audio = Mock(return_value=decoded_audio)
        faster_whisper = ModuleType("faster_whisper")
        faster_whisper.__path__ = []
        faster_whisper_audio = ModuleType("faster_whisper.audio")
        faster_whisper_audio.decode_audio = decode_audio
        faster_whisper.audio = faster_whisper_audio

        torch = ModuleType("torch")
        torch.from_numpy = Mock(return_value=tensor)
        controlled_modules = {
            "faster_whisper": faster_whisper,
            "faster_whisper.audio": faster_whisper_audio,
            "torch": torch,
        }
        missing_module = object()
        original_modules = {name: sys.modules.get(name, missing_module) for name in controlled_modules}

        with patch.dict(sys.modules, controlled_modules, clear=False):
            payload = _load_audio_for_pyannote(media_path)

        decode_audio.assert_called_once_with(str(media_path), sampling_rate=16000)
        torch.from_numpy.assert_called_once_with(decoded_audio)
        tensor.float.assert_called_once_with()
        float_tensor.unsqueeze.assert_called_once_with(0)
        self.assertEqual(payload, {"waveform": waveform, "sample_rate": 16000})
        for name, original_module in original_modules.items():
            if original_module is missing_module:
                self.assertNotIn(name, sys.modules)
            else:
                self.assertIs(sys.modules[name], original_module)

    def test_uses_exclusive_annotation_from_pyannote_community_output(self) -> None:
        output = Mock()
        output.exclusive_speaker_diarization = "exclusive"
        output.speaker_diarization = "regular"

        self.assertEqual(_annotation_from_diarization_output(output), "exclusive")


if __name__ == "__main__":
    unittest.main()
