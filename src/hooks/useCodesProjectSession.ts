import { useCallback, useEffect, useRef, useState } from "react";
import {
  CodesProjectConflictError,
  saveCodesProject,
  type CodesProject,
  type CodesProjectHandle
} from "../lib/api";

export type PersistedProjectSettings = {
  project: CodesProject;
  handle: CodesProjectHandle;
};

export type CodesSettingsSaveState = "saved" | "saving" | "failed";

export type CodesProjectSessionSnapshot = {
  project: CodesProject | null;
  projectFile: string | null;
  projectHandle: CodesProjectHandle | null;
  projectConflict: CodesProjectConflictError | null;
  settingsDirty: boolean;
};

type CodesProjectSessionOptions = {
  onSettingsSaveStarted?: () => void;
  onSettingsSaveError?: (error: unknown, fallback: string) => void;
  onSettingsSaved?: () => void;
};

const SETTINGS_SAVE_DELAY_MS = 250;

export function useCodesProjectSession(options: CodesProjectSessionOptions = {}) {
  const [project, setProject] = useState<CodesProject | null>(null);
  const [projectFile, setProjectFile] = useState<string | null>(null);
  const [projectHandle, setProjectHandle] = useState<CodesProjectHandle | null>(null);
  const [projectConflict, setProjectConflictState] = useState<CodesProjectConflictError | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaveState, setSettingsSaveState] = useState<CodesSettingsSaveState>("saved");

  const projectRef = useRef<CodesProject | null>(null);
  const projectFileRef = useRef<string | null>(null);
  const projectHandleRef = useRef<CodesProjectHandle | null>(null);
  const projectConflictRef = useRef<CodesProjectConflictError | null>(null);
  const settingsDirtyRef = useRef(false);
  const settingsEditVersionRef = useRef(0);
  const settingsSaveTimerRef = useRef<number | null>(null);
  const settingsSavePromiseRef = useRef<Promise<PersistedProjectSettings | null> | null>(null);
  // A generation identifies one activated project/file pair so old saves can finish without publishing stale state.
  const sessionGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cancelScheduledSettingsSave = useCallback(() => {
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
      settingsSaveTimerRef.current = null;
    }
  }, []);

  const getCurrentSession = useCallback((): CodesProjectSessionSnapshot => ({
    project: projectRef.current,
    projectFile: projectFileRef.current,
    projectHandle: projectHandleRef.current,
    projectConflict: projectConflictRef.current,
    settingsDirty: settingsDirtyRef.current
  }), []);

  const currentPersistedSettings = useCallback((): PersistedProjectSettings | null => {
    const currentProject = projectRef.current;
    const currentHandle = projectHandleRef.current;
    if (!currentProject || !currentHandle || !projectFileRef.current) return null;
    return { project: currentProject, handle: currentHandle };
  }, []);

  const setProjectConflict = useCallback((conflict: CodesProjectConflictError | null) => {
    projectConflictRef.current = conflict;
    setProjectConflictState(conflict);
  }, []);

  const activateProjectSession = useCallback((payload: PersistedProjectSettings) => {
    cancelScheduledSettingsSave();
    sessionGenerationRef.current += 1;
    settingsSavePromiseRef.current = null;
    settingsEditVersionRef.current = 0;
    projectRef.current = payload.project;
    projectFileRef.current = payload.handle.project_file;
    projectHandleRef.current = payload.handle;
    projectConflictRef.current = null;
    settingsDirtyRef.current = false;
    setProject(payload.project);
    setProjectFile(payload.handle.project_file);
    setProjectHandle(payload.handle);
    setProjectConflictState(null);
    setSettingsDirty(false);
    setSettingsSaveState("saved");
  }, [cancelScheduledSettingsSave]);

  const clearProjectSession = useCallback(() => {
    cancelScheduledSettingsSave();
    sessionGenerationRef.current += 1;
    settingsSavePromiseRef.current = null;
    settingsEditVersionRef.current = 0;
    projectRef.current = null;
    projectFileRef.current = null;
    projectHandleRef.current = null;
    projectConflictRef.current = null;
    settingsDirtyRef.current = false;
    setProject(null);
    setProjectFile(null);
    setProjectHandle(null);
    setProjectConflictState(null);
    setSettingsDirty(false);
    setSettingsSaveState("saved");
  }, [cancelScheduledSettingsSave]);

  const applyPersistedProject = useCallback((payload: PersistedProjectSettings) => {
    const currentProject = projectRef.current;
    const currentFile = projectFileRef.current;
    if (
      !currentProject
      || currentProject.project_id !== payload.project.project_id
      || currentFile !== payload.handle.project_file
    ) return false;

    projectRef.current = payload.project;
    projectFileRef.current = payload.handle.project_file;
    projectHandleRef.current = payload.handle;
    setProject(payload.project);
    setProjectFile(payload.handle.project_file);
    setProjectHandle(payload.handle);
    return true;
  }, []);

  const updateProjectSettingsLocally = useCallback((updater: (current: CodesProject) => CodesProject) => {
    const current = projectRef.current;
    if (!current) return;
    const nextProject = updater(current);
    projectRef.current = nextProject;
    settingsEditVersionRef.current += 1;
    settingsDirtyRef.current = true;
    setProject(nextProject);
    setSettingsDirty(true);
    setSettingsSaveState("saved");
  }, []);

  const persistSettingsImmediately = useCallback(async function persistSettings(): Promise<PersistedProjectSettings | null> {
    cancelScheduledSettingsSave();
    const activeSave = settingsSavePromiseRef.current;
    if (activeSave) {
      const activeResult = await activeSave;
      if (!activeResult) return null;
      return settingsDirtyRef.current
        ? persistSettings()
        : currentPersistedSettings() ?? activeResult;
    }

    const coherent = currentPersistedSettings();
    if (!coherent) return null;
    if (!settingsDirtyRef.current) return coherent;

    const snapshot = coherent.project;
    const snapshotHandle = coherent.handle;
    const snapshotFile = projectFileRef.current as string;
    const editVersion = settingsEditVersionRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const sessionIsCurrent = () => Boolean(
      mountedRef.current
      && sessionGenerationRef.current === sessionGeneration
      && projectRef.current?.project_id === snapshot.project_id
      && projectFileRef.current === snapshotFile
    );
    setSettingsSaveState("saving");
    optionsRef.current.onSettingsSaveStarted?.();

    const saveRequest = (async (): Promise<PersistedProjectSettings | null> => {
      try {
        const payload = await saveCodesProject(snapshotFile, snapshot, snapshotHandle);
        if (!sessionIsCurrent()) return null;

        projectHandleRef.current = payload.handle;
        projectFileRef.current = payload.handle.project_file;
        setProjectHandle(payload.handle);
        setProjectFile(payload.handle.project_file);

        if (settingsEditVersionRef.current === editVersion) {
          projectRef.current = payload.project;
          settingsDirtyRef.current = false;
          projectConflictRef.current = null;
          setProject(payload.project);
          setSettingsDirty(false);
          setSettingsSaveState("saved");
          setProjectConflictState(null);
          optionsRef.current.onSettingsSaved?.();
          return { project: payload.project, handle: payload.handle };
        }

        // Keep the newer local edit, but advance its handle before serializing the follow-up save.
        return { project: projectRef.current as CodesProject, handle: payload.handle };
      } catch (error) {
        if (!sessionIsCurrent()) return null;
        if (error instanceof CodesProjectConflictError) {
          projectConflictRef.current = error;
          setProjectConflictState(error);
        }
        setSettingsSaveState("failed");
        optionsRef.current.onSettingsSaveError?.(error, "Project settings could not be saved.");
        return null;
      }
    })();
    settingsSavePromiseRef.current = saveRequest;

    let result: PersistedProjectSettings | null;
    try {
      result = await saveRequest;
    } finally {
      if (settingsSavePromiseRef.current === saveRequest) {
        settingsSavePromiseRef.current = null;
      }
    }

    if (!result || !sessionIsCurrent()) return null;
    return settingsDirtyRef.current
      ? persistSettings()
      : currentPersistedSettings() ?? result;
  }, [cancelScheduledSettingsSave, currentPersistedSettings]);

  const scheduleSettingsPersistence = useCallback((delay = SETTINGS_SAVE_DELAY_MS) => {
    if (!settingsDirtyRef.current) return;
    cancelScheduledSettingsSave();
    const sessionGeneration = sessionGenerationRef.current;
    settingsSaveTimerRef.current = window.setTimeout(() => {
      settingsSaveTimerRef.current = null;
      if (sessionGeneration === sessionGenerationRef.current) {
        void persistSettingsImmediately();
      }
    }, delay);
  }, [cancelScheduledSettingsSave, persistSettingsImmediately]);

  const updateProjectAiSettingsLocally = useCallback((update: Partial<CodesProject["ai_settings"]>) => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    updateProjectSettingsLocally((current) => ({
      ...current,
      ai_settings: { ...current.ai_settings, ...update }
    }));
    cancelScheduledSettingsSave();
    scheduleSettingsPersistence(0);
  }, [cancelScheduledSettingsSave, scheduleSettingsPersistence, updateProjectSettingsLocally]);

  const isSettingsPersistenceLocked = useCallback(
    () => settingsSavePromiseRef.current !== null,
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionGenerationRef.current += 1;
      cancelScheduledSettingsSave();
      settingsSavePromiseRef.current = null;
    };
  }, [cancelScheduledSettingsSave]);

  return {
    project,
    projectFile,
    projectHandle,
    projectConflict,
    settingsDirty,
    settingsSaveState,
    getCurrentSession,
    activateProjectSession,
    applyPersistedProject,
    clearProjectSession,
    setProjectConflict,
    updateProjectSettingsLocally,
    updateProjectAiSettingsLocally,
    scheduleSettingsPersistence,
    persistSettingsImmediately,
    isSettingsPersistenceLocked,
    cancelScheduledSettingsSave
  };
}
