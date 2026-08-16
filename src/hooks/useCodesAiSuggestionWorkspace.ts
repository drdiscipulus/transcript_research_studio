import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CodeDialogValue,
  CodesCodeDialogTarget
} from "../components/codes/CodesCodeDialog";
import { emptyThemeForm } from "../components/codes/codesPageUtils";
import type {
  CodesAiCodeDetailsSuggestion,
  CodesAiCodeSuggestion,
  CodesAiDecisionInput,
  CodesAiEvidenceSuggestion,
  CodesAiNoteSuggestion,
  CodesAiRunSnapshot,
  CodesAiRunTask,
  CodesAiThemeSuggestion,
  CodesProject
} from "../lib/api";
import type {
  CodesAiEvidenceAcceptance,
  CodesAiSuggestionRejection
} from "./useCodesAiDecisionLifecycle";
import {
  codesProjectSessionIdentity,
  type CodesCodebookWorkspaceBridge,
  type CodesEvidenceWorkspaceBridge,
  type ContextualAiRunRequest
} from "./codesContextualAiContracts";
import type { CodesProjectSessionSnapshot } from "./useCodesProjectSession";

type CodesAiSuggestionWorkspaceOptions = {
  project: CodesProject | null;
  projectFile: string | null;
  getCurrentSession: () => CodesProjectSessionSnapshot;
  getEvidenceWorkspace: () => CodesEvidenceWorkspaceBridge | null;
  getCodebookWorkspace: () => CodesCodebookWorkspaceBridge | null;
  isRunLocked: () => boolean;
  isExternallyLocked: () => boolean;
  clearTaskFeedback: (task: CodesAiRunTask, suggestionId?: string) => void;
  clearDecisionError: (task: CodesAiRunTask, suggestionId?: string) => void;
  onStatusMessage: (message: string) => void;
};

function sameCodeDialogTarget(
  left: CodesCodeDialogTarget | null | undefined,
  right: CodesCodeDialogTarget | null | undefined
) {
  return Boolean(
    left
    && right
    && left.surface === right.surface
    && left.instanceId === right.instanceId
  );
}

function cloneDecision(decision: CodesAiDecisionInput): CodesAiDecisionInput {
  return {
    ...decision,
    result_ids: decision.result_ids ? [...decision.result_ids] : undefined
  };
}

