import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import type { CodesAiEvidenceSuggestion, CodesAiRunSnapshot, CodesEvidenceItem, CodesProject, CodesTranscript, CodesTranscriptSegment } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import { CodesHighlightControls, type CodesHighlightSettings } from "./CodesHighlightControls";
import { CodesAiActionButton } from "./CodesAiActionButton";
import { CodesAiEvidenceDialog, type EvidenceAiScope } from "./CodesAiEvidenceDialog";
import { CodesAiProgress } from "./CodesAiProgress";
import type { EvidenceDraft } from "./codesPageUtils";
import { timestampRangeLabel } from "./codesPageUtils";
import { ModalDialog } from "../workbench/ModalDialog";

type CodesTranscriptReaderProps = {
  project: CodesProject;
  activeTranscript: CodesTranscript | null;
  selectedEvidence: CodesEvidenceItem | null;
  evidenceDraft: EvidenceDraft | null;
  highlightSettings: CodesHighlightSettings;
  canEditProject: boolean;
  segmentRefs: MutableRefObject<Record<string, HTMLElement | null>>;
  onCaptureEvidenceSelection: () => void;
  onClearEvidenceSelection: () => void;
  onHighlightSettingsChange: (settings: CodesHighlightSettings) => void;
  onSelectEvidence: (evidence: CodesEvidenceItem) => void;
  aiConfigured: boolean;
  aiPrompt: string;
  aiRun: CodesAiRunSnapshot | null;
  aiBusy?: boolean;
  aiLocked?: boolean;
  aiCancellationPending?: boolean;
  aiConnectionMessage?: string;
  aiError: string | null;
  aiWarning?: string | null;
  aiSuggestions: CodesAiEvidenceSuggestion[];
  selectedAiSuggestionId: string;
  onRequireAiConfiguration: () => void;
  onSaveAiPrompt: (prompt: string) => void;
  onRestoreAiPrompt: () => string | null;
  onRunEvidenceAi: (request: { transcriptId: string; scope: EvidenceAiScope; researcherPrompt: string; maximumSuggestions: number }) => void;
  onCancelAiRun: () => void;
  onRetryAiRun?: () => void;
  onSelectAiSuggestion: (suggestion: CodesAiEvidenceSuggestion) => void;
};

type HighlightEvidenceMatch = {
  evidence: CodesEvidenceItem;
  codeIds: string[];
  themeIds: string[];
  evidenceLayer: boolean;
};

export type SegmentHighlightRun = {
  start: number;
  end: number;
  text: string;
  evidenceMatches: HighlightEvidenceMatch[];
  codeIds: string[];
  themeIds: string[];
  evidenceLayer: boolean;
  selected: boolean;
  draft: boolean;
  search: boolean;
  aiSuggestionIds: string[];
  aiSelected: boolean;
};

const readerHelpText = "Read transcripts and create traceable evidence from selected passages.";

function unique(values: string[]) {
  return [...new Set(values)];
}

function activeIds(allIds: string[], scope: "all" | "selected", selectedIds: string[]) {
  return scope === "all" ? new Set(allIds) : new Set(selectedIds);
}

function searchRanges(text: string, search: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const query = search.trim().toLocaleLowerCase();
  if (!query) return ranges;
  const comparable = text.toLocaleLowerCase();
  let from = 0;
  while (from < comparable.length) {
    const start = comparable.indexOf(query, from);
    if (start < 0) break;
    ranges.push({ start, end: start + query.length });
    from = start + Math.max(1, query.length);
  }
  return ranges;
}

