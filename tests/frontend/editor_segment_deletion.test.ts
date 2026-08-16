import { describe, expect, it } from "vitest";

import type { EditorTranscript } from "../../src/lib/api";
import { deleteSegmentAt } from "../../src/lib/editorState";

function transcriptWithSegments(count: number): EditorTranscript {
  return {
    source_transcript_file: "interview.json",
    source_document_id: "interview",
    media_file: "",
    language: "en",
    speakers: [{ id: "SPEAKER_00", name: "SPEAKER_00" }],
    segments: Array.from({ length: count }, (_, index) => ({
      id: `original_${index + 1}`,
      start: index * 10,
      end: (index + 1) * 10,
      speaker: "SPEAKER_00",
      text: `Segment ${index + 1}`
    })),
    metadata: {},
    validation_issues: []
  };
}

describe("deleteSegmentAt", () => {
  it.each([
    [0, ["Segment 2", "Segment 3"]],
    [1, ["Segment 1", "Segment 3"]],
    [2, ["Segment 1", "Segment 2"]]
  ])("deletes segment %i and renumbers the remaining segments", (index, expectedText) => {
    const result = deleteSegmentAt(transcriptWithSegments(3), index);

    expect(result.segments.map((segment) => segment.text)).toEqual(expectedText);
    expect(result.segments.map((segment) => segment.id)).toEqual(["seg_000001", "seg_000002"]);
    expect(result.speakers).toEqual([{ id: "SPEAKER_00", name: "SPEAKER_00" }]);
  });

  it("does not delete the sole remaining segment or accept an invalid index", () => {
    const singleSegment = transcriptWithSegments(1);
    const multipleSegments = transcriptWithSegments(2);

    expect(deleteSegmentAt(singleSegment, 0)).toBe(singleSegment);
    expect(deleteSegmentAt(multipleSegments, -1)).toBe(multipleSegments);
    expect(deleteSegmentAt(multipleSegments, 2)).toBe(multipleSegments);
  });
});
