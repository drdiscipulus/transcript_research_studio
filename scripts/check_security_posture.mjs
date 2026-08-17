import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function walkFiles(relativeDir, predicate = () => true) {
  const absoluteDir = path.join(root, relativeDir);
  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__") {
        continue;
      }
      files.push(...walkFiles(relativePath, predicate));
    } else if (predicate(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

function assertContains(file, phrase) {
  const text = readText(file);
  if (!text.includes(phrase)) {
    throw new Error(`${file} must contain: ${phrase}`);
  }
}

function assertContainsCaseInsensitive(file, phrase) {
  const text = readText(file).toLowerCase();
  if (!text.includes(phrase.toLowerCase())) {
    throw new Error(`${file} must contain: ${phrase}`);
  }
}

function assertNotContains(file, phrase) {
  const text = readText(file);
  if (text.includes(phrase)) {
    throw new Error(`${file} must not contain: ${phrase}`);
  }
}

function assertNoMatches(files, pattern, description) {
  const offenders = [];
  for (const file of files) {
    const text = readText(file);
    if (pattern.test(text)) {
      offenders.push(file);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`${description}: ${offenders.join(", ")}`);
  }
}

const pythonFiles = walkFiles("backend", (file) => file.endsWith(".py"));
const frontendFiles = walkFiles("src", (file) => file.endsWith(".ts") || file.endsWith(".tsx"));

assertContains("backend/sidecar_server/server.py", "normalize_loopback_bind_host");
assertContains("backend/sidecar_server/prompting_providers.py", "normalize_loopback_base_url");
assertContains("backend/sidecar_server/security.py", 'DEFAULT_BACKEND_HOST = "127.0.0.1"');
assertContains("backend/sidecar_server/server.py", "AUTH_HEADER_NAME = \"X-Transcript-Research-Studio-Token\"");
assertContains("src/lib/api/core.ts", 'AUTH_HEADER_NAME = "X-Transcript-Research-Studio-Token"');
assertContains("src-tauri/src/sidecar/connection.rs", 'AUTH_HEADER_NAME: &str = "X-Transcript-Research-Studio-Token"');
assertContains("scripts/verify_release_artifacts.mjs", '"X-Transcript-Research-Studio-Token": token');
assertContains("backend/sidecar_server/transcription_models.py", "_MODEL_ALLOW_PATTERNS");
assertContains("backend/sidecar_server/transcription_models.py", "allow_patterns=_MODEL_ALLOW_PATTERNS");
assertContains("backend/sidecar_server/transcription_models.py", "local_files_only=True");
assertContains("src/components/ModelsPage.tsx", "The token is not stored.");

assertNotContains("backend/sidecar_server/transcription_models.py", "trust_remote_code");
assertNotContains("backend/sidecar_server/hf_credentials.py", "keyring");
assertNotContains("backend/sidecar_server/hf_credentials.py", "write_text");
assertNotContains("backend/sidecar_server/server.py", "/api/v1/advanced/hf-token/save");
assertNotContains("backend/sidecar_server/server.py", "/api/v1/advanced/hf-token/delete");
assertNotContains("backend/sidecar_server/settings_store.py", "hf_token_last_test");
assertNotContains("src/lib/api/settings.ts", "hf_token_last_test");
assertNotContains("backend/sidecar_server/transcription_engine.py", "diagnostic-fallback");
assertNoMatches(pythonFiles, /shell\s*=\s*True/, "Backend must not start subprocesses through a shell");
assertNoMatches(frontendFiles, /console\.log/, "Frontend source must not contain console.log");

assertContains("README.md", "local desktop app");
assertContains("README.md", "Source media files stay untouched.");
assertContains("README.md", "Transcription models are managed on the");
assertContains("docs/user_guide.md", "Source transcript files stay untouched.");
assertContains("docs/user_guide.md", "Keep the Windows portable package together");
assertContains("docs/user_guide.md", "Hugging Face is contacted for explicit transcription model downloads");
assertContains("docs/technical_background.md", "Security Posture");

console.log("Security posture checks passed.");
