import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodesDraftGuard } from "../../src/hooks/useCodesDraftGuard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function renderGuard(strict = false) {
  const state = {
    activeTab: "evidence" as const,
    codebookView: "codes" as const,
    evidenceDraft: false,
    evidenceEditDirty: false,
    codeDraftDirty: false,
    codeName: "Code",
    themeDraftDirty: false,
    themeName: "Theme",
    settingsDirty: false
  };
  let externallyLocked = false;
  const actions = {
    saveEvidenceDraft: vi.fn(async () => true),
    saveEvidenceEditDraft: vi.fn(async () => true),
    saveCodeDraft: vi.fn(async () => true),
    saveThemeDraft: vi.fn(async () => true),
    discardEvidenceDraft: vi.fn(),
    discardEvidenceEditDraft: vi.fn(),
    discardCodeDraft: vi.fn(),
    discardThemeDraft: vi.fn(),
    persistProjectSettings: vi.fn(async () => ({ saved: true }))
  };
  const hook = renderHook(() => useCodesDraftGuard({
    getDraftState: () => state,
    isExternallyLocked: () => externallyLocked,
    ...actions
  }), strict ? { wrapper: StrictModeWrapper } : undefined);
  return {
    ...hook,
    state,
    actions,
    setExternallyLocked(value: boolean) { externallyLocked = value; }
  };
}

