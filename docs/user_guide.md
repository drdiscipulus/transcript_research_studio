# Transcript Research Studio — User Guide

## About

### About Transcript Research Studio

**Transcript Research Studio** is a local desktop app for creating transcripts from audio or video files and analyzing transcript exports with local language models.

It is for researchers and other everyday users who want a normal desktop workflow instead of a command-line or scripting setup. The app brings transcription, transcript editing, qualitative coding, and Transcript Analysis together in one interface while keeping the core workflow local and file-based.

### Purpose

The app supports four connected workflows:

- **Transcription** turns one media file or a folder of audio or video files into transcript exports.
- **Transcript Analysis** runs one built-in or reusable custom analysis on one transcript file or a folder of transcript files.
- **Transcript Editor** loads one exported recording at a time for local transcript cleanup before saving or re-exporting cleaned files.
- **Codes** creates local coding projects for coding transcript passages, maintaining a codebook, grouping codes into themes, writing notes, and exporting the analysis.

This makes it easier to go from raw recordings to structured transcript files and then to follow-up outputs such as summaries, labels, notes, coding support, or other derived text columns.

### Project Information

- **Author and maintainer:** Jens Schüler, Institute for Entrepreneurship & Innovation, University of Bayreuth, jens.schueler@uni-bayreuth.de
- **Version:** Version 1.0 Beta 2 (`1.0.0-beta.2`)
- **License:** GNU GPL v3.0 or later / `GPL-3.0-or-later`

### Availability and Releases

Qualified app packages are distributed through GitHub Releases rather than committed to the source repository. Version 1.0 Beta 2 (`1.0.0-beta.2`) defines separate portable Windows and Apple Silicon macOS packages. Obtain a package from GitHub Releases only after it has been published.

The `1.0.0-beta.2` Windows distribution specifies two portable variants:

- **CPU**: `transcript_research_studio_1.0.0-beta.2_windows_x64_cpu_portable.zip`, smaller and suitable for the broadest range of Windows x64 machines.
- **CUDA**: `transcript_research_studio_1.0.0-beta.2_windows_x64_cuda_portable.zip`, intended for Windows x64 systems with a supported NVIDIA GPU. Because it is large, its published distribution uses `.partNNN` files with a manifest and reassembly helper.

The Windows beta package is not code-signed. When you start a published Windows package, Windows may show a SmartScreen or "unknown publisher" warning. Only run binaries downloaded from this project's GitHub Releases page and verify the published SHA-256 checksum.

Keep the Windows portable package together as one folder. It contains the app executable, this user guide as `README.md`, a portable-mode marker, the bundled runtime, and a `transcript_research_studio_data/` folder for portable settings, logs, caches, and downloaded model files.

If Windows shows a warning and the app still does not appear after you choose to run it, check `transcript_research_studio_data/logs/startup.log` inside the portable folder. This startup log records app launch and local backend startup diagnostics without transcript bodies, prompt text, or tokens.

The macOS beta package is a portable, Developer ID signed and notarized Apple Silicon app bundle for `arm64` Macs running macOS 12 or later. Keep the extracted portable package together as one folder; it contains `Transcript Research Studio.app`, this user guide as `README.md`, a portable-mode marker, and a `transcript_research_studio_data/` folder for portable settings, logs, caches, and downloaded model files.

The macOS release artifact is named `transcript_research_studio_1.0.0-beta.2_macos_arm64_portable.zip`. When it has been published, download it from GitHub Releases, verify its checksum, unzip it, keep the extracted folder together, and launch `Transcript Research Studio.app`.

This beta does not support Intel macOS, Apple MPS acceleration, Windows signing, installers, or runtime downloaders. Internal demo media is not included in public release packages.

### Local Processing

The app is built around local workflows.

- Transcription runs locally on your machine.
- Transcript Analysis runs through a local provider running on your machine.
- Source media files are not modified by the app.
- Source transcript files are not overwritten during analysis.
- Transcription and Transcript Analysis both create new output files.

Transcription models are managed on the **Models** page. Download the faster-whisper models you want to use there first; the Transcription page only shows models that are already available locally.