export function useCodesAiSuggestionWorkspace(options: CodesAiSuggestionWorkspaceOptions) {
  const [evidenceSuggestions, setEvidenceSuggestions] = useState<CodesAiEvidenceSuggestion[]>([]);
  const [selectedEvidenceSuggestionId, setSelectedEvidenceSuggestionId] = useState("");
  const [codeSuggestions, setCodeSuggestions] = useState<CodesAiCodeSuggestion[]>([]);
  const [noteSuggestion, setNoteSuggestion] = useState<CodesAiNoteSuggestion | null>(null);
  const [resultRunIds, setResultRunIds] = useState<Partial<Record<CodesAiRunTask, string>>>({});
  const [codeDetailsSuggestion, setCodeDetailsSuggestion] = useState<CodesAiCodeDetailsSuggestion | null>(null);
  const [codeDetailsSuggestionTarget, setCodeDetailsSuggestionTarget] = useState<CodesCodeDialogTarget | null>(null);
  const [codeRefinementSuggestion, setCodeRefinementSuggestion] = useState<CodesAiCodeDetailsSuggestion | null>(null);
  const [themeSuggestions, setThemeSuggestions] = useState<CodesAiThemeSuggestion[]>([]);
  const [themeRefinementSuggestion, setThemeRefinementSuggestion] = useState<CodesAiThemeSuggestion | null>(null);
  const [themeScope, setThemeScopeState] = useState<"all" | "selected">("all");
  const [themeSelectedCodeIds, setThemeSelectedCodeIds] = useState<string[]>([]);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const currentIdentity = codesProjectSessionIdentity(options.project, options.projectFile);
  const identityRef = useRef(currentIdentity);
  const evidenceSuggestionsRef = useRef<CodesAiEvidenceSuggestion[]>([]);
  const selectedEvidenceSuggestionIdRef = useRef("");
  const codeSuggestionsRef = useRef<CodesAiCodeSuggestion[]>([]);
  const noteSuggestionRef = useRef<CodesAiNoteSuggestion | null>(null);
  const resultRunIdsRef = useRef<Partial<Record<CodesAiRunTask, string>>>({});
  const codeDetailsSuggestionRef = useRef<CodesAiCodeDetailsSuggestion | null>(null);
  const codeDetailsSuggestionTargetRef = useRef<CodesCodeDialogTarget | null>(null);
  const codeRefinementSuggestionRef = useRef<CodesAiCodeDetailsSuggestion | null>(null);
  const codeRefinementTargetIdRef = useRef("");
  const themeSuggestionsRef = useRef<CodesAiThemeSuggestion[]>([]);
  const themeRefinementSuggestionRef = useRef<CodesAiThemeSuggestion | null>(null);
  const themeRefinementTargetIdRef = useRef("");
  const inspectorTargetKeyRef = useRef("");
  const activeCodeDialogTargetsRef = useRef<Partial<Record<CodesCodeDialogTarget["surface"], string>>>({});
  const activeCodeTargetIdRef = useRef("");
  const activeThemeTargetIdRef = useRef("");
  const themeScopeRef = useRef<"all" | "selected">("all");
  const themeSelectedCodeIdsRef = useRef<string[]>([]);

  if (identityRef.current !== currentIdentity) {
    identityRef.current = currentIdentity;
    evidenceSuggestionsRef.current = [];
    selectedEvidenceSuggestionIdRef.current = "";
    codeSuggestionsRef.current = [];
    noteSuggestionRef.current = null;
    resultRunIdsRef.current = {};
    codeDetailsSuggestionRef.current = null;
    codeDetailsSuggestionTargetRef.current = null;
    codeRefinementSuggestionRef.current = null;
    codeRefinementTargetIdRef.current = "";
    themeSuggestionsRef.current = [];
    themeRefinementSuggestionRef.current = null;
    themeRefinementTargetIdRef.current = "";
    inspectorTargetKeyRef.current = "";
    activeCodeDialogTargetsRef.current = {};
    activeCodeTargetIdRef.current = "";
    activeThemeTargetIdRef.current = "";
    themeScopeRef.current = "all";
    themeSelectedCodeIdsRef.current = [];
  }

  const replaceEvidenceSuggestions = useCallback((suggestions: CodesAiEvidenceSuggestion[]) => {
    evidenceSuggestionsRef.current = suggestions;
    setEvidenceSuggestions(suggestions);
  }, []);
  const replaceSelectedEvidenceSuggestionId = useCallback((suggestionId: string) => {
    selectedEvidenceSuggestionIdRef.current = suggestionId;
    setSelectedEvidenceSuggestionId(suggestionId);
  }, []);
  const replaceCodeSuggestions = useCallback((suggestions: CodesAiCodeSuggestion[]) => {
    codeSuggestionsRef.current = suggestions;
    setCodeSuggestions(suggestions);
  }, []);
  const replaceNoteSuggestion = useCallback((suggestion: CodesAiNoteSuggestion | null) => {
    noteSuggestionRef.current = suggestion;
    setNoteSuggestion(suggestion);
  }, []);
  const replaceCodeDetailsSuggestion = useCallback((
    suggestion: CodesAiCodeDetailsSuggestion | null,
    target: CodesCodeDialogTarget | null = null
  ) => {
    codeDetailsSuggestionRef.current = suggestion;
    codeDetailsSuggestionTargetRef.current = suggestion && target ? { ...target } : null;
    setCodeDetailsSuggestion(suggestion);
    setCodeDetailsSuggestionTarget(suggestion && target ? { ...target } : null);
  }, []);
  const replaceCodeRefinementSuggestion = useCallback((suggestion: CodesAiCodeDetailsSuggestion | null, targetId = "") => {
    codeRefinementSuggestionRef.current = suggestion;
    codeRefinementTargetIdRef.current = suggestion ? targetId : "";
    setCodeRefinementSuggestion(suggestion);
  }, []);
  const replaceThemeSuggestions = useCallback((suggestions: CodesAiThemeSuggestion[]) => {
    themeSuggestionsRef.current = suggestions;
    setThemeSuggestions(suggestions);
  }, []);
  const replaceThemeRefinementSuggestion = useCallback((suggestion: CodesAiThemeSuggestion | null, targetId = "") => {
    themeRefinementSuggestionRef.current = suggestion;
    themeRefinementTargetIdRef.current = suggestion ? targetId : "";
    setThemeRefinementSuggestion(suggestion);
  }, []);

  const currentInspectorTargetKey = useCallback(() => {
    const project = optionsRef.current.getCurrentSession().project;
    const workspace = optionsRef.current.getEvidenceWorkspace();
    if (!project || !workspace) return "";
    if (workspace.evidenceDraft) {
      return project.transcripts.some((item) => item.transcript_id === workspace.evidenceDraft?.transcriptId)
        ? `draft:${workspace.evidenceDraft.transcriptId}:${workspace.evidenceDraft.segmentIds.join(",")}`
        : "";
    }
    if (workspace.selectedEvidence) {
      return project.evidence_items.some((item) => item.evidence_id === workspace.selectedEvidence?.evidence_id)
        ? `evidence:${workspace.selectedEvidence.evidence_id}`
        : "";
    }
    return "";
  }, []);

  const requestTargetIsCurrent = useCallback((request: ContextualAiRunRequest) => {
    const project = optionsRef.current.getCurrentSession().project;
    if (!project) return false;
    if (request.task === "codes" || request.task === "note") {
      return Boolean(
        request.inspectorTargetKey
        && request.inspectorTargetKey === inspectorTargetKeyRef.current
        && request.inspectorTargetKey === currentInspectorTargetKey()
      );
    }
    if (request.task === "code_details") {
      const target = request.codeDialogTarget;
      return Boolean(target && activeCodeDialogTargetsRef.current[target.surface] === target.instanceId);
    }
    if (request.task === "code_refinement") {
      const codeId = request.codeId ?? "";
      return Boolean(
        codeId
        && project.codes.some((code) => code.code_id === codeId)
        && optionsRef.current.getCodebookWorkspace()?.currentCodeTargetId() === codeId
      );
    }
    if (request.task === "theme_refinement") {
      const themeId = request.themeId ?? "";
      return Boolean(
        themeId
        && project.themes.some((theme) => theme.theme_id === themeId)
        && optionsRef.current.getCodebookWorkspace()?.currentThemeTargetId() === themeId
      );
    }
    return true;
  }, [currentInspectorTargetKey]);

  const registerRunId = useCallback((task: CodesAiRunTask, runId: string) => {
    const next = { ...resultRunIdsRef.current, [task]: runId };
    resultRunIdsRef.current = next;
    setResultRunIds(next);
  }, []);

  const routeCompletedRun = useCallback((snapshot: CodesAiRunSnapshot, request: ContextualAiRunRequest) => {
    if (!requestTargetIsCurrent(request)) return false;
    registerRunId(snapshot.task, snapshot.run_id);
    optionsRef.current.clearDecisionError(snapshot.task);
    if (snapshot.task === "evidence") {
      const suggestions = snapshot.results.filter((item): item is CodesAiEvidenceSuggestion => item.kind === "evidence");
      replaceEvidenceSuggestions(suggestions);
      replaceSelectedEvidenceSuggestionId(suggestions[0]?.suggestion_id ?? "");
    } else if (snapshot.task === "codes") {
      replaceCodeSuggestions(snapshot.results.filter((item): item is CodesAiCodeSuggestion => (
        item.kind === "existing_code" || item.kind === "new_code"
      )));
    } else if (snapshot.task === "note") {
      replaceNoteSuggestion(snapshot.results.find((item): item is CodesAiNoteSuggestion => item.kind === "note") ?? null);
    } else if (snapshot.task === "code_details") {
      replaceCodeDetailsSuggestion(
        snapshot.results.find((item): item is CodesAiCodeDetailsSuggestion => item.kind === "code_details") ?? null,
        request.codeDialogTarget ?? null
      );
    } else if (snapshot.task === "code_refinement") {
      const suggestion = snapshot.results.find((item): item is CodesAiCodeDetailsSuggestion => (
        item.kind === "code_refinement" && item.code_id === request.codeId
      )) ?? null;
      replaceCodeRefinementSuggestion(suggestion, request.codeId ?? "");
    } else if (snapshot.task === "theme_suggestions") {
      replaceThemeSuggestions(snapshot.results.filter((item): item is CodesAiThemeSuggestion => item.kind === "theme_suggestion"));
    } else if (snapshot.task === "theme_refinement") {
      const suggestion = snapshot.results.find((item): item is CodesAiThemeSuggestion => (
        item.kind === "theme_refinement" && item.theme_id === request.themeId
      )) ?? null;
      replaceThemeRefinementSuggestion(suggestion, request.themeId ?? "");
    }
    return true;
  }, [
    registerRunId,
    replaceCodeDetailsSuggestion,
    replaceCodeRefinementSuggestion,
    replaceCodeSuggestions,
    replaceEvidenceSuggestions,
    replaceNoteSuggestion,
    replaceSelectedEvidenceSuggestionId,
    replaceThemeRefinementSuggestion,
    replaceThemeSuggestions,
    requestTargetIsCurrent
  ]);

  const reset = useCallback(() => {
    replaceEvidenceSuggestions([]);
    replaceSelectedEvidenceSuggestionId("");
    replaceCodeSuggestions([]);
    replaceNoteSuggestion(null);
    replaceCodeDetailsSuggestion(null);
    replaceCodeRefinementSuggestion(null);
    replaceThemeSuggestions([]);
    replaceThemeRefinementSuggestion(null);
    inspectorTargetKeyRef.current = "";
    activeCodeDialogTargetsRef.current = {};
    activeCodeTargetIdRef.current = "";
    activeThemeTargetIdRef.current = "";
    resultRunIdsRef.current = {};
    setResultRunIds({});
    themeScopeRef.current = "all";
    setThemeScopeState("all");
    themeSelectedCodeIdsRef.current = [];
    setThemeSelectedCodeIds([]);
  }, [
    replaceCodeDetailsSuggestion,
    replaceCodeRefinementSuggestion,
    replaceCodeSuggestions,
    replaceEvidenceSuggestions,
    replaceNoteSuggestion,
    replaceSelectedEvidenceSuggestionId,
    replaceThemeRefinementSuggestion,
    replaceThemeSuggestions
  ]);

  useEffect(() => {
    reset();
  }, [currentIdentity, reset]);

  useEffect(() => {
    const project = options.project;
    if (!project) return;
    const codeIds = new Set(project.codes.map((code) => code.code_id));
    const themeIds = new Set(project.themes.map((theme) => theme.theme_id));
    const transcriptIds = new Set(project.transcripts.map((transcript) => transcript.transcript_id));

    const nextScopeCodeIds = themeSelectedCodeIdsRef.current.filter((codeId) => codeIds.has(codeId));
    if (nextScopeCodeIds.length !== themeSelectedCodeIdsRef.current.length) {
      themeSelectedCodeIdsRef.current = nextScopeCodeIds;
      setThemeSelectedCodeIds(nextScopeCodeIds);
    }

    const removedCodeSuggestions = codeSuggestionsRef.current.filter((suggestion) => (
      suggestion.kind === "existing_code" && (!suggestion.code_id || !codeIds.has(suggestion.code_id))
    ));
    if (removedCodeSuggestions.length) {
      replaceCodeSuggestions(codeSuggestionsRef.current.filter((suggestion) => !(
        suggestion.kind === "existing_code" && (!suggestion.code_id || !codeIds.has(suggestion.code_id))
      )));
      removedCodeSuggestions.forEach((suggestion) => optionsRef.current.clearDecisionError("codes", suggestion.suggestion_id));
    }

    const currentEvidenceSuggestions = evidenceSuggestionsRef.current;
    const nextEvidenceSuggestions = currentEvidenceSuggestions.filter((suggestion) => transcriptIds.has(suggestion.transcript_id));
    if (nextEvidenceSuggestions.length !== currentEvidenceSuggestions.length) {
      const removedSuggestions = currentEvidenceSuggestions.filter((suggestion) => !transcriptIds.has(suggestion.transcript_id));
      const selectedId = selectedEvidenceSuggestionIdRef.current;
      const selectedIndex = currentEvidenceSuggestions.findIndex((suggestion) => suggestion.suggestion_id === selectedId);
      const selectedStillExists = nextEvidenceSuggestions.some((suggestion) => suggestion.suggestion_id === selectedId);
      const nextSelected = selectedStillExists
        ? selectedId
        : nextEvidenceSuggestions[Math.min(Math.max(selectedIndex, 0), nextEvidenceSuggestions.length - 1)]?.suggestion_id ?? "";
      replaceEvidenceSuggestions(nextEvidenceSuggestions);
      replaceSelectedEvidenceSuggestionId(nextSelected);
      removedSuggestions.forEach((suggestion) => optionsRef.current.clearDecisionError("evidence", suggestion.suggestion_id));
    }

    if (codeRefinementTargetIdRef.current && !codeIds.has(codeRefinementTargetIdRef.current)) {
      const suggestionId = codeRefinementSuggestionRef.current?.suggestion_id;
      replaceCodeRefinementSuggestion(null);
      optionsRef.current.clearTaskFeedback("code_refinement", suggestionId);
    }
    if (themeRefinementTargetIdRef.current && !themeIds.has(themeRefinementTargetIdRef.current)) {
      const suggestionId = themeRefinementSuggestionRef.current?.suggestion_id;
      replaceThemeRefinementSuggestion(null);
      optionsRef.current.clearTaskFeedback("theme_refinement", suggestionId);
    }
  }, [
    options.project,
    replaceCodeRefinementSuggestion,
    replaceCodeSuggestions,
    replaceEvidenceSuggestions,
    replaceSelectedEvidenceSuggestionId,
    replaceThemeRefinementSuggestion
  ]);

  const captureInspectorContext = useCallback(() => {
    const workspace = optionsRef.current.getEvidenceWorkspace();
    if (workspace?.evidenceDraft) {
      return {
        inspectorTargetKey: `draft:${workspace.evidenceDraft.transcriptId}:${workspace.evidenceDraft.segmentIds.join(",")}`,
        transcriptId: workspace.evidenceDraft.transcriptId,
        segmentIds: [...workspace.evidenceDraft.segmentIds],
        selectedText: workspace.evidenceDraft.selectedText,
        codeIds: [...workspace.evidenceDraft.codeIds]
      };
    }
    if (workspace?.selectedEvidence) {
      return {
        inspectorTargetKey: `evidence:${workspace.selectedEvidence.evidence_id}`,
        transcriptId: workspace.selectedEvidence.transcript_id,
        segmentIds: [...workspace.selectedEvidence.segment_ids],
        evidenceId: workspace.selectedEvidence.evidence_id,
        selectedText: workspace.selectedEvidence.selected_text,
        codeIds: [...(workspace.evidenceEditDraft?.codeIds ?? workspace.selectedEvidence.code_ids)]
      };
    }
    return null;
  }, []);

  const captureThemeSuggestionScope = useCallback(() => {
    const selectedCodeIds = themeScopeRef.current === "selected" ? [...themeSelectedCodeIdsRef.current] : [];
    return themeScopeRef.current === "selected" && !selectedCodeIds.length
      ? { selectedCodeIds, error: "Select at least one code for this theme-suggestion scope." }
      : { selectedCodeIds, error: null };
  }, []);

  const locked = useCallback(() => (
    optionsRef.current.isRunLocked() || optionsRef.current.isExternallyLocked()
  ), []);

  const resolveEvidenceSuggestion = useCallback((suggestion: CodesAiEvidenceSuggestion) => (
    evidenceSuggestionsRef.current.find((item) => (
      item.suggestion_id === suggestion.suggestion_id && item.run_id === suggestion.run_id
    )) ?? null
  ), []);
  const resolveCodeSuggestion = useCallback((suggestion: CodesAiCodeSuggestion, runId: string) => {
    if (!runId || resultRunIdsRef.current.codes !== runId) return null;
    return codeSuggestionsRef.current.find((item) => item.suggestion_id === suggestion.suggestion_id) ?? null;
  }, []);
  const resolveNoteSuggestion = useCallback((suggestion: CodesAiNoteSuggestion, runId: string) => {
    if (!runId || resultRunIdsRef.current.note !== runId) return null;
    const current = noteSuggestionRef.current;
    return current?.suggestion_id === suggestion.suggestion_id ? current : null;
  }, []);
  const resolveCodeDetailsSuggestion = useCallback((suggestion: CodesAiCodeDetailsSuggestion) => {
    const current = codeDetailsSuggestionRef.current;
    return current?.suggestion_id === suggestion.suggestion_id && current.run_id === suggestion.run_id ? current : null;
  }, []);
  const resolveCodeRefinementSuggestion = useCallback((suggestion: CodesAiCodeDetailsSuggestion) => {
    const current = codeRefinementSuggestionRef.current;
    return current?.suggestion_id === suggestion.suggestion_id && current.run_id === suggestion.run_id ? current : null;
  }, []);
  const resolveThemeSuggestion = useCallback((suggestion: CodesAiThemeSuggestion) => (
    themeSuggestionsRef.current.find((item) => (
      item.suggestion_id === suggestion.suggestion_id && item.run_id === suggestion.run_id
    )) ?? null
  ), []);
  const resolveThemeRefinementSuggestion = useCallback((suggestion: CodesAiThemeSuggestion) => {
    const current = themeRefinementSuggestionRef.current;
    return current?.suggestion_id === suggestion.suggestion_id && current.run_id === suggestion.run_id ? current : null;
  }, []);

  const inspectorTargetIsCurrent = useCallback(() => {
    const targetKey = currentInspectorTargetKey();
    return Boolean(targetKey && targetKey === inspectorTargetKeyRef.current);
  }, [currentInspectorTargetKey]);

  const selectEvidenceSuggestion = useCallback((suggestion: CodesAiEvidenceSuggestion) => {
    if (locked()) return false;
    const authoritative = resolveEvidenceSuggestion(suggestion);
    const project = optionsRef.current.getCurrentSession().project;
    if (!authoritative || !project?.transcripts.some((item) => item.transcript_id === authoritative.transcript_id)) return false;
    const workspace = optionsRef.current.getEvidenceWorkspace();
    if (!workspace?.navigateToTranscript(authoritative.transcript_id)) return false;
    replaceSelectedEvidenceSuggestionId(authoritative.suggestion_id);
    return true;
  }, [locked, replaceSelectedEvidenceSuggestionId, resolveEvidenceSuggestion]);

  const removeEvidenceSuggestion = useCallback((identity: { suggestionId: string; runId: string }, navigateToNext: boolean) => {
    const current = evidenceSuggestionsRef.current;
    const removedIndex = current.findIndex((item) => (
      item.suggestion_id === identity.suggestionId && item.run_id === identity.runId
    ));
    if (removedIndex < 0) return false;
    const remaining = current.filter((item) => !(
      item.suggestion_id === identity.suggestionId && item.run_id === identity.runId
    ));
    const nextSuggestion = remaining.length ? remaining[Math.min(removedIndex, remaining.length - 1)] : null;
    replaceEvidenceSuggestions(remaining);
    replaceSelectedEvidenceSuggestionId(nextSuggestion?.suggestion_id ?? "");
    if (navigateToNext && nextSuggestion) {
      optionsRef.current.getEvidenceWorkspace()?.navigateToTranscript(nextSuggestion.transcript_id);
    }
    return true;
  }, [replaceEvidenceSuggestions, replaceSelectedEvidenceSuggestionId]);

  const authorizeEvidenceSuggestion = useCallback((suggestion: CodesAiEvidenceSuggestion) => {
    if (locked()) return null;
    const authoritative = resolveEvidenceSuggestion(suggestion);
    const project = optionsRef.current.getCurrentSession().project;
    return authoritative && project?.transcripts.some((item) => item.transcript_id === authoritative.transcript_id)
      ? authoritative
      : null;
  }, [locked, resolveEvidenceSuggestion]);

  const authorizeEvidenceSuggestions = useCallback((suggestions: readonly CodesAiEvidenceSuggestion[]) => {
    if (locked()) return [];
    const project = optionsRef.current.getCurrentSession().project;
    return suggestions.flatMap((suggestion) => {
      const authoritative = resolveEvidenceSuggestion(suggestion);
      return authoritative && project?.transcripts.some((item) => item.transcript_id === authoritative.transcript_id)
        ? [authoritative]
        : [];
    });
  }, [locked, resolveEvidenceSuggestion]);

  const resolveSuggestionRejection = useCallback((rejection: CodesAiSuggestionRejection) => {
    if (rejection.task === "evidence") {
      const current = evidenceSuggestionsRef.current.find((item) => (
        item.suggestion_id === rejection.suggestionId && item.run_id === rejection.runId
      ));
      return current ? { ...rejection } : null;
    }
    if (rejection.task === "codes") {
      return resultRunIdsRef.current.codes === rejection.runId
        && codeSuggestionsRef.current.some((item) => item.suggestion_id === rejection.suggestionId)
        ? { ...rejection }
        : null;
    }
    if (rejection.task === "note") {
      return resultRunIdsRef.current.note === rejection.runId
        && noteSuggestionRef.current?.suggestion_id === rejection.suggestionId
        ? { ...rejection }
        : null;
    }
    if (rejection.task === "code_details") {
      const current = codeDetailsSuggestionRef.current;
      return current?.suggestion_id === rejection.suggestionId && current.run_id === rejection.runId
        ? { ...rejection }
        : null;
    }
    if (rejection.task === "code_refinement") {
      const current = codeRefinementSuggestionRef.current;
      return current?.suggestion_id === rejection.suggestionId && current.run_id === rejection.runId
        ? { ...rejection }
        : null;
    }
    if (rejection.task === "theme_suggestions") {
      return themeSuggestionsRef.current.some((item) => (
        item.suggestion_id === rejection.suggestionId && item.run_id === rejection.runId
      )) ? { ...rejection } : null;
    }
    const current = themeRefinementSuggestionRef.current;
    return current?.suggestion_id === rejection.suggestionId && current.run_id === rejection.runId
      ? { ...rejection }
      : null;
  }, []);

  const authorizeSuggestionRejection = useCallback((rejection: CodesAiSuggestionRejection) => (
    locked() ? null : resolveSuggestionRejection(rejection)
  ), [locked, resolveSuggestionRejection]);

  const handleEvidenceAccepted = useCallback(({ suggestion, payload }: CodesAiEvidenceAcceptance) => {
    if (!removeEvidenceSuggestion({ suggestionId: suggestion.suggestion_id, runId: suggestion.run_id }, false)) return;
    optionsRef.current.getEvidenceWorkspace()?.acceptPersistedEvidence(payload.evidence);
    optionsRef.current.onStatusMessage(`Saved AI-suggested evidence ${payload.evidence.evidence_id}.`);
  }, [removeEvidenceSuggestion]);

  const handleSuggestionRejected = useCallback((rejection: CodesAiSuggestionRejection) => {
    if (!resolveSuggestionRejection(rejection)) return;
    if (rejection.task === "evidence") {
      removeEvidenceSuggestion(rejection, true);
    } else if (rejection.task === "codes") {
      replaceCodeSuggestions(codeSuggestionsRef.current.filter((item) => item.suggestion_id !== rejection.suggestionId));
    } else if (rejection.task === "note") {
      replaceNoteSuggestion(null);
    } else if (rejection.task === "code_details") {
      replaceCodeDetailsSuggestion(null);
    } else if (rejection.task === "code_refinement") {
      replaceCodeRefinementSuggestion(null);
    } else if (rejection.task === "theme_suggestions") {
      replaceThemeSuggestions(themeSuggestionsRef.current.filter((item) => !(
        item.suggestion_id === rejection.suggestionId && item.run_id === rejection.runId
      )));
    } else {
      replaceThemeRefinementSuggestion(null);
    }
  }, [
    removeEvidenceSuggestion,
    replaceCodeDetailsSuggestion,
    replaceCodeRefinementSuggestion,
    replaceCodeSuggestions,
    replaceNoteSuggestion,
    replaceThemeRefinementSuggestion,
    replaceThemeSuggestions,
    resolveSuggestionRejection
  ]);

  const stageAiCode = useCallback((suggestion: CodesAiCodeSuggestion, runId: string) => {
    const authoritative = resolveCodeSuggestion(suggestion, runId);
    const project = optionsRef.current.getCurrentSession().project;
    if (
      locked()
      || !inspectorTargetIsCurrent()
      || authoritative?.kind !== "existing_code"
      || !authoritative.code_id
      || !project?.codes.some((code) => code.code_id === authoritative.code_id)
    ) return false;
    const staged = optionsRef.current.getEvidenceWorkspace()?.stageExistingCode(authoritative.code_id, {
      run_id: runId,
      suggestion_id: authoritative.suggestion_id,
      task: "codes",
      decision: "accepted",
      result_ids: [authoritative.code_id]
    });
    if (!staged) return false;
    replaceCodeSuggestions(codeSuggestionsRef.current.filter((item) => item.suggestion_id !== authoritative.suggestion_id));
    return true;
  }, [inspectorTargetIsCurrent, locked, replaceCodeSuggestions, resolveCodeSuggestion]);

  const addInspectorCode = useCallback((value: CodeDialogValue, suggestion?: CodesAiCodeSuggestion, runId = "") => {
    if (locked() || (suggestion && !inspectorTargetIsCurrent())) return "";
    const authoritative = suggestion ? resolveCodeSuggestion(suggestion, runId) : null;
    if (suggestion && !authoritative) return "";
    const normalized = authoritative ? {
      ...value,
      aiDecisions: [
        ...value.aiDecisions.filter((decision) => decision.task !== "codes"),
        cloneDecision({
          run_id: runId,
          suggestion_id: authoritative.suggestion_id,
          task: "codes",
          decision: "accepted"
        })
      ]
    } : value;
    const draftCodeId = optionsRef.current.getEvidenceWorkspace()?.addInspectorCode(normalized) ?? "";
    if (draftCodeId && authoritative) {
      replaceCodeSuggestions(codeSuggestionsRef.current.filter((item) => item.suggestion_id !== authoritative.suggestion_id));
    }
    return draftCodeId;
  }, [inspectorTargetIsCurrent, locked, replaceCodeSuggestions, resolveCodeSuggestion]);

  const applyAiNote = useCallback((
    suggestion: CodesAiNoteSuggestion,
    runId: string,
    mode: "use" | "replace" | "append"
  ) => {
    const authoritative = resolveNoteSuggestion(suggestion, runId);
    if (locked() || !inspectorTargetIsCurrent() || !authoritative) return false;
    const applied = optionsRef.current.getEvidenceWorkspace()?.applyAiNote(authoritative.note, mode, {
      run_id: runId,
      suggestion_id: authoritative.suggestion_id,
      task: "note",
      decision: "accepted"
    });
    if (!applied) return false;
    replaceNoteSuggestion(null);
    return true;
  }, [inspectorTargetIsCurrent, locked, replaceNoteSuggestion, resolveNoteSuggestion]);

  const authorizeCodeDetailsSuggestion = useCallback((
    target: CodesCodeDialogTarget,
    suggestion: CodesAiCodeDetailsSuggestion
  ) => {
    const authoritative = resolveCodeDetailsSuggestion(suggestion);
    if (
      locked()
      || !authoritative
      || !sameCodeDialogTarget(target, codeDetailsSuggestionTargetRef.current)
      || activeCodeDialogTargetsRef.current[target.surface] !== target.instanceId
    ) return null;
    replaceCodeDetailsSuggestion(null);
    return authoritative;
  }, [locked, replaceCodeDetailsSuggestion, resolveCodeDetailsSuggestion]);

  const applyCodeRefinement = useCallback((
    candidate: CodesAiCodeDetailsSuggestion,
    fields?: Array<"name" | "description" | "inclusionNote" | "exclusionNote" | "memo">
  ) => {
    const suggestion = resolveCodeRefinementSuggestion(candidate);
    const workspace = optionsRef.current.getCodebookWorkspace();
    const project = optionsRef.current.getCurrentSession().project;
    const expectedCodeId = codeRefinementTargetIdRef.current;
    if (
      !suggestion
      || !workspace
      || !project?.codes.some((code) => code.code_id === expectedCodeId)
      || !expectedCodeId
      || suggestion.code_id !== expectedCodeId
      || locked()
    ) return false;
    const selectedFields = new Set(fields ?? ["name", "description", "inclusionNote", "exclusionNote", "memo"]);
    const applied = workspace.tryUpdateCodeForm(expectedCodeId, (current) => ({
      ...current,
      name: selectedFields.has("name") ? suggestion.name : current.name,
      description: selectedFields.has("description") ? suggestion.description : current.description,
      inclusionNote: selectedFields.has("inclusionNote") ? suggestion.inclusion_note : current.inclusionNote,
      exclusionNote: selectedFields.has("exclusionNote") ? suggestion.exclusion_note : current.exclusionNote,
      memo: selectedFields.has("memo") ? suggestion.memo : current.memo,
      aiDecisions: [...current.aiDecisions, cloneDecision({
        run_id: suggestion.run_id,
        suggestion_id: suggestion.suggestion_id,
        task: "code_refinement",
        decision: fields ? "edited" : "accepted"
      })]
    }));
    if (!applied) return false;
    replaceCodeRefinementSuggestion(null);
    return true;
  }, [locked, replaceCodeRefinementSuggestion, resolveCodeRefinementSuggestion]);

  const acceptThemeSuggestion = useCallback((candidate: CodesAiThemeSuggestion) => {
    const suggestion = resolveThemeSuggestion(candidate);
    const workspace = optionsRef.current.getCodebookWorkspace();
    const project = optionsRef.current.getCurrentSession().project;
    if (
      !suggestion
      || !workspace
      || !project
      || suggestion.code_ids.some((id) => !project.codes.some((code) => code.code_id === id))
      || locked()
    ) return false;
    const opened = workspace.tryOpenNewTheme({
      ...emptyThemeForm,
      name: suggestion.name ?? "",
      description: suggestion.description,
      memo: suggestion.memo,
      codeIds: [...suggestion.code_ids],
      aiDecisions: [cloneDecision({
        run_id: suggestion.run_id,
        suggestion_id: suggestion.suggestion_id,
        task: "theme_suggestions",
        decision: "accepted"
      })]
    });
    if (!opened) return false;
    replaceThemeSuggestions(themeSuggestionsRef.current.filter((item) => !(
      item.suggestion_id === suggestion.suggestion_id && item.run_id === suggestion.run_id
    )));
    return true;
  }, [locked, replaceThemeSuggestions, resolveThemeSuggestion]);

  const applyThemeRefinement = useCallback((candidate: CodesAiThemeSuggestion) => {
    const suggestion = resolveThemeRefinementSuggestion(candidate);
    const workspace = optionsRef.current.getCodebookWorkspace();
    const project = optionsRef.current.getCurrentSession().project;
    const expectedThemeId = themeRefinementTargetIdRef.current;
    if (
      !suggestion
      || !workspace
      || !project?.themes.some((theme) => theme.theme_id === expectedThemeId)
      || suggestion.code_ids.some((codeId) => !project.codes.some((code) => code.code_id === codeId))
      || !expectedThemeId
      || suggestion.theme_id !== expectedThemeId
      || locked()
    ) return false;
    const applied = workspace.tryUpdateThemeForm(expectedThemeId, (current) => ({
      ...current,
      description: suggestion.description,
      memo: suggestion.memo,
      codeIds: [...suggestion.code_ids],
      aiDecisions: [...current.aiDecisions, cloneDecision({
        run_id: suggestion.run_id,
        suggestion_id: suggestion.suggestion_id,
        task: "theme_refinement",
        decision: "edited"
      })]
    }));
    if (!applied) return false;
    replaceThemeRefinementSuggestion(null);
    return true;
  }, [locked, replaceThemeRefinementSuggestion, resolveThemeRefinementSuggestion]);

  const setThemeScope = useCallback((scope: "all" | "selected") => {
    if (locked()) return false;
    themeScopeRef.current = scope;
    setThemeScopeState(scope);
    return true;
  }, [locked]);

  const toggleThemeScopeCode = useCallback((codeId: string) => {
    if (locked()) return false;
    const next = themeSelectedCodeIdsRef.current.includes(codeId)
      ? themeSelectedCodeIdsRef.current.filter((id) => id !== codeId)
      : [...themeSelectedCodeIdsRef.current, codeId];
    themeSelectedCodeIdsRef.current = next;
    setThemeSelectedCodeIds(next);
    return true;
  }, [locked]);

  const setInspectorTarget = useCallback((targetKey: string) => {
    const previousTarget = inspectorTargetKeyRef.current;
    inspectorTargetKeyRef.current = targetKey;
    if (!previousTarget || targetKey === previousTarget) return;
    codeSuggestionsRef.current.forEach((suggestion) => optionsRef.current.clearDecisionError("codes", suggestion.suggestion_id));
    if (noteSuggestionRef.current) optionsRef.current.clearDecisionError("note", noteSuggestionRef.current.suggestion_id);
    replaceCodeSuggestions([]);
    replaceNoteSuggestion(null);
    optionsRef.current.clearTaskFeedback("codes");
    optionsRef.current.clearTaskFeedback("note");
  }, [replaceCodeSuggestions, replaceNoteSuggestion]);

  const activateCodeDialogTarget = useCallback((target: CodesCodeDialogTarget) => {
    const previous = activeCodeDialogTargetsRef.current[target.surface];
    activeCodeDialogTargetsRef.current = {
      ...activeCodeDialogTargetsRef.current,
      [target.surface]: target.instanceId
    };
    if (previous && previous !== target.instanceId && codeDetailsSuggestionTargetRef.current?.surface === target.surface) {
      const suggestionId = codeDetailsSuggestionRef.current?.suggestion_id;
      replaceCodeDetailsSuggestion(null);
      optionsRef.current.clearTaskFeedback("code_details", suggestionId);
    }
  }, [replaceCodeDetailsSuggestion]);

  const invalidateCodeDialogTarget = useCallback((target: CodesCodeDialogTarget) => {
    if (activeCodeDialogTargetsRef.current[target.surface] !== target.instanceId) return;
    const next = { ...activeCodeDialogTargetsRef.current };
    delete next[target.surface];
    activeCodeDialogTargetsRef.current = next;
    if (sameCodeDialogTarget(target, codeDetailsSuggestionTargetRef.current)) {
      const suggestionId = codeDetailsSuggestionRef.current?.suggestion_id;
      replaceCodeDetailsSuggestion(null);
      optionsRef.current.clearTaskFeedback("code_details", suggestionId);
    }
  }, [replaceCodeDetailsSuggestion]);

  const setCodebookTargets = useCallback((codeId: string | null, themeId: string | null) => {
    const nextCodeId = codeId ?? "";
    const nextThemeId = themeId ?? "";
    const previousCodeId = activeCodeTargetIdRef.current;
    const previousThemeId = activeThemeTargetIdRef.current;
    activeCodeTargetIdRef.current = nextCodeId;
    activeThemeTargetIdRef.current = nextThemeId;
    if (previousCodeId && previousCodeId !== nextCodeId && codeRefinementTargetIdRef.current === previousCodeId) {
      const suggestionId = codeRefinementSuggestionRef.current?.suggestion_id;
      replaceCodeRefinementSuggestion(null);
      optionsRef.current.clearTaskFeedback("code_refinement", suggestionId);
    }
    if (previousThemeId && previousThemeId !== nextThemeId && themeRefinementTargetIdRef.current === previousThemeId) {
      const suggestionId = themeRefinementSuggestionRef.current?.suggestion_id;
      replaceThemeRefinementSuggestion(null);
      optionsRef.current.clearTaskFeedback("theme_refinement", suggestionId);
    }
  }, [replaceCodeRefinementSuggestion, replaceThemeRefinementSuggestion]);

  return {
    state: {
      evidenceSuggestions,
      selectedEvidenceSuggestionId,
      codeSuggestions,
      noteSuggestion,
      resultRunIds,
      codeDetailsSuggestion,
      codeDetailsSuggestionTarget,
      codeRefinementSuggestion,
      themeSuggestions,
      themeRefinementSuggestion,
      themeScope,
      themeSelectedCodeIds
    },
    coordinator: {
      requestTargetIsCurrent,
      routeCompletedRun,
      registerRunId,
      captureInspectorContext,
      captureThemeSuggestionScope
    },
    actions: {
      selectEvidenceSuggestion,
      authorizeEvidenceSuggestion,
      authorizeEvidenceSuggestions,
      authorizeSuggestionRejection,
      handleEvidenceAccepted,
      handleSuggestionRejected,
      stageAiCode,
      addInspectorCode,
      applyAiNote,
      authorizeCodeDetailsSuggestion,
      activateCodeDialogTarget,
      invalidateCodeDialogTarget,
      applyCodeRefinement,
      acceptThemeSuggestion,
      applyThemeRefinement,
      setThemeScope,
      toggleThemeScopeCode,
      setInspectorTarget,
      setCodebookTargets
    }
  };
}
