import { useEffect, useRef } from "react";
import { ModalDialog } from "./ModalDialog";

export type ConfirmationIntent = {
  id: string;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
};

type ConfirmationDialogProps = {
  intent: ConfirmationIntent | null;
  busy?: boolean;
  onConfirm: (intent: ConfirmationIntent) => void;
  onCancel: () => void;
};

export function ConfirmationDialog({
  intent,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const admittedIntentRef = useRef<{ id: string; observedBusy: boolean } | null>(null);

  useEffect(() => {
    if (!intent || admittedIntentRef.current?.id !== intent.id) {
      admittedIntentRef.current = null;
      return;
    }
    if (busy) {
      admittedIntentRef.current.observedBusy = true;
    } else if (admittedIntentRef.current.observedBusy) {
      admittedIntentRef.current = null;
    }
  }, [busy, intent]);

  function confirm() {
    if (!intent || busy || admittedIntentRef.current?.id === intent.id) return;
    admittedIntentRef.current = { id: intent.id, observedBusy: false };
    onConfirm(intent);
  }

  return (
    <ModalDialog
      open={Boolean(intent)}
      instanceKey={intent?.id}
      role="alertdialog"
      title={intent?.title ?? "Confirm Action"}
      description={intent?.description}
      initialFocusRef={cancelRef}
      cancelDisabled={busy}
      onCancel={onCancel}
      className="confirmation-dialog"
      footer={intent ? (
        <>
          <button
            type="button"
            className={`secondary-button${intent.destructive ? " danger-button" : ""}`}
            disabled={busy}
            onClick={confirm}
          >
            {intent.confirmLabel}
          </button>
          <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : null}
    />
  );
}
