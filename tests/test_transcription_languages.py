import unittest

from backend.sidecar_server.transcription_languages import (
    normalize_transcription_language,
    transcription_language_options,
)


class TranscriptionLanguageTests(unittest.TestCase):
    def test_catalog_contains_auto_detect_and_all_faster_whisper_language_codes(self) -> None:
        options = transcription_language_options()

        self.assertEqual(options[0], {"value": "auto", "label": "Auto-Detect"})
        self.assertEqual(len(options), 101)
        self.assertEqual(len({option["value"] for option in options}), 101)
        self.assertEqual([option["label"] for option in options[1:]], sorted(
            (option["label"] for option in options[1:]),
            key=str.casefold,
        ))

    def test_normalization_accepts_common_languages_and_auto_detect(self) -> None:
        self.assertEqual(normalize_transcription_language(None, model_name="small"), "auto")
        self.assertEqual(normalize_transcription_language(" DE ", model_name="small"), "de")
        self.assertEqual(normalize_transcription_language("ja", model_name="medium"), "ja")

    def test_normalization_rejects_unknown_language_codes(self) -> None:
        with self.assertRaisesRegex(ValueError, "supported transcription language"):
            normalize_transcription_language("not-a-language", model_name="small")

    def test_cantonese_requires_a_large_v3_model(self) -> None:
        with self.assertRaisesRegex(ValueError, "Cantonese requires"):
            normalize_transcription_language("yue", model_name="small")

        self.assertEqual(normalize_transcription_language("yue", model_name="large-v3"), "yue")
        self.assertEqual(normalize_transcription_language("yue", model_name="large-v3-turbo"), "yue")


if __name__ == "__main__":
    unittest.main()
