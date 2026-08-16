import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  appAuthorAffiliation,
  appAuthorEmail,
  appAuthorName,
  appLicense,
  appLicenseLabel,
  appName,
  appSubtitle,
  appVersion
} from "../lib/appMetadata";

type HelpChapterId =
  | "about"
  | "workflow"
  | "models"
  | "transcription"
  | "editor"
  | "codes"
  | "prompting"
  | "troubleshooting";

type HelpChapter = {
  id: HelpChapterId;
  label: string;
  title: string;
  intro: string;
};

const helpChapters: HelpChapter[] = [
  {
    id: "about",
    label: "About",
    title: `About ${appName}`,
    intro: appSubtitle
  },
  {
    id: "workflow",
    label: "How It Works",
    title: "How It Works",
    intro:
      `${appName} is built around local file-based workflows: model setup, transcription, editing, qualitative coding, and optional transcript analysis.`
  },
  {
    id: "models",
    label: "Models",
    title: "Models",
    intro:
      "The Models page is where transcription and speaker-recognition models are downloaded, checked, and deleted."
  },
  {
    id: "transcription",
    label: "Transcription",
    title: "Transcription",
    intro:
      "Transcription turns one media file or a folder of media files into separate or combined transcript exports."
  },
  {
    id: "editor",
    label: "Editor",
    title: "Transcript Editor",
    intro:
      "The Transcript Editor is a local cleanup workspace for correcting exported transcripts before saving or re-exporting them."
  },
  {
    id: "codes",
    label: "Codes",
    title: "Codes",
    intro:
      "Codes is a local evidence-coding workspace for transcript passages, codebooks, themes, notes, and exports."
  },
  {
    id: "prompting",
    label: "Transcript Analysis",
    title: "Transcript Analysis",
    intro:
      "Transcript Analysis runs one local AI analysis across a transcript file or folder and writes separate result files."
  },
  {
    id: "troubleshooting",
    label: "Troubleshooting",
    title: "Troubleshooting",
    intro:
      "Start with the basics: selected folders, selected file, provider status, model availability, and the current run state."
  }
];

