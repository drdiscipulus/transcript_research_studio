import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf-8");
}

function assertContains(fileName, content, phrase) {
  if (!content.includes(phrase)) {
    throw new Error(`${fileName} is missing expected phrase: ${phrase}`);
  }
}

function assertNotContains(fileName, content, phrase) {
  if (content.includes(phrase)) {
    throw new Error(`${fileName} still contains stale phrase: ${phrase}`);
  }
}

function assertNotContainsCaseInsensitive(fileName, content, phrase) {
  if (content.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) {
    throw new Error(`${fileName} still contains stale phrase: ${phrase}`);
  }
}

const helpPage = read("src/components/HelpPage.tsx");
const userGuide = read("docs/user_guide.md");
const technicalBackground = read("docs/technical_background.md");
const readme = read("README.md");
const backendReadme = read("backend/README.md");
const packageManifest = JSON.parse(read("package.json"));
const releaseVersion = packageManifest.version;
if (typeof releaseVersion !== "string" || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u.test(releaseVersion)) {
  throw new Error("package.json must define a valid current release version.");
}
const prereleaseMatch = releaseVersion.match(/^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/u);
if (!prereleaseMatch) {
  throw new Error(
    `package.json version ${releaseVersion} must use the supported MAJOR.MINOR.PATCH-beta.NUMBER prerelease structure.`
  );
}
const [, major, minor, patch] = prereleaseMatch;
const stableVersion = `${major}.${minor}.${patch}`;
const releaseNotesPath = `docs/release_notes_${releaseVersion}.md`;
const releaseNotes = read(releaseNotesPath);
const uiFiles = [
  ["src/components/TranscriptionPage.tsx", read("src/components/TranscriptionPage.tsx")],
  ["src/components/PromptingPage.tsx", read("src/components/PromptingPage.tsx")],
  ["src/components/HelpPage.tsx", helpPage]
];

const mirroredPhrases = [
  "Transcription models are managed on the",
  "Source media files stay untouched.",
  "Source transcript files stay untouched.",
  "One Transcript Analysis run can process one transcript file or a folder of transcript files.",
  "timestamped segments, or readable paragraphs inside each output file."
];

for (const phrase of mirroredPhrases) {
  assertContains("src/components/HelpPage.tsx", helpPage, phrase);
  assertContains("docs/user_guide.md", userGuide, phrase);
}

for (const [fileName, content] of uiFiles) {
  for (const stalePhrase of [
    "Working Folders",
    "Transcription Settings",
    "Diarization Setup",
    "Provider and Model",
    "Input Table",
    "Start Prompting",
    "Rescan Folder",
    "Waiting for required transcription settings",
    "ready to configure"
  ]) {
    assertNotContains(fileName, content, stalePhrase);
  }
}

for (const phrase of [
  "personal side project",
  "updates may be occasional",
  "GitHub Issues",
  "Feature requests are welcome as context",
  "Version 1.0 Beta 2",
  "Create transcripts",
  "Transcript Editor",
  "Codes",
  "Transcript Analysis",
  "Privacy and Local Processing",
  "GitHub Releases"
]) {
  assertContains("README.md", readme, phrase);
}

const readmeWordCount = readme.trim().split(/\s+/u).length;
if (readmeWordCount < 500 || readmeWordCount > 1100) {
  throw new Error(`README.md must remain a focused 500–1100 word project introduction; found ${readmeWordCount} words.`);
}

for (const phrase of [
  "Power Query",
  "schema 1.1",
  ".evidence.json",
  "diagnostic-fallback",
  "macOS Maintainer Build",
  "npm run",
  "npm ci",
  "cargo ",
  "xcrun",
  "src-tauri",
  "sidecar",
  "loopback",
  "worker protocol",
  "TAURI_CONFIG",
  "git clone"
]) {
  assertNotContainsCaseInsensitive("README.md", readme, phrase);
}

for (const [fileName, content] of [
  ["README.md", readme],
  ["docs/user_guide.md", userGuide],
  [releaseNotesPath, releaseNotes]
]) {
  for (const phrase of ["prerelease", "pre-release", "diagnostic-fallback"]) {
    assertNotContainsCaseInsensitive(fileName, content, phrase);
  }
}

for (const phrase of [
  "QDPX Beta",
  "does not import or round-trip QDPX",
  "not a native MAXQDA or ATLAS.ti project format",
  "manually tested"
]) {
  assertContains(releaseNotesPath, releaseNotes, phrase);
}

for (const phrase of [
  "<strong>Tauri 2</strong>",
  "<strong>React 19</strong>",
  "<strong>TypeScript</strong>",
  "Transcript Research Studio.",
  "templates for Evidence, Codes, Note, Codebook, and Themes",
  "Dismissing a suggestion saves a rejection decision.",
  "the suggestion remains available for retry",
  "does not import or round-trip QDPX",
  "Manually qualify the exact target application and version"
]) {
  assertContains("src/components/HelpPage.tsx", helpPage, phrase);
}

for (const phrase of [
  "Accepting an AI evidence suggestion immediately saves the exact passage as a new evidence item with no codes or note.",
  "Dismissing a suggestion saves a rejection decision.",
  "the suggestion remains available for retry",
  "Provider**, **Model**, **Temperature**, and **Timeout",
  "Evidence, Codes, Note, Codebook, and Themes",
  "not a native MAXQDA or ATLAS.ti project",
  "does not import or round-trip QDPX",
  "Manually qualify the exact target application and version"
]) {
  assertContains("docs/user_guide.md", userGuide, phrase);
}

for (const phrase of [
  "AI Transcription Studio",
  "Tauri 2.10",
  "React 18.3.1",
  "TypeScript 5.6.3"
]) {
  assertNotContains("src/components/HelpPage.tsx", helpPage, phrase);
}
for (const [fileName, content] of [
  ["src/components/HelpPage.tsx", helpPage],
  ["docs/user_guide.md", userGuide]
]) {
  if (/\bmemos?\b/iu.test(content)) {
    throw new Error(`${fileName} still contains the retired user-facing Memo terminology.`);
  }
}

for (const [fileName, content] of [
  ["README.md", readme],
  ["docs/user_guide.md", userGuide],
  [releaseNotesPath, releaseNotes]
]) {
  assertContains(fileName, content, releaseVersion);
  assertNotContains(fileName, content, "0.3.0");
}
assertContains(releaseNotesPath, releaseNotes, `Stable \`${stableVersion}\``);

for (const phrase of [
  "Internal structure",
  "provider adapters",
  "transcript normalization",
  "model download/cache"
]) {
  assertContains("backend/README.md", backendReadme, phrase);
}

for (const phrase of [
  "Architecture",
  "Local HTTP API",
  "Transcription Flow",
  "Transcript Analysis Flow",
  "Security Posture"
]) {
  assertContains("docs/technical_background.md", technicalBackground, phrase);
}

console.log("Documentation consistency checks passed.");
