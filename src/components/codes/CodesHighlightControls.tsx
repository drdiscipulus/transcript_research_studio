import { useEffect, useMemo, useRef, useState } from "react";
import type { CodesCode, CodesTheme } from "../../lib/api";

export type CodesHighlightSettings = {
  show: boolean;
  evidence: boolean;
  codes: boolean;
  themes: boolean;
  codeScope: "all" | "selected";
  themeScope: "all" | "selected";
  selectedCodeIds: string[];
  selectedThemeIds: string[];
};

export const defaultCodesHighlightSettings: CodesHighlightSettings = {
  show: false,
  evidence: true,
  codes: false,
  themes: false,
  codeScope: "all",
  themeScope: "all",
  selectedCodeIds: [],
  selectedThemeIds: []
};

export function pruneCodesHighlightSettings(
  settings: CodesHighlightSettings,
  codeIds: readonly string[],
  themeIds: readonly string[]
): CodesHighlightSettings {
  const validCodeIds = new Set(codeIds);
  const validThemeIds = new Set(themeIds);
  const selectedCodeIds = settings.selectedCodeIds.filter((id) => validCodeIds.has(id));
  const selectedThemeIds = settings.selectedThemeIds.filter((id) => validThemeIds.has(id));
  const codesUnchanged = selectedCodeIds.length === settings.selectedCodeIds.length
    && selectedCodeIds.every((id, index) => id === settings.selectedCodeIds[index]);
  const themesUnchanged = selectedThemeIds.length === settings.selectedThemeIds.length
    && selectedThemeIds.every((id, index) => id === settings.selectedThemeIds[index]);
  return codesUnchanged && themesUnchanged
    ? settings
    : { ...settings, selectedCodeIds, selectedThemeIds };
}

type CodesHighlightControlsProps = {
  codes: CodesCode[];
  themes: CodesTheme[];
  settings: CodesHighlightSettings;
  onChange: (settings: CodesHighlightSettings) => void;
};

