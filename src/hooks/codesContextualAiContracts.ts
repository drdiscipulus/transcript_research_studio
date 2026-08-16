import type { CodeDialogValue, CodesCodeDialogTarget } from "../components/codes/CodesCodeDialog";
import type {
  CodeForm,
  EvidenceDraft,
  EvidenceEditDraft,
  ThemeForm
} from "../components/codes/codesPageUtils";
import type {
  CodesAiDecisionInput,
  CodesEvidenceItem,
  CodesProject,
  CodesAiRunTask
} from "../lib/api";

export type ContextualAiRunRequest = {
  task: CodesAiRunTask;
  researcherPrompt: string;
  maximumSuggestions?: number;
  scope?: Record<string, unknown>;
  transcriptId?: string;
  segmentIds?: string[];
  evidenceId?: string;
  selectedText?: string;
  codeIds?: string[];
  codeId?: string;
  themeId?: string;
  selectedCodeIds?: string[];
  codeDraft?: Record<string, unknown>;
  themeDraft?: Record<string, unknown>;
  inspectorTargetKey?: string;
  codeDialogTarget?: CodesCodeDialogTarget;
};

export type CodesEvidenceWorkspaceBridge = {
  evidenceDraft: EvidenceDraft | null;
  evidenceEditDraft: EvidenceEditDraft | null;
  selectedEvidence: CodesEvidenceItem | null;
  navigateToTranscript: (transcriptId: string) => boolean;
  acceptPersistedEvidence: (evidence: CodesEvidenceItem) => void;
  stageExistingCode: (codeId: string, decision?: CodesAiDecisionInput) => boolean;
  applyAiNote: (
    note: string,
    mode: "use" | "replace" | "append",
    decision: CodesAiDecisionInput
  ) => boolean;
  addInspectorCode: (value: CodeDialogValue) => string;
};

export type CodesCodebookWorkspaceBridge = {
  currentCodeTargetId: () => string | null;
  currentThemeTargetId: () => string | null;
  tryUpdateCodeForm: (expectedCodeId: string, updater: (current: CodeForm) => CodeForm) => boolean;
  tryUpdateThemeForm: (expectedThemeId: string, updater: (current: ThemeForm) => ThemeForm) => boolean;
  tryOpenNewTheme: (initialValue?: ThemeForm | null) => boolean;
};

export function codesProjectSessionIdentity(project: CodesProject | null, projectFile: string | null) {
  return project && projectFile ? `${project.project_id}\u0000${projectFile}` : "";
}