describe("Codes draft guard", () => {
  it("executes immediately with no relevant dirty draft and rejects an external lock", () => {
    const { result, state, setExternallyLocked } = renderGuard();
    const action = vi.fn();
    act(() => expect(result.current.guardAction(action)).toBe(true));
    expect(action).toHaveBeenCalledOnce();

    setExternallyLocked(true);
    act(() => expect(result.current.guardAction(action)).toBe(false));
    expect(action).toHaveBeenCalledOnce();

    const navigation = vi.fn();
    act(() => expect(result.current.guardAction(
      navigation,
      "all",
      { allowLockedNavigation: true }
    )).toBe(true));
    expect(navigation).toHaveBeenCalledOnce();

    state.evidenceDraft = true;
    act(() => expect(result.current.guardAction(
      navigation,
      "evidence",
      { allowLockedNavigation: true }
    )).toBe(false));
    expect(navigation).toHaveBeenCalledOnce();
  });

  it("uses scoped dirty precedence and keeps one pending action", () => {
    const { result, state } = renderGuard();
    state.evidenceDraft = true;
    state.codeDraftDirty = true;
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      expect(result.current.guardAction(first, "code")).toBe(true);
      expect(result.current.guardAction(second, "evidence")).toBe(false);
    });
    expect(result.current.dialogKind).toBe("code");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("saves once, then runs the pending action exactly once", async () => {
    const pending = deferred<boolean>();
    const { result, state, actions } = renderGuard();
    state.evidenceDraft = true;
    actions.saveEvidenceDraft.mockReturnValue(pending.promise);
    const action = vi.fn();
    act(() => { result.current.guardAction(action); });

    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.saveDialog();
      expect(await result.current.saveDialog()).toBe(false);
      pending.resolve(true);
      expect(await first).toBe(true);
    });
    expect(actions.saveEvidenceDraft).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(result.current.dialogKind).toBeNull();
  });

  it("keeps Draft Dialog persistence working after Strict Mode effect replay", async () => {
    const { result, state, actions } = renderGuard(true);
    state.evidenceDraft = true;
    const action = vi.fn();
    act(() => { expect(result.current.guardAction(action)).toBe(true); });

    await act(async () => { expect(await result.current.saveDialog()).toBe(true); });

    expect(actions.saveEvidenceDraft).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(result.current.isLocked()).toBe(false);
  });

  it("treats dialog ownership as a lock and releases it before Save, Discard, or Cancel actions", async () => {
    const { result, state, actions } = renderGuard();
    state.evidenceDraft = true;
    const savedAction = vi.fn(() => expect(result.current.isLocked()).toBe(false));
    act(() => { result.current.guardAction(savedAction); });
    expect(result.current.isLocked()).toBe(true);
    await act(async () => { expect(await result.current.saveDialog()).toBe(true); });
    expect(savedAction).toHaveBeenCalledOnce();

    state.evidenceDraft = true;
    const discardedAction = vi.fn(() => expect(result.current.isLocked()).toBe(false));
    act(() => { result.current.guardAction(discardedAction); });
    expect(result.current.isLocked()).toBe(true);
    act(() => { expect(result.current.discardDialog()).toBe(true); });
    expect(discardedAction).toHaveBeenCalledOnce();

    state.evidenceDraft = true;
    const cancelledAction = vi.fn();
    act(() => { result.current.guardAction(cancelledAction); });
    expect(result.current.isLocked()).toBe(true);
    act(() => { expect(result.current.cancelDialog()).toBe(true); });
    expect(result.current.isLocked()).toBe(false);
    expect(cancelledAction).not.toHaveBeenCalled();
    expect(actions.discardEvidenceDraft).toHaveBeenCalledOnce();
  });

  it("retains the dialog and action after failed persistence", async () => {
    const { result, state, actions } = renderGuard();
    state.evidenceEditDirty = true;
    actions.saveEvidenceEditDraft.mockResolvedValue(false);
    const action = vi.fn();
    act(() => { result.current.guardAction(action); });
    await act(async () => { expect(await result.current.saveDialog()).toBe(false); });
    expect(result.current.dialogKind).toBe("evidenceEdit");
    expect(result.current.isLocked()).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it("discards the relevant draft before one action and cancels without action", () => {
    const { result, state, actions } = renderGuard();
    state.themeDraftDirty = true;
    const discarded = vi.fn();
    act(() => {
      result.current.guardAction(discarded, "theme");
      expect(result.current.discardDialog()).toBe(true);
    });
    expect(actions.discardThemeDraft).toHaveBeenCalledOnce();
    expect(discarded).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    act(() => {
      result.current.guardAction(cancelled, "theme");
      expect(result.current.cancelDialog()).toBe(true);
    });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("blocks blank code and theme saves", async () => {
    const { result, state, actions } = renderGuard();
    state.codeDraftDirty = true;
    state.codeName = "   ";
    act(() => { result.current.guardAction(vi.fn(), "code"); });
    expect(result.current.dialogCanSave).toBe(false);
    await act(async () => { expect(await result.current.saveDialog()).toBe(false); });
    expect(actions.saveCodeDraft).not.toHaveBeenCalled();

    act(() => { result.current.cancelDialog(); });
    state.codeDraftDirty = false;
    state.themeDraftDirty = true;
    state.themeName = "";
    act(() => { result.current.guardAction(vi.fn(), "theme"); });
    expect(result.current.dialogCanSave).toBe(false);
  });

  it("routes the main Save through active context, fallback order, then settings", async () => {
    const { result, state, actions } = renderGuard();
    state.evidenceEditDirty = true;
    state.codeDraftDirty = true;
    state.activeTab = "codebook" as never;
    state.codebookView = "codes";
    await act(async () => { expect(await result.current.saveProject()).toBe(true); });
    expect(actions.saveCodeDraft).toHaveBeenCalledOnce();

    state.codeDraftDirty = false;
    state.activeTab = "export" as never;
    await act(async () => { expect(await result.current.saveProject()).toBe(true); });
    expect(actions.saveEvidenceEditDraft).toHaveBeenCalledOnce();

    state.evidenceEditDirty = false;
    state.settingsDirty = true;
    await act(async () => { expect(await result.current.saveProject()).toBe(true); });
    expect(actions.persistProjectSettings).toHaveBeenCalledOnce();
  });

  it("invalidates pending and late saved actions on replacement and unmount", async () => {
    const pending = deferred<boolean>();
    const { result, state, actions, unmount } = renderGuard();
    state.evidenceDraft = true;
    actions.saveEvidenceDraft.mockReturnValue(pending.promise);
    const action = vi.fn();
    act(() => { result.current.guardAction(action); });
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.saveDialog();
      result.current.invalidate();
    });
    await act(async () => {
      pending.resolve(true);
      expect(await saving).toBe(false);
    });
    expect(action).not.toHaveBeenCalled();
    expect(result.current.dialogKind).toBeNull();
    unmount();
  });

  it("ignores a Draft Dialog save that resolves after unmount", async () => {
    const pending = deferred<boolean>();
    const { result, state, actions, unmount } = renderGuard();
    state.evidenceDraft = true;
    actions.saveEvidenceDraft.mockReturnValue(pending.promise);
    const action = vi.fn();
    act(() => { result.current.guardAction(action); });
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.saveDialog(); });
    unmount();

    await act(async () => {
      pending.resolve(true);
      expect(await saving).toBe(false);
    });
    expect(action).not.toHaveBeenCalled();
  });
});
