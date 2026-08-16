import type { EditorSpeaker } from "../../lib/api";
import { formatSeconds, type EditorSegment } from "../../lib/editorState";
import { AutoResizeTextarea } from "./AutoResizeTextarea";
import { EditorIconButton, PauseIcon, PlayIcon, StopIcon, TrashIcon } from "./EditorIcons";

type SegmentCardProps = {
  segment: EditorSegment;
  index: number;
  active: boolean;
  speakers: EditorSpeaker[];
  speakerNameMap: Record<string, string>;
  canPlay: boolean;
  isPlaying: boolean;
  canMergeNext: boolean;
  canDelete: boolean;
  mutationLocked?: boolean;
  onActivate: (index: number) => void;
  onPlayPause: (index: number) => void;
  onStop: (index: number) => void;
  onUpdateSegment: (index: number, patch: Partial<EditorSegment>) => void;
  onRememberCursor: (segmentId: string, selectionStart: number | null) => void;
  onSplit: (index: number) => void;
  onMergeNext: (index: number) => void;
  onDelete: (index: number) => void;
};

export function SegmentCard({
  segment,
  index,
  active,
  speakers,
  speakerNameMap,
  canPlay,
  isPlaying,
  canMergeNext,
  canDelete,
  mutationLocked = false,
  onActivate,
  onPlayPause,
  onStop,
  onUpdateSegment,
  onRememberCursor,
  onSplit,
  onMergeNext,
  onDelete
}: SegmentCardProps) {
  return (
    <article className={active ? "segment-card active" : "segment-card"}>
      <div className="segment-card-header">
        <EditorIconButton
          label={isPlaying ? `Pause segment ${index + 1}` : `Play segment ${index + 1}`}
          title={canPlay ? (isPlaying ? "Pause this segment." : "Play only this segment.") : "Segment playback requires linked media plus start and end timestamps."}
          disabled={!canPlay}
          onClick={() => onPlayPause(index)}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </EditorIconButton>
        <EditorIconButton
          label={`Stop segment ${index + 1}`}
          title={canPlay ? "Stop and reset this segment to its start." : "Segment playback requires linked media plus start and end timestamps."}
          disabled={!canPlay}
          onClick={() => onStop(index)}
        >
          <StopIcon />
        </EditorIconButton>
        <button type="button" className="segment-index-button" onClick={() => onActivate(index)}>
          {index + 1}
        </button>
        <span className="timestamp-range">{formatSeconds(segment.start)} - {formatSeconds(segment.end)}</span>
        <label className="editor-speaker-field">
          <select
            className="text-input"
            value={segment.speaker}
            disabled={mutationLocked}
            onChange={(event) => onUpdateSegment(index, { speaker: event.target.value })}
          >
            <option value="">No speaker assigned</option>
            {speakers.map((speaker) => (
              <option key={speaker.id} value={speaker.id}>
                {speakerNameMap[speaker.id] || speaker.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary-button compact" onClick={() => onSplit(index)} disabled={mutationLocked}>
          Split
        </button>
        <button
          type="button"
          className="secondary-button compact"
          onClick={() => onMergeNext(index)}
          disabled={mutationLocked || !canMergeNext}
        >
          Merge with Next
        </button>
        <EditorIconButton
          label="Delete Segment"
          title={canDelete ? "Delete this segment. You can restore it with Undo." : "A transcript must contain at least one segment."}
          className="editor-delete-segment-button"
          disabled={mutationLocked || !canDelete}
          onClick={() => onDelete(index)}
        >
          <TrashIcon />
        </EditorIconButton>
      </div>
      <AutoResizeTextarea
        className="text-input"
        value={segment.text}
        disabled={mutationLocked}
        onFocus={(event) => {
          onActivate(index);
          onRememberCursor(segment.id, event.currentTarget.selectionStart);
        }}
        onClick={(event) => onRememberCursor(segment.id, event.currentTarget.selectionStart)}
        onKeyUp={(event) => onRememberCursor(segment.id, event.currentTarget.selectionStart)}
        onSelect={(event) => onRememberCursor(segment.id, event.currentTarget.selectionStart)}
        onChange={(event) => {
          onRememberCursor(segment.id, event.currentTarget.selectionStart);
          onUpdateSegment(index, { text: event.target.value });
        }}
        rows={3}
      />
    </article>
  );
}
