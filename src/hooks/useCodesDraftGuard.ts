import { useCallback, useEffect, useRef, useState } from "react";

export type CodesDraftKind = "evidence" | "evidenceEdit" | "code" | "theme";
export type CodesDraftScope = "all" | "evidence" | "code" | "theme";

type CodesDraftGuardActionOptions = {
  allowLockedNavigation?: boolean;
};

type CodesDraftState = {
  activeTab: "evidence" | "codebook" | "export";
  codebookView: "codes" | "themes";
  evidenceDraft: boolean;
  evidenceEditDirty: boolean;
  codeDraftDirty: boolean;
  codeName: string;
  themeDraftDirty: boolean;
  themeName: string;
  settingsDirty: boolean;
};

type CodesDraftGuardOptions = {
  getDraftState: () => CodesDraftState;
  isExternallyLocked: () => boolean;
  saveEvidenceDraft: () => Promise<boolean>;
  saveEvidenceEditDraft: () => Promise<boolean>;
  saveCodeDraft: () => Promise<boolean>;
  saveThemeDraft: () => Promise<boolean>;
  discardEvidenceDraft: () => void;
  discardEvidenceEditDraft: () => void;
  discardCodeDraft: () => void;
  discardThemeDraft: () => void;
  persistProjectSettings: () => Promise<unknown | null>;
};

const draftLabels: Record<CodesDraftKind, string> = {
  evidence: "The evidence selection",
  evidenceEdit: "The evidence changes",
  code: "The code form",
  theme: "The theme form"
};

function dirtyDraftKind(state: CodesDraftState, scope: CodesDraftScope = "all") {
  if ((scope === "all" || scope === "evidence") && state.evidenceDraft) return "evidence" as const;
  if ((scope === "all" || scope === "evidence") && state.evidenceEditDirty) return "evidenceEdit" as const;
  if ((scope === "all" || scope === "code") && state.codeDraftDirty) return "code" as const;
  if ((scope === "all" || scope === "theme") && state.themeDraftDirty) return "theme" as const;
  return null;
}

function activeDraftKind(state: CodesDraftState) {
  if (state.activeTab === "evidence") {
    if (state.evidenceDraft) return "evidence" as const;
    if (state.evidenceEditDirty) return "evidenceEdit" as const;
  }
  if (state.activeTab === "codebook" && state.codebookView === "codes" && state.codeDraftDirty) {
    return "code" as const;
  }
  if (state.activeTab === "codebook" && state.codebookView === "themes" && state.themeDraftDirty) {
    return "theme" as const;
  }
  return dirtyDraftKind(state);
}

export function useCodesDraftGuard(options: CodesDraftGuardOptions) {
  const [dialogKind, setDialogKind] = useState<CodesDraftKind | null>(null);
  const optionsRef = useRef(options);
  const dialogKindRef = useRef<CodesDraftKind | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  optionsRef.current = options;

  const publishDialogKind = useCallback((kind: CodesDraftKind | null) => {
    dialogKindRef.current = kind;
    setDialogKind(kind);
  }, []);

  const invalidate = useCallback(() => {
    generationRef.current += 1;
    savingRef.current = false;
    pendingActionRef.current = null;
    publishDialogKind(null);
  }, [publishDialogKind]);

  const canSaveKind = useCallback((kind: CodesDraftKind | null) => {
    if (!kind) return false;
    const state = optionsRef.current.getDraftState();
    if (kind === "code") return state.codeDraftDirty && Boolean(state.codeName.trim());
    if (kind === "theme") return state.themeDraftDirty && Boolean(state.themeName.trim());
    if (kind === "evidence") return state.evidenceDraft;
    return state.evidenceEditDirty;
  }, []);

  const saveDraft = useCallback(async (kind: CodesDraftKind) => {
    if (!canSaveKind(kind)) return false;
    if (kind === "evidence") return optionsRef.current.saveEvidenceDraft();
    if (kind === "evidenceEdit") return optionsRef.current.saveEvidenceEditDraft();
    if (kind === "code") return optionsRef.current.saveCodeDraft();
    return optionsRef.current.saveThemeDraft();
  }, [canSaveKind]);

  const discardDraft = useCallback((kind: CodesDraftKind) => {
    if (kind === "evidence") optionsRef.current.discardEvidenceDraft();
    if (kind === "evidenceEdit") optionsRef.current.discardEvidenceEditDraft();
    if (kind === "code") optionsRef.current.discardCodeDraft();
    if (kind === "theme") optionsRef.current.discardThemeDraft();
  }, []);

  const guardAction = useCallback((
    action: () => void,
    scope: CodesDraftScope = "all",
    actionOptions: CodesDraftGuardActionOptions = {}
  ) => {
    if (savingRef.current) return false;
    const kind = dirtyDraftKind(optionsRef.current.getDraftState(), scope);
    if (
      optionsRef.current.isExternallyLocked()
      && (!actionOptions.allowLockedNavigation || kind)
    ) return false;
    if (!kind) {
      action();
      return true;
    }
    if (dialogKindRef.current || pendingActionRef.current) return false;
    pendingActionRef.current = action;
    publishDialogKind(kind);
    return true;
  }, [publishDialogKind]);

  const saveDialog = useCallback(async () => {
    const kind = dialogKindRef.current;
    if (!kind || savingRef.current || optionsRef.current.isExternallyLocked()) return false;
    savingRef.current = true;
    const generation = generationRef.current;
    const pendingAction = pendingActionRef.current;
    let saved: boolean;
    try {
      saved = await saveDraft(kind);
    } catch {
      saved = false;
    }
    if (
      !mountedRef.current
      || generationRef.current !== generation
      || dialogKindRef.current !== kind
      || pendingActionRef.current !== pendingAction
    ) return false;
    savingRef.current = false;
    if (!saved) return false;
    pendingActionRef.current = null;
    publishDialogKind(null);
    pendingAction?.();
    return true;
  }, [publishDialogKind, saveDraft]);

  const discardDialog = useCallback(() => {
    const kind = dialogKindRef.current;
    if (!kind || savingRef.current || optionsRef.current.isExternallyLocked()) return false;
    const action = pendingActionRef.current;
    discardDraft(kind);
    pendingActionRef.current = null;
    publishDialogKind(null);
    action?.();
    return true;
  }, [discardDraft, publishDialogKind]);

  const cancelDialog = useCallback(() => {
    if (!dialogKindRef.current || savingRef.current) return false;
    pendingActionRef.current = null;
    publishDialogKind(null);
    return true;
  }, [publishDialogKind]);

  const saveProject = useCallback(async () => {
    if (savingRef.current || optionsRef.current.isExternallyLocked()) return false;
    savingRef.current = true;
    const generation = generationRef.current;
    try {
      const state = optionsRef.current.getDraftState();
      const kind = activeDraftKind(state);
      if (kind) return await saveDraft(kind);
      if (state.settingsDirty) return Boolean(await optionsRef.current.persistProjectSettings());
      return false;
    } finally {
      if (generationRef.current === generation) savingRef.current = false;
    }
  }, [saveDraft]);

  const isOwned = useCallback(
    () => Boolean(dialogKindRef.current || pendingActionRef.current || savingRef.current),
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      savingRef.current = false;
      pendingActionRef.current = null;
    };
  }, []);

  return {
    dialogKind,
    dialogLabel: draftLabels[dialogKind ?? "evidence"],
    dialogCanSave: canSaveKind(dialogKind),
    guardAction,
    saveDialog,
    discardDialog,
    cancelDialog,
    saveProject,
    invalidate,
    isLocked: isOwned
  };
}