export function buildSegmentHighlightRuns(args: {
  text: string;
  segmentId: string;
  evidenceItems: CodesEvidenceItem[];
  selectedEvidenceId: string;
  draftRange?: { start_offset: number; end_offset: number; excerpt: string };
  codeIds: string[];
  themes: CodesProject["themes"];
  settings: CodesHighlightSettings;
  search: string;
  aiSuggestions?: CodesAiEvidenceSuggestion[];
  selectedAiSuggestionId?: string;
}): SegmentHighlightRun[] {
  const { text, segmentId, evidenceItems, selectedEvidenceId, draftRange, codeIds, themes, settings, search, aiSuggestions = [], selectedAiSuggestionId = "" } = args;
  const enabledCodeIds = activeIds(codeIds, settings.codeScope, settings.selectedCodeIds);
  const enabledThemeIds = activeIds(themes.map((theme) => theme.theme_id), settings.themeScope, settings.selectedThemeIds);
  const matches = evidenceItems.flatMap((evidence): HighlightEvidenceMatch[] => {
    const range = evidence.segment_ranges[segmentId];
    if (!range) return [];
    const matchingCodeIds = settings.show && settings.codes
      ? evidence.code_ids.filter((codeId) => enabledCodeIds.has(codeId))
      : [];
    const matchingThemeIds = settings.show && settings.themes
      ? themes
        .filter((theme) => enabledThemeIds.has(theme.theme_id) && theme.code_ids.some((codeId) => evidence.code_ids.includes(codeId)))
        .map((theme) => theme.theme_id)
      : [];
    const evidenceLayer = settings.show && settings.evidence;
    const focused = evidence.evidence_id === selectedEvidenceId;
    if (!evidenceLayer && !matchingCodeIds.length && !matchingThemeIds.length && !focused) return [];
    return [{ evidence, codeIds: matchingCodeIds, themeIds: matchingThemeIds, evidenceLayer }];
  });
  const searches = searchRanges(text, search);
  const aiMatches = aiSuggestions.filter((suggestion) => Boolean(suggestion.segment_ranges[segmentId]));
  const boundaries = new Set([0, text.length]);
  for (const match of matches) {
    const range = match.evidence.segment_ranges[segmentId];
    boundaries.add(range.start_offset);
    boundaries.add(range.end_offset);
  }
  if (draftRange) {
    boundaries.add(draftRange.start_offset);
    boundaries.add(draftRange.end_offset);
  }
  for (const range of searches) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const suggestion of aiMatches) {
    const range = suggestion.segment_ranges[segmentId];
    boundaries.add(range.start_offset);
    boundaries.add(range.end_offset);
  }
  const points = [...boundaries].filter((point) => point >= 0 && point <= text.length).sort((left, right) => left - right);
  const runs: SegmentHighlightRun[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const evidenceMatches = matches.filter((match) => {
      const range = match.evidence.segment_ranges[segmentId];
      return range.start_offset <= start && range.end_offset >= end;
    });
    runs.push({
      start,
      end,
      text: text.slice(start, end),
      evidenceMatches,
      codeIds: unique(evidenceMatches.flatMap((match) => match.codeIds)),
      themeIds: unique(evidenceMatches.flatMap((match) => match.themeIds)),
      evidenceLayer: evidenceMatches.some((match) => match.evidenceLayer),
      selected: evidenceMatches.some((match) => match.evidence.evidence_id === selectedEvidenceId),
      draft: Boolean(draftRange && draftRange.start_offset <= start && draftRange.end_offset >= end),
      search: searches.some((range) => range.start <= start && range.end >= end),
      aiSuggestionIds: aiMatches
        .filter((suggestion) => {
          const range = suggestion.segment_ranges[segmentId];
          return range.start_offset <= start && range.end_offset >= end;
        })
        .map((suggestion) => suggestion.suggestion_id),
      aiSelected: aiMatches.some((suggestion) => {
        const range = suggestion.segment_ranges[segmentId];
        return suggestion.suggestion_id === selectedAiSuggestionId && range.start_offset <= start && range.end_offset >= end;
      })
    });
  }
  return runs;
}

function ribbonGradient(colors: string[], direction: "right" | "bottom") {
  if (!colors.length) return "transparent";
  const size = 100 / colors.length;
  const stops = colors.flatMap((color, index) => [`${color} ${index * size}%`, `${color} ${(index + 1) * size}%`]);
  return `linear-gradient(to ${direction}, ${stops.join(", ")})`;
}

