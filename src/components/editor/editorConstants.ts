export const DEFAULT_SEGMENTS_PER_PAGE = 5;
export const SEGMENTS_PER_PAGE_OPTIONS = [5, 10, 15, 20, 25];
export const MAX_HISTORY_STATES = 50;

export const EDITOR_EXPORT_FORMATS = [
  { value: "xlsx", label: "XLSX" },
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "docx", label: "DOCX" }
];

export const EDITOR_FIELD_HELP_TEXT = {
  transcript:
    "Required. Choose an existing transcript export or a saved editor working copy. JSON, CSV, XLSX, and app-generated DOCX files are supported.",
  media:
    "Optional. Choose the matching audio or video file only if you want to play from segment timestamps while correcting the transcript.",
  edit:
    "Open the selected transcript in a focused editing workspace. The editor works on one transcript at a time.",
  output:
    "Choose the export formats, then use Export Transcript to select the filename and location in one Save As dialog. All selected formats use the same base filename.",
  exportFormats:
    "Choose the edited transcript formats to create. The Save As filename becomes the shared name for every selected format.",
  editingCopy:
    "Editing copies are JSON working files for reopening in this app. Use Export Transcript to create XLSX, CSV, JSON, or DOCX outputs for use elsewhere.",
  save:
    "Save the current editable JSON copy for reopening in this app. This does not create transcript outputs. You can also use Ctrl+S or Cmd+S.",
  saveAs:
    "Choose a location for a new editable JSON copy and make it the active save file. This does not create transcript outputs.",
  resetChanges:
    "Restore the last saved editing copy, or the originally loaded transcript if it has not been saved yet.",
  closeEditor:
    "Return to the Editor setup and output view. The loaded transcript and unsaved work remain in memory."
} as const;
