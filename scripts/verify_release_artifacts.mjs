import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertSafeBundleSymlinks,
  executableDirectoryForFile,
  resolveBundledDependency,
  resolvePortableRpaths
} from "./sign_macos_bundle.mjs";
import { readPythonProjectIdentity, readReleaseVersion } from "./release_identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const version = readReleaseVersion(repoRoot);
const pythonProjectIdentity = readPythonProjectIdentity(repoRoot);
const portableMarkerName = ".transcript_research_studio_portable";
const portableDataDirectoryName = "transcript_research_studio_data";
const packagedUserGuideName = "README.md";
const licenseFileName = "LICENSE";
const skipSidecar = process.argv.includes("--skip-sidecar");
const windowsVariantArg = process.argv.find((argument) => argument.startsWith("--windows-variant="));
const requestedWindowsVariant = windowsVariantArg ? windowsVariantArg.split("=", 2)[1] : null;
const requireCudaHardware = process.env.TRANSCRIPT_RESEARCH_STUDIO_REQUIRE_CUDA_HARDWARE === "1";

function assertExists(targetPath, description) {
  if (!existsSync(targetPath)) {
    throw new Error(`${description} is missing: ${targetPath}`);
  }
}

function assertDirectory(targetPath, description) {
  assertExists(targetPath, description);
  if (!statSync(targetPath).isDirectory()) {
    throw new Error(`${description} is not a directory: ${targetPath}`);
  }
}

function assertFile(targetPath, description) {
  assertExists(targetPath, description);
  if (!statSync(targetPath).isFile()) {
    throw new Error(`${description} is not a file: ${targetPath}`);
  }
}

function portablePackages() {
  const portableRoot = process.env.TRANSCRIPT_RESEARCH_STUDIO_RELEASE_ASSET_DIR
    ? path.resolve(process.env.TRANSCRIPT_RESEARCH_STUDIO_RELEASE_ASSET_DIR)
    : path.join(repoRoot, "release-artifacts", process.platform, "portable");
  assertDirectory(portableRoot, "Portable release root");
  if (process.platform === "win32") {
    const variants = requestedWindowsVariant ? [requestedWindowsVariant] : ["cpu", "cuda"];
    return variants.map((variant) => {
      const packageName = `transcript_research_studio_${version}_windows_x64_${variant}_portable`;
      return { variant, packageName, portableRoot, archivePath: path.join(portableRoot, `${packageName}.zip`) };
    });
  }
  if (process.platform === "darwin") {
    return [
      {
        variant: "macos",
        packageName: `transcript_research_studio_${version}_macos_arm64_portable`,
        portableRoot,
        archivePath: path.join(portableRoot, `transcript_research_studio_${version}_macos_arm64_portable.zip`)
      }
    ];
  }
  throw new Error(`Portable release verification is not configured for ${process.platform}.`);
}

function pythonExecutable(runtimeRoot) {
  if (process.platform === "win32") {
    return path.join(runtimeRoot, "python-runtime", "python.exe");
  }
  return path.join(runtimeRoot, "python-runtime", "bin", "python");
}

function inheritedEnvironmentValue(sourceEnvironment, ...names) {
  const wantedNames = new Set(names.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (wantedNames.has(name.toLowerCase()) && value) {
      return value;
    }
  }
  return undefined;
}

