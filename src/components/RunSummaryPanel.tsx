import { FieldLabelWithHelp } from "./FieldLabelWithHelp";

type RunSummaryPanelProps = {
  label: string;
  value: string;
  helpText?: string;
  className?: string;
};

export function RunSummaryPanel({ label, value, helpText, className }: RunSummaryPanelProps) {
  return (
    <article className={`summary-panel compact${className ? ` ${className}` : ""}`} title={value}>
      {helpText ? (
        <FieldLabelWithHelp label={label} helpText={helpText} labelClassName="summary-label" />
      ) : (
        <span className="summary-label">{label}</span>
      )}
      <strong>{value}</strong>
    </article>
  );
}
