import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CodesCode, CodesEvidenceItem, CodesProject, CodesTheme } from "../../lib/api";
import type { CodeForm, ThemeForm } from "./codesPageUtils";
import { ThemeCodeSelector } from "./ThemeCodeSelector";

export type CodebookEntityView = "codes" | "themes";

type CodesCodebookPanelProps = {
  project: CodesProject;
  activeView: CodebookEntityView;
  codeForm: CodeForm;
  themeForm: ThemeForm;
  busy: boolean;
  canEditProject: boolean;
  codeFormDirty: boolean;
  themeFormDirty: boolean;
  editorError?: string | null;
  onViewChange: (view: CodebookEntityView) => void;
  onCodeFormChange: (updater: (current: CodeForm) => CodeForm) => void;
  onThemeFormChange: (updater: (current: ThemeForm) => ThemeForm) => void;
  onToggleThemeCode: (codeId: string) => void;
  onSaveCode: () => void;
  onSaveTheme: () => void;
  onCancelCode: () => void;
  onCancelTheme: () => void;
  onEditCode: (code: CodesCode) => void;
  onEditTheme: (theme: CodesTheme) => void;
  onNewCode: () => void;
  onNewTheme: () => void;
  onDeleteCode: (code: CodesCode) => void;
  onDeleteTheme: (theme: CodesTheme) => void;
  onOpenMergeCode: (code: CodesCode) => void;
  onOpenEvidence: (evidence: CodesEvidenceItem) => void;
  codeAiAction?: ReactNode;
  themeAiAction?: ReactNode;
  themeRefineAiAction?: ReactNode;
  codeAiResults?: ReactNode;
  themeAiResults?: ReactNode;
};

const EVIDENCE_PAGE_SIZE = 25;

