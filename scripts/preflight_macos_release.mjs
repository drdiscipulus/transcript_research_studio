import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const identity = process.env.APPLE_SIGNING_IDENTITY || "";
const keychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE || "transcript-research-notary";

const failures = [];
const notes = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 16,
    ...options
  });
}

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

function assertCommand(command) {
  const result = run("/usr/bin/which", [command]);
  if (result.status !== 0) {
    fail(`Required command is missing from PATH: ${command}`);
  }
}

function assertXcrunTool(toolName) {
  const result = run("xcrun", ["--find", toolName]);
  if (result.status !== 0 || !result.stdout.trim()) {
    fail(`Xcode command line tool is unavailable through xcrun: ${toolName}`);
  }
}

function probePythonVersion(pythonPath) {
  const result = run(pythonPath, ["-c", "import sys; print('.'.join(str(part) for part in sys.version_info[:2]))"]);
  if (result.status !== 0) {
    fail(`Could not run Python runtime for bundling: ${pythonPath}`);
    return;
  }
  const version = result.stdout.trim();
  if (version !== "3.12") {
    fail(`Bundled runtime must use Python 3.12, but ${pythonPath} reports ${version || "unknown"}.`);
  }
}

function probePythonRequirements(pythonPath) {
  const expected = {
    av: "17.0.1",
    "faster-whisper": "1.2.1",
    "huggingface-hub": "0.36.2",
    "pyannote.audio": "4.0.4",
    torch: "2.8.0",
    torchaudio: "2.8.0"
  };
  const script = `
import importlib.metadata
import json
import platform

packages = ${JSON.stringify(Object.keys(expected))}
print(json.dumps({
    "machine": platform.machine(),
    "versions": {name: importlib.metadata.version(name) for name in packages},
}, sort_keys=True))
  `.trim();
  const result = run(pythonPath, ["-c", script]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown packages";
    fail(`Python bundle runtime is missing macOS requirements: ${detail}`);
    return;
  }
  const payload = JSON.parse(result.stdout);
  if (String(payload.machine).toLowerCase() !== "arm64") {
    fail(`Bundled macOS runtime must be native arm64, but reports ${payload.machine || "unknown"}.`);
  }
  for (const [name, version] of Object.entries(expected)) {
    if (payload.versions?.[name] !== version) {
      fail(`Bundled macOS runtime must use ${name} ${version}, but reports ${payload.versions?.[name] || "missing"}.`);
    }
  }
}

function assertPythonRuntimeInput() {
  const candidates = [
    process.env.TRANSCRIPT_RESEARCH_STUDIO_SHARED_VENV_PYTHON,
    process.env.TRANSCRIPT_RESEARCH_STUDIO_MAIN_VENV_PYTHON,
    path.join(repoRoot, ".release-envs", "macos-arm64", "bin", "python")
  ].filter(Boolean);
  const pythonPath = candidates.find((candidate) => existsSync(candidate));
  if (!pythonPath) {
    fail("Locked macOS arm64 runtime is missing. Run npm run runtime:macos:arm64 before npm run release:macos.");
    return;
  }
  probePythonVersion(pythonPath);
  probePythonRequirements(pythonPath);
}

function assertNodeInstall() {
  if (!existsSync(path.join(repoRoot, "node_modules", ".bin", "tauri"))) {
    fail("Node dependencies are missing. Run npm ci before npm run release:macos.");
    return;
  }
  const result = run(process.execPath, [path.join(repoRoot, "scripts", "verify_node_install.mjs")]);
  if (result.status !== 0) {
    fail(`Node dependencies do not match package-lock.json. Run npm ci. ${result.stderr || result.stdout}`);
  }
}

function parseDeveloperIdIdentities(output) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]*Developer ID Application:[^"]+)"/);
      return match ? { hash: match[1], name: match[2] } : null;
    })
    .filter(Boolean);
}

function assertSigningIdentity() {
  const result = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (result.status !== 0) {
    fail("Could not inspect Keychain code signing identities.");
    return;
  }

  const developerIdIdentities = parseDeveloperIdIdentities(result.stdout);
  if (developerIdIdentities.length === 0) {
    fail("No valid Developer ID Application code signing identity was found in Keychain.");
  }

  if (!identity) {
    fail("APPLE_SIGNING_IDENTITY is required, for example: Developer ID Application: Your Name (TEAMID)");
    if (developerIdIdentities.length === 1) {
      note(`Detected identity candidate: ${developerIdIdentities[0].name}`);
    }
    return;
  }

  if (
    !developerIdIdentities.some(
      (candidate) => candidate.hash === identity || candidate.name === identity || candidate.name.includes(identity)
    )
  ) {
    fail(`APPLE_SIGNING_IDENTITY does not match a valid Developer ID Application identity: ${identity}`);
  }
}

function assertNotarizationProfile() {
  const result = run("xcrun", ["notarytool", "history", "--keychain-profile", keychainProfile]);
  if (result.status !== 0) {
    fail(
      `APPLE_NOTARY_KEYCHAIN_PROFILE does not reference a usable notarytool keychain profile: ${keychainProfile}`
    );
  }
}

if (process.platform !== "darwin") {
  throw new Error("macOS release preflight can only run on macOS.");
}

for (const command of ["codesign", "ditto", "file", "find", "install_name_tool", "otool", "security", "spctl", "xcrun"]) {
  assertCommand(command);
}
assertXcrunTool("notarytool");
assertXcrunTool("stapler");
assertNodeInstall();
assertPythonRuntimeInput();
assertSigningIdentity();
assertNotarizationProfile();

note(`Using notarization keychain profile name: ${keychainProfile}`);

if (failures.length > 0) {
  console.error("macOS release preflight failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  for (const item of notes) {
    console.error(`note: ${item}`);
  }
  process.exit(1);
}

for (const item of notes) {
  console.log(item);
}
console.log("macOS release preflight passed.");
