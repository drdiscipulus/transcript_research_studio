# Stability fixtures

These fixtures describe or encode the release-gating edge cases without adding large generated files to Git.

- `media/valid-tiny.wav.b64` is a valid 44-byte PCM WAV container with an audio stream.
- `media/corrupt.wav` has a supported extension but an invalid container.
- `models/incomplete/` resembles a partial faster-whisper snapshot and intentionally lacks a vocabulary file.
- `oversized_excel.json` defines an Excel cell payload larger than 32,767 characters.
- `large_evidence.json` defines the deterministic payload size used to build a project larger than 10 MiB in tests.

Generated release archives must not contain this directory.