The app does not add telemetry, analytics, or cloud upload behavior. The local app service and local Transcript Analysis provider access use loopback/localhost communication. Hugging Face is contacted for explicit transcription model downloads, pyannote model setup, and diarization model checks.

The app handles practical local batch sizes rather than unlimited archive-scale processing. Very large transcription folders or very large Transcript Analysis inputs may be rejected and should then be split into smaller batches.

---

## How It Works

### Overview

Transcript Research Studio is built around four connected workflows:

1. **Transcription**
2. **Transcript Editor**
3. **Codes**
4. **Analysis** (page title: **Transcript Analysis**)

A typical workflow starts with transcription, then continues with transcript editing, coding, Transcript Analysis, or any combination that fits the research project.

### Normal Workflow

1. Choose the input source and transcript output folder needed for a transcription run.
2. Scan the selected media file or input folder and review the detected files.
3. Run transcription to create the selected exports in the transcript output folder.
4. Open the resulting transcript files from the transcript output folder.
5. If the transcript needs correction first, switch to Editor, load the export, and clean one recording.
6. Save the edited working JSON and export cleaned files.
7. If you want qualitative evidence coding, switch to Codes and create or open a coding project.
8. Import transcript files, select exact passages, create evidence items, assign codes, group codes into themes, and export the project.
9. If you want to analyze transcript files outside a coding project, switch to Analysis.
10. Load one transcript file or a folder, choose one analysis, and run it through a local model.
11. Review the completion summary and generated files in the analysis output folder.

### Important Behavior

- The app works with files and folders you choose.
- Each media file creates its own transcript output file for each selected export format.
- Transcript structure can be one full transcript block, timestamped segments, or readable paragraphs inside each output file.
- The editor saves a separate edited JSON working file and can export cleaned CSV, XLSX, JSON, and DOCX files.
- Codes projects are saved explicitly as `.evidence.json` files and keep transcript snapshots inside the project.
- Codes exports create one privacy-first ZIP bundle containing the selected analysis workbook, normalized CSV data, structured JSON, coded DOCX report, or QDPX beta exchange project.
- One Transcript Analysis run can process one transcript file or a folder of transcript files.
- Transcript Analysis creates new result files and does not modify source transcripts.
- Source media files stay untouched.
- Source transcript files stay untouched.

### What the App Does Not Do

- It does not install Ollama or LM Studio for you.
- It does not download local Transcript Analysis models for you.
- It is not a full guide to local LLM setup.
- It does not automatically choose the perfect model for every machine.
- It does not replace the need to choose practical model sizes for your hardware.
- It does not provide semantic search, inter-coder reliability workflows, multi-user collaboration, or native MAXQDA/ATLAS.ti project files. The limited QDPX Beta exchange export is described below.

---

## Transcript Editor

### What the Editor Does

The Transcript Editor is a local cleanup workspace for transcript exports. It loads one selected recording, normalizes it into editable segments, and lets you correct the transcript before using the resulting general-purpose tables or documents in downstream tools. MAXQDA and ATLAS.ti import behavior is documented only for workflows that have been manually tested; the app does not create their native project formats.

Use it when you need to:

- correct segment text
- rename speaker labels globally
- change the speaker for individual segments
- merge a segment with the next segment
- optionally play a matching media file from a segment timestamp
- save an edited JSON working file
- export cleaned CSV, XLSX, JSON, or DOCX files

### Supported Inputs

The editor can load app-generated **JSON**, **CSV**, **XLSX**, and **DOCX** exports. JSON exports with multiple recordings show a document selector so you can choose the one recording to edit.

DOCX import is best effort and is intended for DOCX files produced by this app. Arbitrary Word documents may load as untimed text segments when timestamp and speaker patterns cannot be recognized.

### Working Files and Export

Saving from the editor writes a separate edited JSON working file. The original transcript export is preserved. Exporting from the editor adapts the edited transcript back into the app's existing export pipeline so cleaned files can be written as CSV, XLSX, JSON, or DOCX where supported.

### Media Playback

Loading a matching audio or video file is optional. When a segment has a start timestamp, its play button seeks the local media file to that point. The editor may show a lightweight waveform for audio, but waveform rendering is non-critical; if it is unavailable, the normal audio or video controls remain available.

