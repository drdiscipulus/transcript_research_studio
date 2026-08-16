import type { CodesTranscript } from "../../lib/api";
import type { EvidenceDraftSelection } from "./codesPageUtils";

function closestSegmentId(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-codes-segment-id]")?.dataset.codesSegmentId ?? "";
}

function closestSegmentTextElement(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-codes-segment-text]") ?? null;
}

function validBoundaryOffset(node: Node, offset: number) {
  if (!Number.isInteger(offset) || offset < 0) return false;
  return node.nodeType === Node.TEXT_NODE
    ? offset <= (node.textContent?.length ?? 0)
    : offset <= node.childNodes.length;
}

function textOffsetWithin(element: HTMLElement, node: Node, offset: number) {
  if (
    (node !== element && !element.contains(node))
    || !validBoundaryOffset(node, offset)
    || (node instanceof Element ? node : node.parentElement)?.closest("[data-codes-nontranscript]")
  ) return null;

  try {
    const prefix = document.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(node, offset);
    const fragment = prefix.cloneContents();
    fragment.querySelectorAll?.("[data-codes-nontranscript]").forEach((excluded) => excluded.remove());
    return fragment.textContent?.length ?? 0;
  } catch {
    return null;
  }
}

function trimmedTextRange(text: string, startOffset: number, endOffset: number) {
  if (
    !Number.isInteger(startOffset)
    || !Number.isInteger(endOffset)
    || startOffset < 0
    || endOffset < startOffset
    || endOffset > text.length
  ) return null;

  const raw = text.slice(startOffset, endOffset);
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const trailingWhitespace = raw.length - raw.trimEnd().length;
  const start = startOffset + leadingWhitespace;
  const end = Math.max(start, endOffset - trailingWhitespace);
  const excerpt = text.slice(start, end);
  return excerpt ? { start, end, excerpt } : null;
}

export function evidenceSelectionFromDom(
  selection: Selection | null,
  transcript: CodesTranscript
): EvidenceDraftSelection | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.toString().trim()) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const startTextElement = closestSegmentTextElement(range.startContainer);
  const endTextElement = closestSegmentTextElement(range.endContainer);
  const startSegmentId = closestSegmentId(range.startContainer);
  const endSegmentId = closestSegmentId(range.endContainer);
  if (!startTextElement || !endTextElement || !startSegmentId || !endSegmentId) return null;

  const startIndex = transcript.segments.findIndex((segment) => segment.segment_id === startSegmentId);
  const endIndex = transcript.segments.findIndex((segment) => segment.segment_id === endSegmentId);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) return null;

  const startOffset = textOffsetWithin(startTextElement, range.startContainer, range.startOffset);
  const endOffset = textOffsetWithin(endTextElement, range.endContainer, range.endOffset);
  if (startOffset === null || endOffset === null) return null;

  const selectedSegments = transcript.segments.slice(startIndex, endIndex + 1);
  const anchoredSegments = selectedSegments.flatMap((segment, index) => {
    const rawStart = selectedSegments.length === 1 || index === 0 ? startOffset : 0;
    const rawEnd = selectedSegments.length === 1 || index === selectedSegments.length - 1
      ? endOffset
      : segment.text.length;
    const anchored = trimmedTextRange(segment.text, rawStart, rawEnd);
    return anchored ? [{ segment, anchored }] : [];
  });
  if (!anchoredSegments.length) return null;

  return {
    transcriptId: transcript.transcript_id,
    segmentIds: anchoredSegments.map(({ segment }) => segment.segment_id),
    selectedText: anchoredSegments.map(({ anchored }) => anchored.excerpt).join(" "),
    segmentRanges: Object.fromEntries(anchoredSegments.map(({ segment, anchored }) => [
      segment.segment_id,
      { start_offset: anchored.start, end_offset: anchored.end, excerpt: anchored.excerpt }
    ]))
  };
}
