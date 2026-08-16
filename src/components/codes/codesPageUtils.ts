import type {
  CodesAiDecisionInput,
  CodesCode,
  CodesEvidenceItem,
  CodesEvidenceSegmentRange,
  CodesProvisionalCodeInput,
  CodesTheme
} from "../../lib/api";
import { fileName } from "../../lib/codesProjectPaths";

export type ProvisionalEvidenceCode = {
  clientId: string;
  name: string;
  color: string;
  description: string;
  inclusionNote: string;
  exclusionNote: string;
  exampleEvidenceIds: string[];
  memo: string;
  aiDecisions: CodesAiDecisionInput[];
  useCurrentEvidenceAsExample: boolean;
};

export type EvidenceDraft = {
  transcriptId: string;
  segmentIds: string[];
  selectedText: string;
  segmentRanges: Record<string, CodesEvidenceSegmentRange>;
  codeIds: string[];
  newCodes: ProvisionalEvidenceCode[];
  memo: string;
  aiDecisions: CodesAiDecisionInput[];
};

export type EvidenceEditDraft = {
  evidenceId: string;
  codeIds: string[];
  newCodes: ProvisionalEvidenceCode[];
  memo: string;
  aiDecisions: CodesAiDecisionInput[];
};

export function provisionalCodeInput(code: ProvisionalEvidenceCode): CodesProvisionalCodeInput {
  return {
    client_id: code.clientId,
    name: code.name,
    color: code.color,
    description: code.description,
    inclusion_note: code.inclusionNote,
    exclusion_note: code.exclusionNote,
    example_evidence_ids: [...code.exampleEvidenceIds],
    memo: code.memo,
    use_current_evidence_as_example: code.useCurrentEvidenceAsExample
  };
}

export function evidenceEditDraftFromEvidence(evidence: CodesEvidenceItem): EvidenceEditDraft {
  return {
    evidenceId: evidence.evidence_id,
    codeIds: [...evidence.code_ids],
    newCodes: [],
    memo: evidence.memo,
    aiDecisions: []
  };
}

export function evidenceEditDraftHasChanges(
  draft: EvidenceEditDraft | null,
  evidence: CodesEvidenceItem | null
) {
  if (!draft || !evidence || draft.evidenceId !== evidence.evidence_id) return false;
  return draft.memo !== evidence.memo
    || draft.newCodes.length > 0
    || draft.aiDecisions.length > 0
    || draft.codeIds.length !== evidence.code_ids.length
    || draft.codeIds.some((codeId, index) => codeId !== evidence.code_ids[index]);
}

export type EvidenceDraftSelection = Pick<
  EvidenceDraft,
  "transcriptId" | "segmentIds" | "selectedText" | "segmentRanges"
>;

export function replaceEvidenceDraftSelection(
  current: EvidenceDraft | null,
  selection: EvidenceDraftSelection
): EvidenceDraft {
  if (!current) {
    return {
      ...selection,
      codeIds: [],
      newCodes: [],
      memo: "",
      aiDecisions: []
    };
  }
  return {
    ...current,
    ...selection
  };
}

export type CodeForm = {
  codeId: string | null;
  name: string;
  description: string;
  inclusionNote: string;
  exclusionNote: string;
  exampleEvidenceIds: string[];
  color: string;
  memo: string;
  aiDecisions: CodesAiDecisionInput[];
};

export type ThemeForm = {
  themeId: string | null;
  name: string;
  description: string;
  color: string;
  codeIds: string[];
  memo: string;
  aiDecisions: CodesAiDecisionInput[];
};

export const emptyCodeForm: CodeForm = {
  codeId: null,
  name: "",
  description: "",
  inclusionNote: "",
  exclusionNote: "",
  exampleEvidenceIds: [],
  color: "#0f766e",
  memo: "",
  aiDecisions: []
};

export const emptyThemeForm: ThemeForm = {
  themeId: null,
  name: "",
  description: "",
  color: "#164e63",
  codeIds: [],
  memo: "",
  aiDecisions: []
};

export function areOrderedIdArraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function codeFormHasChanges(form: CodeForm, saved: CodesCode | null) {
  if (!form.codeId) {
    return Boolean(
      form.name.trim() || form.description.trim() || form.inclusionNote.trim() || form.exclusionNote.trim()
      || form.exampleEvidenceIds.length || form.memo.trim() || form.color !== emptyCodeForm.color || form.aiDecisions.length
    );
  }
  return !saved
    || form.name !== saved.name
    || form.description !== saved.description
    || form.inclusionNote !== saved.inclusion_note
    || form.exclusionNote !== saved.exclusion_note
    || !areOrderedIdArraysEqual(form.exampleEvidenceIds, saved.example_evidence_ids)
    || form.color !== saved.color
    || form.memo !== saved.memo
    || form.aiDecisions.length > 0;
}

export function themeFormHasChanges(form: ThemeForm, saved: CodesTheme | null) {
  if (!form.themeId) {
    return Boolean(
      form.name.trim() || form.description.trim() || form.codeIds.length || form.memo.trim()
      || form.color !== emptyThemeForm.color || form.aiDecisions.length
    );
  }
  return !saved
    || form.name !== saved.name
    || form.description !== saved.description
    || !areOrderedIdArraysEqual(form.codeIds, saved.code_ids)
    || form.color !== saved.color
    || form.memo !== saved.memo
    || form.aiDecisions.length > 0;
}

export function codeFormFromCode(code: CodesCode): CodeForm {
  return {
    codeId: code.code_id,
    name: code.name,
    description: code.description,
    inclusionNote: code.inclusion_note,
    exclusionNote: code.exclusion_note,
    exampleEvidenceIds: code.example_evidence_ids,
    color: code.color,
    memo: code.memo,
    aiDecisions: []
  };
}

export function themeFormFromTheme(theme: CodesTheme): ThemeForm {
  return {
    themeId: theme.theme_id,
    name: theme.name,
    description: theme.description,
    color: theme.color,
    codeIds: theme.code_ids,
    memo: theme.memo,
    aiDecisions: []
  };
}

export function exportBaseName(path: string) {
  return fileName(path).replace(/\.(xlsx|csv|json|docx)$/i, "");
}

export function timestampLabel(value: number | null) {
  if (value === null) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function timestampRangeLabel(start: number | null, end: number | null) {
  const startLabel = timestampLabel(start);
  const endLabel = timestampLabel(end);
  if (startLabel && endLabel) {
    return `${startLabel} - ${endLabel}`;
  }
  return startLabel || endLabel || "No timestamp";
}

export function evidenceLabel(evidence: CodesEvidenceItem) {
  return `${evidence.evidence_id} - ${timestampRangeLabel(evidence.start, evidence.end)}`;
}

export function codeLabel(code: CodesCode) {
  return `${code.code_id} - ${code.name}`;
}

export function themeLabel(theme: CodesTheme) {
  return `${theme.theme_id} - ${theme.name}`;
}