### Boundaries

The editor is not the qualitative analysis workspace. Use Codes when you want evidence items, codes, themes, and notes.

---

## Codes

### What Codes Does

Codes is a local evidence-coding workspace. It lets you create an `.evidence.json` project, import transcript snapshots, select exact passages, save evidence items, assign codes, organize codes into themes, write plain text notes, and export the result.

Use it when you need to:

- collect exact transcript evidence with source transcript, segment, speaker, and timestamp metadata
- create and maintain a codebook
- assign multiple codes to one evidence item
- group codes into multiple themes
- merge duplicate codes while keeping evidence and theme assignments
- use local AI suggestions as optional starting points
- export evidence, codes, themes, transcript metadata, and AI suggestion decisions

### Project Files

Coding projects are editable files ending in `.evidence.json`. Confirmed transcript imports, evidence, codes, themes, notes, and project-setting changes save automatically and atomically. Unfinished form text is retained as an **Unsaved Draft** until you explicitly save or discard it. **Save** commits the current valid draft or pending project settings to the active project file. **Save As…** creates a copy at a selected location and makes that file the active project.

Imported transcripts are stored as snapshots inside the coding project, and the original transcript files are not modified. The visible v1 workflow does not refresh an imported transcript in place. To import an edited version as a separate snapshot, first save or copy it under a distinct filename or path, then import that copy. A transcript can be removed only while it has no evidence items.

Folder import is non-recursive and previews supported files directly inside the selected folder. Each candidate is shown as ready, already imported, an alternate format, or a problem before anything is committed. Equivalent app-generated exports are grouped and prefer `JSON > XLSX > CSV > DOCX` by default, although an alternate can be selected deliberately. One malformed file does not prevent valid candidates from importing.

### Evidence, Codes, And Themes

Start Coding Mode and select transcript text with the mouse or keyboard to open an evidence draft. Selecting another passage adjusts the unsaved draft. New evidence starts without inherited codes. You can add a note and assign existing or provisional new codes before explicitly saving, or cancel the draft.

The evidence list jumps back to the source transcript segment when you select an item. Note and code-assignment changes remain local in the Evidence Inspector until you choose **Save**; **Cancel** restores the saved evidence and **Delete** removes the evidence item.

Codes have a name, color, definition, inclusion criteria, exclusion criteria, note, and searchable example evidence. Deleting a code removes it from evidence and themes. Merging a code into another code reassigns evidence and theme references to the target code.

Themes have a name, color, description, note, and one or more code assignments. A code can belong to multiple themes.

### AI Assistance

