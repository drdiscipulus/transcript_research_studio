# Transcript Research Studio — Version 1.0 Beta 2

**Version 1.0 Beta 2** (`1.0.0-beta.2`) is a focused bug-fix update for Transcript Research Studio. It keeps the supported workflows and platform scope of Beta 1 while correcting settings interactions discovered during hands-on testing. Stable `1.0.0` follows only after the beta has been tested with real research projects and across the complete platform qualification matrix.

## Fixes In Beta 2

- Codes now loads the locally available Ollama and LM Studio model list when the AI Assistant Settings are opened, without requiring the coding project to be closed and reopened.
- The AI Assistant Settings and Project Prompt Templates sections in Codes can be expanded and collapsed reliably.
- Settings sections use consistent chevrons and heading typography.
- Refresh Providers now shares the compact settings row in both Codes and Transcript Analysis.
- The sidebar uses the shorter **Analysis** label while the page title remains **Transcript Analysis**.

## Supported Packages

- Windows x64 CPU portable package
- Windows x64 NVIDIA/CUDA portable package
- Apple Silicon macOS 12 or later portable package, signed and notarized with Apple Developer ID

The Windows packages are not code-signed in this beta. Windows may display SmartScreen or an “unknown publisher” warning. Download packages only from this project’s GitHub Releases page.

The macOS package is supported only after its Developer ID signature, notarization, and Gatekeeper checks have passed. Intel Macs and Apple MPS acceleration are not supported by this beta.

## Main Workflows

- **Transcription** processes one recording or a folder of recordings and creates the selected Excel, CSV, JSON, or Word outputs.
- **Transcript Editor** supports correction of text, speakers, timestamps, and segment structure before cleaned files are exported.
- **Codes** stores evidence passages, codes, themes, and notes in a local coding project and creates selected downstream exports.
- **Transcript Analysis** runs built-in or reusable analyses with a local Ollama or LM Studio model and leaves source transcripts unchanged.
- **Models** manages the local transcription models used by the app and supports optional speaker-recognition setup.

## Files And Exchange Formats

Transcript exports are available as XLSX, CSV, JSON, and DOCX. Codes can create a privacy-focused ZIP bundle containing selected workbook, normalized CSV data, structured JSON, coded DOCX reports, or a schema-validated REFI-QDA **QDPX Beta** exchange project.

QDPX transfers text sources, codes, coded passages, notes, and theme groups; linked media is excluded. Transcript Research Studio does not import or round-trip QDPX, and QDPX is not a native MAXQDA or ATLAS.ti project format. Any application-specific import claim requires the exact application and version to be manually tested.

## Privacy And Limitations

- Recordings and transcripts are processed locally, and source files remain unchanged.
- The app adds no telemetry, analytics, crash upload, or automatic cloud upload.
- Ollama and LM Studio integrations are restricted to locally running providers.
- Hugging Face access is limited to explicit model downloads, speaker-recognition setup, and token tests.
- Intel macOS, Apple MPS acceleration, Windows code signing, installers, and runtime downloaders remain deferred.

Published assets are never replaced under an existing version tag. A later correction receives `v1.0.0-beta.3` or a later version.