export function CodesHighlightControls({ codes, themes, settings, onChange }: CodesHighlightControlsProps) {
  const [open, setOpen] = useState(false);
  const [codeSearch, setCodeSearch] = useState("");
  const [themeSearch, setThemeSearch] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filteredCodes = useMemo(() => {
    const query = codeSearch.trim().toLocaleLowerCase();
    return query ? codes.filter((code) => code.name.toLocaleLowerCase().includes(query)) : codes;
  }, [codeSearch, codes]);
  const filteredThemes = useMemo(() => {
    const query = themeSearch.trim().toLocaleLowerCase();
    return query ? themes.filter((theme) => theme.name.toLocaleLowerCase().includes(query)) : themes;
  }, [themeSearch, themes]);

  function update(changes: Partial<CodesHighlightSettings>) {
    onChange({ ...settings, ...changes });
  }

  function toggleId(kind: "code" | "theme", id: string) {
    const key = kind === "code" ? "selectedCodeIds" : "selectedThemeIds";
    const current = settings[key];
    update({ [key]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  }

  function closePopover(returnFocus = false) {
    setOpen(false);
    if (returnFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover(true);
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closePopover();
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  return (
    <div className={`codes-highlight-menu${open ? " open" : ""}`} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="secondary-button compact codes-highlight-trigger"
        aria-label="Highlight Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="codes-highlight-popover"
        onClick={() => setOpen((current) => !current)}
      >
        Highlights{settings.show ? " On" : ""}
      </button>
      {open ? <div id="codes-highlight-popover" className="codes-highlight-popover" role="dialog" aria-label="Highlight Settings">
        <div className="codes-highlight-popover-header">
          <strong>Highlight Settings</strong>
          <button type="button" className="secondary-button compact" onClick={() => closePopover(true)}>Close</button>
        </div>
        <label className="codes-highlight-master">
          <input type="checkbox" checked={settings.show} onChange={(event) => update({ show: event.target.checked })} />
          <strong>Show Highlights</strong>
        </label>

        <fieldset className="codes-highlight-group">
          <legend>
            <label><input type="checkbox" checked={settings.evidence} onChange={(event) => update({ evidence: event.target.checked })} /> Evidence</label>
          </legend>
          <span className="codes-highlight-help">Show every saved evidence passage in the active transcript.</span>
        </fieldset>

        <fieldset className="codes-highlight-group">
          <legend>
            <label><input type="checkbox" checked={settings.codes} onChange={(event) => update({ codes: event.target.checked })} /> Codes</label>
          </legend>
          <div className="codes-highlight-scope" role="radiogroup" aria-label="Code Highlight Scope">
            <label><input type="radio" name="code-highlight-scope" checked={settings.codeScope === "all"} onChange={() => update({ codeScope: "all" })} /> All</label>
            <label><input type="radio" name="code-highlight-scope" checked={settings.codeScope === "selected"} onChange={() => update({ codeScope: "selected" })} /> Selected</label>
          </div>
          {settings.codeScope === "selected" ? (
            <>
              <input className="text-input compact" aria-label="Search Highlight Codes" placeholder="Search codes" value={codeSearch} onChange={(event) => setCodeSearch(event.target.value)} />
              <div className="codes-highlight-checklist">
                {filteredCodes.map((code) => (
                  <label key={code.code_id}>
                    <input type="checkbox" checked={settings.selectedCodeIds.includes(code.code_id)} onChange={() => toggleId("code", code.code_id)} />
                    <span className="codes-highlight-swatch" style={{ backgroundColor: code.color }} aria-hidden="true" />
                    <span>{code.name}</span>
                  </label>
                ))}
                {!filteredCodes.length ? <span className="muted-text">No codes found.</span> : null}
              </div>
              <button type="button" className="link-button compact" disabled={!settings.selectedCodeIds.length} onClick={() => update({ selectedCodeIds: [] })}>Clear Code Selection</button>
            </>
          ) : null}
        </fieldset>

        <fieldset className="codes-highlight-group">
          <legend>
            <label><input type="checkbox" checked={settings.themes} onChange={(event) => update({ themes: event.target.checked })} /> Themes</label>
          </legend>
          <div className="codes-highlight-scope" role="radiogroup" aria-label="Theme Highlight Scope">
            <label><input type="radio" name="theme-highlight-scope" checked={settings.themeScope === "all"} onChange={() => update({ themeScope: "all" })} /> All</label>
            <label><input type="radio" name="theme-highlight-scope" checked={settings.themeScope === "selected"} onChange={() => update({ themeScope: "selected" })} /> Selected</label>
          </div>
          {settings.themeScope === "selected" ? (
            <>
              <input className="text-input compact" aria-label="Search Highlight Themes" placeholder="Search themes" value={themeSearch} onChange={(event) => setThemeSearch(event.target.value)} />
              <div className="codes-highlight-checklist">
                {filteredThemes.map((theme) => (
                  <label key={theme.theme_id}>
                    <input type="checkbox" checked={settings.selectedThemeIds.includes(theme.theme_id)} onChange={() => toggleId("theme", theme.theme_id)} />
                    <span className="codes-highlight-swatch" style={{ backgroundColor: theme.color }} aria-hidden="true" />
                    <span>{theme.name}</span>
                  </label>
                ))}
                {!filteredThemes.length ? <span className="muted-text">No themes found.</span> : null}
              </div>
              <button type="button" className="link-button compact" disabled={!settings.selectedThemeIds.length} onClick={() => update({ selectedThemeIds: [] })}>Clear Theme Selection</button>
            </>
          ) : null}
        </fieldset>

        <div className="codes-highlight-legend" aria-label="Highlight Legend">
          <span><i className="evidence" /> Evidence</span>
          <span><i className="code" /> Code ribbon</span>
          <span><i className="theme" /> Theme ribbon</span>
        </div>
      </div> : null}
    </div>
  );
}