export function sanitizedRuntimeEnvironment(
  runtimeRoot,
  isolationRoot,
  additionalEnvironment = {},
  inheritedEnvironment = process.env
) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedIsolationRoot = path.resolve(isolationRoot);
  const pythonRoot = path.join(resolvedRuntimeRoot, "python-runtime");
  const environment = {
    TRANSCRIPT_RESEARCH_STUDIO_RESOURCE_DIR: resolvedRuntimeRoot,
    HOME: resolvedIsolationRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: pythonRoot,
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: resolvedRuntimeRoot,
    PYTHONUTF8: "1"
  };

  if (process.platform === "win32") {
    const systemRoot = inheritedEnvironmentValue(inheritedEnvironment, "SystemRoot", "WINDIR");
    if (!systemRoot) {
      throw new Error("SystemRoot is required to verify the packaged Windows Python runtime.");
    }
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
    environment.COMSPEC = inheritedEnvironmentValue(inheritedEnvironment, "COMSPEC") || path.join(systemRoot, "System32", "cmd.exe");
    environment.PATHEXT = inheritedEnvironmentValue(inheritedEnvironment, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
    environment.USERPROFILE = resolvedIsolationRoot;
    environment.APPDATA = path.join(resolvedIsolationRoot, "AppData", "Roaming");
    environment.LOCALAPPDATA = path.join(resolvedIsolationRoot, "AppData", "Local");
    environment.TEMP = resolvedIsolationRoot;
    environment.TMP = resolvedIsolationRoot;
    environment.PATH = [
      pythonRoot,
      path.join(pythonRoot, "Scripts"),
      path.join(systemRoot, "System32"),
      systemRoot
    ].join(path.delimiter);
  } else {
    environment.TMPDIR = resolvedIsolationRoot;
    environment.PATH = [
      path.join(pythonRoot, "bin"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ].join(path.delimiter);
  }

  const allowedAdditionalNames = new Set([
    "TRANSCRIPT_RESEARCH_STUDIO_BACKEND_HOST",
    "TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT",
    "TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN",
    "TRANSCRIPT_RESEARCH_STUDIO_PORTABLE_ROOT"
  ]);
  for (const [name, value] of Object.entries(additionalEnvironment)) {
    if (!allowedAdditionalNames.has(name) || typeof value !== "string") {
      throw new Error(`Unsafe runtime probe environment override: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

function pythonSitePackagesRoots(runtimeRoot) {
  const runtimePythonRoot = path.join(runtimeRoot, "python-runtime");
  if (process.platform === "win32") {
    return [path.join(runtimePythonRoot, "Lib", "site-packages")].filter(existsSync);
  }

  const libRoot = path.join(runtimePythonRoot, "lib");
  if (!existsSync(libRoot)) {
    return [];
  }
  return readdirSync(libRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("python"))
    .map((entry) => path.join(libRoot, entry.name, "site-packages"))
    .filter(existsSync);
}

function verifyNoObsoleteAsrPackages(runtimeRoot) {
  const blockedNames = ["openai-whisper", "openai_whisper", "whisper", "whisperx"];
  const blockedDistInfoPrefixes = ["openai-whisper-", "openai_whisper-", "whisper-", "whisperx-"];
  for (const sitePackagesRoot of pythonSitePackagesRoots(runtimeRoot)) {
    for (const entry of readdirSync(sitePackagesRoot, { withFileTypes: true })) {
      const lowerName = entry.name.toLowerCase();
      const isBlockedPackage = entry.isDirectory() && blockedNames.includes(lowerName);
      const isBlockedMetadata =
        entry.isDirectory() &&
        lowerName.endsWith(".dist-info") &&
        blockedDistInfoPrefixes.some((prefix) => lowerName.startsWith(prefix));
      if (isBlockedPackage || isBlockedMetadata) {
        throw new Error(`Obsolete ASR package is staged unintentionally: ${path.join(sitePackagesRoot, entry.name)}`);
      }
    }
  }
}

function verifyCudaTorchDlls(runtimeRoot) {
  const torchLibRoot = path.join(runtimeRoot, "python-runtime", "Lib", "site-packages", "torch", "lib");
  for (const dllName of ["cublas64_12.dll", "cublasLt64_12.dll", "nvrtc64_120_0.dll", "cudnn64_9.dll"]) {
    assertFile(path.join(torchLibRoot, dllName), `CUDA torch DLL ${dllName}`);
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function directorySummary(directoryPath) {
  let fileCount = 0;
  let totalBytes = 0;
  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        fileCount += 1;
        totalBytes += statSync(entryPath).size;
      }
    }
  }
  walk(directoryPath);
  return { fileCount, totalBytes };
}

function sha256Directory(directoryPath) {
  const hash = createHash("sha256");
  function walk(currentPath) {
    const entries = readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.name !== "__pycache__" && !entry.name.endsWith(".pyc") && !entry.name.endsWith(".pyo"))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(directoryPath, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(readFileSync(entryPath));
        hash.update("\0");
      }
    }
  }
  walk(directoryPath);
  return hash.digest("hex");
}

function normalizeDistributionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function lockedDistributions(lockPath) {
  const distributions = new Map();
  for (const line of readFileSync(lockPath, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\?$/);
    if (match) {
      distributions.set(normalizeDistributionName(match[1]), match[2]);
    }
  }
  return distributions;
}

function packagedDistributions(runtimeRoot) {
  const distributions = new Map();
  for (const sitePackagesRoot of pythonSitePackagesRoots(runtimeRoot)) {
    for (const entry of readdirSync(sitePackagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) {
        continue;
      }
      const metadataPath = path.join(sitePackagesRoot, entry.name, "METADATA");
      if (!existsSync(metadataPath)) {
        continue;
      }
      const metadata = readFileSync(metadataPath, "utf-8");
      const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
      const packageVersion = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
      if (name && packageVersion) {
        distributions.set(normalizeDistributionName(name), packageVersion);
      }
    }
  }
  return distributions;
}

function verifyRuntimeDistributions(runtimeRoot, lockPath) {
  const expected = lockedDistributions(lockPath);
  expected.set(pythonProjectIdentity.name, pythonProjectIdentity.version);
  const actual = packagedDistributions(runtimeRoot);
  const missing = [...expected].filter(([name, packageVersion]) => actual.get(name) !== packageVersion);
  const unexpected = [...actual].filter(([name, packageVersion]) => expected.get(name) !== packageVersion);
  if (missing.length || unexpected.length) {
    const describe = (entries) => entries.map(([name, packageVersion]) => `${name}==${packageVersion}`).join(", ") || "none";
    throw new Error(
      `Packaged distributions differ from ${path.basename(lockPath)}. Missing/mismatched: ${describe(missing)}. ` +
      `Unexpected/mismatched: ${describe(unexpected)}.`
    );
  }
}

function gitValue(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8", shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function verifyManifestSourceIdentity(manifest) {
  const head = gitValue(["rev-parse", "HEAD"]);
  if (manifest.commit_sha !== head) {
    throw new Error(`Runtime manifest commit ${manifest.commit_sha} does not match checked-out HEAD ${head}.`);
  }
  const qualification = process.env.TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD === "1";
  if (qualification) {
    const expectedTag = `qualification-${head.slice(0, 12)}`;
    if (manifest.tag !== expectedTag || manifest.qualification_build !== true) {
      throw new Error(`Qualification artifact identity mismatch: ${manifest.tag}.`);
    }
    return;
  }
  const expectedTag = `v${version}`;
  const tagType = gitValue(["cat-file", "-t", `refs/tags/${expectedTag}`]);
  const taggedCommit = gitValue(["rev-parse", `${expectedTag}^{commit}`]);
  if (tagType !== "tag" || taggedCommit !== head || manifest.tag !== expectedTag || manifest.qualification_build === true) {
    throw new Error(`${expectedTag} must be an annotated tag at HEAD and match the packaged manifest.`);
  }
}

function verifyManifest(runtimeRoot, variant) {
  const manifestPath = path.join(runtimeRoot, "bundle-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const expectedProfile = variant === "cpu"
    ? "windows-x64-cpu"
    : variant === "cuda"
      ? "windows-x64-cuda"
      : "macos-arm64-cpu";
  const expectedLock = variant === "cpu"
    ? "requirements-win-cpu.txt"
    : variant === "cuda"
      ? "requirements-win-gpu.txt"
      : "requirements-macos-cpu.txt";
  const expectedArchitecture = process.platform === "win32" ? "x64" : "arm64";
  const required = [
    "app_version", "tag", "commit_sha", "platform", "architecture", "runtime_profile",
    "python_version", "dependency_lock", "dependency_lock_hash", "backend_source_hash", "build_time_utc"
  ];
  for (const field of required) {
    if (!manifest[field]) {
      throw new Error(`Runtime manifest is missing ${field}: ${manifestPath}`);
    }
  }
  if (manifest.app_version !== version) {
    throw new Error(`Runtime manifest version mismatch: ${manifest.app_version}.`);
  }
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(manifest.commit_sha)) {
    throw new Error(`Runtime manifest has an invalid commit SHA: ${manifest.commit_sha}.`);
  }
  if (manifest.platform !== process.platform || manifest.architecture !== expectedArchitecture) {
    throw new Error(`Runtime manifest platform mismatch: ${manifest.platform}/${manifest.architecture}.`);
  }
  if (manifest.runtime_profile !== expectedProfile || manifest.dependency_lock !== expectedLock) {
    throw new Error(`Runtime manifest profile mismatch: ${manifest.runtime_profile}/${manifest.dependency_lock}.`);
  }
  if (!String(manifest.python_version).startsWith("3.12.")) {
    throw new Error(`Runtime manifest requires Python 3.12, found ${manifest.python_version}.`);
  }
  const lockPath = path.join(repoRoot, expectedLock);
  if (manifest.dependency_lock_hash !== sha256File(lockPath)) {
    throw new Error(`Runtime dependency lock hash mismatch for ${expectedLock}.`);
  }
  verifyRuntimeDistributions(runtimeRoot, lockPath);
  if (manifest.backend_source_hash !== sha256Directory(path.join(runtimeRoot, "backend"))) {
    throw new Error("Runtime backend source hash does not match the staged backend.");
  }
  const actualRuntimeSummary = directorySummary(path.join(runtimeRoot, "python-runtime"));
  if (
    manifest.python_runtime_summary?.fileCount !== actualRuntimeSummary.fileCount ||
    manifest.python_runtime_summary?.totalBytes !== actualRuntimeSummary.totalBytes
  ) {
    throw new Error("Runtime manifest file count/size summary does not match the packaged Python runtime.");
  }
  if (Number.isNaN(Date.parse(manifest.build_time_utc))) {
    throw new Error(`Runtime manifest has an invalid UTC build time: ${manifest.build_time_utc}.`);
  }
  const commitEpoch = Number(gitValue(["show", "-s", "--format=%ct", manifest.commit_sha]));
  if (manifest.build_time_utc !== new Date(commitEpoch * 1000).toISOString()) {
    throw new Error("Runtime manifest build time must equal the verified source commit timestamp.");
  }
  verifyManifestSourceIdentity(manifest);
  return manifest;
}

export function verifyNoForbiddenContent(packageRoot) {
  const forbiddenDirectoryNames = new Set([".git", ".pytest_cache", "logs", "models", "node_modules", "samples", "test-results"]);
  const forbiddenMediaExtensions = new Set([".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm", ".wma"]);
  const maintainerPathPattern = /(?:[A-Za-z]:[\\/](?:Users|coding_projects)[\\/]|\/Users\/[^/]+\/)/;
  const tokenPattern = /\bhf_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/;

  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(packageRoot, entryPath);
      const segments = relativePath.split(path.sep);
      const insidePythonRuntime = segments.includes("python-runtime");
      if (entry.isDirectory()) {
        if (!insidePythonRuntime && forbiddenDirectoryNames.has(entry.name.toLowerCase())) {
          throw new Error(`Forbidden release directory: ${relativePath}`);
        }
        if (entry.name.startsWith("__editable__")) {
          throw new Error(`Editable-install artifact found in release: ${relativePath}`);
        }
        walk(entryPath);
        continue;
      }
      if (entry.name === "direct_url.json" || entry.name.startsWith("__editable__") || entry.name.endsWith(".egg-link")) {
        throw new Error(`Local/editable installation metadata found in release: ${relativePath}`);
      }
      if (!insidePythonRuntime && forbiddenMediaExtensions.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`Internal/demo media found in release: ${relativePath}`);
      }
      if (statSync(entryPath).size <= 2 * 1024 * 1024 && /\.(cfg|cmake|ini|json|la|md|pc|pth|py|sh|toml|txt|yaml|yml)$/i.test(entry.name)) {
        const text = readFileSync(entryPath, "utf-8");
        if (!insidePythonRuntime) {
          if (text.includes(repoRoot) || maintainerPathPattern.test(text)) {
            throw new Error(`Absolute maintainer path found in release file: ${relativePath}`);
          }
          if (tokenPattern.test(text)) {
            throw new Error(`Credential-looking secret found in release file: ${relativePath}`);
          }
        }
        if (entry.name.endsWith(".pth")) {
          const absolutePathEntry = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("#") && !line.startsWith("import ") && (path.isAbsolute(line) || /^[A-Za-z]:[\\/]/.test(line)));
          if (absolutePathEntry) {
            throw new Error(`Absolute path hook found in release file: ${relativePath}`);
          }
        }
      }
    }
  }

  walk(packageRoot);
  const portableData = path.join(packageRoot, portableDataDirectoryName);
  if (existsSync(portableData) && readdirSync(portableData).length !== 0) {
    throw new Error(`Portable data directory must be empty in release artifacts: ${portableData}`);
  }
}

function verifyReleaseMetadata(packageRoot) {
  const sbomPath = path.join(packageRoot, "SBOM.cdx.json");
  const sbom = JSON.parse(readFileSync(sbomPath, "utf-8"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || sbom.version !== 1) {
    throw new Error("Packaged SBOM is not CycloneDX 1.5.");
  }
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sbom.serialNumber)) {
    throw new Error(`Packaged SBOM has an invalid deterministic UUID: ${sbom.serialNumber}`);
  }
  if (sbom.metadata?.component?.version !== version) {
    throw new Error(`Packaged SBOM application version mismatch: ${sbom.metadata?.component?.version}`);
  }
  const purls = (sbom.components || []).map((component) => String(component.purl || ""));
  if (!purls.some((purl) => purl.startsWith("pkg:generic/CPython@")) || new Set(purls).size !== purls.length) {
    throw new Error("Packaged SBOM is missing CPython or contains duplicate package URLs.");
  }
  if (purls.some((purl) => purl.startsWith("pkg:npm/") && /%2f/i.test(purl))) {
    throw new Error("Packaged SBOM contains an incorrectly encoded scoped npm package URL.");
  }
  const notices = readFileSync(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf-8");
  if (!notices.includes("# Third-Party Notices") || !notices.includes("generic: CPython")) {
    throw new Error("Packaged third-party notices do not include the bundled CPython runtime.");
  }
}

function verifyStaticLayout(packageRoot) {
  assertDirectory(packageRoot, "Portable package");
  if (process.platform === "darwin") {
    assertSafeBundleSymlinks(packageRoot);
  }
  assertFile(path.join(packageRoot, portableMarkerName), "Portable marker");
  assertFile(path.join(packageRoot, packagedUserGuideName), "Portable README user guide");
  assertFile(path.join(packageRoot, licenseFileName), "Portable GPL license");
  assertFile(path.join(packageRoot, "SBOM.cdx.json"), "CycloneDX SBOM");
  assertFile(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), "Third-party notices");
  assertDirectory(path.join(packageRoot, portableDataDirectoryName), "Portable data directory");
  verifyNoForbiddenContent(packageRoot);
  verifyReleaseMetadata(packageRoot);

  let runtimeRoot = path.join(packageRoot, "gen", "runtime");
  if (process.platform === "darwin") {
    const appBundlePath = path.join(packageRoot, "Transcript Research Studio.app");
    assertDirectory(appBundlePath, "Portable macOS app bundle");
    runtimeRoot = path.join(appBundlePath, "Contents", "Resources", "gen", "runtime");
  }

  assertDirectory(runtimeRoot, "Portable runtime");
  assertFile(path.join(runtimeRoot, "bundle-manifest.json"), "Runtime bundle manifest");
  assertDirectory(path.join(runtimeRoot, "backend"), "Runtime backend package");
  assertFile(path.join(runtimeRoot, "backend", "README.md"), "Runtime backend README");
  assertDirectory(path.join(runtimeRoot, "backend", "sidecar_server"), "Runtime sidecar server package");
  assertFile(path.join(runtimeRoot, "backend", "sidecar_server", "server.py"), "Runtime sidecar server entrypoint");
  assertFile(pythonExecutable(runtimeRoot), "Portable Python executable");

  if (process.platform === "win32") {
    assertFile(path.join(packageRoot, "transcript_research_studio.exe"), "Portable Windows executable");
  }

  verifyNoObsoleteAsrPackages(runtimeRoot);

  const manifest = JSON.parse(readFileSync(path.join(runtimeRoot, "bundle-manifest.json"), "utf-8"));
  if (!manifest.runtime_layout && !Array.isArray(manifest.resources) && !Array.isArray(manifest.items)) {
    throw new Error("Runtime bundle manifest does not expose a known layout marker.");
  }
  return { runtimeRoot, manifest };
}

function verifyWindowsRuntimeVariant(packageRoot, runtimeRoot, variant) {
  if (process.platform !== "win32") {
    return;
  }

  const sitePackagesRoot = path.join(runtimeRoot, "python-runtime", "Lib", "site-packages");
  const nvidiaRoot = path.join(sitePackagesRoot, "nvidia");
  if (variant === "cpu" && existsSync(nvidiaRoot)) {
    throw new Error(`CPU Windows package still contains CUDA NVIDIA packages: ${nvidiaRoot}`);
  }

  if (variant === "cuda") {
    verifyCudaTorchDlls(runtimeRoot);
  }

  const python = pythonExecutable(runtimeRoot);
  const probeIsolationRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-runtime-probe-"));
  let importProbe;
  try {
    importProbe = spawnSync(
      python,
      [
        "-c",
        [
          "from backend.sidecar_server.runtime_env import configure_ml_runtime_environment",
          "configure_ml_runtime_environment()",
          "import ctranslate2",
          "import faster_whisper",
          "import importlib.metadata as metadata",
          "import platform",
          "import sys",
          "import torch",
          "import pyannote.audio",
          "import torchaudio",
          "print('ct2-cuda-count=' + str(ctranslate2.get_cuda_device_count()))",
          "print('torch-cuda=' + str(torch.cuda.is_available()))",
          "print('python=' + platform.python_version())",
          "print('machine=' + platform.machine())",
          "print('pointer-bits=' + str(64 if sys.maxsize > 2**32 else 32))",
          "print('torch-version=' + torch.__version__)",
          "print('torchaudio-version=' + torchaudio.__version__)",
          "print('faster-whisper-version=' + metadata.version('faster-whisper'))",
          "print('pyannote-audio-version=' + metadata.version('pyannote-audio'))",
          "print('av-version=' + metadata.version('av'))",
          "print('huggingface-hub-version=' + metadata.version('huggingface-hub'))",
          "print('runtime-imports-ok')"
        ].join("; ")
      ],
      {
        cwd: runtimeRoot,
        env: sanitizedRuntimeEnvironment(runtimeRoot, probeIsolationRoot),
        encoding: "utf-8"
      }
    );
  } finally {
    rmSync(probeIsolationRoot, { force: true, recursive: true });
  }

  if (importProbe.status !== 0) {
    throw new Error(
      `Portable ${variant} runtime import probe failed for ${packageRoot}: ${importProbe.stderr || importProbe.stdout}`
    );
  }

  for (const expectedLine of [
    "pointer-bits=64",
    "faster-whisper-version=1.2.1",
    "pyannote-audio-version=4.0.4",
    "av-version=17.0.1",
    "huggingface-hub-version=0.36.2",
    `torch-version=2.8.0+${variant === "cuda" ? "cu128" : "cpu"}`,
    `torchaudio-version=2.8.0+${variant === "cuda" ? "cu128" : "cpu"}`
  ]) {
    if (!importProbe.stdout.includes(expectedLine)) {
      throw new Error(`Portable ${variant} runtime profile mismatch; expected ${expectedLine}. stdout=${importProbe.stdout}`);
    }
  }

  if (variant === "cuda" && requireCudaHardware && !importProbe.stdout.includes("torch-cuda=True")) {
    throw new Error(
      `CUDA Windows package imports torch/pyannote, but PyTorch CUDA is not available. stdout=${importProbe.stdout} stderr=${importProbe.stderr}`
    );
  }
  if (variant === "cuda" && requireCudaHardware) {
    const ctranslateDeviceCount = importProbe.stdout.match(/ct2-cuda-count=(\d+)/);
    if (!ctranslateDeviceCount || Number(ctranslateDeviceCount[1]) < 1) {
      throw new Error(
        `CUDA Windows package imports, but CTranslate2 reports no CUDA devices. stdout=${importProbe.stdout} stderr=${importProbe.stderr}`
      );
    }
  }
  if (variant === "cpu" && importProbe.stdout.includes("torch-cuda=True")) {
    throw new Error(
      `CPU Windows package should not expose CUDA-enabled PyTorch. stdout=${importProbe.stdout} stderr=${importProbe.stderr}`
    );
  }
}

function filesRecursively(rootPath) {
  const files = [];
  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  walk(rootPath);
  return files;
}

function macCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function macRpaths(filePath) {
  const lines = macCommand("otool", ["-l", filePath]).split(/\r?\n/);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") {
      continue;
    }
    for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = lines[cursor].trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/);
      if (match) {
        values.push(match[1]);
        break;
      }
    }
  }
  return values;
}

function macDylibInstallName(filePath) {
  const result = spawnSync("otool", ["-D", filePath], { encoding: "utf-8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).find(Boolean) || null;
}

function verifyMacMachOPortability(appPath) {
  assertSafeBundleSymlinks(appPath);
  const machOFiles = filesRecursively(appPath).filter((filePath) => {
    const result = spawnSync("file", [filePath], { encoding: "utf-8" });
    return result.status === 0 && result.stdout.includes("Mach-O");
  });
  if (!machOFiles.length) {
    throw new Error(`No Mach-O files were found in ${appPath}.`);
  }
  const bundledMachOPaths = new Set(machOFiles.map((filePath) => realpathSync(filePath)));
  for (const filePath of machOFiles) {
    const architectures = macCommand("lipo", ["-archs", filePath]).trim().split(/\s+/).filter(Boolean);
    if (architectures.length !== 1 || architectures[0] !== "arm64") {
      throw new Error(`Bundled Mach-O must be arm64-only: ${filePath} (${architectures.join(", ") || "unknown"})`);
    }
    const dependencies = macCommand("otool", ["-L", filePath])
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/, 1)[0])
      .filter(Boolean);
    const executableDirectory = executableDirectoryForFile(filePath, appPath);
    const searchPaths = macRpaths(filePath);
    resolvePortableRpaths({ appRoot: appPath, filePath, executableDirectory, searchPaths });

    const installName = macDylibInstallName(filePath);
    let skippedInstallName = false;
    for (const dependency of dependencies) {
      if (!skippedInstallName && installName && dependency === installName) {
        skippedInstallName = true;
        continue;
      }
      const targets = resolveBundledDependency({
        appRoot: appPath,
        filePath,
        executableDirectory,
        dependency,
        searchPaths
      });
      for (const target of targets) {
        if (!bundledMachOPaths.has(target)) {
          throw new Error(`Mach-O dependency resolves to a non-Mach-O bundled file: ${filePath} -> ${dependency} -> ${target}`);
        }
      }
    }
  }
}

function verifyMacRuntime(packageRoot, runtimeRoot) {
  if (process.platform !== "darwin") {
    return;
  }
  const python = pythonExecutable(runtimeRoot);
  const probeScript = [
    "import importlib.metadata as metadata, platform, sys, torch, torchaudio",
    "print('python=' + platform.python_version())",
    "print('machine=' + platform.machine())",
    "print('pointer-bits=' + str(64 if sys.maxsize > 2**32 else 32))",
    "print('torch-version=' + torch.__version__)",
    "print('torchaudio-version=' + torchaudio.__version__)",
    "print('faster-whisper-version=' + metadata.version('faster-whisper'))",
    "print('pyannote-audio-version=' + metadata.version('pyannote-audio'))",
    "print('av-version=' + metadata.version('av'))",
    "print('huggingface-hub-version=' + metadata.version('huggingface-hub'))"
  ].join("; ");
  const probeIsolationRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-runtime-probe-"));
  let probe;
  try {
    probe = spawnSync(python, ["-c", probeScript], {
      cwd: runtimeRoot,
      env: sanitizedRuntimeEnvironment(runtimeRoot, probeIsolationRoot),
      encoding: "utf-8"
    });
  } finally {
    rmSync(probeIsolationRoot, { force: true, recursive: true });
  }
  if (probe.status !== 0) {
    throw new Error(`Portable macOS runtime import probe failed: ${probe.stderr || probe.stdout}`);
  }
  for (const expectedLine of [
    "machine=arm64", "pointer-bits=64", "torch-version=2.8.0", "torchaudio-version=2.8.0",
    "faster-whisper-version=1.2.1", "pyannote-audio-version=4.0.4", "av-version=17.0.1",
    "huggingface-hub-version=0.36.2"
  ]) {
    if (!probe.stdout.includes(expectedLine)) {
      throw new Error(`Portable macOS runtime profile mismatch; expected ${expectedLine}. stdout=${probe.stdout}`);
    }
  }

  const appPath = path.join(packageRoot, "Transcript Research Studio.app");
  verifyMacMachOPortability(appPath);
  for (const [command, args] of [
    ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]],
    ["xcrun", ["stapler", "validate", appPath]],
    ["spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]]
  ]) {
    const result = spawnSync(command, args, { encoding: "utf-8" });
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed for the extracted app: ${result.stderr || result.stdout}`);
    }
  }
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function requestHealth(port, token, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 1000,
        signal,
        headers: { "X-Transcript-Research-Studio-Token": token }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          if (body.length + chunk.length > 64 * 1024) {
            request.destroy(new Error("Sidecar health response exceeded the size limit."));
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Sidecar health returned HTTP ${response.statusCode}.`));
            return;
          }
          let payload;
          try {
            payload = JSON.parse(body);
          } catch {
            reject(new Error("Sidecar health returned invalid JSON."));
            return;
          }
          if (payload.status !== "ok" || typeof payload.instance_id !== "string" || !payload.instance_id.trim()) {
            reject(new Error("Sidecar health returned an invalid status payload."));
            return;
          }
          resolve(payload);
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Timed out waiting for sidecar health response.")));
    request.end();
  });
}

function waitWithSignal(timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, timeoutMs);
    const handleAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(new Error("Sidecar health wait was cancelled."));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitForHealth(port, token, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Sidecar health wait was cancelled.");
    try {
      return await requestHealth(port, token, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await waitWithSignal(250, signal);
    }
  }
  throw lastError || new Error("Sidecar health did not respond in time.");
}

async function signalChildAndWait(child, signal, timeoutMs) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onExit = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    timer = setTimeout(() => {
      finish(reject, new Error("Timed out waiting for the release-probe sidecar to exit."));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    try { child.kill(signal); } catch (error) { finish(reject, error); }
  });
}

export async function terminateChildAndWait(child, timeoutMs = 5000) {
  if (!child || !Number.isInteger(child.pid)) {
    return { kind: "not-spawned" };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { kind: "already-exited", exitCode: child.exitCode, signalCode: child.signalCode };
  }
  try {
    await signalChildAndWait(child, undefined, timeoutMs);
    return { kind: "terminated", exitCode: child.exitCode, signalCode: child.signalCode };
  } catch (terminationError) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { kind: "terminated", exitCode: child.exitCode, signalCode: child.signalCode };
    }
    try {
      await signalChildAndWait(child, "SIGKILL", Math.min(timeoutMs, 1000));
      return { kind: "force-killed", exitCode: child.exitCode, signalCode: child.signalCode };
    } catch (forceKillError) {
      return {
        kind: "termination-unconfirmed",
        errors: [terminationError, forceKillError]
      };
    }
  }
}

export async function cleanupProbeProcess(child, removeIsolationRoot, timeoutMs = 5000) {
  const outcome = await terminateChildAndWait(child, timeoutMs);
  let removalError = null;
  if (outcome.kind !== "termination-unconfirmed") {
    try {
      removeIsolationRoot();
    } catch (error) {
      removalError = error;
    }
  }
  return { outcome, removalError };
}

export function cleanupProbeFailures(existingFailures, processFailureError, cleanup) {
  const failures = [...existingFailures];
  if (processFailureError && !failures.some(({ error }) => error === processFailureError)) {
    failures.push({ stage: "process lifecycle", error: processFailureError });
  }
  if (cleanup.outcome.kind === "termination-unconfirmed") {
    const cleanupDetails = cleanup.outcome.errors
      .map((error) => error?.message || String(error))
      .join("; ");
    failures.push({
      stage: "process cleanup",
      error: new Error(
        `Portable sidecar termination could not be confirmed${cleanupDetails ? `: ${cleanupDetails}` : "."}`
      )
    });
  } else if (cleanup.outcome.kind === "already-exited" && !processFailureError) {
    failures.push({
      stage: "process lifecycle",
      error: new Error(
        `Portable sidecar exited before verifier cleanup (${cleanup.outcome.exitCode ?? cleanup.outcome.signalCode ?? "unknown status"}).`
      )
    });
  }
  if (cleanup.removalError) {
    failures.push({ stage: "portable-data cleanup", error: cleanup.removalError });
  }
  return failures;
}

function appendBoundedText(current, chunk, limit = 64 * 1024) {
  const combined = current + String(chunk);
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

async function verifySidecarHealth(packageRoot, runtimeRoot) {
  const port = await findOpenPort();
  const token = "release-smoke-token";
  const python = pythonExecutable(runtimeRoot);
  const portableTestRoot = mkdtempSync(path.join(tmpdir(), "ai-transcription-portable-verify-"));
  const child = spawn(python, ["-m", "backend.sidecar_server"], {
    cwd: runtimeRoot,
    env: sanitizedRuntimeEnvironment(runtimeRoot, portableTestRoot, {
      TRANSCRIPT_RESEARCH_STUDIO_BACKEND_HOST: "127.0.0.1",
      TRANSCRIPT_RESEARCH_STUDIO_BACKEND_PORT: String(port),
      TRANSCRIPT_RESEARCH_STUDIO_BACKEND_TOKEN: token,
      TRANSCRIPT_RESEARCH_STUDIO_PORTABLE_ROOT: portableTestRoot
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  const captureStderr = (chunk) => { stderr = appendBoundedText(stderr, chunk); };
  child.stderr?.on("data", captureStderr);
  let failures = [];
  let processFailureError = null;
  let rejectProcessFailure;
  const processFailure = new Promise((_, reject) => { rejectProcessFailure = reject; });
  const handleProcessError = (error) => {
    processFailureError = new Error(`Portable sidecar process failed: ${error.message}`);
    rejectProcessFailure(processFailureError);
  };
  const handleProcessExit = (code, signal) => {
    processFailureError = new Error(
      `Portable sidecar exited before verifier cleanup (${code ?? signal ?? "unknown status"}).`
    );
    rejectProcessFailure(processFailureError);
  };
  child.once("error", handleProcessError);
  child.once("exit", handleProcessExit);
  const healthAbort = new AbortController();
  const healthAttempt = waitForHealth(port, token, 15000, healthAbort.signal);
  try {
    await Promise.race([healthAttempt, processFailure]);
  } catch (error) {
    failures.push({ stage: "health verification", error });
  } finally {
    healthAbort.abort();
    await healthAttempt.catch(() => {});
    child.stderr?.removeListener("data", captureStderr);
    child.removeListener("error", handleProcessError);
    child.removeListener("exit", handleProcessExit);
    const cleanup = await cleanupProbeProcess(
      child,
      () => rmSync(portableTestRoot, { force: true, recursive: true })
    );
    failures = cleanupProbeFailures(failures, processFailureError, cleanup);
  }
  const failure = buildProbeFailure(failures, stderr, token);
  if (failure) throw failure;
}

export function buildProbeFailure(failures, stderr = "", token = "") {
  if (!failures.length) return null;
  const redact = (value) => {
    const text = String(value);
    return token ? text.split(token).join("[redacted]") : text;
  };
  const details = failures.map(({ stage, error }) => `- ${stage}: ${redact(error?.message || error)}`);
  const safeStderr = redact(stderr).trim();
  if (safeStderr) details.push(`- bounded stderr: ${safeStderr}`);
  return new Error(`Portable sidecar verification failed:\n${details.join("\n")}`);
}

function assetNameKey(name, caseSensitive) {
  return caseSensitive ? name : name.toLocaleLowerCase("en-US");
}

function assertSafeAssetName(name, description = "checksum asset") {
  if (
    !name.trim()
    || name.trim() !== name
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || path.basename(name) !== name
    || path.isAbsolute(name)
    || [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`Unsafe ${description} name: ${name || "<empty>"}`);
  }
}

export function parseChecksumManifest(
  contents,
  { caseSensitive = process.platform !== "win32" } = {}
) {
  const entries = new Map();
  const identities = new Set();
  const lines = contents.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("Release checksum manifest is empty.");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const name = match[2];
    assertSafeAssetName(name);
    const identity = assetNameKey(name, caseSensitive);
    if (identities.has(identity)) throw new Error(`Duplicate checksum asset entry: ${name}`);
    identities.add(identity);
    entries.set(name, match[1].toLowerCase());
  }
  return entries;
}

export function verifyChecksumEntries(
  portableRoot,
  contents,
  expectedAssetNames,
  { caseSensitive = process.platform !== "win32" } = {}
) {
  const root = realpathSync(portableRoot);
  const entries = parseChecksumManifest(contents, { caseSensitive });
  const entriesByIdentity = new Map(
    [...entries].map(([name, digest]) => [assetNameKey(name, caseSensitive), { name, digest }])
  );
  const expectedIdentities = new Set();
  for (const expectedName of expectedAssetNames) {
    assertSafeAssetName(expectedName, "expected release asset");
    const identity = assetNameKey(expectedName, caseSensitive);
    if (expectedIdentities.has(identity)) {
      throw new Error(`Duplicate expected release asset: ${expectedName}`);
    }
    expectedIdentities.add(identity);
    if (!entriesByIdentity.has(identity)) {
      throw new Error(`Expected release asset is missing from the checksum manifest: ${expectedName}`);
    }
  }
  for (const [name, expectedDigest] of entries) {
    const assetPath = path.resolve(root, name);
    if (path.dirname(assetPath) !== root) throw new Error(`Checksummed release asset escapes the release root: ${name}`);
    let metadata;
    try {
      metadata = lstatSync(assetPath);
    } catch {
      throw new Error(`Checksummed release asset is missing: ${name}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Checksummed release asset must be an ordinary file: ${name}`);
    }
    const canonicalAsset = realpathSync(assetPath);
    const relativeTarget = path.relative(root, canonicalAsset);
    if (
      relativeTarget === ""
      || relativeTarget === ".."
      || relativeTarget.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeTarget)
    ) {
      throw new Error(`Checksummed release asset escapes the release root: ${name}`);
    }
    if (sha256File(assetPath) !== expectedDigest) throw new Error(`Release asset checksum mismatch: ${name}`);
  }
  return entries;
}

export function expectedPublishedAssetNames(releasePackages, platform = process.platform) {
  const caseSensitive = platform !== "win32";
  const expected = [];
  const identities = new Map();
  const addExpected = (name, role) => {
    assertSafeAssetName(name, "expected release asset");
    const identity = assetNameKey(name, caseSensitive);
    const existingRole = identities.get(identity);
    if (existingRole) {
      throw new Error(`Expected release asset collision between ${existingRole} and ${role}: ${name}`);
    }
    identities.set(identity, role);
    expected.push(name);
  };
  for (const releasePackage of releasePackages) {
    addExpected(`${releasePackage.packageName}.SBOM.cdx.json`, `${releasePackage.variant} SBOM`);
    addExpected(`${releasePackage.packageName}.THIRD_PARTY_NOTICES.md`, `${releasePackage.variant} notices`);
    if (platform !== "win32" || releasePackage.variant !== "cuda") {
      addExpected(path.basename(releasePackage.archivePath), `${releasePackage.variant} archive`);
      continue;
    }
    const manifestName = `${path.basename(releasePackage.archivePath)}.parts.json`;
    const manifestPath = path.join(releasePackage.portableRoot, manifestName);
    assertFile(manifestPath, "CUDA parts manifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    addExpected(manifestName, "CUDA parts manifest");
    addExpected("reassemble_cuda.ps1", "CUDA reassembly helper");
    const parts = Array.isArray(manifest.parts) ? manifest.parts : [];
    if (!parts.length) {
      throw new Error("CUDA parts manifest does not declare any archive parts.");
    }
    const seenParts = new Set();
    for (const part of parts) {
      const partName = String(part?.file_name || "");
      try {
        assertSafeAssetName(partName, "CUDA part filename");
      } catch {
        throw new Error(`CUDA parts manifest contains an unsafe part filename: ${partName || "<empty>"}`);
      }
      const partIdentity = assetNameKey(partName, false);
      if (seenParts.has(partIdentity)) {
        throw new Error(`CUDA parts manifest contains a duplicate part filename: ${partName}`);
      }
      seenParts.add(partIdentity);
      addExpected(partName, "CUDA archive part");
    }
  }
  return expected;
}

function verifyPublishedChecksums(portableRoot, releasePackages) {
  const checksumName = process.platform === "win32" ? "SHA256SUMS-windows-x64.txt" : "SHA256SUMS-macos-arm64.txt";
  const checksumPath = path.join(portableRoot, checksumName);
  assertFile(checksumPath, "Release checksum manifest");
  verifyChecksumEntries(
    portableRoot,
    readFileSync(checksumPath, "utf-8"),
    expectedPublishedAssetNames(releasePackages, process.platform),
    { caseSensitive: process.platform !== "win32" }
  );
}

function extractPublishedArchive(releasePackage) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ai-transcription-archive-verify-"));
  const extractionRoot = path.join(tempRoot, "extracted");
  mkdirSync(extractionRoot, { recursive: true });
  let archivePath = releasePackage.archivePath;

  if (process.platform === "win32" && releasePackage.variant === "cuda") {
    const publishedManifestPath = `${archivePath}.parts.json`;
    const publishedHelperPath = path.join(releasePackage.portableRoot, "reassemble_cuda.ps1");
    assertFile(publishedManifestPath, "CUDA parts manifest");
    assertFile(publishedHelperPath, "CUDA reassembly helper");
    const cudaAssetsRoot = path.join(tempRoot, "cuda-assets");
    mkdirSync(cudaAssetsRoot, { recursive: true });
    const manifest = JSON.parse(readFileSync(publishedManifestPath, "utf-8"));
    const manifestPath = path.join(cudaAssetsRoot, path.basename(publishedManifestPath));
    const helperPath = path.join(cudaAssetsRoot, "reassemble_cuda.ps1");
    copyFileSync(publishedManifestPath, manifestPath);
    copyFileSync(publishedHelperPath, helperPath);
    for (const part of Array.isArray(manifest.parts) ? manifest.parts : []) {
      const partName = String(part?.file_name || "");
      if (!partName || path.basename(partName) !== partName) {
        throw new Error(`CUDA parts manifest contains an unsafe part filename: ${partName || "<empty>"}`);
      }
      const sourcePart = path.join(releasePackage.portableRoot, partName);
      assertFile(sourcePart, `CUDA archive part ${partName}`);
      copyFileSync(sourcePart, path.join(cudaAssetsRoot, path.basename(partName)));
    }
    archivePath = path.join(cudaAssetsRoot, path.basename(releasePackage.archivePath));
    const reassemble = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath,
        "-ManifestPath", manifestPath
      ],
      { encoding: "utf-8" }
    );
    if (reassemble.status !== 0) {
      throw new Error(`CUDA reassembly helper failed: ${reassemble.stderr || reassemble.stdout}`);
    }
  } else {
    assertFile(archivePath, `Published ${releasePackage.variant} ZIP`);
  }

  const extraction = process.platform === "darwin"
    ? spawnSync("ditto", ["-x", "-k", archivePath, extractionRoot], { encoding: "utf-8" })
    : spawnSync("tar", ["-xf", archivePath, "-C", extractionRoot], { encoding: "utf-8" });
  if (extraction.error) {
    throw extraction.error;
  }
  if (extraction.status !== 0) {
    throw new Error(`Could not extract ${archivePath}: ${extraction.stderr || extraction.stdout}`);
  }
  return {
    tempRoot,
    packageRoot: path.join(extractionRoot, releasePackage.packageName)
  };
}

function verifyPublishedPackageMetadata(releasePackage, extractedPackageRoot) {
  for (const [suffix, packagedName] of [
    ["SBOM.cdx.json", "SBOM.cdx.json"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"]
  ]) {
    const publishedPath = path.join(releasePackage.portableRoot, `${releasePackage.packageName}.${suffix}`);
    const packagedPath = path.join(extractedPackageRoot, packagedName);
    assertFile(publishedPath, `Published ${releasePackage.variant} ${suffix}`);
    assertFile(packagedPath, `Packaged ${releasePackage.variant} ${packagedName}`);
    if (sha256File(publishedPath) !== sha256File(packagedPath)) {
      throw new Error(`Published ${suffix} does not match the copy inside ${releasePackage.packageName}.`);
    }
  }
}

async function main() {
  const releasePackages = portablePackages();
  if (process.platform === "win32") {
    const cudaPackage = releasePackages.find((releasePackage) => releasePackage.variant === "cuda");
    if (cudaPackage && existsSync(cudaPackage.archivePath)) {
      throw new Error("The oversized complete CUDA ZIP must not remain among the publishable release assets.");
    }
  }
  verifyPublishedChecksums(releasePackages[0].portableRoot, releasePackages);
  for (const releasePackage of releasePackages) {
    const extracted = extractPublishedArchive(releasePackage);
    try {
      verifyPublishedPackageMetadata(releasePackage, extracted.packageRoot);
      const { runtimeRoot } = verifyStaticLayout(extracted.packageRoot);
      verifyManifest(runtimeRoot, releasePackage.variant);
      verifyWindowsRuntimeVariant(extracted.packageRoot, runtimeRoot, releasePackage.variant);
      verifyMacRuntime(extracted.packageRoot, runtimeRoot);
      if (!skipSidecar) {
        await verifySidecarHealth(extracted.packageRoot, runtimeRoot);
      }
      console.log(`Release archive verified: ${releasePackage.archivePath}`);
    } finally {
      rmSync(extracted.tempRoot, { force: true, recursive: true });
    }
  }
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentScriptPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectInvocation = process.platform === "win32"
  ? invokedScriptPath.toLowerCase() === currentScriptPath.toLowerCase()
  : invokedScriptPath === currentScriptPath;

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