function plural(count: number, singular: string, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function formatTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "Time unavailable";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function CodesCodebookPanel(props: CodesCodebookPanelProps) {
  const {
    project, activeView, codeForm, themeForm, busy, canEditProject, codeFormDirty, themeFormDirty, editorError,
    onViewChange, onCodeFormChange, onThemeFormChange, onToggleThemeCode, onSaveCode, onSaveTheme,
    onCancelCode, onCancelTheme, onEditCode, onEditTheme, onNewCode, onNewTheme, onDeleteCode,
    onDeleteTheme, onOpenMergeCode, onOpenEvidence, codeAiAction, themeAiAction, themeRefineAiAction,
    codeAiResults, themeAiResults
  } = props;
  const [codeSearch, setCodeSearch] = useState("");
  const [themeSearch, setThemeSearch] = useState("");
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [evidencePage, setEvidencePage] = useState(1);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const selectedCode = project.codes.find((code) => code.code_id === codeForm.codeId) ?? null;
  const selectedTheme = project.themes.find((theme) => theme.theme_id === themeForm.themeId) ?? null;

  useEffect(() => {
    setActionsOpen(false);
    setEvidenceSearch("");
    setEvidencePage(1);
  }, [activeView, codeForm.codeId, themeForm.themeId]);

  useEffect(() => {
    if (!actionsOpen) return;
    function closeActions(event: globalThis.KeyboardEvent | MouseEvent) {
      if (event instanceof globalThis.KeyboardEvent && event.key === "Escape") {
        setActionsOpen(false);
        return;
      }
      if (event instanceof MouseEvent && actionsRef.current && !actionsRef.current.contains(event.target as Node)) {
        setActionsOpen(false);
      }
    }
    document.addEventListener("keydown", closeActions);
    document.addEventListener("mousedown", closeActions);
    return () => {
      document.removeEventListener("keydown", closeActions);
      document.removeEventListener("mousedown", closeActions);
    };
  }, [actionsOpen]);

  const evidenceIdsByCode = useMemo(() => {
    const evidenceIds = new Map<string, Set<string>>();
    project.evidence_items.forEach((evidence) => evidence.code_ids.forEach((codeId) => {
      const current = evidenceIds.get(codeId) ?? new Set<string>();
      current.add(evidence.evidence_id);
      evidenceIds.set(codeId, current);
    }));
    return evidenceIds;
  }, [project.evidence_items]);
  const themeCountByCode = useMemo(() => {
    const counts = new Map<string, number>();
    project.themes.forEach((theme) => theme.code_ids.forEach((codeId) => counts.set(codeId, (counts.get(codeId) ?? 0) + 1)));
    return counts;
  }, [project.themes]);
  const relatedEvidenceByTheme = useMemo(() => {
    const counts = new Map<string, number>();
    project.themes.forEach((theme) => {
      const evidenceIds = new Set<string>();
      theme.code_ids.forEach((codeId) => evidenceIdsByCode.get(codeId)?.forEach((evidenceId) => evidenceIds.add(evidenceId)));
      counts.set(theme.theme_id, evidenceIds.size);
    });
    return counts;
  }, [evidenceIdsByCode, project.themes]);
  const transcriptById = useMemo(() => new Map(project.transcripts.map((transcript) => [transcript.transcript_id, transcript])), [project.transcripts]);

  const codeQuery = codeSearch.trim().toLocaleLowerCase();
  const themeQuery = themeSearch.trim().toLocaleLowerCase();
  const filteredCodes = useMemo(
    () => project.codes.filter((code) => !codeQuery || code.name.toLocaleLowerCase().includes(codeQuery) || code.description.toLocaleLowerCase().includes(codeQuery) || code.code_id.toLocaleLowerCase().includes(codeQuery)),
    [project.codes, codeQuery]
  );
  const filteredThemes = useMemo(
    () => project.themes.filter((theme) => !themeQuery || theme.name.toLocaleLowerCase().includes(themeQuery) || theme.description.toLocaleLowerCase().includes(themeQuery) || theme.theme_id.toLocaleLowerCase().includes(themeQuery)),
    [project.themes, themeQuery]
  );
  const codedEvidence = useMemo(
    () => codeForm.codeId ? project.evidence_items.filter((item) => item.code_ids.includes(codeForm.codeId!)) : [],
    [codeForm.codeId, project.evidence_items]
  );
  const filteredCodedEvidence = useMemo(() => {
    const query = evidenceSearch.trim().toLocaleLowerCase();
    return codedEvidence.filter((item) => {
      const transcript = transcriptById.get(item.transcript_id);
      return !query || item.selected_text.toLocaleLowerCase().includes(query) || item.evidence_id.toLocaleLowerCase().includes(query) || transcript?.label.toLocaleLowerCase().includes(query);
    });
  }, [codedEvidence, evidenceSearch, transcriptById]);
  const evidencePageCount = Math.max(1, Math.ceil(filteredCodedEvidence.length / EVIDENCE_PAGE_SIZE));
  const safeEvidencePage = Math.min(evidencePage, evidencePageCount);
  const visibleCodedEvidence = filteredCodedEvidence.slice((safeEvidencePage - 1) * EVIDENCE_PAGE_SIZE, safeEvidencePage * EVIDENCE_PAGE_SIZE);
  const exampleEvidence = codeForm.exampleEvidenceIds.map((id) => project.evidence_items.find((item) => item.evidence_id === id)).filter((item): item is CodesEvidenceItem => Boolean(item));
  const duplicateCodeName = Boolean(selectedCode && project.codes.some((code) => code.code_id !== selectedCode.code_id && code.name.trim().toLocaleLowerCase() === codeForm.name.trim().toLocaleLowerCase()));
  const duplicateThemeName = Boolean(selectedTheme && project.themes.some((theme) => theme.theme_id !== selectedTheme.theme_id && theme.name.trim().toLocaleLowerCase() === themeForm.name.trim().toLocaleLowerCase()));

  function handleViewKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: CodebookEntityView) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: CodebookEntityView = event.key === "ArrowLeft" || event.key === "Home" ? "codes" : event.key === "ArrowRight" || event.key === "End" ? "themes" : current;
    onViewChange(next);
    window.setTimeout(() => document.getElementById(`codebook-tab-${next}`)?.focus(), 0);
  }

  function toggleExample(evidenceId: string) {
    onCodeFormChange((current) => ({
      ...current,
      exampleEvidenceIds: current.exampleEvidenceIds.includes(evidenceId)
        ? current.exampleEvidenceIds.filter((id) => id !== evidenceId)
        : [...current.exampleEvidenceIds, evidenceId]
    }));
  }

  function renderEvidenceMetadata(evidence: CodesEvidenceItem) {
    const transcript = transcriptById.get(evidence.transcript_id);
    return `${transcript?.label ?? "Unknown Transcript"} · ${evidence.speaker || "Speaker unavailable"} · ${formatTime(evidence.start)}–${formatTime(evidence.end)}`;
  }

  const catalogSearch = activeView === "codes" ? codeSearch : themeSearch;
  const setCatalogSearch = activeView === "codes" ? setCodeSearch : setThemeSearch;
  const catalogIsEmpty = activeView === "codes" ? project.codes.length === 0 : project.themes.length === 0;
  const catalogHasNoMatches = activeView === "codes" ? filteredCodes.length === 0 : filteredThemes.length === 0;

  return (
    <section className="section-card codes-codebook-workspace">
      <div className="codes-codebook-header">
        <div className="segmented-control compact-segmented-control" role="tablist" aria-label="Codebook content">
          <button id="codebook-tab-codes" type="button" role="tab" aria-selected={activeView === "codes"} aria-controls="codebook-panel-codes" tabIndex={activeView === "codes" ? 0 : -1} className={activeView === "codes" ? "segment active" : "segment"} onClick={() => onViewChange("codes")} onKeyDown={(event) => handleViewKeyDown(event, "codes")}>Codes ({project.codes.length})</button>
          <button id="codebook-tab-themes" type="button" role="tab" aria-selected={activeView === "themes"} aria-controls="codebook-panel-themes" tabIndex={activeView === "themes" ? 0 : -1} className={activeView === "themes" ? "segment active" : "segment"} onClick={() => onViewChange("themes")} onKeyDown={(event) => handleViewKeyDown(event, "themes")}>Themes ({project.themes.length})</button>
        </div>
        <input className="text-input codes-catalog-search" value={catalogSearch} placeholder={activeView === "codes" ? "Search codes" : "Search themes"} aria-label={activeView === "codes" ? "Search Codes" : "Search Themes"} onChange={(event) => setCatalogSearch(event.target.value)} />
        <div className="action-row codes-codebook-primary-actions">
          {activeView === "themes" ? themeAiAction : null}
          <button type="button" className="primary-button compact" onClick={activeView === "codes" ? onNewCode : onNewTheme} disabled={!canEditProject || busy}>{activeView === "codes" ? "New Code" : "New Theme"}</button>
        </div>
      </div>

      <div id={`codebook-panel-${activeView}`} role="tabpanel" aria-labelledby={`codebook-tab-${activeView}`} className="codes-catalog-grid">
        <aside className={catalogHasNoMatches ? "codes-catalog-list empty" : "codes-catalog-list"} aria-label={activeView === "codes" ? "Codes" : "Themes"}>
          <div className="codes-catalog-scroll">
            {activeView === "codes" ? filteredCodes.map((code) => (
              <button key={code.code_id} type="button" aria-current={code.code_id === codeForm.codeId ? "true" : undefined} className={code.code_id === codeForm.codeId ? "codes-catalog-row active" : "codes-catalog-row"} onClick={() => onEditCode(code)}>
                <span className="codes-color-dot" aria-hidden="true" style={{ backgroundColor: code.color }} />
                <span><strong>{code.name}</strong><small>{plural(evidenceIdsByCode.get(code.code_id)?.size ?? 0, "Evidence Item")} · {plural(themeCountByCode.get(code.code_id) ?? 0, "Theme")}</small><small className="codes-audit-id">{code.code_id}</small></span>
              </button>
            )) : filteredThemes.map((theme) => (
              <button key={theme.theme_id} type="button" aria-current={theme.theme_id === themeForm.themeId ? "true" : undefined} className={theme.theme_id === themeForm.themeId ? "codes-catalog-row active" : "codes-catalog-row"} onClick={() => onEditTheme(theme)}>
                <span className="codes-color-dot" aria-hidden="true" style={{ backgroundColor: theme.color }} />
                <span><strong>{theme.name}</strong><small>{plural(theme.code_ids.length, "Code")} · {plural(relatedEvidenceByTheme.get(theme.theme_id) ?? 0, "Evidence Item")}</small><small className="codes-audit-id">{theme.theme_id}</small></span>
              </button>
            ))}
            {catalogHasNoMatches ? (
              <div className="codes-catalog-empty-state" role="status">
                <strong>{catalogIsEmpty ? (activeView === "codes" ? "No Codes Yet" : "No Themes Yet") : (activeView === "codes" ? "No Codes Found" : "No Themes Found")}</strong>
                <small>
                  {catalogIsEmpty
                    ? (activeView === "codes" ? "Create a code to begin building the codebook." : "Create a theme to group related codes.")
                    : "Try a different search term."}
                </small>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="codes-catalog-editor">
          {activeView === "themes" ? themeAiResults : null}
          {activeView === "codes" && selectedCode ? (
            <>
              <div className="codes-entity-editor-header">
                <div className="codes-entity-title">
                  <span className="codes-color-dot large" aria-hidden="true" style={{ backgroundColor: codeForm.color }} />
                  <div><h3>{codeForm.name || selectedCode.name}</h3><small>{selectedCode.code_id} · {plural(codedEvidence.length, "Evidence Item")} · {plural(themeCountByCode.get(selectedCode.code_id) ?? 0, "Theme")}</small></div>
                  {codeFormDirty ? <span className="codes-draft-badge">Unsaved Changes</span> : null}
                </div>
                <div className="action-row">
                  {codeAiAction}
                  <div className="codes-entity-actions-menu" ref={actionsRef}>
                    <button type="button" className="secondary-button compact" aria-expanded={actionsOpen} onClick={() => setActionsOpen((value) => !value)}>Actions</button>
                    {actionsOpen ? (
                      <div className="codes-entity-actions-popover" role="group" aria-label="Code Actions">
                        {codeFormDirty ? <small>Save or cancel changes before merging this code.</small> : null}
                        {project.codes.length > 1 ? <button type="button" className="secondary-button" disabled={busy || codeFormDirty} onClick={() => { setActionsOpen(false); onOpenMergeCode(selectedCode); }}>Merge Into…</button> : null}
                        <button type="button" className="secondary-button danger-button" onClick={() => { setActionsOpen(false); onDeleteCode(selectedCode); }} disabled={busy}>Delete Code</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {codeAiResults}
              {editorError ? <div className="codes-ai-inline-message error" role="alert">{editorError}</div> : null}
              <div className="codes-code-editor-form">
                <div className="codes-code-name-row">
                  <label className="field-group"><span className="field-label">Code Name</span><input className="text-input" value={codeForm.name} onChange={(event) => onCodeFormChange((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label className="field-group codes-color-field"><span className="field-label">Color</span><input type="color" value={codeForm.color} onChange={(event) => onCodeFormChange((current) => ({ ...current, color: event.target.value }))} aria-label="Code Color" /></label>
                </div>
                {duplicateCodeName ? <div className="codes-ai-inline-message error" role="alert">A code with this name already exists.</div> : null}
                <label className="field-group"><span className="field-label">Definition</span><textarea className="text-input" rows={3} value={codeForm.description} onChange={(event) => onCodeFormChange((current) => ({ ...current, description: event.target.value }))} /></label>
                <div className="codes-criteria-grid">
                  <label className="field-group"><span className="field-label">Inclusion Criteria</span><textarea className="text-input" rows={3} value={codeForm.inclusionNote} onChange={(event) => onCodeFormChange((current) => ({ ...current, inclusionNote: event.target.value }))} /></label>
                  <label className="field-group"><span className="field-label">Exclusion Criteria</span><textarea className="text-input" rows={3} value={codeForm.exclusionNote} onChange={(event) => onCodeFormChange((current) => ({ ...current, exclusionNote: event.target.value }))} /></label>
                </div>
                <label className="field-group"><span className="field-label">Note</span><textarea className="text-input" rows={3} value={codeForm.memo} onChange={(event) => onCodeFormChange((current) => ({ ...current, memo: event.target.value }))} /></label>

                <details key={`coded-${selectedCode.code_id}`} className="codes-evidence-manager">
                  <summary>Coded Evidence ({codedEvidence.length})</summary>
                  <div className="codes-evidence-manager-toolbar">
                    <input className="text-input" value={evidenceSearch} placeholder="Search coded evidence" aria-label="Search Coded Evidence" onChange={(event) => { setEvidenceSearch(event.target.value); setEvidencePage(1); }} />
                    <span>{filteredCodedEvidence.length} Result{filteredCodedEvidence.length === 1 ? "" : "s"}</span>
                  </div>
                  <small className="editor-muted">Select the checkbox beside a passage to use it as Example Evidence. Open a passage to review it in Transcript Coding.</small>
                  <div className="codes-evidence-manager-list">
                    {visibleCodedEvidence.map((evidence) => (
                      <div key={evidence.evidence_id} className="codes-evidence-manager-row">
                        <label title="Use as Example Evidence"><input type="checkbox" checked={codeForm.exampleEvidenceIds.includes(evidence.evidence_id)} onChange={() => toggleExample(evidence.evidence_id)} /><span className="sr-only">Use {evidence.evidence_id} as Example Evidence</span></label>
                        <button type="button" onClick={() => onOpenEvidence(evidence)}><strong>{evidence.selected_text}</strong><small>{renderEvidenceMetadata(evidence)}</small><small className="codes-audit-id">{evidence.evidence_id}</small></button>
                      </div>
                    ))}
                    {!visibleCodedEvidence.length ? <div className="codes-empty-list compact">No Coded Evidence</div> : null}
                  </div>
                  {evidencePageCount > 1 ? <div className="codes-evidence-pagination"><button type="button" className="secondary-button compact" disabled={safeEvidencePage <= 1} onClick={() => setEvidencePage((page) => Math.max(1, page - 1))}>Previous</button><span>Page {safeEvidencePage} / {evidencePageCount}</span><button type="button" className="secondary-button compact" disabled={safeEvidencePage >= evidencePageCount} onClick={() => setEvidencePage((page) => Math.min(evidencePageCount, page + 1))}>Next</button></div> : null}
                </details>

                <details key={`examples-${selectedCode.code_id}`} className="codes-evidence-manager">
                  <summary>Example Evidence ({exampleEvidence.length})</summary>
                  <div className="codes-evidence-manager-list">
                    {exampleEvidence.map((evidence) => (
                      <div key={evidence.evidence_id} className="codes-evidence-manager-row example">
                        <button type="button" onClick={() => onOpenEvidence(evidence)}><strong>{evidence.selected_text}</strong><small>{renderEvidenceMetadata(evidence)}</small><small className="codes-audit-id">{evidence.evidence_id}</small></button>
                        <button type="button" className="secondary-button compact" onClick={() => toggleExample(evidence.evidence_id)}>Remove Example</button>
                      </div>
                    ))}
                    {!exampleEvidence.length ? <div className="codes-empty-list compact">No Example Evidence Selected</div> : null}
                  </div>
                </details>
              </div>
              <div className="codes-catalog-editor-actions sticky">
                <button type="button" className="primary-button" onClick={onSaveCode} disabled={busy || !codeFormDirty || !codeForm.name.trim() || duplicateCodeName}>Save Code</button>
                <button type="button" className="secondary-button" onClick={onCancelCode} disabled={busy || !codeFormDirty}>Cancel</button>
              </div>
            </>
          ) : null}

          {activeView === "themes" && selectedTheme ? (
            <>
              <div className="codes-entity-editor-header">
                <div className="codes-entity-title"><span className="codes-color-dot large" aria-hidden="true" style={{ backgroundColor: themeForm.color }} /><div><h3>{themeForm.name || selectedTheme.name}</h3><small>{selectedTheme.theme_id} · {plural(themeForm.codeIds.length, "Code")} · {plural(relatedEvidenceByTheme.get(selectedTheme.theme_id) ?? 0, "Evidence Item")}</small></div>{themeFormDirty ? <span className="codes-draft-badge">Unsaved Changes</span> : null}</div>
                <div className="action-row">{themeRefineAiAction}<button type="button" className="secondary-button danger-button compact" onClick={() => onDeleteTheme(selectedTheme)} disabled={busy}>Delete Theme</button></div>
              </div>
              {editorError ? <div className="codes-ai-inline-message error" role="alert">{editorError}</div> : null}
              <div className="codes-code-editor-form">
                <div className="codes-code-name-row">
                  <label className="field-group"><span className="field-label">Theme Name</span><input className="text-input" value={themeForm.name} onChange={(event) => onThemeFormChange((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label className="field-group codes-color-field"><span className="field-label">Color</span><input type="color" value={themeForm.color} onChange={(event) => onThemeFormChange((current) => ({ ...current, color: event.target.value }))} aria-label="Theme Color" /></label>
                </div>
                {duplicateThemeName ? <div className="codes-ai-inline-message error" role="alert">A theme with this name already exists.</div> : null}
                <label className="field-group"><span className="field-label">Description</span><textarea className="text-input" rows={4} value={themeForm.description} onChange={(event) => onThemeFormChange((current) => ({ ...current, description: event.target.value }))} /></label>
                <label className="field-group"><span className="field-label">Note</span><textarea className="text-input" rows={3} value={themeForm.memo} onChange={(event) => onThemeFormChange((current) => ({ ...current, memo: event.target.value }))} /></label>
                <ThemeCodeSelector codes={project.codes} selectedCodeIds={themeForm.codeIds} onToggle={onToggleThemeCode} disabled={busy || !canEditProject} resetKey={selectedTheme.theme_id} />
              </div>
              <div className="codes-catalog-editor-actions sticky"><button type="button" className="primary-button" onClick={onSaveTheme} disabled={busy || !themeFormDirty || !themeForm.name.trim() || duplicateThemeName}>Save Theme</button><button type="button" className="secondary-button" onClick={onCancelTheme} disabled={busy || !themeFormDirty}>Cancel</button></div>
            </>
          ) : null}

          {(activeView === "codes" && !selectedCode) || (activeView === "themes" && !selectedTheme) ? (
            <div className="empty-state compact-empty-state">
              <strong>{catalogIsEmpty ? (activeView === "codes" ? "Create Your First Code" : "Create Your First Theme") : (activeView === "codes" ? "Select a Code" : "Select a Theme")}</strong>
              <p>{catalogIsEmpty ? (activeView === "codes" ? "Codes organize recurring ideas across evidence passages." : "Themes bring related codes together into broader analytical patterns.") : "Choose an item from the catalog or create a new one."}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
