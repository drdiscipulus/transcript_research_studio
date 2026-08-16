# 1.0.0-beta.2 Release Checklist

Use this checklist before publishing or handing over `v1.0.0-beta.2`. This is a stability beta, not a feature release. Do not advance to a later section while an earlier gate is failing.

## Release Identity And Scope

- [ ] Version is `1.0.0-beta.2` everywhere and the intended annotated tag is `v1.0.0-beta.2`.
- [ ] The release targets only Windows x64 CPU portable, Windows x64 NVIDIA/CUDA portable, and Apple Silicon macOS 12 or later portable.
- [ ] Windows artifacts are explicitly described as unsigned and likely to trigger SmartScreen or an "unknown publisher" warning.
- [ ] The macOS artifact is Developer ID signed, notarized, and accepted by Gatekeeper. Never publish an unsigned or unnotarized macOS build.
- [ ] Intel macOS, MPS acceleration, Windows signing, installers, runtime downloaders, semantic search, collaboration, and new Codes/AI capabilities remain deferred.
- [ ] Existing transcript columns and the Power Query folder-combine workflow remain compatible; coding projects use `.evidence.json` schema 1.1.
- [ ] Release notes do not claim native MAXQDA or ATLAS.ti project-format compatibility. Record an import workflow only when that exact workflow was manually tested.
- [ ] Internal demo media and all other internal test data are absent from generated artifacts.
- [ ] The Git working tree is clean before any release build begins.

## Automated Checks

Run from the repository root:

```powershell
py -3.12 -m unittest discover -s tests -q
npm run frontend:check
npm run build
npm run docs:check
npm run security:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

The backend smoke tests must continue to cover sidecar health routes, a mocked transcription batch, and a mocked Transcript Analysis run. The full suite must also cover corrupt media, valid media smaller than 5 KB, incomplete model snapshots, XML-invalid text, oversized Excel cells, and large coding projects.

The gate passes only when Python tests, frontend tests and typechecking, the production frontend build, Rust checks, documentation checks, and security checks all pass on Windows and macOS CI. GitHub Actions starts this matrix automatically only for a pull request targeting `main` once it is ready for review; draft pull requests do not consume the matrix, and maintainers can start the same gate manually when necessary. New commits and reopened ready pull requests rerun it, while merging an already qualified pull request does not automatically repeat the identical matrix on `main`.

CI is a cross-platform quality gate, not a release-packaging workflow: it installs only the minimal hash-pinned test dependencies and does not create runtimes or packages, use GPU hardware, download models, sign, notarize, staple, upload artifacts, or publish anything. The GitHub Windows runner neither produces nor qualifies a CUDA build. Its `cargo check` and `cargo test` steps use a Tauri configuration overlay with an empty resource list, so clean-checkout compilation does not require ignored, locally generated release runtimes; the ordinary Tauri configuration and local release-build resource validation remain unchanged. Passing CI is necessary but does not replace the separate maintainer-controlled Windows CPU, Windows CUDA, and signed/notarized/stapled macOS package builds and manual qualification below.

## Fresh Hashed Runtimes

Build each runtime from scratch with Python 3.12 and the profile-specific exact, hashed lock. Runtime creation must install with hash verification, install the application non-editably from a temporary owned build context, and leave the repository root free of Python build products.

```powershell
npm run runtime:windows:cpu
npm run runtime:windows:cuda
```

On Apple Silicon macOS:

```bash
npm run runtime:macos:arm64
```

- [ ] Windows CPU uses `requirements-win-cpu.txt` and CPU-only Torch/Torchaudio wheels.
- [ ] Windows CUDA uses `requirements-win-gpu.txt` and the intended CUDA Torch/Torchaudio wheels.
- [ ] macOS arm64 uses `requirements-macos-cpu.txt`. Its source lock environment may contain Universal2 wheels, but maintained staging recreates its owned generated root and produces a physically arm64-only runtime without modifying the source environment.
- [ ] Every staged macOS Mach-O contains exactly one `arm64` slice; any non-helper dependency without arm64 remains a hard release blocker.
- [ ] The staged macOS runtime omits only the enumerated optional Torio/TorchCodec FFmpeg and TorchAudio SoX native bridges. Core TorchAudio remains present, and a synthetic WAV passes through the production faster-whisper decoder into pyannote as an in-memory waveform without loading an omitted bridge.
- [ ] The validated baseline is Python 3.12, faster-whisper 1.2.1, pyannote.audio 4.0.4, Torch/Torchaudio 2.8.0, PyAV 17.0.1, and huggingface-hub 0.36.2.
- [ ] Staging removes stale files from its exact generated bundle root; no runtime contains an editable-install hook, absolute maintainer path, stale source copy, model cache, log, secret, or test data.
- [ ] The CPU environment was created independently. It was not cloned from or pruned out of the CUDA environment.
- [ ] Production dependency audit succeeds and no high-severity development advisory remains.

## macOS Maintainer Setup

Build the macOS release on Apple Silicon macOS 12 or later. The app is distributed as a portable GitHub Release zip, not through the Mac App Store and not as a PKG, DMG, or installer.

Prerequisites:

- Xcode command line tools: `xcode-select --install`
- Rust toolchain
- Node.js with npm
- Python 3.12
- Apple Developer account
- Developer ID Application certificate installed in Keychain

From a fresh clone of the intended tag:

```bash
git clone https://github.com/drdiscipulus/transcript-research-studio.git
cd transcript-research-studio
git checkout v1.0.0-beta.2
npm ci
npm run runtime:macos:arm64
.release-envs/macos-arm64/bin/python -m unittest discover -s tests -q
npm run frontend:check
npm run build
npm run docs:check
npm run security:check
```

Store notarization credentials once:

```bash
xcrun notarytool store-credentials transcript-research-notary \
  --apple-id "<apple-id>" \
  --team-id "<team-id>" \
  --password "<app-specific-password>"
