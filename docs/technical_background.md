# Technical Background

Transcript Research Studio is a local desktop application built around a Tauri shell, a React user interface, and a bundled Python sidecar backend. It works as a file-based research companion app rather than a hosted service.

## Architecture

- **Desktop shell:** Tauri 2 runs the desktop window, launches the bundled sidecar, and mediates desktop file/folder interactions.
- **Frontend:** React and TypeScript provide the app screens for Home, Models, Transcription, Editor, Codes, Analysis, and Help. The Analysis page title remains **Transcript Analysis**; `prompting` remains an internal page and route family where compatibility requires it.
- **Backend:** A bundled Python sidecar exposes a local HTTP API for hardware detection, validated media scans, transcription batches, transcript editing/import/export, file-backed coding projects, settings, ephemeral Hugging Face token tests/setup, provider discovery, and Transcript Analysis runs.
- **Workers:** One isolated Python process serves each transcription batch through a versioned JSON-lines protocol. It loads faster-whisper and optional pyannote once, processes files sequentially, survives per-file errors, and can be restarted once after a worker crash.

Release packages bundle the Python runtime and backend code into the app resources. Users do not need to install Python manually for normal use.

Release runtime creation installs the local sidecar non-editably from an owned temporary source context so Python build products cannot dirty the repository. Hash-locked macOS source environments may legitimately contain Universal2 wheels; the maintained staging step recreates only its owned generated runtime root, copies and prunes the locked environment, removes the known unused Intel interpreter helper, atomically thins Universal2 Mach-O files in the staged copy to arm64, and atomically removes absolute wheel-build runtime search paths while retaining portable loader-relative paths. Because that load-command change invalidates existing Wheel integrity metadata, the changed files receive a verified ad-hoc seal so the unsigned staged runtime remains executable; the release signer later replaces it with the required Developer ID signature. Staging also removes only the versioned Torio/TorchCodec FFmpeg bridges and TorchAudio SoX bridges that are outside the application audio boundary: application media is decoded by the locked faster-whisper/PyAV path and pyannote receives the resulting in-memory waveform, while the core TorchAudio tensor and signal-processing runtime remains bundled. The source environment and system Python remain unchanged. Any staged Mach-O without an arm64 slice or with an unresolved non-system dependency is a release blocker, and the signer independently audits the complete immutable Mach-O graph before making any binary change.

## Core Speech-Processing Components