export function HelpPage() {
  const [activeChapter, setActiveChapter] = useState<HelpChapterId>("about");
  const chapterTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const currentChapter = useMemo(
    () => helpChapters.find((chapter) => chapter.id === activeChapter) ?? helpChapters[0],
    [activeChapter]
  );

  function handleChapterKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? helpChapters.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + helpChapters.length) % helpChapters.length;
    setActiveChapter(helpChapters[nextIndex].id);
    chapterTabRefs.current[nextIndex]?.focus();
  }

  function renderAboutChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <p>
            It is for researchers and other everyday users who want a normal desktop workflow instead of a
            command-line or scripting setup. The app brings transcription, transcript editing, qualitative coding, and
            Transcript Analysis together in one interface while keeping the core workflow local and file-based.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Purpose</h4>
          <p>The app supports four connected workflows:</p>
          <ul>
            <li>
              <strong>Transcription</strong> turns one media file or a folder of media files into transcript exports.
            </li>
            <li>
              <strong>Transcript Analysis</strong> creates transcript overviews, research-focus analyses, interview
              reviews, or reusable custom analyses with a local LLM.
            </li>
            <li>
              <strong>Transcript Editor</strong> loads one exported recording at a time for segment text, speaker, and
              timestamp-based media review.
            </li>
            <li>
              <strong>Codes</strong> stores evidence passages, codes, themes, notes, and downstream exports in a local
              coding project.
            </li>
          </ul>
          <p>
            This makes it easier to go from raw recordings to corrected transcripts, qualitative coding projects,
            structured analysis outputs, and files for downstream research tools.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Technology Stack</h4>
          <p>{appName} is built as a desktop application using:</p>
          <ul>
            <li>
              <strong>Tauri 2</strong> and <strong>Rust 2021</strong> for the desktop shell
            </li>
            <li>
              <strong>React 19</strong> and <strong>TypeScript</strong> for the user interface
            </li>
            <li>
              a bundled <strong>Python 3.12</strong> processing service for local work
            </li>
            <li>
              <strong>faster-whisper 1.x</strong> for the standard transcription workflow
            </li>
            <li>
              <strong>pyannote.audio</strong> for optional speaker recognition after transcription
            </li>
            <li>
              <strong>Ollama</strong> or <strong>LM Studio</strong> as supported local analysis providers
            </li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Local Processing</h4>
          <p>The app is designed around local workflows.</p>
          <ul>
            <li>Transcription runs locally on your machine.</li>
            <li>Transcript Analysis runs through a local provider running on your machine.</li>
            <li>Source media files are not modified by the app.</li>
            <li>Source transcript files are not overwritten during analysis.</li>
            <li>Transcription and Transcript Analysis both create new output files.</li>
          </ul>
          <p>
            Transcription models are managed on the <strong>Models</strong> page. Download the faster-whisper models
            you want to use there first; the Transcription page only shows models that are already available locally.
          </p>
          <p>
            The app does not add telemetry, analytics, or cloud upload behavior. The local app service and local
            analysis-provider access use loopback/localhost communication. Hugging Face is contacted for
            explicit transcription model downloads, pyannote setup, diarization model access checks, and token tests.
          </p>
          <p>
            The app handles practical local batch sizes rather than unlimited archive-scale processing. Very
            large transcription folders or very large analysis inputs may be rejected and should then be split into
            smaller batches.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Project Information</h4>
          <ul>
            <li>
              <strong>Author and maintainer:</strong> {appAuthorName}, {appAuthorAffiliation},{" "}
              <a href={`mailto:${appAuthorEmail}`}>{appAuthorEmail}</a>
            </li>
            <li>
              <strong>Version:</strong> {appVersion}
            </li>
            <li>
              <strong>License:</strong> {appLicenseLabel} / <code>{appLicense}</code>
            </li>
          </ul>
        </section>
      </div>
    );
  }

  function renderWorkflowChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>Normal Workflow</h4>
          <ol className="help-number-list">
            <li>Open Models and download the faster-whisper transcription models you want to use.</li>
            <li>If you need speaker recognition, download the pyannote model from Models with a temporary Hugging Face token.</li>
            <li>Choose one media file or a folder of media files for a transcription run.</li>
            <li>Review the automatic media scan, including ready and excluded files.</li>
            <li>Run transcription to create the selected exports in the transcript output folder.</li>
            <li>Open the resulting transcript files from the transcript output folder.</li>
            <li>If the transcript needs correction first, switch to Editor, load the export, and clean one recording.</li>
            <li>Save an editable JSON working copy if you want to continue later, or export the edited transcript directly from the Editor workspace.</li>
            <li>If you want qualitative evidence coding, switch to Codes and create or open a coding project.</li>
            <li>If you want to analyze transcript exports outside a coding project, switch to Analysis.</li>
            <li>Load one transcript file or folder, choose one analysis, and run it through a local LLM provider.</li>
            <li>Review the completion summary and generated files in the selected analysis output folder.</li>
          </ol>
        </section>

        <section className="help-content-section">
          <h4>Important Behavior</h4>
          <ul>
            <li>The app works with files and folders you choose.</li>
            <li>A file input creates one transcript per selected format. A folder input can create separate files per recording or one combined file per selected format.</li>
            <li>The transcript structure can be one full transcript block, timestamped segments, or readable paragraphs inside each output file.</li>
            <li>One Transcript Analysis run can process one transcript file or a folder of transcript files.</li>
            <li>Transcript Analysis creates new result files and does not modify source transcripts.</li>
            <li>The editor saves an editable JSON working copy and can export cleaned CSV, XLSX, JSON, and DOCX files.</li>
            <li>Source media files stay untouched.</li>
            <li>Source transcript files stay untouched.</li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>What the App Does Not Do</h4>
          <ul>
            <li>It does not install Ollama or LM Studio for you.</li>
            <li>It does not download local analysis models for you.</li>
            <li>It is not a full guide to local LLM setup.</li>
            <li>It does not automatically choose the perfect model for every machine.</li>
            <li>It does not replace the need to choose practical model sizes for your hardware.</li>
            <li>It does not provide semantic search, inter-coder reliability workflows, or multi-user collaboration.</li>
            <li>QDPX export is a beta exchange feature. The app does not import QDPX, round-trip QDA projects, or create proprietary MAXQDA or ATLAS.ti project files.</li>
          </ul>
        </section>
      </div>
    );
  }

  function renderModelsChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>What the Models Page Does</h4>
          <p>
            The Models page is the setup area for local transcription and speaker-recognition models. The Transcription
            page only lists faster-whisper models that are already downloaded or bundled locally.
          </p>
          <p>Use Models to:</p>
          <ul>
            <li>download or delete faster-whisper transcription models</li>
            <li>download or delete the local pyannote speaker-recognition model</li>
            <li>open the Hugging Face model page when pyannote access has to be accepted</li>
            <li>test a temporary Hugging Face token before downloading pyannote</li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Faster-Whisper Models</h4>
          <p>
            Faster-whisper is the only speech recognition engine used by the app. Smaller models usually run faster and use less
            memory. Larger models may improve transcript quality in some recordings but need more disk space and
            processing time.
          </p>
          <p>
            Each model row shows whether the model is downloaded, incomplete, or missing. The action changes between{" "}
            <strong>Download</strong>, <strong>Repair</strong>, and <strong>Delete</strong> depending on local readiness.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Pyannote Speaker Recognition</h4>
          <p>
            Speaker recognition uses a pyannote model after faster-whisper transcription. It is only needed when you
            enable Speaker Detection in Transcription.
          </p>
          <p>
            To download the pyannote model, you may need to sign in to Hugging Face, accept the model access terms, and
            paste a read-only token into the Models page. The token is used for setup and is not stored after the model
            download.
          </p>
          <p>
            After the model is downloaded, speaker recognition runs locally from the downloaded model files.
          </p>
        </section>

        <section className="help-content-section">
          <h4>CPU and GPU Builds</h4>
          <p>
            macOS builds are CPU-only. Windows has separate CPU and NVIDIA/CUDA builds. CUDA acceleration for
            faster-whisper and CUDA availability for pyannote are separate runtime capabilities.
          </p>
          <p>
            If speaker recognition is enabled and CUDA-enabled torch is unavailable, pyannote may fall back to CPU when
            the CPU runtime is available. The run status shows warnings when speaker recognition is skipped or falls
            back.
          </p>
        </section>
      </div>
    );
  }

  function renderEditorChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>What the Editor Does</h4>
          <p>
            The Transcript Editor loads existing transcript exports, normalizes one selected recording into editable
            segments, and opens a focused editing workspace in the same app window.
          </p>
          <p>Use it when you need to:</p>
          <ul>
            <li>correct segment text</li>
            <li>rename speaker labels globally</li>
            <li>add or delete speaker labels for correction</li>
            <li>change the speaker for individual segments</li>
            <li>split a segment at the textarea cursor position</li>
            <li>merge a segment with the next segment</li>
            <li>merge adjacent segments that have the same assigned speaker</li>
            <li>delete an unwanted segment and restore it with Undo if needed</li>
            <li>use undo and redo while editing</li>
            <li>page through long transcripts</li>
            <li>play only the current segment when matching media and timestamps are available</li>
            <li>save an editing copy or export the edited transcript</li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Supported Inputs</h4>
          <p>
            The editor can load app-generated JSON, CSV, XLSX, and DOCX exports. The editor works on one transcript at
            a time. If a file contains several recordings, choose the transcript you want to edit from the document
            selector. Edited transcript JSON files can be loaded again later to continue correction.
          </p>
          <p>
            DOCX import is best effort and is intended for DOCX files produced by this app. Arbitrary Word documents
            may load as untimed text segments when timestamp and speaker patterns cannot be recognized.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Media Playback</h4>
          <p>
            Loading a media file is optional. When a segment has start and end timestamps, the segment play button
            seeks to the segment start and stops at the segment end. If timestamps are missing, playback for that
            segment is disabled, but text and speaker editing still work.
          </p>
          <p>
            The media player stays near the top of the editing workspace. If waveform rendering is unavailable, the
            normal audio or video controls remain available.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Saving and Exporting</h4>
          <p>
            In the Editor, <strong>Save As…</strong> chooses a location for an editable JSON working copy. After that,
            <strong> Save</strong> updates the same file; Ctrl+S and Cmd+S provide the same action.
            <strong> Reset</strong> restores the last saved copy, or the originally loaded transcript before
            the first save. <strong>Close Editor</strong> returns to setup without discarding work held in memory.
          </p>
          <p>
            <strong>Export Transcript</strong> opens a Save As dialog where you choose the output location and
            filename together. When several formats are selected, the chosen name is shared by the XLSX, CSV,
            JSON, and DOCX files created beside one another. Exporting does not save or clear the editable
            working-copy state. For spreadsheet formats, each edited segment becomes one row.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Boundaries</h4>
          <p>
            The editor is not the qualitative analysis workspace. Use Codes when you want evidence items, codes,
            themes, notes, and local coding-project exports.
          </p>
        </section>
      </div>
    );
  }

  function renderCodesChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>What Codes Does</h4>
          <p>
            Codes stores editable coding projects as <code>.evidence.json</code> files. Confirmed imports, evidence,
            codes, themes, notes, and project settings save automatically. Unfinished form text remains a clearly
            marked local draft until you save or discard it. Use <strong>Save</strong> to commit the current valid
            draft to the active project file, and <strong>Save As…</strong> to create and activate another project file.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Manual Coding Workflow</h4>
          <ul>
            <li>Create or open a coding project.</li>
            <li>
              Preview one transcript file or a non-recursive transcript folder, review duplicates and problems, and
              then confirm the valid candidates. JSON is preferred when equivalent app exports are present.
            </li>
            <li>
              Start Coding Mode, select transcript text to open an evidence draft immediately, and save or cancel the
              draft. Select another passage to adjust the unsaved evidence. Coding Mode stays active for the next
              passage until you choose Finish Coding.
            </li>
            <li>
              In the Evidence Inspector, stage note and code-assignment changes, then choose Save to commit them
              together or Cancel to restore the saved evidence.
            </li>
            <li>Create codes, assign multiple codes to evidence, and group codes into themes.</li>
            <li>
              Use the unified <strong>Codebook</strong> workspace to search and edit codes or themes. Code definitions,
              inclusion and exclusion criteria, notes, example evidence, assignments, and colors remain editable.
            </li>
            <li>Use Merge Into when duplicate codes should become one code while keeping evidence and theme assignments.</li>
            <li>
              Removing a transcript removes it only from the coding project and never deletes its source file. Removal
              is blocked while the transcript has evidence items.
            </li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>AI Suggestions</h4>
          <p>
            Configure <strong>Provider</strong>, <strong>Model</strong>, <strong>Temperature</strong>, and
            {" "}<strong>Timeout</strong> in <strong>AI Assistant Settings</strong> below Project Settings. Provider and model
            discovery remains lazy: opening a coding project alone does not contact either local provider. Prompt
            templates for Evidence, Codes, Note, Codebook, and Themes are stored per project, while protected
            source-validation and response rules cannot be changed.
          </p>
          <p>
            Buttons marked <strong>✦ AI</strong> can suggest exact transcript evidence, fitting existing or new codes,
            concise analytical notes, code details, code refinements, themes, and theme refinements. Each run shows its
            local-model progress and retains human review as the final decision.
          </p>
          <p>
            Accepting an AI evidence suggestion immediately saves that exact passage as evidence without codes or a
            note, so you can review a list efficiently. Dismissing a suggestion saves a rejection decision. If either
            persistence request fails, the suggestion remains available for retry. AI code and note suggestions only
            modify the open Evidence Inspector draft and require its normal <strong>Save</strong>. Codebook and theme
            suggestions populate normal unsaved forms for review. Invalid or ambiguous quotations are omitted rather
            than converted into evidence.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Evidence Navigation and Highlights</h4>
          <p>
            The Transcript Coding workspace keeps the transcript reader beside a searchable Evidence list and
            Evidence Inspector. Selecting saved evidence opens its transcript page and highlights the exact captured
            text. Filters can narrow evidence by transcript, code, or theme.
          </p>
          <p>
            <strong>Highlights</strong> can independently show saved evidence, selected codes, and selected themes in
            the transcript. Highlight settings are session-only display preferences and do not modify the project.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Codebook and Themes</h4>
          <p>
            Codebook contains internal <strong>Codes</strong> and <strong>Themes</strong> views. Codes can store a name,
            color, definition, inclusion criteria, exclusion criteria, note, and example evidence. Themes can store a
            name, color, description, note, and multiple member codes.
          </p>
          <p>
            Assigned theme codes appear as compact chips. Use <strong>Assign Codes</strong> to search for another code,
            or expand <strong>Browse All Codes</strong> for a compact codebook overview. Changes remain a draft until
            you choose <strong>Save Code</strong> or <strong>Save Theme</strong>.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Exports</h4>
          <p>
            <strong>Export Bundle…</strong> creates one ZIP containing the selected downstream products: an XLSX analysis
            workbook, normalized CSV data, structured JSON, coded DOCX reports, or a beta REFI-QDA QDPX exchange
            project. Each product card explains its supported content and limitations. The editable
            <code>.evidence.json</code> file remains separate and is not replaced by an export bundle.
          </p>
          <p>
            Local source paths and AI audit data are excluded by default. QDPX transfers text sources, codes, coded
            passages, notes, and theme groups, but excludes linked media and may be modified by application-specific
            import behavior in compatible QDA software. It is not a native MAXQDA or ATLAS.ti project, and this app
            does not import or round-trip QDPX. Manually qualify the exact target application and version before
            expanding compatibility claims.
          </p>
          <p>
            Every bundle includes a README and manifest. DOCX can be generated as separate transcript reports or one
            combined document. XLSX is selected by default; choose at least one export product.
          </p>
        </section>
      </div>
    );
  }

  function renderTranscriptionSimpleChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>Inputs and Outputs</h4>
          <h5>Input Source</h5>
          <p>
            Select <strong>File</strong> for one media recording or <strong>Folder</strong> for a folder containing
            multiple recordings. Both choices are normalized into a media-file list.
          </p>
          <h5>Output Naming</h5>
          <p>
            Separate transcripts use each source media filename by default. Combined output uses
            <code>combined_transcripts</code>. Existing outputs receive copy suffixes instead of being overwritten.
            The Separate/Combined choice appears only after selecting a folder because it is not relevant to one file.
          </p>
          <h5>Run Overview</h5>
          <p>
            Every run creates a timestamped overview spreadsheet with metadata, status, errors, and output paths. It
            does not contain the full transcript text.
          </p>
          <h5>Input Media File or Input Folder</h5>
          <p>
            Use the File or Folder button beside the media path. Folder scanning is non-recursive and only includes
            supported files directly inside the selected folder.
          </p>
          <h5>Transcript Output Folder</h5>
          <p>
            All transcript exports are written into this folder. Separate mode creates one transcript per recording and
            format; combined mode creates one collected transcript per selected format.
          </p>
          <p>The scan guardrails are:</p>
          <ul>
            <li>up to <strong>1000</strong> supported media files per run</li>
            <li>up to <strong>8 GB</strong> for one individual media file</li>
            <li>up to <strong>64 GB</strong> total supported media size in one folder scan</li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Transcription Setup</h4>
          <h5>Model</h5>
          <p>The faster-whisper model used for transcription. Only downloaded or bundled models are shown here.</p>
          <h5>Acceleration</h5>
          <p>The runtime path used for faster-whisper transcription, such as CPU or NVIDIA / CUDA.</p>
          <h5>Language</h5>
          <p><strong>Auto-detect</strong> is the normal default. Select a language directly if you already know it.</p>
          <h5>Task</h5>
          <p><strong>Transcribe</strong> keeps the source language. <strong>Translate To English</strong> translates recognized speech to English.</p>
          <h5>Transcript Structure</h5>
          <p>This controls how each output transcript file is organized after transcription. It does not change recognition or speaker detection.</p>
          <ul>
            <li><strong>Full Transcript</strong>: one combined transcript entry for the whole media file</li>
            <li><strong>Segments</strong>: final timestamped segments stay separate</li>
            <li><strong>Paragraphs</strong>: nearby segments are merged into readable paragraphs; detected speaker changes always create a new paragraph and optional pause-based breaks can divide longer same-speaker turns</li>
          </ul>
          <h5>Speaker Detection</h5>
          <p>Runs the local pyannote model after faster-whisper to add speaker labels.</p>
          <h5>Timestamps</h5>
          <p>Adds timestamps to text-style exports where supported. Segment-based table exports already include timestamp columns.</p>
          <h5>Advanced Settings</h5>
          <p>Expand the Advanced settings row for decoding, paragraph-pause, and speaker-count controls. The panel stays collapsed when those controls are not needed.</p>
          <h5>Export Formats</h5>
          <p>Choose XLSX, CSV, JSON, DOCX, or any combination of them. At least one format must be selected.</p>
        </section>
      </div>
    );
  }

  function renderTranscriptionAdvancedChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>Advanced</h4>
          <h5>Beam Size</h5>
          <p>Controls how many alternative word sequences the decoder keeps while listening.</p>
          <p>
            The default is a good starting point. Higher values search more possibilities and can help ambiguous audio,
            but they slow the run down. Lower values are faster but may miss harder words.
          </p>

          <h5>VAD Filter</h5>
          <p>Controls whether voice activity detection filtering is used before or during transcription.</p>
          <p>This can help with some files, especially when there is extra silence or uneven speech activity.</p>

          <h5>Temperature</h5>
          <p>Controls decoding behavior.</p>
          <p>Most users should leave this at the default unless they have a specific reason to experiment.</p>

          <h5>Compute Type</h5>
          <p>Controls inference precision such as <code>int8</code>, <code>float16</code>, or <code>float32</code>.</p>
          <p>
            Use <code>int8</code> as the safest CPU/default choice. <code>float16</code> is mainly for CUDA or modern
            GPUs with FP16 support and can be slow or unsupported on CPU. <code>float32</code> uses more memory and is
            usually only worth trying for compatibility or debugging.
          </p>

          <h5>Pause-Based Breaks</h5>
          <p>
            Controls additional pause-based breaks for <strong>Paragraphs</strong> transcript structure only. Detected
            speaker changes always create a new paragraph. When enabled, a pause longer than the selected number of
            seconds also creates a new paragraph within the same speaker&apos;s turn.
          </p>
          <p>
            Without speaker labels, pauses become the paragraph-boundary rule. If both speaker detection and
            pause-based breaks are off, the transcript may be exported as one large paragraph. This setting is
            separate from faster-whisper VAD and only affects how finished transcript segments are grouped in exports.
          </p>

          <h5>Speaker Mode</h5>
          <p>Only matters when Speaker Detection is enabled. Speaker Mode controls how the app guides diarization:</p>
          <ul>
            <li><strong>Auto</strong>: let the diarization workflow estimate the speakers</li>
            <li><strong>Exact count</strong>: specify the exact number of speakers</li>
            <li><strong>Range</strong>: provide a minimum and maximum speaker count</li>
          </ul>
          <p>
            Use hints only if you actually know something about the recording. Otherwise, Auto is usually the safest
            starting point.
          </p>
        </section>
      </div>
    );
  }

  function renderTranscriptionRunChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>Run Transcription</h4>
          <p>
            Use <strong>Start</strong> to begin the run. Use <strong>New Run</strong> to clear the current selections and
            results before starting with another set of recordings.
            While a run is active, the run area shows status, processed files, duration, and progress. After a run, it
            also shows output-folder and log-folder actions.
          </p>
        </section>

        <section className="help-content-section">
          <h4>What the Export Contains</h4>
          <p>The transcript export can include fields such as:</p>
          <ul>
            <li>file name, duration, file info, detected language, and selected task</li>
            <li>transcript text</li>
            <li>speaker summary if speaker detection is used</li>
            <li>paragraph timestamps and speaker labels in paragraph-based exports</li>
            <li>segment timestamps and speaker labels in segment-based exports</li>
          </ul>
          <p>The exact content can vary slightly depending on settings and workflow path.</p>
        </section>
      </div>
    );
  }

  function renderPromptingChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>Inputs and Outputs</h4>
          <p>
            Transcript Analysis is a local workflow for analyzing transcript exports with Ollama or LM Studio. Source
            transcripts remain untouched; each run writes new result files.
          </p>
          <h5>Transcript Input</h5>
          <p>Choose <strong>File</strong> for one transcript or <strong>Folder</strong> for a nonrecursive folder scan.</p>
          <p>
            The input preview treats documents inside combined exports as logical transcript candidates, isolates
            unreadable files, and asks you to choose explicitly between equivalent JSON, XLSX, CSV, or DOCX exports.
            A problem in one file does not prevent valid candidates from running.
          </p>
          <h5>Output Naming</h5>
          <p>The app automatically combines the selected file or folder name with the analysis name. Every selected format shares that name, and existing files receive a copy suffix.</p>
          <h5>Output Formats</h5>
          <p>
            XLSX creates one workbook with task sheets plus Run Info. CSV creates one file per result table. JSON
            creates one structured file. DOCX creates a readable report.
          </p>
          <h5>Transcript File or Transcript Folder</h5>
          <p>Supported input formats are CSV, XLSX, JSON, and app-generated DOCX.</p>
          <h5>Analysis Output Folder</h5>
          <p>All transcript-analysis result files are written into this folder.</p>
          <h5>Column Mapping</h5>
          <p>
            This appears only for table-style inputs when mapping is available or needed. It lets you choose transcript
            text, transcript ID, speaker, start time, and end time columns.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Analysis</h4>
          <p>
            Choose one analysis for each run. The question-mark help beside Analysis describes the current selection.
            Built-in analyses and reusable custom analyses appear in the same selector.
          </p>
          <h5>Transcript Overview</h5>
          <p>Creates a concise overview, topics, key points, entities, and a chronological outline where useful.</p>
          <h5>Research Focus Analysis</h5>
          <p>Examines transcripts against a research question and grounds findings in verified source excerpts.</p>
          <h5>Interview Review</h5>
          <p>Flags observable completeness, clarity, consistency, relevance, and interview-structure issues. It does not assess honesty or factual truth.</p>
          <h5>Custom Analysis</h5>
          <p>
            Use <strong>New Custom Analysis…</strong> to save reusable researcher-authored instructions. When a custom
            analysis is selected, its <strong>Actions</strong> menu provides Edit, Duplicate, and Delete.
          </p>
          <h5>Customize Prompt</h5>
          <p>
            Expand the chevron row to edit the current run&apos;s Researcher Instructions. The Customized badge identifies
            a run-only change. Restore Built-in Prompt returns to a built-in instruction; Restore Saved Instructions
            returns to a custom analysis&apos;s saved instruction. Protected grounding and response rules remain unchanged.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Local LLM Settings</h4>
          <h5>Provider</h5>
          <p>Choose the local provider: Ollama or LM Studio. The provider must already be running.</p>
          <h5>Provider API Access</h5>
          <p>
            The app does not talk to the Ollama or LM Studio desktop windows directly. It looks for their local HTTP
            APIs on this computer, so the provider API server must be running before models can appear.
          </p>
          <p>
            For <strong>Ollama</strong>, start the Ollama app or service and make sure its local API is available at{" "}
            <code>127.0.0.1:11434</code>. If the service is not running, start Ollama from the app or with{" "}
            <code>ollama serve</code>, then download at least one model with Ollama. The app checks Ollama model
            status through the local API and sends prompts to that same local service.
          </p>
          <p>
            For <strong>LM Studio</strong>, load a model, open the <strong>Developer</strong> or local server view, and
            toggle <strong>Start Server</strong>. Keep the server on the default local address{" "}
            <code>127.0.0.1:1234</code>. The app reads LM Studio models from that local server and sends prompts through
            its OpenAI-compatible chat endpoint.
          </p>
          <p>
            Keep both providers bound to localhost for this app. Network-exposed provider addresses are not used by
            Transcript Research Studio.
          </p>
          <h5>Model</h5>
          <p>Choose a locally available model from the selected provider.</p>
          <h5>Temperature</h5>
          <p>Controls how deterministic the analysis is. Lower values are more stable; the default is 0.</p>
          <h5>Timeout</h5>
          <p>
            The maximum number of seconds each local model request may run before the current task is marked as failed.
            The default is <strong>180 seconds</strong>.
          </p>
          <h5>Context Window</h5>
          <p>
            The context window controls how much text a local model can consider in one request. The app chunks
            transcripts automatically and prioritizes reliable processing over using the largest possible context.
          </p>
          <div className="help-table-wrapper">
            <table className="help-table">
              <thead>
                <tr>
                  <th>Setup</th>
                  <th>Recommended Context</th>
                  <th>App Behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>CPU-only, less than 16 GB RAM</td>
                  <td>4096</td>
                  <td>Conservative chunking</td>
                </tr>
                <tr>
                  <td>CPU-only, 16 GB RAM</td>
                  <td>4096-8192</td>
                  <td>Conservative chunking, larger context optional</td>
                </tr>
                <tr>
                  <td>CPU-only, 32 GB RAM</td>
                  <td>8192</td>
                  <td>Fewer chunks if provider supports it</td>
                </tr>
                <tr>
                  <td>CPU-only, 64 GB RAM</td>
                  <td>8192-16384</td>
                  <td>Larger chunks possible</td>
                </tr>
                <tr>
                  <td>GPU, 6-8 GB VRAM</td>
                  <td>4096-8192</td>
                  <td>Avoid aggressive context to prevent memory pressure</td>
                </tr>
                <tr>
                  <td>GPU, 12+ GB VRAM</td>
                  <td>8192-16384</td>
                  <td>Larger context can improve coherence</td>
                </tr>
                <tr>
                  <td>GPU, 16+ GB VRAM</td>
                  <td>16384 possible</td>
                  <td>Use if stable; the app still chunks safely</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Bigger context uses more RAM or VRAM and can slow local models. LM Studio may load a model with a smaller
            active context than the model's theoretical maximum. Ollama context can be adjusted in Ollama settings or
            API options, but the app still chunks transcripts to stay safe.
          </p>
          <p>Ollama and LM Studio are not installed by the app. You install the provider and download local LLMs separately.</p>
        </section>

        <section className="help-content-section">
          <h4>Run Analysis</h4>
          <ul>
            <li><strong>Start</strong> begins the selected analysis. While running, the action becomes <strong>Cancel</strong>.</li>
            <li><strong>Status</strong> shows readiness, current transcript, completion, or errors.</li>
            <li>The progress display reports completed transcripts and real analysis-chunk progress.</li>
            <li>A failed transcript does not discard successful results from other transcripts.</li>
          </ul>
          <p>
            When output files are created, the status section shows actions to open the output folder or log file.
          </p>
        </section>
      </div>
    );
  }

  function renderTroubleshootingChapter() {
    return (
      <div className="help-content-stack">
        <section className="help-content-section">
          <h4>First Checks</h4>
          <p>If something does not work, start with the basics:</p>
          <ul>
            <li>check the selected folders</li>
            <li>check the selected file</li>
            <li>check whether a provider is running</li>
            <li>check whether a model is available</li>
            <li>check whether the current run state is waiting for missing input</li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Transcription Problems</h4>

          <h5>No media files appear</h5>
          <p>In folder mode, make sure supported audio or video files are directly inside the selected input folder.</p>
          <p>Scanning is non-recursive, so files inside subfolders are not included.</p>

          <h5>Transcription does not start</h5>
          <p>Check that all required items are set:</p>
          <ul>
            <li>input media file or input folder</li>
            <li>transcript output folder</li>
            <li>at least one export format</li>
            <li>scanned files available</li>
          </ul>

          <h5>CUDA is unavailable</h5>
          <p>
            Hardware detection appears in stages on Home. CPU transcription remains available while the app checks
            the NVIDIA GPU and CUDA runtime. If the scan fails, use <strong>Retry Hardware Scan</strong>; if CUDA still
            cannot be verified, continue with CPU and inspect the startup log. A CPU-only Windows build may name an
            installed NVIDIA GPU but intentionally offers only CPU acceleration.
          </p>

          <h5>Model download takes time</h5>
          <p>
            Download transcription models from the Models page before starting a run. Larger faster-whisper models can
            take longer to download and use more disk space.
          </p>

          <h5>The folder is too large for one run</h5>
          <p>
            If a folder contains very many files or very large recordings, the app may stop the run before it starts
            and ask you to split the folder into smaller batches.
          </p>
          <p>The current transcription guardrails are:</p>
          <ul>
            <li>
              up to <strong>1000</strong> supported media files per run
            </li>
            <li>
              up to <strong>8 GB</strong> for one individual media file
            </li>
            <li>
              up to <strong>64 GB</strong> total supported media size in one folder scan
            </li>
          </ul>
        </section>

        <section className="help-content-section">
          <h4>Transcript Analysis Problems</h4>

          <h5>No provider is available</h5>
          <p>
            Make sure <strong>Ollama</strong> or <strong>LM Studio</strong> is installed, running, and exposing its
            local API on the default localhost port. Ollama should respond on <code>127.0.0.1:11434</code>. LM Studio
            needs its Developer/local server started on <code>127.0.0.1:1234</code>.
          </p>

          <h5>No models appear</h5>
          <p>
            Make sure the selected provider already has local models available. The app does not install or download
            analysis models for you.
          </p>

          <h5>Transcript Analysis does not start</h5>
          <p>Check that all required fields are set:</p>
          <ul>
            <li>provider</li>
            <li>model</li>
            <li>input file or folder</li>
            <li>analysis output folder</li>
            <li>one selected analysis</li>
            <li>a research question when Research Focus Analysis is selected</li>
            <li>at least one output format</li>
          </ul>
          <p>
            Very large transcript files may be chunked before being sent to the local model. If a local model still
            cannot handle the request, try a smaller local model, shorten a custom instruction, or split the transcript input.
          </p>
          <p>The current transcript-analysis guardrails are:</p>
          <ul>
            <li>
              up to <strong>64 MB</strong> for one source transcript file
            </li>
            <li>
              up to <strong>20,000</strong> table rows for CSV/XLSX inputs
            </li>
          </ul>

          <h5>The source transcript should not be overwritten</h5>
          <p>This is expected behavior. Transcript Analysis writes new result files instead of modifying the source transcript.</p>
        </section>

        <section className="help-content-section">
          <h4>Speaker Detection Problems</h4>

          <h5>Speaker detection is unavailable</h5>
          <p>Open Models and check whether the pyannote speaker model has been downloaded successfully.</p>

          <h5>Token is valid but access is still restricted</h5>
          <p>
            Open the required diarization model page on Hugging Face, sign in with the same account, accept access, and
            test the token again.
          </p>

          <h5>Speaker detection is slow</h5>
          <p>
            This can happen because speaker recognition is an additional model pass after transcription. Longer recordings can
            take noticeably more time than short single-speaker files.
          </p>
        </section>

        <section className="help-content-section">
          <h4>Output Problems</h4>

          <h5>Output file cannot be written</h5>
          <p>
            Check that the selected output folder is writable and that the target file is not already locked by another
            program.
          </p>

          <h5>An analysis output file already exists</h5>
          <p>The app uses conflict-free copy suffixes. If a file is locked by another program, close it and run again.</p>

          <h5>Brief logs</h5>
          <p>
            Troubleshooting logs stay sparse. They record run status and file-level outcomes, but not full transcript
            bodies or full prompt instructions.
          </p>
        </section>
      </div>
    );
  }

  function renderChapterBody() {
    switch (activeChapter) {
      case "about":
        return renderAboutChapter();
      case "workflow":
        return renderWorkflowChapter();
      case "models":
        return renderModelsChapter();
      case "transcription":
        return (
          <>
            {renderTranscriptionSimpleChapter()}
            {renderTranscriptionAdvancedChapter()}
            {renderTranscriptionRunChapter()}
          </>
        );
      case "editor":
        return renderEditorChapter();
      case "codes":
        return renderCodesChapter();
      case "prompting":
        return renderPromptingChapter();
      case "troubleshooting":
        return renderTroubleshootingChapter();
      default:
        return null;
    }
  }

  return (
    <div className="page-stack">
      <section className="page-header">
        <div>
          <h2>Help</h2>
          <p>Guidance for setup, transcription, transcript analysis, and troubleshooting.</p>
        </div>
      </section>

      <section className="section-card">
        <div className="help-chapter-nav" role="tablist" aria-label="Help chapters">
          {helpChapters.map((chapter, index) => (
            <button
              key={chapter.id}
              type="button"
              ref={(element) => { chapterTabRefs.current[index] = element; }}
              id={`help-tab-${chapter.id}`}
              role="tab"
              aria-selected={chapter.id === activeChapter}
              aria-controls={`help-panel-${chapter.id}`}
              tabIndex={chapter.id === activeChapter ? 0 : -1}
              className={chapter.id === activeChapter ? "help-chapter-tab active" : "help-chapter-tab"}
              onClick={() => setActiveChapter(chapter.id)}
              onKeyDown={(event) => handleChapterKeyDown(event, index)}
            >
              {chapter.label}
            </button>
          ))}
        </div>
      </section>

      <section
        id={`help-panel-${activeChapter}`}
        className="section-card help-doc-card"
        role="tabpanel"
        aria-labelledby={`help-tab-${activeChapter}`}
        tabIndex={0}
      >
        <div className="help-doc-header">
          <h3>{currentChapter.title}</h3>
          <p>{currentChapter.intro}</p>
        </div>
        {renderChapterBody()}
      </section>
    </div>
  );
}
