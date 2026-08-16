import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SegmentToolbar } from "../../src/components/editor/SegmentToolbar";

describe("SegmentToolbar", () => {
  it("uses explicit same-speaker merge wording without repeating the transcript filename", () => {
    const { container } = render(
      <SegmentToolbar
        segmentRangeLabel="1-5 of 20"
        totalSegments={20}
        totalPages={4}
        currentPage={0}
        segmentsPerPage={5}
        pageSizeOptions={[5, 10]}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onMergeAdjacentSameSpeakerSegments={vi.fn()}
        onSegmentsPerPageChange={vi.fn()}
        onPageChange={vi.fn()}
        onPreviousPage={vi.fn()}
        onNextPage={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Merge Adjacent Same-Speaker Segments" })).toBeEnabled();
    expect(screen.getByText("Segments Per Page")).toBeInTheDocument();
    expect(screen.getByText("Showing 1-5 of 20")).toBeInTheDocument();
    expect(container.querySelector(".editor-segment-source")).not.toBeInTheDocument();
  });
});
