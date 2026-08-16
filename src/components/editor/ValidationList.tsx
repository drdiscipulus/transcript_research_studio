import type { EditorValidationIssue } from "../../lib/api";

type ValidationListProps = {
  title: string;
  issues: EditorValidationIssue[];
};

export function ValidationList({ title, issues }: ValidationListProps) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <div className="validation-list">
      <h3>{title}</h3>
      {issues.map((issue, index) => (
        <p key={`${issue.segment_id ?? "global"}-${index}`}>
          {issue.segment_id ? `${issue.segment_id}: ` : ""}{issue.message}
        </p>
      ))}
    </div>
  );
}
