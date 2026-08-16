import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf-8", shell: false, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

for (const entry of readdirSync(__dirname, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".mjs")) {
    run(process.execPath, ["--check", path.join(__dirname, entry.name)]);
  }
}
run(process.platform === "win32" ? "py" : "python3", ["-m", "py_compile", path.join(__dirname, "create_deterministic_zip.py")]);

if (process.platform === "win32") {
  const parser = [
    "$tokens = $null",
    "$errors = $null",
    "[System.Management.Automation.Language.Parser]::ParseFile($env:TRANSCRIPT_RESEARCH_STUDIO_PS1_TO_CHECK, [ref]$tokens, [ref]$errors) | Out-Null",
    "if ($errors.Count -gt 0) { throw ($errors | Out-String) }"
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
    env: { ...process.env, TRANSCRIPT_RESEARCH_STUDIO_PS1_TO_CHECK: path.join(__dirname, "reassemble_cuda.ps1") }
  });
}

process.stdout.write("Release script syntax checks passed.\n");
