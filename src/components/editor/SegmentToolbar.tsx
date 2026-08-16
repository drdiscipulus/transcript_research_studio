import { FieldLabelWithHelp } from "../FieldLabelWithHelp";
import { EditorIconButton, RedoIcon, UndoIcon } from "./EditorIcons";

type SegmentToolbarProps = {
  segmentRangeLabel: string;
  totalSegments: number;
  totalPages: number;
  currentPage: number;
  segmentsPerPage: number;
  pageSizeOptions: number[];
  canUndo: boolean;
  canRedo: boolean;
  mutationLocked?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onMergeAdjacentSameSpeakerSegments: () => void;
  onSegmentsPerPageChange: (pageSize: number) => void;
  onPageChange: (page: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
};

export function SegmentToolbar({
  segmentRangeLabel,
  totalSegments,
  totalPages,
  currentPage,
  segmentsPerPage,
  pageSizeOptions,
  canUndo,
  canRedo,
  mutationLocked = false,
  onUndo,
  onRedo,
  onMergeAdjacentSameSpeakerSegments,
  onSegmentsPerPageChange,
  onPageChange,
  onPreviousPage,
  onNextPage
}: SegmentToolbarProps) {
  return (
    <div className="section-heading">
      <div>
        <h3 className="home-section-title">
          <FieldLabelWithHelp
            label="Segments"
            helpText="Edit segment text, assign speakers, split at the cursor, merge with the next segment, or combine consecutive segments whose speaker assignments match. Undo and redo step through editor changes in this session. Playback uses linked media and start/end timestamps. Pagination only changes how many cards are shown."
            labelClassName="home-section-title"
          />
        </h3>
        <p>Showing {segmentRangeLabel}</p>
      </div>
      <div className="editor-pagination">
        <EditorIconButton
          label="Undo"
          title="Undo last editor change"
          disabled={mutationLocked || !canUndo}
          onClick={onUndo}
        >
          <UndoIcon />
        </EditorIconButton>
        <EditorIconButton
          label="Redo"
          title="Redo last undone editor change"
          disabled={mutationLocked || !canRedo}
          onClick={onRedo}
        >
          <RedoIcon />
        </EditorIconButton>
        <button
          type="button"
          className="secondary-button compact"
          onClick={onMergeAdjacentSameSpeakerSegments}
          disabled={mutationLocked || totalSegments < 2}
          title="Merge consecutive segments when they have the same assigned speaker"
        >
          Merge Adjacent Same-Speaker Segments
        </button>
        <label className="editor-inline-control editor-page-size-field">
          <span className="field-label">Segments Per Page</span>
          <select
            className="text-input editor-page-size-select"
            value={segmentsPerPage}
            onChange={(event) => onSegmentsPerPageChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((pageSize) => (
              <option key={pageSize} value={pageSize}>
                {pageSize}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button compact"
          onClick={onPreviousPage}
          disabled={currentPage <= 0}
        >
          Previous
        </button>
        <select
          className="text-input editor-page-select"
          value={currentPage}
          onChange={(event) => onPageChange(Number(event.target.value))}
        >
          {Array.from({ length: totalPages }, (_, page) => (
            <option key={page} value={page}>
              Page {page + 1} / {totalPages}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary-button compact"
          onClick={onNextPage}
          disabled={currentPage >= totalPages - 1}
        >
          Next
        </button>
      </div>
    </div>
  );
}