function speakerName(transcript: CodesTranscript, speakerId: string) {
  return transcript.speakers.find((speaker) => speaker.id === speakerId)?.name || speakerId || "No Speaker";
}

export function CodesTranscriptReader({
  project,
  activeTranscript,
  selectedEvidence,
  evidenceDraft,
  highlightSettings,
  canEditProject,
  segmentRefs,
  onCaptureEvidenceSelection,
  onClearEvidenceSelection,
  onHighlightSettingsChange,
  onSelectEvidence,
  aiConfigured = false,
  aiPrompt = "",
  aiRun = null,
  aiBusy = false,
  aiLocked = false,
  aiCancellationPending = false,
  aiConnectionMessage = "",
  aiError = null,
  aiWarning = null,
  aiSuggestions = [],
  selectedAiSuggestionId = "",
  onRequireAiConfiguration = () => {},
  onSaveAiPrompt = () => {},
  onRestoreAiPrompt = () => "",
  onRunEvidenceAi = () => {},
  onCancelAiRun = () => {},
  onRetryAiRun = () => {},
  onSelectAiSuggestion = () => {}
}: CodesTranscriptReaderProps) {
  const [search, setSearch] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [codingMode, setCodingMode] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [chooserEvidenceIds, setChooserEvidenceIds] = useState<string[]>([]);
  const chooserFirstRef = useRef<HTMLButtonElement>(null);
  const chooserTriggerRef = useRef<HTMLElement | null>(null);
  const filteredSegments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!activeTranscript || !query) return activeTranscript?.segments ?? [];
    return activeTranscript.segments.filter((segment) =>
      segment.text.toLocaleLowerCase().includes(query)
      || speakerName(activeTranscript, segment.speaker).toLocaleLowerCase().includes(query)
    );
  }, [activeTranscript, search]);
  const pageCount = Math.max(1, Math.ceil(filteredSegments.length / pageSize));
  const visibleSegments = filteredSegments.slice((page - 1) * pageSize, page * pageSize);
  const transcriptEvidence = project.evidence_items.filter((evidence) => evidence.transcript_id === activeTranscript?.transcript_id);
  const codeLookup = new Map(project.codes.map((code) => [code.code_id, code]));
  const themeLookup = new Map(project.themes.map((theme) => [theme.theme_id, theme]));
  const aiRunning = aiLocked;
  const evidenceAiRunning = aiBusy;

  useEffect(() => {
    setPage(1);
    setSearch("");
    setChooserEvidenceIds([]);
  }, [activeTranscript?.transcript_id]);

  useEffect(() => {
    if (selectedEvidence?.evidence_id) setSearch("");
  }, [selectedEvidence?.evidence_id]);

  useEffect(() => {
    if (evidenceDraft) setCodingMode(true);
  }, [evidenceDraft]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  useEffect(() => {
    if (!chooserEvidenceIds.length) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEvidenceChooser();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [chooserEvidenceIds.length]);

  useEffect(() => {
    const selectedAiSuggestion = aiSuggestions.find((suggestion) => suggestion.suggestion_id === selectedAiSuggestionId);
    const segmentId = selectedEvidence?.segment_ids[0] ?? evidenceDraft?.segmentIds[0] ?? selectedAiSuggestion?.segment_ids[0];
    if (!activeTranscript || !segmentId || search) return;
    const index = activeTranscript.segments.findIndex((segment) => segment.segment_id === segmentId);
    if (index >= 0) setPage(Math.floor(index / pageSize) + 1);
  }, [activeTranscript, aiSuggestions, evidenceDraft?.segmentIds, pageSize, search, selectedAiSuggestionId, selectedEvidence?.segment_ids]);

  const selectedAiSuggestion = aiSuggestions.find((suggestion) => suggestion.suggestion_id === selectedAiSuggestionId);
  const activeSegmentIds = evidenceDraft?.segmentIds ?? selectedEvidence?.segment_ids ?? selectedAiSuggestion?.segment_ids ?? [];
  const targetSegmentId = activeSegmentIds[0] ?? "";
  const targetVisible = visibleSegments.some((segment) => segment.segment_id === targetSegmentId);

  useEffect(() => {
    if (!targetSegmentId || !targetVisible) return;
    const frame = window.requestAnimationFrame(() => {
      const target = segmentRefs.current[targetSegmentId];
      if (typeof target?.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [segmentRefs, targetSegmentId, targetVisible]);

  function finishCoding() {
    setCodingMode(false);
    onClearEvidenceSelection();
  }

  function openEvidence(evidenceIds: string[]) {
    if (window.getSelection()?.toString()) return;
    const ids = unique(evidenceIds);
    if (ids.length === 1) {
      const evidence = project.evidence_items.find((item) => item.evidence_id === ids[0]);
      if (evidence) onSelectEvidence(evidence);
      return;
    }
    if (ids.length > 1) {
      chooserTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setChooserEvidenceIds(ids);
    }
  }

  function closeEvidenceChooser() {
    setChooserEvidenceIds([]);
    window.setTimeout(() => chooserTriggerRef.current?.focus(), 0);
  }

  function renderRun(run: SegmentHighlightRun, key: string): ReactNode {
    const evidenceIds = unique(run.evidenceMatches.map((match) => match.evidence.evidence_id));
    const codeColors = run.codeIds.map((id) => codeLookup.get(id)?.color).filter((color): color is string => Boolean(color));
    const themeColors = run.themeIds.map((id) => themeLookup.get(id)?.color).filter((color): color is string => Boolean(color));
    const highlighted = run.evidenceLayer || run.codeIds.length > 0 || run.themeIds.length > 0 || run.selected || run.draft || run.aiSuggestionIds.length > 0;
    const tooltipId = evidenceIds.length ? `codes-highlight-tooltip-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}` : undefined;
    const style = {
      "--codes-highlight-code-gradient": ribbonGradient(codeColors, "right"),
      "--codes-highlight-theme-gradient": ribbonGradient(themeColors, "bottom")
    } as CSSProperties;
    const content = run.search ? <mark className="codes-search-highlight">{run.text}</mark> : run.text;
    if (!highlighted) return <span key={key}>{content}</span>;
    return (
      <span
        key={key}
        className={[
          "codes-highlight-run",
          run.evidenceLayer ? "evidence-layer" : "",
          run.codeIds.length ? "code-layer" : "",
          run.themeIds.length ? "theme-layer" : "",
          run.selected || run.draft ? "selected" : "",
          run.aiSuggestionIds.length ? "ai-suggestion" : "",
          run.aiSelected ? "ai-selected" : ""
        ].filter(Boolean).join(" ")}
        style={style}
        role={evidenceIds.length || run.aiSuggestionIds.length ? "button" : undefined}
        tabIndex={evidenceIds.length || run.aiSuggestionIds.length ? 0 : undefined}
        aria-label={evidenceIds.length
          ? `Open ${evidenceIds.length === 1 ? `Evidence ${evidenceIds[0]}` : `${evidenceIds.length} Overlapping Evidence Items`}`
          : run.aiSuggestionIds.length
            ? "Open AI Evidence Suggestion"
            : undefined}
        aria-describedby={tooltipId}
        onClick={evidenceIds.length || run.aiSuggestionIds.length ? () => {
          if (evidenceIds.length) openEvidence(evidenceIds);
          else {
            const suggestion = aiSuggestions.find((item) => run.aiSuggestionIds.includes(item.suggestion_id));
            if (suggestion) onSelectAiSuggestion(suggestion);
          }
        } : undefined}
        onKeyDown={evidenceIds.length || run.aiSuggestionIds.length ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (evidenceIds.length) openEvidence(evidenceIds);
            else {
              const suggestion = aiSuggestions.find((item) => run.aiSuggestionIds.includes(item.suggestion_id));
              if (suggestion) onSelectAiSuggestion(suggestion);
            }
          }
        } : undefined}
      >
        <span className={run.themeIds.length ? "codes-highlight-theme-ribbon" : undefined}>
          <span className={run.codeIds.length ? "codes-highlight-code-ribbon" : undefined}>{content}</span>
        </span>
        {tooltipId ? (
          <span id={tooltipId} className="codes-highlight-tooltip" role="tooltip" data-codes-nontranscript>
            {run.evidenceMatches.map(({ evidence }) => {
              const assignedCodes = unique(evidence.code_ids);
              const associatedThemes = project.themes.filter((theme) => theme.code_ids.some((codeId) => assignedCodes.includes(codeId)));
              return (
                <span key={evidence.evidence_id} className="codes-highlight-tooltip-item">
                  <strong>Evidence {evidence.evidence_id}</strong>
                  <span className="codes-highlight-tooltip-excerpt">“{evidence.selected_text}”</span>
                  <span>Codes: {assignedCodes.map((id) => codeLookup.get(id)?.name ?? id).join(", ") || "None"}</span>
                  <span>Themes: {associatedThemes.map((theme) => theme.name).join(", ") || "None"}</span>
                </span>
              );
            })}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <section className="section-card codes-reader-panel">
      <div className="section-heading">
        <FieldLabelWithHelp label="Transcript Reader" helpText={readerHelpText} labelClassName="home-section-title" />
      </div>
      {activeTranscript ? (
        <div
          className="codes-segment-list"
          onMouseUp={codingMode ? onCaptureEvidenceSelection : undefined}
          onKeyUp={codingMode ? onCaptureEvidenceSelection : undefined}
        >
          <div className="codes-reader-control-toolbar">
            <label className="field-group transcription-field transcription-field-compact">
              <span className="field-label">Search Transcript</span>
              <input className="text-input" value={search} placeholder="Search text or speaker" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label className="field-group transcription-field transcription-field-compact codes-page-size-field">
              <span className="field-label">Segments Per Page</span>
              <select className="text-input" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <CodesHighlightControls codes={project.codes} themes={project.themes} settings={highlightSettings} onChange={onHighlightSettingsChange} />
            <div className="action-row codes-reader-pagination">
              <button type="button" className="secondary-button compact" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
              <span>Page {page} / {pageCount}</span>
              <button type="button" className="secondary-button compact" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button>
            </div>
          </div>

          <div className="codes-selection-action codes-evidence-capture-row" role="status" aria-live="polite">
            <span>
              {evidenceDraft
                ? "Select another passage to adjust this evidence draft, or save or cancel it in the Evidence panel."
                : codingMode
                  ? "Select a passage in the transcript. Each selection opens an evidence draft."
                  : "Start Coding, then select transcript text to create evidence."}
            </span>
            <div className="action-row">
              <CodesAiActionButton
                action="Suggest Evidence"
                className="compact"
                simpleLabel
                busy={evidenceAiRunning}
                busyLabel="AI Analyzing…"
                disabled={!canEditProject || aiRunning}
                onClick={() => {
                  if (!aiConfigured) onRequireAiConfiguration();
                  else setAiDialogOpen(true);
                }}
              >
                AI Suggestions
              </CodesAiActionButton>
              <button
                type="button"
                className={codingMode ? "primary-button compact" : "secondary-button compact"}
                aria-pressed={codingMode}
                onClick={() => {
                  if (codingMode) finishCoding();
                  else {
                    onClearEvidenceSelection();
                    setCodingMode(true);
                  }
                }}
                disabled={!canEditProject || Boolean(evidenceDraft)}
              >
                {codingMode ? "Finish Coding" : "Start Coding"}
              </button>
            </div>
          </div>

          {evidenceAiRunning && aiRun ? (
            <CodesAiProgress
              run={aiRun}
              timeoutSeconds={project.ai_settings.timeout_seconds}
              onCancel={onCancelAiRun}
              cancellationPending={aiCancellationPending}
              connectionMessage={aiConnectionMessage}
            />
          ) : null}
          {aiWarning ? <div className="codes-ai-inline-message warning" role="status">{aiWarning}</div> : null}
          {aiError ? (
            <div className="codes-ai-inline-message error" role="alert">
              <span>{aiError}</span>
              <button type="button" className="secondary-button compact" onClick={onRetryAiRun}>Retry</button>
            </div>
          ) : null}

          {visibleSegments.map((segment: CodesTranscriptSegment) => {
            const originalIndex = activeTranscript.segments.findIndex((item) => item.segment_id === segment.segment_id);
            const runs = buildSegmentHighlightRuns({
              text: segment.text,
              segmentId: segment.segment_id,
              evidenceItems: transcriptEvidence,
              selectedEvidenceId: selectedEvidence?.evidence_id ?? "",
              draftRange: evidenceDraft?.segmentRanges[segment.segment_id],
              codeIds: project.codes.map((code) => code.code_id),
              themes: project.themes,
              settings: highlightSettings,
              search,
              aiSuggestions,
              selectedAiSuggestionId
            });
            return (
              <article
                key={segment.segment_id}
                ref={(element) => { segmentRefs.current[segment.segment_id] = element; }}
                className={activeSegmentIds.includes(segment.segment_id) ? "codes-segment-card active" : "codes-segment-card"}
                data-codes-segment-id={segment.segment_id}
              >
                <header>
                  <span className="segment-index-button">{originalIndex + 1}</span>
                  <span className="timestamp-range">{timestampRangeLabel(segment.start, segment.end)}</span>
                  <strong>{speakerName(activeTranscript, segment.speaker)}</strong>
                </header>
                <p data-codes-segment-text>{runs.map((run, index) => renderRun(run, `${segment.segment_id}-${index}`))}</p>
              </article>
            );
          })}
          {!visibleSegments.length ? <div className="codes-empty-list compact">No matching transcript segments</div> : null}
        </div>
      ) : (
        <div className="codes-reader-empty">
          <strong>No Transcript Selected</strong>
          <span>Choose an imported transcript from the Transcript toolbar.</span>
        </div>
      )}

      <ModalDialog
        open={chooserEvidenceIds.length > 0}
        instanceKey={chooserEvidenceIds.join("|")}
        className="codes-highlight-chooser"
        title="Choose Evidence"
        description="Several evidence items overlap at this location."
        initialFocusRef={chooserFirstRef}
        onCancel={closeEvidenceChooser}
        footer={<button type="button" className="secondary-button" onClick={closeEvidenceChooser}>Cancel</button>}
      >
        {chooserEvidenceIds.length ? (
            <div className="codes-highlight-choice-list">
              {chooserEvidenceIds.map((evidenceId, index) => {
                const evidence = project.evidence_items.find((item) => item.evidence_id === evidenceId);
                if (!evidence) return null;
                const evidenceThemes = project.themes.filter((theme) => theme.code_ids.some((codeId) => evidence.code_ids.includes(codeId)));
                return (
                  <button
                    key={evidenceId}
                    type="button"
                    className="secondary-button codes-highlight-choice"
                    ref={index === 0 ? chooserFirstRef : undefined}
                    onClick={() => { setChooserEvidenceIds([]); onSelectEvidence(evidence); }}
                  >
                    <strong>{evidence.selected_text}</strong>
                    <span>Evidence {evidence.evidence_id}</span>
                    <span>Codes: {evidence.code_ids.map((id) => codeLookup.get(id)?.name ?? id).join(", ") || "None"}</span>
                    <span>Themes: {evidenceThemes.map((theme) => theme.name).join(", ") || "None"}</span>
                  </button>
                );
              })}
            </div>
        ) : null}
      </ModalDialog>
      {activeTranscript ? (
        <CodesAiEvidenceDialog
          open={aiDialogOpen}
          transcript={activeTranscript}
          currentPageSegmentIds={visibleSegments.map((segment) => segment.segment_id)}
          initialPrompt={aiPrompt}
          busy={evidenceAiRunning}
          onSaveDefault={onSaveAiPrompt}
          onRestoreDefault={onRestoreAiPrompt}
          onRun={(request) => {
            setAiDialogOpen(false);
            onRunEvidenceAi({ transcriptId: activeTranscript.transcript_id, ...request });
          }}
          onClose={() => setAiDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}
