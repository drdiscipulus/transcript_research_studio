# Transcript Research Studio — Version 1.0 Beta 3

**Version 1.0 Beta 3** (`1.0.0-beta.3`) expands transcription-language selection while keeping the local-first workflows and supported platform scope of Beta 2.

## Changes In Beta 3

- The Transcription language selector now exposes the complete language catalog supported by the bundled faster-whisper runtime.
- Languages can be filtered by name or language code and selected with mouse or keyboard.
- Auto-Detect remains the default.
- Cantonese is available with Large V3 and Large V3 Turbo; choosing a different model returns the setting to Auto-Detect.
- Speaker Detection remains independent of the selected transcription language.
- Dropdown sizing, chevrons, and fixed-height text controls were aligned to prevent clipped labels.
- The README and user guidance explain the local Ollama and LM Studio integration more clearly and include a Transcription workspace screenshot.

## Supported Packages

- Windows x64 CPU portable package
- Windows x64 NVIDIA/CUDA portable package
- Apple Silicon macOS 12 or later portable package, signed and notarized with Apple Developer ID

The Windows packages are not code-signed. Windows may display SmartScreen or an “unknown publisher” warning. Download packages only from this project’s GitHub Releases page.

The macOS package is supported only after its Developer ID signature, notarization, and Gatekeeper checks have passed. Intel Macs and Apple MPS acceleration are not supported.

Codes can export a schema-validated **QDPX Beta** exchange project. Transcript Research Studio does not import or round-trip QDPX, and QDPX is not a native MAXQDA or ATLAS.ti project format. Any application-specific compatibility claim must be manually tested with the exact application and version.

## Privacy And Limitations

- Recordings and transcripts are processed locally, and source files remain unchanged.
- The app adds no telemetry, analytics, crash upload, or automatic cloud upload.
- Ollama and LM Studio integrations are restricted to locally running providers.
- Hugging Face access is limited to explicit model downloads, speaker-recognition setup, and token tests.
- Intel macOS, Apple MPS acceleration, Windows code signing, installers, and runtime downloaders remain deferred.

Published assets are never replaced under an existing version tag. A later correction receives a new version and tag.
