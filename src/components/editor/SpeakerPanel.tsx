import { useState } from "react";
import type { EditorSpeaker } from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";

type SpeakerPanelProps = {
  speakers: EditorSpeaker[];
  mutationLocked?: boolean;
  onUpdateSpeaker: (speakerId: string, name: string) => void;
  onRemoveSpeaker: (speakerId: string) => void;
  onAddSpeaker: () => void;
};

export function SpeakerPanel({ speakers, mutationLocked = false, onUpdateSpeaker, onRemoveSpeaker, onAddSpeaker }: SpeakerPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <section className={`section-card speaker-accordion${isOpen ? " open" : ""}`}>
      <div className="speaker-panel">
        <div className="speaker-accordion-header">
          <button
            type="button"
            className="transcription-advanced-summary speaker-accordion-summary"
            aria-expanded={isOpen}
            aria-controls="editor-speaker-accordion-content"
            onClick={() => setIsOpen((open) => !open)}
          >
            <span className="transcription-advanced-chevron" aria-hidden="true">›</span>
            <span className="transcription-advanced-summary-label">Speakers ({speakers.length})</span>
          </button>
          <FieldLabelWithHelp
            label="Speakers"
            helpText="Rename detected speaker IDs, add speakers when the transcript missed one, then assign speakers from each segment dropdown. Deleting a speaker clears its segment assignments after confirmation."
            hideLabel
          />
        </div>
        <div
          id="editor-speaker-accordion-content"
          className="speaker-accordion-content"
          hidden={!isOpen}
        >
          {speakers.length > 0 ? (
            <div className="speaker-list">
              {speakers.map((speaker) => (
                <div key={speaker.id} className="speaker-row">
                  <span>{speaker.id}</span>
                  <input
                    className="text-input"
                    value={speaker.name}
                    disabled={mutationLocked}
                    aria-label={`Display name for ${speaker.id}`}
                    onChange={(event) => onUpdateSpeaker(speaker.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className="secondary-button danger-button model-action-button speaker-delete-button"
                    onClick={() => onRemoveSpeaker(speaker.id)}
                    disabled={mutationLocked}
                    aria-label={`Delete ${speaker.id}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state compact-empty-state">
              <strong>No speakers detected</strong>
              <p>Add speakers manually if you want to label segments.</p>
            </div>
          )}
          <div className="speaker-panel-actions">
            <button type="button" className="secondary-button compact" onClick={onAddSpeaker} disabled={mutationLocked}>
              Add Speaker
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
