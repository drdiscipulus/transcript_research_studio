import { useRef } from "react";
import type { CodesTranscript } from "../../lib/api";
import { ModalDialog } from "../workbench/ModalDialog";

type TranscriptActionDialogState = { kind: "remove"; transcript: CodesTranscript; evidenceCount: number } | null;

type CodesTranscriptActionDialogProps = {
  state: TranscriptActionDialogState;
  busy: boolean;
  mutationLocked?: boolean;
  error?: string | null;
  onConfirmRemove: () => void;
  onShowEvidence: () => void;
  onClose: () => void;
};

export function CodesTranscriptActionDialog({ state, busy, mutationLocked = false, error, onConfirmRemove, onShowEvidence, onClose }: CodesTranscriptActionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const blocked = (state?.evidenceCount ?? 0) > 0;
  return (
    <ModalDialog
      open={Boolean(state)}
      instanceKey={state?.transcript.transcript_id}
      className="codes-transcript-action-dialog"
      role={blocked ? "alertdialog" : "dialog"}
      title="Remove Transcript"
      initialFocusRef={cancelRef}
      cancelDisabled={busy}
      onCancel={onClose}
      footer={(
        <>
          {blocked ? <button type="button" className="secondary-button" onClick={onShowEvidence} disabled={busy}>Show Evidence</button> : (
            <button type="button" className="secondary-button danger-button" onClick={onConfirmRemove} disabled={busy || mutationLocked}>Remove Transcript</button>
          )}
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        </>
      )}
    >
      {state ? (blocked ? (
          <p>This transcript has {state.evidenceCount} evidence item(s). Remove those evidence items before removing the transcript.</p>
        ) : (
          <p>Remove <strong>{state.transcript.label}</strong> from this coding project? The original transcript file will not be deleted.</p>
        )) : null}
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}

export type { TranscriptActionDialogState };