```

The pre-tag macOS qualification path builds, signs, notarizes, staples, exports, and verifies a qualification-marked artifact:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_NOTARY_KEYCHAIN_PROFILE="transcript-research-notary"
npm run release:macos:preflight
npm run release:macos:qualification
```

After qualification, create and check out the annotated release tag in a fresh, clean clone. Unset qualification mode and use the identity-checked final macOS entrypoint:

```bash
unset TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD
npm run release:macos:final
```

`release:macos:final` verifies the clean annotated-tag identity first, then invokes the same signed and notarized macOS pipeline. Do not use the internal `release:macos` pipeline directly for a final public artifact.

Do not commit Apple IDs, app-specific passwords, signing identities, keychain material, or generated notarization archives.

## Artifact Provenance And Packaging

- [ ] Build metadata embeds the app version, tag, commit SHA, platform, architecture, runtime profile, Python version, dependency-lock hash, backend source hash, and UTC build time.
- [ ] Each archive is generated from a clean, fresh profile-specific environment and is extracted into a new directory for final verification.
- [ ] Verification rejects absolute maintainer paths, editable-install hooks, stale source, bundled models, logs, caches, test data, secrets, wrong architectures, and wrong Torch profiles.
- [ ] Each deliverable has a SHA-256 checksum, SBOM, and `THIRD_PARTY_NOTICES.md`.
- [ ] Windows CPU is one portable zip.
- [ ] Windows CUDA is built reproducibly as one zip and then split deterministically into `.partNNN` assets below GitHub's per-asset limit.
- [ ] The CUDA parts manifest lists size and SHA-256 for every part.
- [ ] `reassemble_cuda.ps1` is checksummed, validates every part, reconstructs the original zip, and the reconstructed zip extracts and verifies successfully.
- [ ] Apple Silicon macOS is one signed and notarized portable zip.
- [ ] The portable packages launch on machines without Node, Rust, or system Python.
- [ ] Paths containing spaces and non-ASCII characters work for the package, media input, projects, and output.

For a full local build, export, package, and verification cycle:

```powershell
npm run release:qualification
```

