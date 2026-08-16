import { FieldLabelWithHelp } from "./FieldLabelWithHelp";

type WorkflowPathFieldProps = {
  label: string;
  helpText?: string;
  value: string;
  placeholder: string;
  onBrowse: () => void;
  onOpen: () => void;
  onReset: () => void;
  inlineBrowse?: boolean;
  resetLabel?: string;
  browseLabel?: string;
  secondaryBrowseLabel?: string;
  onSecondaryBrowse?: () => void;
  disabled?: boolean;
};

export function WorkflowPathField({
  label,
  helpText,
  value,
  placeholder,
  onBrowse,
  onOpen,
  onReset,
  inlineBrowse = false,
  resetLabel = "Reset",
  browseLabel = "Browse",
  secondaryBrowseLabel,
  onSecondaryBrowse,
  disabled = false
}: WorkflowPathFieldProps) {
  const displayedValue = value;
  const hasValue = Boolean(value.trim());

  return (
    <article className={`folder-card workflow-folder-card${inlineBrowse ? " workflow-folder-card-inline" : ""}${onSecondaryBrowse ? " workflow-folder-card-double-browse" : ""}`}>
      {helpText ? <FieldLabelWithHelp label={label} helpText={helpText} /> : <span className="field-label">{label}</span>}
      <div className="workflow-path-control-row">
        <input
          className="text-input path-input"
          type="text"
          aria-label={label}
          value={displayedValue}
          readOnly
          placeholder={placeholder}
          title={displayedValue || placeholder}
          disabled={disabled}
        />
        {inlineBrowse ? (
          <>
            <button type="button" className="secondary-button" onClick={onBrowse} disabled={disabled}>
              {browseLabel}
            </button>
            {onSecondaryBrowse ? (
              <button type="button" className="secondary-button" onClick={onSecondaryBrowse} disabled={disabled}>
                {secondaryBrowseLabel}
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={onOpen} disabled={disabled || !hasValue}>
              Open
            </button>
            <button type="button" className="secondary-button" onClick={onReset} disabled={disabled || !hasValue}>
              {resetLabel}
            </button>
          </>
        ) : null}
      </div>
      {!inlineBrowse ? (
        <div className="action-row field-action-row">
          <button type="button" className="secondary-button" onClick={onBrowse} disabled={disabled}>
            {browseLabel}
          </button>
          {onSecondaryBrowse ? (
            <button type="button" className="secondary-button" onClick={onSecondaryBrowse} disabled={disabled}>
              {secondaryBrowseLabel}
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={onOpen} disabled={disabled || !hasValue}>
            Open
          </button>
          <button type="button" className="secondary-button" onClick={onReset} disabled={disabled || !hasValue}>
            {resetLabel}
          </button>
        </div>
      ) : null}
    </article>
  );
}
