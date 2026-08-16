import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

export type WorkbenchPageId =
  | "home"
  | "transcription"
  | "editor"
  | "codes"
  | "models"
  | "prompting"
  | "help";

export type WorkbenchPageState = {
  dirty: boolean;
  activeJob: boolean;
  activityLabel: string;
};

type WorkbenchContextValue = {
  activePage: WorkbenchPageId;
  visitedPages: ReadonlySet<WorkbenchPageId>;
  pageStates: Readonly<Record<WorkbenchPageId, WorkbenchPageState>>;
  navigateTo: (pageId: WorkbenchPageId) => void;
  reportPageState: (pageId: WorkbenchPageId, state: WorkbenchPageState) => void;
};

const EMPTY_PAGE_STATE: WorkbenchPageState = {
  dirty: false,
  activeJob: false,
  activityLabel: ""
};

const initialPageStates: Record<WorkbenchPageId, WorkbenchPageState> = {
  home: EMPTY_PAGE_STATE,
  transcription: EMPTY_PAGE_STATE,
  editor: EMPTY_PAGE_STATE,
  codes: EMPTY_PAGE_STATE,
  models: EMPTY_PAGE_STATE,
  prompting: EMPTY_PAGE_STATE,
  help: EMPTY_PAGE_STATE
};

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function WorkbenchLifecycleProvider({ children }: { children: ReactNode }) {
  const [activePage, setActivePage] = useState<WorkbenchPageId>("home");
  const [visitedPages, setVisitedPages] = useState<Set<WorkbenchPageId>>(() => new Set(["home"]));
  const [pageStates, setPageStates] = useState(initialPageStates);

  const navigateTo = useCallback((pageId: WorkbenchPageId) => {
    setVisitedPages((current) => {
      if (current.has(pageId)) {
        return current;
      }
      const next = new Set(current);
      next.add(pageId);
      return next;
    });
    setActivePage(pageId);
  }, []);

  const reportPageState = useCallback((pageId: WorkbenchPageId, state: WorkbenchPageState) => {
    setPageStates((current) => {
      const previous = current[pageId];
      if (
        previous.dirty === state.dirty &&
        previous.activeJob === state.activeJob &&
        previous.activityLabel === state.activityLabel
      ) {
        return current;
      }
      return { ...current, [pageId]: state };
    });
  }, []);

  const value = useMemo<WorkbenchContextValue>(() => ({
    activePage,
    visitedPages,
    pageStates,
    navigateTo,
    reportPageState
  }), [activePage, navigateTo, pageStates, reportPageState, visitedPages]);

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbenchLifecycle(): WorkbenchContextValue {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error("Workbench lifecycle must be used inside WorkbenchLifecycleProvider.");
  }
  return context;
}

export function useWorkbenchPageLifecycle(
  pageId: WorkbenchPageId,
  state: Partial<WorkbenchPageState>
): boolean {
  const { activePage, reportPageState } = useWorkbenchLifecycle();
  const dirty = Boolean(state.dirty);
  const activeJob = Boolean(state.activeJob);
  const activityLabel = state.activityLabel?.trim() ?? "";

  useEffect(() => {
    reportPageState(pageId, { dirty, activeJob, activityLabel });
  }, [activeJob, activityLabel, dirty, pageId, reportPageState]);

  useEffect(() => {
    return () => {
      reportPageState(pageId, EMPTY_PAGE_STATE);
    };
  }, [pageId, reportPageState]);

  return activePage === pageId;
}

export function WorkbenchPageHost({
  pageId,
  children
}: {
  pageId: WorkbenchPageId;
  children: ReactNode;
}) {
  const { activePage, visitedPages } = useWorkbenchLifecycle();
  if (!visitedPages.has(pageId)) {
    return null;
  }
  const isActive = activePage === pageId;
  return (
    <section
      className="workbench-page-host"
      hidden={!isActive}
      aria-hidden={!isActive}
      data-page-id={pageId}
    >
      {children}
    </section>
  );
}