On macOS, use `npm run release:macos:qualification` for the pre-tag qualification artifact. The Windows
application and CUDA reassembly helper remain unsigned in this beta. The final verifier checks the helper's
SHA-256 entry in `SHA256SUMS.txt` before using it to reconstruct the CUDA archive.

For the final post-qualification Windows build from the fresh clone of the annotated tag, use
`npm run release:final`. For the final macOS build, use `npm run release:macos:final` so the
identity check is followed by the signed/notarized pipeline. Both commands reject a lightweight
tag, a tag that does not point to `HEAD`, a dirty working tree, or inherited
`TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD=1` before building. They also remove the qualification
variable from the child build environment so final filenames and embedded provenance cannot use
the `qualification-<commit>` identity.

## Platform Workflow Qualification

Complete the following on physical or representative target machines, using archives extracted from the final packaged assets rather than staging directories.

### Windows x64 CPU Without NVIDIA

- [ ] Launch and service recovery work without a developer environment.
- [ ] Model download, incomplete-model Repair, and offline model reuse work.
- [ ] Transcription and diarization run on CPU.
- [ ] Transcript Analysis, Editor, Codes, and all selected exports complete.
- [ ] The app never attempts to load CUDA libraries as its selected profile.

### Windows x64 NVIDIA/CUDA

On the NVIDIA qualification machine, require the archive verifier to exercise real CUDA hardware:

```powershell
$env:TRANSCRIPT_RESEARCH_STUDIO_REQUIRE_CUDA_HARDWARE = "1"
npm run release:verify
Remove-Item Env:\TRANSCRIPT_RESEARCH_STUDIO_REQUIRE_CUDA_HARDWARE
```

- [ ] CTranslate2 reports CUDA execution.
- [ ] Torch and pyannote report CUDA execution.
- [ ] Model download/Repair, offline reuse, transcription, diarization, Transcript Analysis, Editor, Codes, and exports complete.
- [ ] A recognized CUDA runtime failure retries the active file once on CPU and clearly records the fallback; unrelated ASR failures do not trigger CPU fallback.

### Apple Silicon macOS 12 Or Later

- [ ] Executables and native libraries report arm64, not x86_64/Rosetta.
- [ ] Gatekeeper opens the unzipped app without damaged-app or unidentified-developer blocking.
- [ ] CPU transcription and diarization complete.
- [ ] Model download/Repair, offline reuse, Transcript Analysis, Editor, Codes, and exports complete.

## 60-File Offline Soak

Use at least 60 short recordings in one input folder so the run exceeds the reported approximately 50-file failure threshold. The corpus must include valid audio smaller than 5 KB, corrupt media, zero-byte media, video-only media, spaces and non-ASCII characters in paths, and ordinary valid recordings.

Model matrix:

- Windows CPU and macOS arm64: `small` and `large-v3-turbo`
- Windows CUDA: `small`, `large-v3`, and `large-v3-turbo`

For every model/profile combination:

1. Download or repair the model while online and confirm it is classified `ready`.
2. Disable network access before starting transcription.
3. Scan and confirm valid tiny audio remains eligible while corrupt, zero-byte, unreadable, and video-only files are excluded individually.
4. Run all eligible files and confirm exclusions do not abort the batch.
5. Confirm installed transcription models make no Hugging Face requests.
6. Confirm one per-file failure does not stop remaining files and the run always reaches a terminal state.
7. Confirm no failed file produces a transcript export or substitute transcript content.
8. Confirm the overview and log show truthful success, failure, exclusion, skip, device, fallback, and created-output information without transcript bodies or secrets.

## Export And Research-Workflow Qualification