The AI assistant uses the same [local AI providers and models](#local-ai-providers-and-models) as Transcript Analysis. The provider must already be running and have a local model available.

Configure **Provider**, **Model**, **Temperature**, and **Timeout** in **AI Assistant Settings** below Project Settings. The app loads provider and model information only when this accordion is expanded or an AI action is invoked; opening a coding project alone performs no provider request. Temperature and timeout default to `0` and `180` seconds. Prompts for Evidence, Codes, Note, Codebook, and Themes can be customized per project without changing the protected response schema or source-validation rules.

Buttons with the visible **✦ AI** badge are advisory AI actions:

- **Suggest Evidence** analyzes the current page, a selected segment range, or the entire active transcript. Returned quotations must match one unambiguous source location exactly. Results appear above the saved Evidence List for acceptance or dismissal.
- **Suggest Codes** compares the current evidence with the complete codebook. Adding a suggestion stages an existing assignment or provisional new code in the Evidence Inspector.
- **Draft Note** produces a grounded note preview that can be used, appended, or used to replace the current draft note.

Accepting an AI evidence suggestion immediately saves the exact passage as a new evidence item with no codes or note. Dismissing a suggestion saves a rejection decision. If either persistence request fails, the suggestion remains available for retry. Code and note suggestions change only the open Evidence Inspector draft, while Codebook and Theme suggestions fill normal unsaved forms; these changes require the usual **Save** action. Unapplied suggestion bodies remain session-only. Compact run metadata and explicit accepted, edited, or rejected decisions remain in the project for auditability; transcript text is not duplicated into run records. Whole-transcript work is chunked, so results remain best-effort starting points rather than a claim of exhaustive analysis.

### Codes Export

**Export Coding Project** opens a ZIP Save As dialog. Select one or more product cards; every bundle includes a README and manifest explaining its contents, counts, privacy choices, and known limitations.

- **Analysis Workbook (XLSX)**: overview, transcripts, segments, evidence, complete codebook, themes, and normalized relationship sheets with frozen/filterable headers.
- **Structured CSV Data**: one UTF-8 CSV per normalized table plus a data dictionary. Empty tables retain headers and stable IDs support joins in R, Python, databases, or Power Query.
- **Structured JSON**: a complete sanitized machine-readable project export for scripts and integrations. It is not an editable working copy.
- **Coded Transcript Report (DOCX)**: separate transcript reports and a codebook by default, or one combined document. Reports retain uncoded text and show exact saved evidence highlights with references, assignments, themes, and notes.
- **QDA Exchange Project (QDPX Beta)**: a schema-validated REFI-QDA exchange file for compatible QDA software, including MAXQDA and ATLAS.ti. It transfers text sources, codes, coded passages, notes, and theme groups, but it is not a native MAXQDA or ATLAS.ti project. Linked media is excluded, application-specific features may change during import, and this app does not import or round-trip QDPX. Manually qualify the exact target application and version before expanding compatibility claims.

The `.evidence.json` file remains the editable coding project. Local source paths and AI audit data are excluded by default. Enabling AI Audit includes researcher prompts, provider/model metadata, run records, and decisions, so review the bundle before sharing it. Protected system prompts and secrets are never exported.

---

## Transcription

### Transcription: Standard Workflow

The standard workflow keeps the visible options small and practical while exposing the main run controls. Expert settings remain available in a collapsed accordion.

### Input, Output, and Scan

Before starting a run, choose:

- an **Input Source** using the **File** or **Folder** button beside the media path
- a **Transcript Output Folder**

Important scan behavior:

- folder scanning is **non-recursive**
- folder mode includes only files directly inside the selected folder
- single-file mode processes only the selected media file
- unsupported files are ignored
- common hidden or system files are ignored

If no supported media files appear, check whether the files are directly inside the selected folder and not only inside subfolders.

The app handles practical batch sizes. A single transcription run currently allows up to **1000** supported media files. Very large individual recordings or very large total folder sizes may also be blocked and should then be split into smaller batches.

### Simple Settings

#### Model

The transcription model used for the run.

This selects the faster-whisper model. Smaller models usually finish sooner and are easier on CPU, RAM, and VRAM. Larger models can improve recognition on difficult recordings, accents, background noise, or domain-specific terms, but they take longer and may be uncomfortable on modest hardware.

For everyday research batches, start with the default `small` model. Move up only when the output quality is not good enough for your material and the extra runtime is acceptable.

#### Acceleration

The device path used for transcription.

Use **NVIDIA / CUDA** when the machine has a supported NVIDIA GPU and CUDA is available. This is usually much faster than CPU transcription, especially for longer recordings or larger models.

Use **CPU** when CUDA is unavailable, unstable, or not worth occupying for the current run. CPU transcription is slower, but it is the most broadly compatible path and is a good fallback for smaller batches.

#### Language

The language setting for the transcription run.

**Auto-detect** is convenient when files may contain different languages or when you are unsure. If all files use the same known language, selecting it directly can make runs more stable and can reduce avoidable language-detection mistakes.

#### Task

The main transcription task.

- **Transcribe** keeps the source language. Use this for most research transcripts, especially when the original wording matters.
- **Translate to English** asks Whisper to produce English text from non-English speech. Use it when you need an English working transcript, not when you need a verbatim source-language record.

#### Transcript Structure

Controls how each transcript output file is structured after transcription. It does not change recognition or speaker detection.

- **Full transcript** creates one combined transcript entry for the source media file. This is the simplest structure and works well when you want one text field per interview, meeting, field note, or recording.
- **Segments** creates one row or paragraph for each final timestamped segment. Use this when timing matters, when you want fine-grained review units, or when you need to inspect short passages against the audio.
- **Paragraphs** merges nearby segments into longer readable blocks. This is usually most useful with diarization, because speaker changes provide meaningful paragraph boundaries. Without diarization, paragraph building can use longer pauses as practical readability breaks, but it is not a guarantee of semantic paragraphs.

JSON exports always keep the full structured document and segment data in addition to the grouped rows. DOCX output follows the selected structure in the document body.

#### Paragraph Rules

The Advanced panel includes one paragraph-specific control:

- **Pause-Based Breaks** can be switched on or off. Detected speaker changes always create a new paragraph. When Pause-Based Breaks is on, the seconds value sets the largest gap allowed between neighboring same-speaker segments before a new paragraph starts. Shorter values create more, smaller paragraphs. Longer values merge more speech into the same paragraph.

Without diarization or usable speaker labels, pauses become the paragraph-boundary rule. Treat these pause-based breaks as a practical formatting rule rather than evidence that the speaker changed topic. When Pause-Based Breaks is off, pauses are ignored and detected speaker changes are the only automatic paragraph boundary. If no speaker labels are available either, the transcript may become one large paragraph.

#### Transcript Files and Naming

For folder input, **Separate files** is the default and creates one transcript per recording for every selected export format. This preserves the normal folder-based workflow, including combining equally structured XLSX files later with Power Query.

Choose **Combined file** when you want every successful recording collected into one output per selected format. For example, selecting XLSX and JSON creates `combined_transcripts.xlsx` and `combined_transcripts.json`. Source filename and metadata remain attached to the corresponding rows, and recordings keep their stable input order. Failed and excluded files are not inserted into the transcript output; use the automatic run overview to review them. Combined DOCX output separates recordings with page breaks.

By default, the app uses the input media filename as the output basename. For example, `interview_01.mp3` creates `interview_01.json`, `interview_01.xlsx`, and `interview_01.docx` when those formats are selected.

Combined output uses the generic basename `combined_transcripts`. Existing output files are not overwritten silently; the app adds copy suffixes such as `_copy01` when needed.

Every run creates a timestamped metadata-only spreadsheet named like `run_overview_2026-07-17_180500.xlsx` in the transcript output folder. It records source media paths, transcript output paths, duration, language, speaker count, status, and errors without including full transcript text.

#### Speaker Recognition

Runs the local pyannote model after faster-whisper to add speaker labels. Download the pyannote model on the Models page before enabling this for a run.

#### Include Timestamps

Adds inline timestamps to text-style exports where supported. Segment-based table exports already include dedicated timestamp columns.

#### Advanced Settings

The normal settings remain visible at all times. Expand the **Advanced settings** accordion when you need decoding controls, paragraph-pause behavior, or speaker-count hints. A **Customized** badge indicates that hidden advanced values differ from their defaults, and **Reset to defaults** restores the settings inside the accordion.

#### Export Formats

Choose the export formats for the run.

Supported formats:

- **XLSX**: spreadsheet export for Excel, LibreOffice, and table-based review.
- **CSV**: plain table export for statistics tools, scripts, and long-term interoperability.
- **JSON**: structured export with rows plus full document data, useful when another tool needs richer metadata or segment structure.
- **DOCX**: readable transcript documents, one per recording, useful for reading, annotation, or sharing outside a table workflow.

At least one format must be selected.

When **DOCX** is selected, the app automatically enables **Include Timestamps** if diarization is not active. DOCX exports are reading documents, and visible timestamps inside the text make it easier to trace passages back to the source recording.

### Starting a Run

Use **Start** to begin the batch.

One run processes the selected media file or every supported media file in the selected input folder. Each media file creates one transcript output file per selected export format. The selected **Transcript Structure** decides whether each output file is structured as one full transcript block, timestamped segments, or readable paragraphs.

### What the Export Contains

The transcript export can include fields such as:

- file name
- duration
- file info
- transcript text
- detected language
- selected task
- speaker summary if diarization is used
- paragraph timestamps and speaker labels in paragraph-based exports
- segment timestamps and speaker labels in segment-based exports

The exact content can vary slightly depending on settings and workflow path.

---

## Advanced

### Transcription: Advanced Settings

The collapsible Advanced settings panel adds expert controls for the faster-whisper path, paragraph exports, and optional pyannote speaker recognition.

You only need to expand it when you want more control over transcription behavior, paragraph splitting, or speaker-count hints.

### Advanced Settings

#### Beam Size

Controls how many alternative word sequences the decoder keeps while listening.

The default is a good starting point. Higher values ask the decoder to keep more possible word sequences before choosing the final text. That can help with ambiguous audio, technical vocabulary, or unclear speech, but it slows the run down. Lower values are faster, but they give the decoder fewer chances to recover from hard passages.

Most users should leave this alone. Change it only when you are comparing output quality on the same test recording.

#### VAD Filter

Controls whether voice activity detection filtering is used before or during transcription.

Leave this enabled for most recordings. It helps skip silence and non-speech regions before decoding, which can improve segmentation and avoid spending time on empty parts of a file. Turn it off only if you suspect the filter is cutting away quiet speech or unusual audio.

#### Temperature

Controls decoding behavior.

Lower values make decoding more stable and repeatable. Higher values allow more variation when the model is uncertain, but they can also make output less predictable. For research transcripts, the default low value is usually the safer choice.

#### Compute Type

Controls inference precision such as `int8`, `float16`, or `float32`.

- **int8** is the safest default, especially on CPU. It uses less memory and is usually the most practical option for everyday local runs.
- **float16** is mainly for CUDA or modern GPUs with FP16 support. It can be fast on the right GPU, but it can be slow, unsupported, or unstable on CPU.
- **float32** uses more memory and compute. It is usually not a quality upgrade worth choosing for normal batches; use it only for compatibility checks or debugging.

If you are unsure, keep `int8`. Changing compute type is a hardware/runtime choice, not a normal quality slider.

#### Pause-Based Breaks

Controls optional additional pause-based breaks for paragraph exports. Detected speaker changes always start a new paragraph. The threshold is shown in seconds and divides longer turns by the same speaker. Without speaker labels, pauses provide the paragraph boundaries.

This is separate from faster-whisper VAD. It only affects how finished transcript segments are grouped in exports.

### Diarization

Speaker recognition is optional and can be enabled from the main Transcription Setup.

When diarization is enabled, the app transcribes with faster-whisper first and then uses pyannote to identify and label different speakers inside the transcript.

In CPU builds, diarization runs on **CPU**. In CUDA builds, pyannote can run on CUDA when CUDA-enabled torch is available.

### Speaker Mode

Speaker Mode controls how the app guides diarization:

- **Auto**: let the diarization workflow estimate the speakers
- **Exact count**: specify the exact number of speakers
- **Range**: provide a minimum and maximum speaker count

Use hints only if you actually know something about the recording. Otherwise, Auto is usually the safest starting point.

### Models Setup

The **Models** page shows each faster-whisper model and the pyannote speaker model with a Download or Delete action.

For model setup, the Models page lets you:

- download and delete faster-whisper transcription models
- open the Hugging Face pyannote model page
- open the Hugging Face token page
- test a token
- download or delete the speaker model in the local app data folder

Testing checks both the token itself and whether the required diarization model can be accessed.

The token is used for setup and is not stored by default. After the speaker model is downloaded, diarization loads the local model copy.

If the token is valid but access is still restricted, you may need to open the required model page on Hugging Face, sign in, and accept access first.

### When to Use Advanced Settings

Expand Advanced settings when you want to:

- fine-tune transcription behavior
- provide speaker hints
- work with settings beyond the normal default workflow

If you just want a straightforward transcript export, leave the accordion collapsed.

---

## Transcript Analysis

### What Transcript Analysis Does

Transcript Analysis is a local workflow for examining transcript exports with a selected Ollama or LM Studio model. It accepts one transcript file or a nonrecursive folder, runs one analysis at a time, and writes new result files without modifying the source transcripts.

Built-in analyses include:

- **Transcript Overview** for topics, key points, relevant entities, and a useful chronological outline;
- **Research Focus Analysis** for findings grounded in verified excerpts and segment references;
- **Interview Review** for advisory observations about incomplete, unclear, inconsistent, unanswered, off-topic, or structurally weak passages;
- **Custom Analysis** for reusable researcher-authored analytical instructions.

Interview Review does not assess honesty or claim that participant statements are factually false.

### Local AI Providers and Models

Transcript Research Studio uses optional local language models in two areas:

- The **Codes AI assistant** can suggest evidence passages and codes, draft analytical notes, and help draft or refine codebook entries and themes.
- **Transcript Analysis** can create overviews, research-focused analyses, interview reviews, and reusable custom analyses from transcript files.

Both areas use the same local provider configuration. Supported providers are:

- **Ollama**
- **LM Studio**

These providers are separate applications and are **not included** with Transcript Research Studio. You must install one of them yourself and download or otherwise make at least one language model available through that provider.

Transcript Research Studio does not communicate with the provider's desktop window directly. It connects to the provider's local HTTP API and reads the models currently available there:

- **Ollama:** Start the Ollama application or service and keep its API available at `127.0.0.1:11434`. If necessary, start it with `ollama serve`. Download at least one model using Ollama before refreshing the provider list in Transcript Research Studio.
- **LM Studio:** Download a model, open **Developer**, start the local server, and keep it at `127.0.0.1:1234`. The selected model must be available through that server.

Provider access is limited to loopback addresses on the same computer. Do not expose either server to your local network or the internet for Transcript Research Studio. If no provider is running or no model is available through its API, the optional AI actions cannot start. Transcription, transcript editing, manual coding, and exports remain usable without Ollama or LM Studio.

### Choosing Models Carefully

When choosing a local LLM for AI assistance or Transcript Analysis, keep your machine's hardware in mind.

As a general rule:

- larger models need more memory
- if a model does not fit well on the GPU, performance can drop significantly
- on systems without suitable GPU support, analysis may rely more heavily on CPU and RAM
- larger models can therefore become much slower

Transcript Research Studio does not act as a full guide to local LLM setup. It is still the user’s responsibility to choose practical model sizes for their machine.

### Input and Output

Transcript Analysis uses:

- one **Transcript File** or one **Transcript Folder**
- one **Analysis Output Folder**
- one selected built-in or saved custom analysis
- one local provider and model
- at least one output format

Supported input formats are:

- **CSV**
- **XLSX**
- **JSON**
- **DOCX** generated by the app, with best-effort support for similar Word files

The source file stays untouched. Each run writes new conflict-free output files named from the selected file or folder and analysis, such as `founder_interview_transcript_overview.xlsx`.

### Input Preview and Mapping

JSON and edited JSON transcripts are read directly. CSV and XLSX inputs are mapped independently so heterogeneous folders do not share an incorrect mapping. If the app cannot infer the transcript text column, choose it in that candidate's **Column Mapping** section. Speaker, transcript ID, start time, and end time columns are optional.

The preview parses files independently. A malformed file is listed as a problem without blocking valid transcripts. When equivalent JSON, XLSX, CSV, or DOCX representations are found, choose one explicitly; JSON is marked as recommended.

### Choosing an Analysis

Choose exactly one analysis for a run. Research Focus Analysis additionally requires a research question or analytical focus. **Customize Prompt** permits a run-only change to a built-in analytical instruction; protected grounding, validation, and response rules remain unchanged. **Restore Built-in Prompt** returns a built-in analysis to its default instruction; **Restore Saved Instructions** returns a custom analysis to its saved instruction.

Use **New Custom Analysis…** to save a named instruction in the reusable app-level library. Saved custom analyses can be edited, duplicated, or deleted and appear in the Analysis dropdown.

#### Output Naming

The app automatically combines the selected file or folder name with the analysis name. All selected formats share that basename. Existing files are not overwritten silently and receive a copy suffix.

#### Temperature

Controls how deterministic the analysis output is.

Lower values are more stable. Higher values allow more variation in the model’s responses.

#### Timeout

The maximum number of seconds each local-model request may run before it is marked as failed.

The default is **180 seconds** per local-model request. Increase it for slow local models or very long inputs. Decrease it when you want stuck provider requests to fail faster.

#### Output Format

XLSX is the recommended default and creates a workbook with analysis-specific sheets plus Run Info. CSV creates predictable analysis tables plus Run Info. JSON retains the complete structured result. DOCX creates a readable report grouped by transcript.

### How an Analysis Run Works

1. Choose a provider.
2. Choose a model available in that provider.
3. Load one transcript file or a transcript folder.
4. Review the logical transcript preview and resolve any equivalent-format or column-mapping decisions.
5. Choose one built-in or saved custom analysis.
6. Enter a research focus when required.
7. Select at least one output format.
8. Adjust temperature or timeout if needed.
9. Start the run.

The app processes logical transcripts independently, continues after individual failures, and preserves successful results. The run area reports transcript and chunk progress, exclusions, warnings, per-transcript outcomes, and every created file.

---

## Troubleshooting

### First Checks

If something does not work, start with the basics:

- check the selected folders
- check the selected file
- check whether a provider is running
- check whether a model is available
- check whether the current run state is waiting for missing input

### Transcription Problems

#### No media files appear

In folder mode, make sure supported audio or video files are directly inside the selected input folder.

Scanning is non-recursive, so files inside subfolders are not included.

#### Transcription does not start

Check that all required items are set:

- input media file or input folder
- transcript output folder
- at least one export format
- scanned files available

#### CUDA is unavailable

Hardware detection appears in stages on Home. CPU transcription remains available while the app checks the NVIDIA GPU and CUDA runtime. If the scan fails, use **Retry Hardware Scan**; if CUDA still cannot be verified, continue with CPU and inspect the startup log. A CPU-only Windows build may name an installed NVIDIA GPU but intentionally offers only CPU acceleration.

#### Model download takes time

Download transcription models from the Models page before starting a run. Larger faster-whisper models can take longer to download and use more disk space.

#### The folder is too large for one run

If a folder contains very many files or very large recordings, the app may stop the run before it starts and ask you to split the folder into smaller batches.

The current transcription guardrails are:

- up to **1000** supported media files per run
- up to **8 GB** for one individual media file
- up to **64 GB** total supported media size in one folder scan

### Transcript Analysis Problems

#### No provider is available

Make sure **Ollama** or **LM Studio** is installed, running, and exposing its local API on the default localhost port. Ollama should respond on `127.0.0.1:11434`. LM Studio needs its Developer/local server started on `127.0.0.1:1234`.

#### No models appear

Make sure the selected provider already has local models available. The app does not install or download analysis models for you.

#### Transcript Analysis does not start

Check that all required fields are set:

- provider
- model
- input file or folder
- analysis output folder
- one selected analysis
- a research question when Research Focus Analysis is selected
- at least one output format

Very large transcript files may be chunked before being sent to the local model. If a local model still cannot handle the request, try a smaller local model, shorten a custom instruction, or split the transcript input.

The current Transcript Analysis guardrails are:

- up to **64 MB** for one source transcript file
- up to **20,000** table rows for CSV/XLSX inputs

#### The source transcript should not be overwritten

This is expected behavior. Transcript Analysis writes new result files instead of modifying the source file in place.

### Diarization Problems

#### Diarization is unavailable

Open Models and check whether the pyannote speaker model has been downloaded successfully.

#### Token is valid but access is still restricted

Open the required diarization model page on Hugging Face, sign in with the same account, accept access, and test the token again.

#### Diarization is slow

This can happen because speaker recognition is an additional model pass after transcription. Longer recordings can take noticeably more time than short single-speaker files.

### Output Problems

#### Output file cannot be written

Check that the selected output folder is writable and that the target file is not already locked by another program.

#### Analysis output file already exists

The app uses deterministic copy suffixes when possible. If a file is locked by another program, close it and run again.

#### Brief logs

Troubleshooting logs stay sparse. They record run status and file-level outcomes, but not full transcript bodies or full prompt instructions.

If the desktop window does not appear at startup, check `transcript_research_studio_data/logs/startup.log` in a portable release. This file records the desktop shell and Python sidecar startup path so maintainers can diagnose blocked or missing runtimes.

---
