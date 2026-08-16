import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

const stalePatterns = [
  [/source-table/, "old source-table prompting route language"],
  [/\binput_column\b/, "old row-wise prompting input_column field"],
  [/\boutput_column\b/, "old row-wise prompting output_column field"],
  [/\bPromptRowStatus\b/, "old row-wise prompting status type"],
  [/\bPromptRunPlan\b/, "old row-wise prompting plan type"],
  [/\bprompting_preparation\b/, "old row-wise prompting preparation module"],
  [/\bscanInputFolder\b/, "legacy folder-only transcription scan helper"],
  [/\bfunction\s+pickFile\b/, "generic file picker helper"],
  [/\bopenTasks\b/, "multi-open prompting accordion state"],
  [/\bsetOpenTasks\b/, "multi-open prompting accordion setter"],
  [/window\.confirm\s*\(/, "native confirmation dialog"],
  [/className=["'`]modal-backdrop["'`]/, "direct modal backdrop outside the shared modal boundary"]
];

const failures = [];

for (const filePath of listSourceFiles(srcRoot)) {
  const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
  const content = readFileSync(filePath, "utf-8");
  for (const [pattern, description] of stalePatterns) {
    if (description === "direct modal backdrop outside the shared modal boundary"
      && relativePath === "src/components/workbench/ModalDialog.tsx") continue;
    if (pattern.test(content)) {
      failures.push(`${relativePath}: ${description}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Frontend structure check failed:\n${failures.join("\n")}`);
}

console.log("Frontend structure checks passed.");
