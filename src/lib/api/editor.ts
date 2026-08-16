import { API_TIMEOUTS, requestJson, type PreparedExport } from "./core";

export type EditorSpeaker = {
  id: string;
  name: string;
};

export type EditorSegment = {
  id: string;
  start: number | null;
  end: number | null;
  speaker: string;
  text: string;
};

export type EditorValidationIssue = {
  level: "error" | "warning" | string;
  segment_id: string | null;
  message: string;
};

export type EditorTranscript = {
  schema_version?: string;
  source_transcript_file: string;
  source_document_id: string;
  media_file: string;
  language: string;
  speakers: EditorSpeaker[];
  segments: EditorSegment[];
  metadata: Record<string, unknown>;
  validation_issues?: EditorValidationIssue[];
};

export type EditorDocumentChoice = {
  id: string;
  label: string;
  file_name: string;
  segment_count: number;
  duration: number | null;
};

export type EditorInspectResult = {
  transcript_file: string;
  format: string;
  documents: EditorDocumentChoice[];
  requires_document_selection: boolean;
};

export type EditorExportResult = {
  output_files: PreparedExport[];
  validation_issues: EditorValidationIssue[];
};

export async function inspectEditorTranscript(transcriptFile: string): Promise<EditorInspectResult> {
  return await requestJson<EditorInspectResult>("/api/v1/editor/inspect-transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ transcript_file: transcriptFile }),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Inspect transcript"
  });
}

export async function loadEditorTranscript(
  transcriptFile: string,
  documentId?: string
): Promise<EditorTranscript> {
  return await requestJson<EditorTranscript>("/api/v1/editor/load-transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transcript_file: transcriptFile,
      document_id: documentId ?? null
    }),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Load transcript"
  });
}

export async function saveEditorTranscript(
  outputFile: string,
  transcript: EditorTranscript
): Promise<{ output_file: string; validation_issues: EditorValidationIssue[] }> {
  return await requestJson<{ output_file: string; validation_issues: EditorValidationIssue[] }>("/api/v1/editor/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ output_file: outputFile, transcript }),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Save transcript"
  });
}

export async function exportEditorTranscript(payload: {
  transcript: EditorTranscript;
  output_folder: string;
  output_name: string;
  export_formats: string[];
  transcript_layout: string;
}): Promise<EditorExportResult> {
  return await requestJson<EditorExportResult>("/api/v1/editor/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    timeoutMs: API_TIMEOUTS.scan,
    operation: "Export transcript"
  });
}
