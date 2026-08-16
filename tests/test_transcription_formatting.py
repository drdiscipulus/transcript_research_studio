from __future__ import annotations

import unittest

from backend.sidecar_server.transcription_formatting import (
    format_timestamp,
    format_transcript,
    normalize_advanced_settings,
    segments_from_serialized_result,
    speaker_summary,
)
from backend.sidecar_server.transcription_types import SegmentLine


class TranscriptionFormattingTests(unittest.TestCase):
    def test_timestamp_and_transcript_formatting(self) -> None:
        segments = [
            SegmentLine(start_seconds=1.4, end_seconds=2.0, text="Hello", speaker="Speaker 1"),
            SegmentLine(start_seconds=65.0, end_seconds=70.0, text="World", speaker=None),
        ]

        self.assertEqual(format_timestamp(1.4), "00:01")
        self.assertEqual(format_timestamp(3661), "01:01:01")
        self.assertEqual(
            format_transcript(segments, include_timestamps=True),
            "[00:01] Speaker 1: Hello [01:05] World",
        )
        self.assertEqual(format_transcript(segments, include_timestamps=False), "Speaker 1: Hello World")

    def test_segments_from_serialized_result_normalizes_fields(self) -> None:
        segments = segments_from_serialized_result(
            [
                {"start": "1.5", "end": 2, "speaker": "SPEAKER_01", "text": " Hi "},
                {"text": "   "},
                "bad",
            ]
        )

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].start_seconds, 1.5)
        self.assertEqual(segments[0].end_seconds, 2.0)
        self.assertEqual(segments[0].speaker, "Speaker 01")
        self.assertEqual(segments[0].text, "Hi")
        self.assertEqual(speaker_summary(segments), "Speaker 01")

    def test_advanced_settings_are_normalized(self) -> None:
        options = normalize_advanced_settings(
            {
                "diarization_enabled": True,
                "include_timestamps": True,
                "beam_size": 0,
                "temperature": "-1",
                "exact_speakers": "2",
            }
        )

        self.assertTrue(options.diarization_enabled)
        self.assertTrue(options.include_timestamps)
        self.assertEqual(options.beam_size, 5)
        self.assertEqual(options.temperature, 0.0)
        self.assertEqual(options.exact_speakers, 2)
