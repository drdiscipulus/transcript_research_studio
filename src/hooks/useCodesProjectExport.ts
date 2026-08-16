import { useCallback, useEffect, useRef, useState } from "react";
import {
  exportCodesProjectBundle,
  openPath,
  pickCodesExportBundleFile,
  type CodesDocxMode,
  type CodesExportArtifact,
  type CodesExportProduct,
  type CodesProjectHandle
} from "../lib/api";
import { fileName, pathDirectory, projectSaveName } from "../lib/codesProjectPaths";
import type { CodesProjectSessionSnapshot } from "./useCodesProjectSession";

type ExportSessionIdentity = {
  projectId: string;
  projectFile: string;
  revision: string;
};

type ExportResult = {
  identity: ExportSessionIdentity;
  bundlePath: string;
  outputFolder: string;
  artifacts: CodesExportArtifact[];
  warnings: string[];
  status: string;
};

type ExportError = {
  identity: ExportSessionIdentity;
  message: string;
};

type CodesProjectExportOptions = {
  desktopAvailable: boolean;
  getCurrentSession: () => CodesProjectSessionSnapshot;
};

function sessionIdentity(session: CodesProjectSessionSnapshot): ExportSessionIdentity | null {
  if (!session.project || !session.projectFile || !session.projectHandle) return null;
  if (
    session.project.project_id !== session.projectHandle.project_id
    || session.projectFile !== session.projectHandle.project_file
  ) return null;
  return {
    projectId: session.project.project_id,
    projectFile: session.projectFile,
    revision: session.projectHandle.revision
  };
}

function sameExactSession(left: ExportSessionIdentity, right: ExportSessionIdentity | null) {
  return Boolean(
    right
    && left.projectId === right.projectId
    && left.projectFile === right.projectFile
    && left.revision === right.revision
  );
}

function cloneHandle(handle: CodesProjectHandle): CodesProjectHandle {
  return { ...handle };
}

