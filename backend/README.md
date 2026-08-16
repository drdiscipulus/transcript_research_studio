# Python Sidecar

Bundled backend sidecar for Transcript Research Studio.

## Responsibilities

- expose an authenticated, loopback-only desktop API and safe local path helpers;
- detect system hardware in phases without blocking ordinary CPU workflows;
- scan media, freeze run settings, and execute sequential transcription batches through one persistent protocol-v2 worker;
- inspect, load, save, and export transcript editing copies without modifying source files;
- validate and manage local faster-whisper and optional pyannote model snapshots through explicit user actions;
- own revisioned coding-project persistence, contextual AI decisions, and privacy-first export bundles;
- inspect logical Transcript Analysis candidates and run selected analyses through local Ollama or LM Studio providers;
- persist local app settings and write safe, conflict-free workflow outputs.

## Internal structure

- `run_screen.py` keeps run-screen defaults and batch preparation orchestration; `run_hardware.py` owns the phased background hardware manager, and media-file/folder scanning lives in focused helper modules.
- `batch_runner.py` owns sequential batch state and execution; one `transcription_session.py` protocol-v2 JSON-lines worker is retained per batch, and export rows/file writers live behind `export_writer.py`.
- `prompting.py` owns Transcript Analysis run state; provider adapters, transcript normalization, task execution, output package writing, and analysis logs live in focused helper modules.
- `transcription_engine.py` owns transcription execution; model download/cache, result types, and transcript formatting live in focused helper modules.

## API families

- **Health, authentication, and hardware:** `/health` plus `/api/v1/system/*` expose authenticated process identity, phased hardware snapshots/retry, and validated desktop path actions.
- **Transcription:** `/api/v1/transcription/*` serves setup defaults, media scanning, immutable batch start, current state, and cancellation. The retained worker protocol is internal rather than a public HTTP contract.
- **Editor:** `/api/v1/editor/*` inspects supported transcript files, loads one logical document, saves JSON editing copies, and exports edited content.
- **Models and Hugging Face setup:** `/api/v1/models/*` reports combined readiness and performs explicit faster-whisper download/delete actions; `/api/v1/advanced/*` performs ephemeral token tests and explicit pyannote setup/delete actions.
- **Codes:** `/api/v1/codes/project/*` owns current handle/revision project operations, transcript import, exact evidence, codes/themes, contextual AI runs/decisions, and ZIP export bundles.
- **Transcript Analysis:** `/api/v1/prompting/*` inspects logical candidates, resolves local provider/model choices, manages custom analyses and prompt templates, and writes selected outputs.
- **Settings and safe desktop helpers:** `/api/v1/settings*` persists local settings, while the system family opens or selects validated local paths.

Removed discovery, status, compatibility, and whole-project fallback routes are not part of the current API. Add or restore an endpoint only for an explicit active contract.

## Development run

From the repository root:

```powershell
py -m backend.sidecar_server
```

In development, the sidecar binds to localhost and uses the configured host and port values. In the desktop app, it is launched on a private per-run localhost port and protected by a per-launch auth token passed in by the Tauri shell.

## Local security posture

- The sidecar accepts loopback bind hosts only; non-loopback host overrides fall back to `127.0.0.1`.
- Browser-origin requests are limited to the Tauri/local development origins configured in `server.py`.
- When the desktop shell provides `TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN`, all sidecar routes require the matching `X-Transcript-Research-Studio-Token` header.
- Ollama and LM Studio provider URLs are normalized to loopback HTTP(S) URLs only.
- Hugging Face network access is limited to explicit model downloads, pyannote model setup, and ephemeral token tests. Installed faster-whisper snapshots are loaded local-only.
- Backend subprocess calls use argument arrays rather than shell execution.

## Verification

From the repository root:

```powershell
py -m unittest discover -s tests -q
npm run security:check
```

The regression suite includes local workflow smoke tests for sidecar health,
mocked transcription export writing, and mocked Transcript Analysis output writing.
