import type {
  CodesDocxMode,
  CodesExportArtifact,
  CodesExportProduct
} from "../../lib/api";
import { FieldLabelWithHelp } from "../FieldLabelWithHelp";

type CodesExportPanelProps = {
  products: CodesExportProduct[];
  docxMode: CodesDocxMode;
  includeLocalPaths: boolean;
  includeAiAudit: boolean;
  bundlePath: string;
  artifacts: CodesExportArtifact[];
  warnings: string[];
  statusLabel: string;
  errorLabel: string | null;
  busy: boolean;
  canEditProject: boolean;
  onToggleProduct: (product: CodesExportProduct) => void;
  onDocxModeChange: (mode: CodesDocxMode) => void;
  onIncludeLocalPathsChange: (value: boolean) => void;
  onIncludeAiAuditChange: (value: boolean) => void;
  onOpenOutputFolder: () => void;
  onExportProject: () => void;
};

const productOptions: Array<{
  id: CodesExportProduct;
  format: string;
  title: string;
  use: string;
  includes: string;
  help: string;
}> = [
  {
    id: "xlsx",
    format: "XLSX",
    title: "Analysis Workbook",
    use: "Review, filter, and analyze the complete coding project in Excel or LibreOffice.",
    includes: "Overview, transcripts, segments, evidence, full codebook, themes, and normalized relationship sheets.",
    help: "Best for spreadsheet analysis and Power Query. Exact evidence offsets are included in relationship sheets; colored in-cell transcript highlighting is intentionally not used."
  },
  {
    id: "docx",
    format: "DOCX",
    title: "Coded Transcript Report",
    use: "Read, share, and annotate a human-readable report in Word or compatible software.",
    includes: "Project overview, codebook, themes, full transcript text, exact evidence highlights, references, codes, and notes.",
    help: "This is a readable report, not a native QDA project. It includes uncoded text and represents overlapping evidence with exact highlights plus annotation blocks."
  },
  {
    id: "csv",
    format: "CSV",
    title: "Structured CSV Data",
    use: "Analyze the project with R, Python, Power Query, databases, or other tabular tools.",
    includes: "One UTF-8 CSV per table, normalized relationship files, stable IDs, empty tables with headers, and a data dictionary.",
    help: "CSV cannot preserve document formatting or highlights. Stable transcript, segment, evidence, code, and theme IDs support reliable joins across files."
  },
  {
    id: "json",
    format: "JSON",
    title: "Structured JSON",
    use: "Build scripts, integrations, reproducible pipelines, or custom research tooling.",
    includes: "A complete sanitized project export with metadata, transcripts, exact ranges, codebook, themes, and relationships.",
    help: "This downstream JSON export is not an editable .evidence.json working copy and cannot be reopened as a coding project."
  },
  {
    id: "qdpx",
    format: "QDPX Beta",
    title: "QDA Exchange Project",
    use: "Transfer coded text to MAXQDA, ATLAS.ti, and other REFI-QDA-compatible software.",
    includes: "Text sources, codes, coded passages, notes, and theme groups with stable deterministic identifiers.",
    help: "Linked media is not included. Application-specific features may be modified during import. This app exports QDPX but does not import or round-trip it; compatibility remains beta until manually qualified."
  }
];

