import type { ButtonHTMLAttributes, ReactNode } from "react";

type EditorIconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
};

export function EditorIconButton({ label, children, className = "", ...props }: EditorIconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button editor-action-icon-button ${className}`.trim()}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7h10v10H7z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 20a2 2 0 0 1-2-2V7h14v11a2 2 0 0 1-2 2H7zm10-15H7V3h3.5l1-1h1l1 1H17v2z" />
    </svg>
  );
}

export function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 7H5v4h2V9h7a4 4 0 1 1-2.83 6.83l-1.42 1.42A6 6 0 1 0 14 7H9z" />
    </svg>
  );
}

export function RedoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15 7h4v4h-2V9h-7a4 4 0 1 0 2.83 6.83l1.42 1.42A6 6 0 1 1 10 7h5z" />
    </svg>
  );
}