export function useCodesProjectExport(options: CodesProjectExportOptions) {
  const [products, setProducts] = useState<CodesExportProduct[]>(["xlsx"]);
  const [docxMode, setDocxMode] = useState<CodesDocxMode>("separate");
  const [includeLocalPaths, setIncludeLocalPaths] = useState(false);
  const [includeAiAudit, setIncludeAiAudit] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [exportError, setExportError] = useState<ExportError | null>(null);
  const [busy, setBusy] = useState(false);

  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const nextRequestIdRef = useRef(0);
  const activeRequestIdRef = useRef<number | null>(null);
  const previousIdentityRef = useRef<ExportSessionIdentity | null>(
    sessionIdentity(options.getCurrentSession())
  );
  optionsRef.current = options;

  const renderedIdentity = sessionIdentity(options.getCurrentSession());
  const renderedIdentityKey = renderedIdentity
    ? `${renderedIdentity.projectId}\u0000${renderedIdentity.projectFile}\u0000${renderedIdentity.revision}`
    : "";

  const currentIdentity = useCallback(
    () => sessionIdentity(optionsRef.current.getCurrentSession()),
    []
  );

  const requestIsActive = useCallback((requestId: number) => Boolean(
    mountedRef.current && activeRequestIdRef.current === requestId
  ), []);

  const startRequest = useCallback(() => {
    const requestId = ++nextRequestIdRef.current;
    activeRequestIdRef.current = requestId;
    setBusy(true);
    return requestId;
  }, []);

  const finishRequest = useCallback((requestId: number) => {
    if (!requestIsActive(requestId)) return;
    activeRequestIdRef.current = null;
    setBusy(false);
  }, [requestIsActive]);

  const invalidateRequests = useCallback(() => {
    nextRequestIdRef.current += 1;
    activeRequestIdRef.current = null;
    setBusy(false);
  }, []);

  const toggleProduct = useCallback((product: CodesExportProduct) => {
    setProducts((current) => current.includes(product)
      ? current.filter((item) => item !== product)
      : [...current, product]);
  }, []);

  const exportProject = useCallback(async () => {
    const session = optionsRef.current.getCurrentSession();
    const identity = sessionIdentity(session);
    if (
      !optionsRef.current.desktopAvailable
      || !identity
      || !session.project
      || !session.projectHandle
      || products.length === 0
    ) return;

    const requestId = startRequest();
    const request = {
      identity,
      project: session.project,
      handle: cloneHandle(session.projectHandle),
      products: [...products],
      docxMode,
      includeLocalPaths,
      includeAiAudit
    };

    let selectedPath: string | null;
    try {
      const defaultBaseName = projectSaveName(request.project).replace(/\.evidence\.json$/i, "");
      selectedPath = await pickCodesExportBundleFile(
        `${defaultBaseName}_export.zip`,
        request.identity.projectFile
      );
    } catch (error) {
      if (requestIsActive(requestId) && sameExactSession(request.identity, currentIdentity())) {
        setExportError({
          identity: request.identity,
          message: error instanceof Error ? error.message : "Coding project could not be exported."
        });
      }
      finishRequest(requestId);
      return;
    }

    if (
      !requestIsActive(requestId)
      || !sameExactSession(request.identity, currentIdentity())
      || !selectedPath
    ) {
      finishRequest(requestId);
      return;
    }

    const outputFolder = pathDirectory(selectedPath);
    if (!outputFolder) {
      setExportError({ identity: request.identity, message: "Choose a valid output file location." });
      finishRequest(requestId);
      return;
    }

    setExportError(null);
    setResult(null);
    try {
      const payload = await exportCodesProjectBundle({
        handle: request.handle,
        output_file: selectedPath,
        products: request.products,
        docx_mode: request.docxMode,
        include_local_paths: request.includeLocalPaths,
        include_ai_audit: request.includeAiAudit
      });
      if (!requestIsActive(requestId) || !sameExactSession(request.identity, currentIdentity())) return;

      setResult({
        identity: request.identity,
        bundlePath: payload.bundle.path,
        outputFolder,
        artifacts: payload.artifacts,
        warnings: payload.warnings,
        status: `Created ${fileName(payload.bundle.path)} with ${payload.artifacts.length} contained file(s).`
      });
    } catch (error) {
      if (requestIsActive(requestId) && sameExactSession(request.identity, currentIdentity())) {
        setExportError({
          identity: request.identity,
          message: error instanceof Error ? error.message : "Coding project could not be exported."
        });
      }
    } finally {
      finishRequest(requestId);
    }
  }, [currentIdentity, docxMode, finishRequest, includeAiAudit, includeLocalPaths, products, requestIsActive, startRequest]);

  const openOutputFolder = useCallback(async () => {
    const visibleResult = result;
    if (!visibleResult || !sameExactSession(visibleResult.identity, currentIdentity())) return;

    const requestId = startRequest();
    setExportError(null);
    try {
      await openPath({
        path: visibleResult.outputFolder,
        expect_directory: true,
        create_if_missing: false
      });
    } catch (error) {
      if (
        requestIsActive(requestId)
        && sameExactSession(visibleResult.identity, currentIdentity())
        && visibleResult === result
      ) {
        setExportError({
          identity: visibleResult.identity,
          message: error instanceof Error ? error.message : "The output folder could not be opened."
        });
      }
    } finally {
      finishRequest(requestId);
    }
  }, [currentIdentity, finishRequest, requestIsActive, result, startRequest]);

  const reset = useCallback(() => {
    invalidateRequests();
    setResult(null);
    setExportError(null);
    setIncludeLocalPaths(false);
    setIncludeAiAudit(false);
  }, [invalidateRequests]);

  const isLocked = useCallback(() => activeRequestIdRef.current !== null, []);

  useEffect(() => {
    const nextIdentity = currentIdentity();
    const previousIdentity = previousIdentityRef.current;
    previousIdentityRef.current = nextIdentity;
    const logicalProjectChanged = previousIdentity?.projectId !== nextIdentity?.projectId;
    const exactSessionChanged = previousIdentity?.projectId !== nextIdentity?.projectId
      || previousIdentity?.projectFile !== nextIdentity?.projectFile
      || previousIdentity?.revision !== nextIdentity?.revision;
    if (!exactSessionChanged) return;

    invalidateRequests();
    setResult(null);
    setExportError(null);
    if (logicalProjectChanged) {
      setIncludeLocalPaths(false);
      setIncludeAiAudit(false);
    }
  }, [currentIdentity, invalidateRequests, renderedIdentityKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      nextRequestIdRef.current += 1;
      activeRequestIdRef.current = null;
    };
  }, []);

  const visibleResult = result && renderedIdentity && sameExactSession(result.identity, renderedIdentity)
    ? result
    : null;
  const visibleError = exportError && renderedIdentity && sameExactSession(exportError.identity, renderedIdentity)
    ? exportError.message
    : null;

  return {
    products,
    docxMode,
    includeLocalPaths,
    includeAiAudit,
    bundlePath: visibleResult?.bundlePath ?? "",
    artifacts: visibleResult?.artifacts ?? [],
    warnings: visibleResult?.warnings ?? [],
    status: visibleResult?.status ?? "",
    error: visibleError,
    busy,
    isLocked,
    toggleProduct,
    setDocxMode,
    setIncludeLocalPaths,
    setIncludeAiAudit,
    exportProject,
    openOutputFolder,
    reset
  };
}