export function CodesExportPanel({
  products,
  docxMode,
  includeLocalPaths,
  includeAiAudit,
  bundlePath,
  artifacts,
  warnings,
  statusLabel,
  errorLabel,
  busy,
  canEditProject,
  onToggleProduct,
  onDocxModeChange,
  onIncludeLocalPathsChange,
  onIncludeAiAuditChange,
  onOpenOutputFolder,
  onExportProject
}: CodesExportPanelProps) {
  return (
    <section className="section-card codes-export-panel">
      <div className="section-heading codes-export-heading">
        <div>
          <h3 className="home-section-title">Export Coding Project</h3>
          <p className="codes-section-description">
            Choose the downstream products you need. The app creates one privacy-first ZIP bundle; your editable .evidence.json project remains unchanged.
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={onExportProject}
          disabled={!canEditProject || busy || products.length === 0}
        >
          {busy ? "Creating Bundle…" : "Export Bundle…"}
        </button>
      </div>

      <div className="codes-export-product-grid" role="group" aria-label="Export products">
        {productOptions.map((option) => {
          const selected = products.includes(option.id);
          const inputId = `codes-export-product-${option.id}`;
          return (
            <article key={option.id} className={`codes-export-product-card${selected ? " selected" : ""}`}>
              <input
                id={inputId}
                type="checkbox"
                checked={selected}
                disabled={!canEditProject || busy}
                onChange={() => onToggleProduct(option.id)}
              />
              <label htmlFor={inputId} className="codes-export-product-body">
                <span className="codes-export-product-title-row">
                  <span>
                    <strong>{option.title}</strong>
                    <span className="codes-export-format-badge">{option.format}</span>
                  </span>
                </span>
                <span className="codes-export-product-use">{option.use}</span>
                <span className="codes-export-product-includes"><strong>Includes:</strong> {option.includes}</span>
              </label>
              <FieldLabelWithHelp label={`${option.title} help`} helpText={option.help} hideLabel />
            </article>
          );
        })}
      </div>

      {products.includes("docx") ? (
        <fieldset className="codes-export-docx-options" disabled={!canEditProject || busy}>
          <legend>DOCX Documents</legend>
          <label><input type="radio" name="codes-docx-mode" checked={docxMode === "separate"} onChange={() => onDocxModeChange("separate")} /> Separate Transcripts</label>
          <label><input type="radio" name="codes-docx-mode" checked={docxMode === "combined"} onChange={() => onDocxModeChange("combined")} /> Combined Document</label>
        </fieldset>
      ) : null}

      <details className="codes-export-advanced">
        <summary>Advanced Export Settings</summary>
        <div className="codes-export-advanced-body">
          <label className="codes-export-privacy-option">
            <input
              type="checkbox"
              checked={includeLocalPaths}
              disabled={!canEditProject || busy}
              onChange={(event) => onIncludeLocalPathsChange(event.target.checked)}
            />
            <span><strong>Include Local Source Paths</strong><small>Off by default. Otherwise only transcript filenames are exported.</small></span>
          </label>
          <label className="codes-export-privacy-option">
            <input
              type="checkbox"
              checked={includeAiAudit}
              disabled={!canEditProject || busy}
              onChange={(event) => onIncludeAiAuditChange(event.target.checked)}
            />
            <span><strong>Include AI Audit</strong><small>Includes researcher prompts, provider/model metadata, runs, and decisions. Protected system prompts and secrets are never exported.</small></span>
          </label>
          {includeAiAudit ? <div className="codes-export-audit-warning" role="status">Review AI audit data before sharing this bundle.</div> : null}
        </div>
      </details>

      {!products.length ? <div className="codes-export-validation" role="alert">Choose at least one export product.</div> : null}
      {statusLabel || errorLabel ? (
        <div className={errorLabel ? "codes-export-status error" : "codes-export-status"} role={errorLabel ? "alert" : "status"}>
          {errorLabel || statusLabel}
        </div>
      ) : null}

      {bundlePath ? (
        <div className="codes-export-results">
          <div className="section-heading">
            <div>
              <h4>Created Export Bundle</h4>
              <span className="codes-export-bundle-path" title={bundlePath}>{bundlePath}</span>
            </div>
            <button type="button" className="secondary-button compact" disabled={busy} onClick={onOpenOutputFolder}>Open Output Folder</button>
          </div>
          {warnings.length ? (
            <div className="codes-export-warning-list" role="status">
              {warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          ) : null}
          <details className="codes-export-artifacts">
            <summary>Contained Files ({artifacts.length})</summary>
            {artifacts.map((artifact) => (
              <div key={`${artifact.product}-${artifact.archive_path}`} className="codes-export-result-row">
                <strong>{artifact.product === "bundle" ? "Bundle" : artifact.product.toUpperCase()}</strong>
                <span title={artifact.archive_path}>{artifact.archive_path}</span>
                <small>{formatBytes(artifact.size)}</small>
              </div>
            ))}
          </details>
        </div>
      ) : null}
    </section>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