- **Transcription:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) performs local automatic speech recognition using app-managed model snapshots downloaded from Hugging Face.
- **Speaker diarization:** [pyannote.audio](https://github.com/pyannote/pyannote-audio) provides optional speaker diarization through the [Community-1 speaker diarization model](https://huggingface.co/pyannote/speaker-diarization-community-1). It distinguishes anonymous speaker turns; it does not identify the people speaking.
- **Processing order:** faster-whisper creates the transcript first. When diarization is enabled, pyannote runs afterward and the backend assigns its speaker labels to transcript segments by timestamp overlap.
- **Local model use:** Model downloads occur only after an explicit user action. Installed transcription and diarization models are then loaded from validated local snapshots.

## Local HTTP API

The frontend talks to the Python sidecar over HTTP on a loopback address. In desktop mode, the Tauri shell starts the sidecar on a private per-launch localhost port and provides a per-launch auth token. Sidecar routes require the matching `X-Transcript-Research-Studio-Token` header when that token is configured. The shell reports the service as ready only after an authenticated health response returns a valid healthy status and sidecar instance identity; accepting a TCP connection alone is insufficient.

Main endpoint groups include:

- `GET /health`
- transcription run-screen, scan, start-batch, and current-batch routes
- Transcript Analysis (`prompting`) provider, model, input inspection, prompt template, start-run, current-run, and cancel-run routes
- settings reset/update routes
- model status routes for faster-whisper and pyannote setup
- an ephemeral Hugging Face token test route (tokens are never persisted)
- pyannote model status and download routes
- transcript editor inspect, load, save, and export routes

The backend only accepts loopback bind hosts. Local Transcript Analysis provider URLs for Ollama and LM Studio are normalized to loopback HTTP(S) URLs.

## Transcription Flow

1. The user chooses either one media file or an input folder, plus a transcript output folder.
2. The sidecar opens each supported container and accepts it only when it has an audio stream. Corrupt, empty, unreadable, and video-only files are excluded individually; valid tiny files are not rejected by size.
3. The run request is normalized, rescanned, and frozen with both ready files and exclusions.
4. The batch runner starts one persistent worker and processes files sequentially without reloading the models for every file.
5. The transcription engine resolves a validated local faster-whisper snapshot and loads it in offline/local-only mode.
6. If diarization is enabled, pyannote runs after faster-whisper and speaker labels are merged by timestamp overlap.
7. A failed file produces no transcript export. Other files continue, and the automatic timestamped run overview records done, failed, excluded, and skipped outcomes.
8. Export writers create one selected-format transcript file per successfully completed media file.

Each selected export format is generated from the same per-media transcript data. By default, output filenames use the source media basename, for example `interview_01.json`, `interview_01.xlsx`, and `interview_01.docx`. If the user overrides the basename for multiple media files, the backend appends deterministic numbering such as `_01`, `_02`, and `_03`. Existing outputs are not overwritten silently; deterministic `_copyNN` suffixes are used when needed.

The transcript structure setting controls the rows or document body inside each output file: one full transcript block, one row/paragraph per final timestamped segment, or generated paragraph rows. JSON also keeps the full structured `documents` and `segments` data regardless of the grouped rows. Every run writes a timestamped run overview containing metadata and paths only, without full transcript text.

## Transcript Editor Flow

The Transcript Editor is an additive cleanup workflow, not a database-backed project mode.

1. The user loads an existing `JSON`, `CSV`, `XLSX`, or app-generated `DOCX` transcript export.
2. The sidecar inspects the file and reports document choices when a JSON export contains multiple recordings.
3. The selected recording is normalized into an edited transcript JSON shape with stable speaker IDs and editable segments.
4. The frontend lets the user edit segment text, change segment speaker IDs, rename speakers globally, merge neighboring segments, and optionally play a local media file from segment timestamps.
5. Saving writes a separate edited JSON working file.
6. Export adapts the edited transcript back into the existing document/segment shape and reuses the CSV, XLSX, JSON, and DOCX writers.

DOCX import is best-effort and is intended for files generated by this app. The editor remains a cleanup workflow; qualitative coding projects, codes, themes, notes, and AI suggestion decisions live in the separate Codes workflow.

## Codes Flow

Codes stores schema-1.1 `.evidence.json` project files behind a project handle containing the file path, project ID, and content-hash revision. A save location is required when the project is created. Confirmed evidence, code, theme, import, and AI-decision mutations auto-save atomically through a same-directory temporary file and retain one backup; HTTP 409 conflicts offer Reload or Save Copy. Unsaved form text remains an in-memory draft covered by the workbench close guard.

Folder import is non-recursive and uses a per-candidate preview before one atomic confirmed import. Equivalent app exports are grouped using path/document identity, normalized content fingerprints, and sibling export stems, with JSON preferred by default. The visible v1 workflow treats imported transcripts as project snapshots and does not refresh them in place. An edited version must use a distinct filename or path before it can be imported as a separate snapshot; transcript removal remains evidence-protected. Codes exports create one privacy-first ZIP bundle containing selected XLSX, normalized CSV, structured JSON, coded DOCX, and QDPX beta products without provider access. Optional Ollama and LM Studio providers are lazy-loaded only when AI Assistant Settings opens or a contextual AI action is invoked. Evidence, code, and note runs use typed task payloads, protected system prompts, transient result bodies, one active run per project, and exact-source validation. Compact run metadata is saved at run start; accepted, edited, and rejected decisions are committed atomically with the resulting evidence draft changes.

## Transcript Analysis Flow

Transcript Analysis runs one selected local-LLM analysis over one transcript file or a nonrecursive folder. Supported inputs are app JSON, edited JSON, CSV, XLSX, and app-generated or best-effort DOCX.

1. The app detects running local providers.
2. The user selects Ollama or LM Studio and one available local model.
3. The sidecar parses each source independently into logical transcript candidates and isolates malformed files.
4. Equivalent formats require an explicit representation choice; CSV and XLSX mappings are maintained per source.
5. The user selects Transcript Overview, Research Focus Analysis, Interview Review, or a saved Custom Analysis.
6. The sidecar runs the analysis independently per logical transcript. Long transcripts are chunked and synthesized where needed, and valid results survive later failures.
7. Conflict-free XLSX, CSV, JSON, or DOCX results are written under a basename derived from the input and analysis names; source transcripts stay untouched.

Provider requests are local HTTP calls to the user's separately installed Ollama or LM Studio instance. The app does not install providers or download analysis models.

## Portable Data

Release builds keep runtime data in a sibling folder named:

```text
transcript_research_studio_data/
```

That folder makes the package easy to move, archive, and remove. Hugging Face tokens pasted for pyannote setup are used only for the explicit request and are not stored.

## Model And Network Behavior

- Whisper transcription models are downloaded explicitly from the Models page and then selected from the Transcription page.
- The default `small` transcription model is not bundled and must be downloaded before use.
- pyannote diarization requires a one-time local model download after the user accepts the Hugging Face model terms.
- Hugging Face network access is limited to explicit transcription model downloads, pyannote model setup, and token tests. Installed transcription models are opened by validated snapshot path in local-only mode.
- Ollama and LM Studio access is limited to local provider URLs.
- The app does not add telemetry, analytics, crash upload, or cloud upload behavior.

## Security Posture

Transcript Research Studio is a local single-user desktop app. It assumes the user controls the local machine and explicitly selects the files and folders to process.

Important boundaries:

- The sidecar binds to loopback only.
- Desktop sidecar requests use a per-launch auth token.
- Provider URLs are constrained to loopback/local addresses.
- Source media files stay untouched.
- Source transcript files stay untouched.
- Backend subprocess calls use argument arrays rather than shell execution.
- Release artifacts must not contain local tokens, `.env` files, test data, `__pycache__`, `.pyc`, or temporary files.

The app is not a sandbox for untrusted local files or models. Researchers should use practical batch sizes, inspect generated outputs, and choose local models appropriate for their hardware and data.

## Source Repository Shape

The public repository keeps source, tests, scripts, lockfiles, and documentation visible for inspection. Generated outputs such as `release-artifacts/`, `dist/`, Tauri build output, `node_modules/`, virtual environments, and local work folders are ignored.