- [ ] Open XLSX output in Microsoft Excel and LibreOffice.
- [ ] Confirm XML-invalid characters do not corrupt workbooks.
- [ ] Confirm transcript text longer than 32,767 characters is preserved in ordered additional rows with existing headers and repeated file metadata.
- [ ] Combine a folder of generated XLSX files with the tester's Power Query workflow and confirm the stable column structure still combines without manual reshaping.
- [ ] Confirm unrelated pre-existing DOCX files survive an export and the result lists only files created by that operation.
- [ ] For general CSV/XLSX/DOCX interoperability, test MAXQDA or ATLAS.ti only when a maintainer can perform the manual test. Record the exact application/version and steps; otherwise make no compatibility claim beyond general-purpose exports.
- [ ] Before release material names MAXQDA, ATLAS.ti, or another QDA application in connection with **QDPX Beta**, manually import the generated QDPX into the exact claimed application and version. Record the workflow and confirm transferred source text, codes, coded passages, notes, theme-group behavior, and any application-specific changes. Confirm linked media is excluded. Transcript Research Studio exports QDPX but does not import or round-trip QDPX, and it does not create a native project format for that application.
- [ ] Open, mutate, save, reopen, and conflict-test a Coding project larger than 10 MiB. Confirm atomic recovery and exact evidence ranges in the `.evidence.json` 1.1 schema remain intact.

## Portable Smoke Tests

- [ ] App opens without a developer environment and reports correct build metadata.
- [ ] Package contains top-level `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, checksum information, portable marker, and data folder.
- [ ] Startup log exists after launch and contains no auth token, Hugging Face token, transcript text, or prompt text.
- [ ] One-file and mixed-folder transcription produce the selected XLSX, CSV, JSON, and DOCX outputs.
- [ ] Recording, segment, and paragraph transcript structures work.
- [ ] Transcript Analysis leaves source transcripts untouched and produces the selected analysis plus run information.
- [ ] Editor navigation does not discard unsaved work.
- [ ] Codes project creation requires a save location; mutations auto-save and survive reopening.
- [ ] Sidecar restart or death never leaves an interrupted run displayed as indefinitely active.
- [ ] Internal demo media is not present anywhere in the extracted archive.

## Security And Data Sanity

- [ ] Sidecar and Transcript Analysis provider URLs remain loopback-only.
- [ ] No telemetry, analytics, crash upload, or cloud upload behavior was added.
- [ ] Hugging Face access is limited to explicit model acquisition/setup; setup tokens remain ephemeral.
- [ ] Artifact contains no local token, `.env`, `__pycache__`, `.pyc`, temporary file, source recording, transcript, or coding project.
- [ ] Obsolete ASR packages such as `whisperx` and `openai-whisper` are absent.
- [ ] Logs contain status and safe error metadata, not transcript bodies, prompt bodies, or secrets.

## GitHub Beta Publication

1. Build all platforms from a fresh clone of annotated tag `v1.0.0-beta.2` with a clean working tree.
2. Create a GitHub Release for Version 1.0 Beta 2, classify it as a beta rather than the stable latest release, and upload checksums, SBOMs, notices, CPU zip, signed/notarized macOS zip, CUDA parts, CUDA parts manifest, and reassembly helper.
3. Include the unsigned Windows SmartScreen warning and signed/notarized macOS requirement prominently.
4. Summarize the supported platforms, local-processing boundaries, and known limitations of Version 1.0 Beta 2.
5. Link the user guide, technical background, and `1.0.0-beta.2` release notes.
6. Redownload every published asset into an empty directory.
7. Set `TRANSCRIPT_RESEARCH_STUDIO_RELEASE_ASSET_DIR` to that redownload directory on each target platform, then run
   `npm run release:verify`. This verifies safe, complete platform-specific checksum entries, reconstructs the CUDA zip,
   extracts every archive, and reruns final artifact verification.
8. Expose the beta release to testers only after redownload verification passes.

Never replace assets under an existing tag. Any fix becomes `v1.0.0-beta.3` or later.

## Documentation

Keep these files aligned:

- `src/components/HelpPage.tsx`
- `docs/user_guide.md`
- `docs/technical_background.md`
- `docs/release_notes_1.0.0-beta.2.md`
- `README.md`
- `backend/README.md`

When labels, workflows, export behavior, security behavior, or release steps change, update the documentation in the same change.
