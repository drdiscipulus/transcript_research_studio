import unittest

from backend.sidecar_server.paragraph_builder import build_paragraphs


class ParagraphBuilderTests(unittest.TestCase):
    def test_merges_nearby_segments_with_same_speaker(self) -> None:
        paragraphs = build_paragraphs(
            [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 2.0,
                    "speaker": "Speaker 1",
                    "text": "Also ich glaube,",
                },
                {
                    "start_seconds": 2.6,
                    "end_seconds": 5.0,
                    "speaker": "Speaker 1",
                    "text": "da muss man ein bisschen ausholen.",
                },
            ]
        )

        self.assertEqual(len(paragraphs), 1)
        self.assertEqual(paragraphs[0]["paragraph_index"], 1)
        self.assertEqual(paragraphs[0]["start_seconds"], 0.0)
        self.assertEqual(paragraphs[0]["end_seconds"], 5.0)
        self.assertEqual(paragraphs[0]["speaker"], "Speaker 1")
        self.assertEqual(
            paragraphs[0]["text"],
            "Also ich glaube, da muss man ein bisschen ausholen.",
        )
        self.assertEqual(paragraphs[0]["source_segment_count"], 2)

    def test_splits_on_speaker_change(self) -> None:
        paragraphs = build_paragraphs(
            [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 2.0,
                    "speaker": "Speaker 1",
                    "text": "Erster Gedanke.",
                },
                {
                    "start_seconds": 2.2,
                    "end_seconds": 3.0,
                    "speaker": "Speaker 2",
                    "text": "Antwort.",
                },
            ]
        )

        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(paragraphs[0]["speaker"], "Speaker 1")
        self.assertEqual(paragraphs[1]["speaker"], "Speaker 2")

    def test_splits_on_long_pause(self) -> None:
        paragraphs = build_paragraphs(
            [
                {"start_seconds": 0.0, "end_seconds": 2.0, "text": "Erster Teil."},
                {"start_seconds": 5.1, "end_seconds": 7.0, "text": "Neuer Teil."},
            ]
        )

        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(paragraphs[0]["text"], "Erster Teil.")
        self.assertEqual(paragraphs[1]["text"], "Neuer Teil.")

    def test_default_pause_allows_longer_interview_pauses(self) -> None:
        paragraphs = build_paragraphs(
            [
                {"start_seconds": 0.0, "end_seconds": 2.0, "text": "Erster Teil."},
                {"start_seconds": 4.8, "end_seconds": 7.0, "text": "Weiter erzaehlt."},
            ]
        )

        self.assertEqual(len(paragraphs), 1)

    def test_ignores_long_pauses_when_pause_rule_is_disabled(self) -> None:
        paragraphs = build_paragraphs(
            [
                {"start_seconds": 0.0, "end_seconds": 2.0, "text": "eins zwei drei"},
                {"start_seconds": 12.4, "end_seconds": 14.0, "text": "vier fuenf"},
            ],
            max_pause_seconds=None,
        )

        self.assertEqual(len(paragraphs), 1)

    def test_does_not_merge_known_and_unknown_speaker(self) -> None:
        paragraphs = build_paragraphs(
            [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 2.0,
                    "speaker": "Speaker 1",
                    "text": "Mit Sprecher.",
                },
                {
                    "start_seconds": 2.2,
                    "end_seconds": 3.0,
                    "speaker": None,
                    "text": "Ohne Sprecher.",
                },
            ]
        )

        self.assertEqual(len(paragraphs), 2)

    def test_speaker_and_pause_break_strategy_matrix(self) -> None:
        cases = [
            ("speakers with pauses", "Speaker 1", "Speaker 1", 3.0, 2),
            ("speakers without pauses", "Speaker 1", "Speaker 2", None, 2),
            ("no speakers with pauses", None, None, 3.0, 2),
            ("no speakers without pauses", None, None, None, 1),
        ]

        for name, first_speaker, second_speaker, max_pause_seconds, expected_count in cases:
            with self.subTest(name=name):
                paragraphs = build_paragraphs(
                    [
                        {
                            "start_seconds": 0.0,
                            "end_seconds": 2.0,
                            "speaker": first_speaker,
                            "text": "First thought.",
                        },
                        {
                            "start_seconds": 8.0,
                            "end_seconds": 10.0,
                            "speaker": second_speaker,
                            "text": "Second thought.",
                        },
                    ],
                    max_pause_seconds=max_pause_seconds,
                )

                self.assertEqual(len(paragraphs), expected_count)


if __name__ == "__main__":
    unittest.main()
