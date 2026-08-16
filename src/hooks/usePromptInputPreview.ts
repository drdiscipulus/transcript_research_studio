import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  inspectPromptInput,
  type PromptAdvancedMapping,
  type PromptInputCandidate,
  type PromptInputInspectResult
} from "../lib/api";

type InputMode = "file" | "folder";

function candidateIsSelectable(candidate: PromptInputCandidate): boolean {
  return candidate.status === "ready" || candidate.status === "equivalent_format";
}

export function usePromptInputPreview(inputMode: InputMode, inputPath: string) {
  const [storedPreview, setStoredPreview] = useState<PromptInputInspectResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [candidateMappings, setCandidateMappings] = useState<Record<string, PromptAdvancedMapping>>({});
  const candidateMappingsRef = useRef<Record<string, PromptAdvancedMapping>>({});
  const requestGenerationRef = useRef(0);

  const preview = useMemo(() => {
    if (!storedPreview) return null;
    return storedPreview.input_mode === inputMode && storedPreview.input_path === inputPath
      ? storedPreview
      : null;
  }, [inputMode, inputPath, storedPreview]);

  const inspectInput = useCallback(async (
    mode: InputMode,
    path: string,
    mappings: Record<string, PromptAdvancedMapping>
  ) => {
    const requestGeneration = ++requestGenerationRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await inspectPromptInput({
        input_mode: mode,
        input_path: path,
        candidate_mappings: mappings
      });
      if (requestGeneration !== requestGenerationRef.current) return;
      setStoredPreview(result);
      setPreviewOpen(
        result.counts.decisions_required > 0
          || result.counts.mapping_required > 0
          || result.counts.problems > 0
      );
      setSelectedCandidateIds((current) => {
        const selectable = new Set(
          result.candidates.filter(candidateIsSelectable).map((candidate) => candidate.candidate_id)
        );
        const retained = current.filter((candidateId) => selectable.has(candidateId));
        const ready = result.candidates
          .filter((candidate) => candidate.status === "ready")
          .map((candidate) => candidate.candidate_id);
        return Array.from(new Set([...retained, ...ready]));
      });
    } catch (error) {
      if (requestGeneration !== requestGenerationRef.current) return;
      setStoredPreview(null);
      setSelectedCandidateIds([]);
      setPreviewError(error instanceof Error ? error.message : "Transcript input could not be inspected.");
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setPreviewLoading(false);
      }
    }
  }, []);

  const clearPreview = useCallback((clearMappings = true) => {
    requestGenerationRef.current += 1;
    setStoredPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewOpen(false);
    setSelectedCandidateIds([]);
    if (clearMappings) {
      candidateMappingsRef.current = {};
      setCandidateMappings({});
    }
  }, []);

  useEffect(() => {
    if (!inputPath.trim()) {
      clearPreview(false);
      return;
    }
    void inspectInput(inputMode, inputPath, candidateMappingsRef.current);
    // Mapping changes explicitly start their own request so one edit produces one inspection.
  }, [clearPreview, inputMode, inputPath, inspectInput]);

  const selectCandidate = useCallback((candidate: PromptInputCandidate) => {
    if (!candidateIsSelectable(candidate)) return;
    setSelectedCandidateIds((current) => {
      if (candidate.equivalent_group && preview) {
        const groupIds = preview.candidates
          .filter((item) => item.equivalent_group === candidate.equivalent_group)
          .map((item) => item.candidate_id);
        return [...current.filter((candidateId) => !groupIds.includes(candidateId)), candidate.candidate_id];
      }
      return current.includes(candidate.candidate_id)
        ? current.filter((candidateId) => candidateId !== candidate.candidate_id)
        : [...current, candidate.candidate_id];
    });
  }, [preview]);

  const updateCandidateMapping = useCallback((
    candidate: PromptInputCandidate,
    key: keyof PromptAdvancedMapping,
    value: string
  ) => {
    const currentMappings = candidateMappingsRef.current;
    const next = {
      ...currentMappings,
      [candidate.source_path]: {
        ...(currentMappings[candidate.source_path] ?? candidate.mapping),
        [key]: value
      }
    };
    candidateMappingsRef.current = next;
    setCandidateMappings(next);
    void inspectInput(inputMode, inputPath, next);
  }, [inputMode, inputPath, inspectInput]);

  return {
    preview,
    previewLoading,
    previewError,
    previewOpen,
    selectedCandidateIds,
    candidateMappings,
    setPreviewOpen,
    selectCandidate,
    updateCandidateMapping,
    clearPreview
  };
}
