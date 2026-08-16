import type { ButtonHTMLAttributes, ReactNode } from "react";

type CodesAiActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  action: string;
  children?: ReactNode;
  fullWidth?: boolean;
  simpleLabel?: boolean;
  busy?: boolean;
  busyLabel?: ReactNode;
};

export function CodesAiActionButton({ action, children, fullWidth, simpleLabel, busy = false, busyLabel, className = "", ...props }: CodesAiActionButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`secondary-button codes-ai-action-button${fullWidth ? " full-width" : ""}${className ? ` ${className}` : ""}`}
      aria-label={props["aria-label"] ?? `AI: ${action}`}
      aria-busy={busy || undefined}
    >
      {simpleLabel ? (
        <span className="codes-ai-action-sparkle" aria-hidden="true">✦</span>
      ) : (
        <span className="codes-ai-action-badge" aria-hidden="true"><span>✦</span> AI</span>
      )}
      <span>{busy ? (busyLabel ?? `${action}…`) : (children ?? action)}</span>
    </button>
  );
}
