import { useRef } from "react";
import { ModalDialog } from "../workbench/ModalDialog";

type EditorConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function EditorConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel
}: EditorConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalDialog
      open={open}
      className="editor-confirmation-dialog"
      role="alertdialog"
      title={title}
      description={description}
      initialFocusRef={cancelRef}
      onCancel={onCancel}
      footer={(
        <>
          <button
            type="button"
            className={`secondary-button${destructive ? " danger-button" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    />
  );
}
