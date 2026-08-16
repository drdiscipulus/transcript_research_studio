import { afterEach, describe, expect, it } from "vitest";
import { evidenceSelectionFromDom } from "../../src/components/codes/codesEvidenceSelection";
import type { CodesTranscript } from "../../src/lib/api";

const transcript: CodesTranscript = {
  transcript_id: "T000001",
  label: "Interview",
  source_file: "interview.json",
  source_document_id: "document-1",
  imported_at: "",
  refreshed_at: null,
  language: "en",
  speakers: [],
  segments: [
    { segment_id: "seg_1", start: 0, end: 1, speaker: "SPEAKER_00", text: "  Alpha beta  " },
    { segment_id: "seg_2", start: 1, end: 2, speaker: "SPEAKER_01", text: "Gamma delta" }
  ],
  metadata: {},
  validation_issues: []
};

function mountSegments(secondId = "seg_2") {
  document.body.innerHTML = `
    <article data-codes-segment-id="seg_1">
      <div data-codes-nontranscript>1</div>
      <p data-codes-segment-text>  <span>Alpha</span> beta  </p>
    </article>
    <article data-codes-segment-id="${secondId}">
      <p data-codes-segment-text><strong>Gamma</strong> delta</p>
    </article>
    <p id="outside">Outside text</p>
  `;
  const firstText = document.querySelector("[data-codes-segment-id='seg_1'] [data-codes-segment-text]") as HTMLElement;
  const secondText = document.querySelector(`[data-codes-segment-id='${secondId}'] [data-codes-segment-text]`) as HTMLElement;
  return { firstText, secondText };
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("Codes DOM evidence selection", () => {
  it("anchors and trims a same-segment selection inside nested text nodes", () => {
    const { firstText } = mountSegments();
    const alpha = firstText.querySelector("span")?.firstChild as Text;
    const trailing = firstText.lastChild as Text;
    const selection = select(alpha, 0, trailing, trailing.data.length);

    expect(evidenceSelectionFromDom(selection, transcript)).toEqual({
      transcriptId: "T000001",
      segmentIds: ["seg_1"],
      selectedText: "Alpha beta",
      segmentRanges: {
        seg_1: { start_offset: 2, end_offset: 12, excerpt: "Alpha beta" }
      }
    });
  });

  it("anchors an ordered multi-segment selection and joins excerpts with one space", () => {
    const { firstText, secondText } = mountSegments();
    const alpha = firstText.querySelector("span")?.firstChild as Text;
    const gamma = secondText.querySelector("strong")?.firstChild as Text;
    const selection = select(alpha, 1, gamma, 4);

    expect(evidenceSelectionFromDom(selection, transcript)).toEqual({
      transcriptId: "T000001",
      segmentIds: ["seg_1", "seg_2"],
      selectedText: "lpha beta Gamm",
      segmentRanges: {
        seg_1: { start_offset: 3, end_offset: 12, excerpt: "lpha beta" },
        seg_2: { start_offset: 0, end_offset: 4, excerpt: "Gamm" }
      }
    });
  });

  it("rejects empty, collapsed, and outside selections", () => {
    const { firstText } = mountSegments();
    const alpha = firstText.querySelector("span")?.firstChild as Text;
    const collapsed = select(alpha, 1, alpha, 1);
    expect(evidenceSelectionFromDom(collapsed, transcript)).toBeNull();

    const outside = document.getElementById("outside")?.firstChild as Text;
    expect(evidenceSelectionFromDom(select(outside, 0, outside, 7), transcript)).toBeNull();
    expect(evidenceSelectionFromDom(null, transcript)).toBeNull();
  });

  it("rejects unknown and reversed segment order", () => {
    const unknown = mountSegments("seg_unknown");
    const unknownText = unknown.secondText.querySelector("strong")?.firstChild as Text;
    expect(evidenceSelectionFromDom(select(unknownText, 0, unknownText, 5), transcript)).toBeNull();

    const { firstText, secondText } = mountSegments();
    const first = firstText.querySelector("span")?.firstChild as Text;
    const second = secondText.querySelector("strong")?.firstChild as Text;
    const fakeRange = {
      collapsed: false,
      startContainer: second,
      startOffset: 0,
      endContainer: first,
      endOffset: 5
    } as Range;
    const fakeSelection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "Gamma Alpha",
      getRangeAt: () => fakeRange
    } as unknown as Selection;
    expect(evidenceSelectionFromDom(fakeSelection, transcript)).toBeNull();
  });

  it("rejects impossible offsets and boundaries inside non-transcript UI", () => {
    const { firstText } = mountSegments();
    const alpha = firstText.querySelector("span")?.firstChild as Text;
    const invalidRange = {
      collapsed: false,
      startContainer: alpha,
      startOffset: 99,
      endContainer: alpha,
      endOffset: 100
    } as Range;
    const invalidSelection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "Alpha",
      getRangeAt: () => invalidRange
    } as unknown as Selection;
    expect(evidenceSelectionFromDom(invalidSelection, transcript)).toBeNull();

    const excluded = document.querySelector("[data-codes-nontranscript]")?.firstChild as Text;
    expect(evidenceSelectionFromDom(select(excluded, 0, excluded, 1), transcript)).toBeNull();
  });

  it("rejects selections with multiple ranges", () => {
    const { firstText } = mountSegments();
    const alpha = firstText.querySelector("span")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(alpha, 0);
    range.setEnd(alpha, 2);
    const selection = {
      rangeCount: 2,
      isCollapsed: false,
      toString: () => "Al",
      getRangeAt: () => range
    } as unknown as Selection;

    expect(evidenceSelectionFromDom(selection, transcript)).toBeNull();
  });

  it("rejects impossible element-node offsets", () => {
    const { firstText } = mountSegments();
    const invalidRange = {
      collapsed: false,
      startContainer: firstText,
      startOffset: firstText.childNodes.length + 1,
      endContainer: firstText,
      endOffset: firstText.childNodes.length
    } as Range;
    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "Alpha",
      getRangeAt: () => invalidRange
    } as unknown as Selection;

    expect(evidenceSelectionFromDom(selection, transcript)).toBeNull();
  });

  it("rejects a DOM segment order that does not match the active transcript", () => {
    document.body.innerHTML = `
      <article data-codes-segment-id="seg_2">
        <p data-codes-segment-text>Gamma delta</p>
      </article>
      <article data-codes-segment-id="seg_1">
        <p data-codes-segment-text>Alpha beta</p>
      </article>
    `;
    const first = document.querySelector("[data-codes-segment-id='seg_2'] [data-codes-segment-text]")?.firstChild as Text;
    const second = document.querySelector("[data-codes-segment-id='seg_1'] [data-codes-segment-text]")?.firstChild as Text;

    expect(evidenceSelectionFromDom(select(first, 0, second, 5), transcript)).toBeNull();
  });
});
