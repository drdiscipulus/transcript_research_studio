import { useRef } from "react";

import type { ModelsTarget } from "../../lib/modelsWorkspaceContracts";
import { ModalDialog } from "../workbench/ModalDialog";

type ModelsDeleteDialogProps = {
  open: boolean;
  requestKey: string | null;
  target: ModelsTarget | null;
  onConfirm: (requestKey: string | null) => void;
  onCancel: (requestKey: string | null) => void;
};

export function ModelsDeleteDialog({
  open,
  requestKey,
  target,
  onConfirm,
  onCancel
}: ModelsDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const visible = open && Boolean(requestKey) && Boolean(target);
  const description = target?.kind === "pyannote"
    ? "Delete the local Pyannote speaker recognition model? You will need a Hugging Face token to download it again."
    : `Delete the local ${target?.label ?? "selected"} faster-whisper model? You can download it again from Models.`;

  return (
    <ModalDialog
      open={visible}
      instanceKey={requestKey}
      className="editor-confirmation-dialog"
      role="alertdialog"
      title="Delete Model?"
      description={description}
      initialFocusRef={cancelRef}
      onCancel={() => onCancel(requestKey)}
      footer={requestKey ? (
        <>
          <button
            type="button"
            className="secondary-button danger-button"
            onClick={() => onConfirm(requestKey)}
          >
            Delete Model
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            onClick={() => onCancel(requestKey)}
          >
            Cancel
          </button>
        </>
      ) : null}
    />
  );
}
