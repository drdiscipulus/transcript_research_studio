import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CodesCode } from "../../lib/api";

type ThemeCodeSelectorProps = {
  codes: CodesCode[];
  selectedCodeIds: string[];
  onToggle: (codeId: string) => void;
  disabled?: boolean;
  resetKey?: string;
};

export function ThemeCodeSelector({ codes, selectedCodeIds, onToggle, disabled = false, resetKey = "" }: ThemeCodeSelectorProps) {
  const inputId = useId();
  const listboxId = `${inputId}-results`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const browseRef = useRef<HTMLDetailsElement | null>(null);
  const [search, setSearch] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedIds = useMemo(() => new Set(selectedCodeIds), [selectedCodeIds]);
  const assignedCodes = useMemo(() => codes.filter((code) => selectedIds.has(code.code_id)), [codes, selectedIds]);
  const availableCodes = useMemo(() => codes.filter((code) => !selectedIds.has(code.code_id)), [codes, selectedIds]);
  const matchingCodes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return availableCodes.filter((code) => !query
      || code.name.toLocaleLowerCase().includes(query)
      || code.description.toLocaleLowerCase().includes(query)
      || code.code_id.toLocaleLowerCase().includes(query));
  }, [availableCodes, search]);

  useEffect(() => {
    setSearch("");
    setResultsOpen(false);
    setActiveIndex(0);
    if (browseRef.current) browseRef.current.open = false;
  }, [resetKey]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, matchingCodes.length - 1)));
  }, [matchingCodes.length]);

  function assignCode(code: CodesCode) {
    if (disabled || selectedIds.has(code.code_id)) return;
    onToggle(code.code_id);
    setSearch("");
    setActiveIndex(0);
    setResultsOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setResultsOpen(true);
      setActiveIndex((current) => matchingCodes.length ? (current + 1) % matchingCodes.length : 0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setResultsOpen(true);
      setActiveIndex((current) => matchingCodes.length ? (current - 1 + matchingCodes.length) % matchingCodes.length : 0);
      return;
    }
    if (event.key === "Enter" && resultsOpen && matchingCodes[activeIndex]) {
      event.preventDefault();
      assignCode(matchingCodes[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setResultsOpen(false);
    }
  }

  const emptyResult = !availableCodes.length ? "All Codes Assigned" : "No Matching Codes";

  return (
    <div className="codes-theme-code-selector">
      <span className="field-label">Codes ({assignedCodes.length})</span>
      {assignedCodes.length ? (
        <div className="codes-assigned-code-list" aria-label="Assigned Theme Codes">
          {assignedCodes.map((code) => (
            <span key={code.code_id} className="codes-assigned-code-chip" title={code.name}>
              <span className="codes-color-dot" aria-hidden="true" style={{ backgroundColor: code.color }} />
              <span className="codes-theme-code-chip-name">{code.name}</span>
              <button type="button" onClick={() => onToggle(code.code_id)} disabled={disabled} aria-label={`Remove ${code.name} from theme`} title="Remove Assignment">×</button>
            </span>
          ))}
        </div>
      ) : <span className="editor-muted">No Codes Assigned</span>}

      <div
        className="codes-theme-code-combobox"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setResultsOpen(false);
        }}
      >
        <label className="field-label" htmlFor={inputId}>Assign Codes</label>
        <input
          ref={inputRef}
          id={inputId}
          className="text-input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={resultsOpen}
          aria-activedescendant={resultsOpen && matchingCodes[activeIndex] ? `${listboxId}-${matchingCodes[activeIndex].code_id}` : undefined}
          value={search}
          placeholder="Search by code name or definition"
          disabled={disabled || !codes.length}
          onFocus={() => setResultsOpen(true)}
          onChange={(event) => { setSearch(event.target.value); setActiveIndex(0); setResultsOpen(true); }}
          onKeyDown={handleSearchKeyDown}
        />
        {resultsOpen ? (
          <div id={listboxId} className="codes-theme-code-results" role="listbox" aria-label="Available Theme Codes">
            {matchingCodes.map((code, index) => (
              <button
                id={`${listboxId}-${code.code_id}`}
                key={code.code_id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : undefined}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => assignCode(code)}
              >
                <span className="codes-color-dot" aria-hidden="true" style={{ backgroundColor: code.color }} />
                <span><strong>{code.name}</strong><small>{code.description || code.code_id}</small></span>
                <span>Assign</span>
              </button>
            ))}
            {!matchingCodes.length ? <div className="codes-theme-code-empty">{emptyResult}</div> : null}
          </div>
        ) : null}
      </div>

      <details ref={browseRef} className="codes-theme-code-browser">
        <summary>Browse All Codes</summary>
        {codes.length ? (
          <div className="codes-theme-code-grid">
            {codes.map((code) => (
              <label key={code.code_id} title={code.name}>
                <input type="checkbox" checked={selectedIds.has(code.code_id)} disabled={disabled} onChange={() => onToggle(code.code_id)} />
                <span className="codes-color-dot" aria-hidden="true" style={{ backgroundColor: code.color }} />
                <span className="codes-theme-code-grid-name">{code.name}</span>
              </label>
            ))}
          </div>
        ) : <div className="codes-theme-code-empty">No Codes Available</div>}
      </details>
    </div>
  );
}
