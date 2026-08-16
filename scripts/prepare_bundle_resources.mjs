import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readPythonProjectIdentity, readReleaseVersion } from "./release_identity.mjs";
import {
  assertStagedPythonEntrypoints,
  assertStagedRuntimeSymlinks,
  normalizeStagedMacRuntime,
  pruneUnusedMacosAudioIoBackends,
  recreateOwnedGeneratedRoot,
  removeKnownIntelPythonHelpers,
  sanitizeStagedMacRuntimeSearchPaths
} from "./macos_runtime_staging.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const appVersion = readReleaseVersion(repoRoot);
const pythonProjectIdentity = readPythonProjectIdentity(repoRoot);
const bundleRoot = path.join(repoRoot, "src-tauri", "gen", "runtime");
const windowsCpuBundleRoot = path.join(repoRoot, "src-tauri", "gen", "runtime-windows-cpu");
const tauriTargetRoot = path.join(repoRoot, "src-tauri", "target");
const obsoleteAsrPackageNames = new Set(["openai-whisper", "openai_whisper", "whisper", "whisperx"]);
const obsoleteAsrDistInfoPrefixes = ["openai-whisper-", "openai_whisper-", "whisper-", "whisperx-"];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function ensureCleanDirectory(directoryPath) {
  rmSync(directoryPath, { force: true, recursive: true });
  mkdirSync(directoryPath, { recursive: true });
}

function defaultFilter(sourcePath) {
  const name = path.basename(sourcePath);
  return name !== "__pycache__" && !name.endsWith(".pyc") && !name.endsWith(".pyo");
}

function detectWindowsPythonBase(version) {
  const output = execFileSync("py", [`-${version}`, "-c", "import sys; print(sys.base_prefix)"], {
    cwd: repoRoot,
    encoding: "utf-8"
  }).trim();
  if (!output) {
    throw new Error(`Python ${version} base runtime path could not be detected.`);
  }
  return output;
}

function detectWindowsVenvPurelib(venvPythonPath) {
  const output = execFileSync(
    venvPythonPath,
    ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
    { cwd: repoRoot, encoding: "utf-8" }
  ).trim();
  if (!output) {
    throw new Error(`Could not detect purelib path for ${venvPythonPath}`);
  }
  return output;
}

function probePythonRuntime(pythonExecutable) {
  const script = `
import json
import os
import sys
import sysconfig

payload = {
  "base_prefix": sys.base_prefix,
  "purelib": sysconfig.get_path("purelib"),
  "version_major_minor": ".".join(str(part) for part in sys.version_info[:2]),
  "version": ".".join(str(part) for part in sys.version_info[:3]),
  "version_tag": f"python{sys.version_info[0]}.{sys.version_info[1]}",
  "executable_name": os.path.basename(sys.executable),
  "base_executable_name": os.path.basename(getattr(sys, "_base_executable", sys.executable)),
}
print(json.dumps(payload))
  `.trim();

  const output = execFileSync(pythonExecutable, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8"
  }).trim();
  if (!output) {
    throw new Error(`Could not probe Python runtime metadata for ${pythonExecutable}`);
  }
  return JSON.parse(output);
}

function validateRuntimeProfile(pythonExecutable, profile) {
  const script = `
import importlib.metadata as metadata
import json
import platform
import sys
import torch
import torchaudio

payload = {
  "python": platform.python_version(),
  "machine": platform.machine().lower(),
  "pointer_bits": 64 if sys.maxsize > 2**32 else 32,
  "torch": torch.__version__,
  "torchaudio": torchaudio.__version__,
  "torch_cuda": torch.version.cuda,
  "faster_whisper": metadata.version("faster-whisper"),
  "pyannote_audio": metadata.version("pyannote-audio"),
  "av": metadata.version("av"),
  "huggingface_hub": metadata.version("huggingface-hub"),
}
print(json.dumps(payload))
  `.trim();
  const payload = JSON.parse(execFileSync(pythonExecutable, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8"
  }).trim());
  const expected = {
    faster_whisper: "1.2.1",
    pyannote_audio: "4.0.4",
    av: "17.0.1",
    huggingface_hub: "0.36.2"
  };
  for (const [name, version] of Object.entries(expected)) {
    if (payload[name] !== version) {
      throw new Error(`${profile} requires ${name} ${version}, but ${pythonExecutable} has ${payload[name]}.`);
    }
  }
  if (!payload.python.startsWith("3.12.") || payload.pointer_bits !== 64) {
    throw new Error(`${profile} requires 64-bit Python 3.12, but found ${payload.python} (${payload.pointer_bits}-bit).`);
  }
  if (profile === "windows-x64-cpu" && (payload.torch !== "2.8.0+cpu" || payload.torchaudio !== "2.8.0+cpu")) {
    throw new Error(`${profile} requires Torch/Torchaudio 2.8.0+cpu, found ${payload.torch}/${payload.torchaudio}.`);
  }
  if (profile === "windows-x64-cuda" && (payload.torch !== "2.8.0+cu128" || payload.torchaudio !== "2.8.0+cu128" || payload.torch_cuda !== "12.8")) {
    throw new Error(`${profile} requires Torch/Torchaudio 2.8.0+cu128 with CUDA 12.8, found ${payload.torch}/${payload.torchaudio} (${payload.torch_cuda}).`);
  }
  if (profile === "macos-arm64-cpu" && (payload.torch !== "2.8.0" || payload.torchaudio !== "2.8.0" || !payload.machine.includes("arm64"))) {
    throw new Error(`${profile} requires native arm64 Torch/Torchaudio 2.8.0, found ${payload.machine} ${payload.torch}/${payload.torchaudio}.`);
  }
  return payload;
}

function copyDirectory(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: defaultFilter
  });
}

function removePathIfPresent(targetPath) {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { force: true, recursive: true });
  }
}

function removeMatchingChildren(parentDirectory, predicate) {
  if (!existsSync(parentDirectory)) {
    return;
  }
  for (const entry of readdirSync(parentDirectory, { withFileTypes: true })) {
    if (predicate(entry)) {
      removePathIfPresent(path.join(parentDirectory, entry.name));
    }
  }
}

function clearGeneratedRuntimeOutputs() {
  for (const mode of ["debug", "release"]) {
    removePathIfPresent(path.join(tauriTargetRoot, mode, "gen", "runtime"));
  }
}

function overlayDirectoryContents(sourceDirectory, destinationDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (defaultFilter(sourcePath)) {
      cpSync(sourcePath, destinationPath, { force: true });
    }
  }
}

function copyWindowsRuntimeRoot(sourceRoot, destinationRoot) {
  const runtimeFiles = [
    "LICENSE.txt",
    "python.exe",
    "pythonw.exe",
    "python3.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll"
  ];
  const runtimeDirectories = ["DLLs", "Lib"];

  for (const name of runtimeFiles) {
    const sourcePath = path.join(sourceRoot, name);
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, path.join(destinationRoot, name), { force: true });
    }
  }

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (/^python\d+\.dll$/i.test(entry.name)) {
      cpSync(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name), { force: true });
    }
  }

  for (const directoryName of runtimeDirectories) {
    const sourcePath = path.join(sourceRoot, directoryName);
    if (existsSync(sourcePath)) {
      copyDirectory(sourcePath, path.join(destinationRoot, directoryName));
    }
  }
}

function copyPosixRuntimeRoot(sourceRoot, destinationRoot) {
  copyDirectory(sourceRoot, destinationRoot);
}

function pruneDirectoryChildren(parentDirectory, childNames) {
  if (!existsSync(parentDirectory)) {
    return;
  }
  for (const childName of childNames) {
    removePathIfPresent(path.join(parentDirectory, childName));
  }
}

function ensureOwnerWritableTree(directoryPath) {
  if (!existsSync(directoryPath)) {
    return;
  }

  function walk(currentPath) {
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      return;
    }
    try {
      chmodSync(currentPath, stats.mode | 0o200);
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") {
        throw error;
      }
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      walk(path.join(currentPath, entry.name));
    }
  }

  walk(directoryPath);
}

function pruneRuntimeTree(destinationRoot, runtimeInfo) {
  if (process.platform === "win32") {
    pruneWindowsRuntimeTree(destinationRoot);
    return;
  }
  prunePosixRuntimeTree(destinationRoot, runtimeInfo);
}

function pruneWindowsRuntimeTree(destinationRoot) {
  pruneDirectoryChildren(destinationRoot, ["Doc", "include", "libs", "Scripts", "tcl", "Tools", "NEWS.txt", "__install__.json"]);

  const stdlibRoot = path.join(destinationRoot, "Lib");
  pruneCommonRuntimePaths(stdlibRoot, path.join(stdlibRoot, "site-packages"));
}

function prunePosixRuntimeTree(destinationRoot, runtimeInfo) {
  pruneDirectoryChildren(destinationRoot, ["Headers", "include", "share"]);

  const stdlibRoot = path.join(destinationRoot, "lib", runtimeInfo.version_tag);
  pruneCommonRuntimePaths(stdlibRoot, path.join(stdlibRoot, "site-packages"));
}

function pruneCommonRuntimePaths(stdlibRoot, sitePackagesRoot) {
  if (!existsSync(stdlibRoot)) {
    return;
  }

  pruneDirectoryChildren(stdlibRoot, ["ensurepip", "idlelib", "lib2to3", "test", "tkinter", "turtledemo", "venv"]);

  if (!existsSync(sitePackagesRoot)) {
    return;
  }

  pruneObsoleteAsrPackages(sitePackagesRoot);

  pruneDirectoryChildren(sitePackagesRoot, [
    "pip",
    "wheel"
  ]);

  for (const entry of readdirSync(sitePackagesRoot, { withFileTypes: true })) {
    const entryPath = path.join(sitePackagesRoot, entry.name);
    if (entry.name.startsWith("__editable__")) {
      removePathIfPresent(entryPath);
      continue;
    }
    if (entry.isDirectory() && entry.name.endsWith(".dist-info")) {
      removePathIfPresent(path.join(entryPath, "direct_url.json"));
    }
    if (entry.name.startsWith("pip-") && entry.name.endsWith(".dist-info")) {
      removePathIfPresent(entryPath);
      continue;
    }
    if (entry.name.startsWith("wheel-") && entry.name.endsWith(".dist-info")) {
      removePathIfPresent(entryPath);
      continue;
    }
  }

  const removableDirectoryNames = new Set([
    "__pycache__",
    "benchmarks",
    "benchmark",
    "docs",
    "doc",
    "examples",
    "example",
    "include",
    "samples",
    "sample",
    "tests",
    "test",
    "testing"
  ]);
  const removableFileExtensions = new Set([".a", ".exp", ".lib", ".pdb"]);
  const protectedDirectoryPaths = new Set([path.join("numpy", "testing")]);

  function walk(currentDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        const relativePath = path.relative(sitePackagesRoot, entryPath);
        const relativeSegments = relativePath.split(path.sep);
        const protectedPackageRoots = new Set(["torch"]);
        const isProtectedTree = protectedPackageRoots.has(relativeSegments[0]);
        const isProtectedDirectory = protectedDirectoryPaths.has(relativePath);
        if (removableDirectoryNames.has(entry.name.toLowerCase())) {
          if (isProtectedTree || isProtectedDirectory) {
            walk(entryPath);
            continue;
          }
          removePathIfPresent(entryPath);
          continue;
        }
        walk(entryPath);
      } else if (removableFileExtensions.has(path.extname(entry.name).toLowerCase())) {
        removePathIfPresent(entryPath);
      }
    }
  }

  walk(sitePackagesRoot);
}

function pruneObsoleteAsrPackages(sitePackagesRoot) {
  for (const entry of readdirSync(sitePackagesRoot, { withFileTypes: true })) {
    const lowerName = entry.name.toLowerCase();
    const isObsoletePackageDirectory = entry.isDirectory() && obsoleteAsrPackageNames.has(lowerName);
    const isObsoleteMetadata =
      entry.isDirectory() &&
      lowerName.endsWith(".dist-info") &&
      obsoleteAsrDistInfoPrefixes.some((prefix) => lowerName.startsWith(prefix));

    if (isObsoletePackageDirectory || isObsoleteMetadata) {
      removePathIfPresent(path.join(sitePackagesRoot, entry.name));
    }
  }
}

function pruneCpuRuntimeSitePackages(sitePackagesRoot) {
  const torchRoot = path.join(sitePackagesRoot, "torch");
  pruneDirectoryChildren(torchRoot, ["include"]);
}

function normalizeDistributionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function lockedDistributions(lockFileName) {
  const contents = readFileSync(path.join(repoRoot, lockFileName), "utf-8");
  const distributions = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\?$/);
    if (match) {
      distributions.set(normalizeDistributionName(match[1]), match[2]);
    }
  }
  if (distributions.size === 0) {
    throw new Error(`No exact distributions were found in ${lockFileName}.`);
  }
  return distributions;
}

function stagedDistributions(sitePackagesRoot) {
  const distributions = new Map();
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
    const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (name && version) {
      distributions.set(normalizeDistributionName(name), version);
    }
  }
  return distributions;
}

function validateStagedDistributions(sitePackagesRoot, lockFileName) {
  const expected = lockedDistributions(lockFileName);
  expected.set(pythonProjectIdentity.name, pythonProjectIdentity.version);
  const actual = stagedDistributions(sitePackagesRoot);
  const missing = [...expected].filter(([name, version]) => actual.get(name) !== version);
  const unexpected = [...actual].filter(([name, version]) => expected.get(name) !== version);
  if (missing.length || unexpected.length) {
    const describe = (entries) => entries.map(([name, version]) => `${name}==${version}`).join(", ") || "none";
    throw new Error(
      `Staged Python distributions do not match ${lockFileName}. Missing/mismatched: ${describe(missing)}. ` +
      `Unexpected/mismatched: ${describe(unexpected)}.`
    );
  }
}

function pruneRedundantCudaRuntimePackages(sitePackagesRoot) {
  if (!torchLibHasRequiredCudaDlls(sitePackagesRoot)) {
    return;
  }
  pruneDirectoryChildren(sitePackagesRoot, ["nvidia"]);
  removeMatchingChildren(
    sitePackagesRoot,
    (entry) => entry.isDirectory() && /^nvidia[_-].*\.dist-info$/i.test(entry.name)
  );
}

function torchLibHasRequiredCudaDlls(sitePackagesRoot) {
  const torchLibRoot = path.join(sitePackagesRoot, "torch", "lib");
  return ["cublas64_12.dll", "cublasLt64_12.dll", "nvrtc64_120_0.dll", "cudnn64_9.dll"].every((dllName) =>
    existsSync(path.join(torchLibRoot, dllName))
  );
}

function ensurePosixPythonEntryPoint(destinationRoot, runtimeInfo) {
  const binRoot = path.join(destinationRoot, "bin");
  const pythonEntryPoint = path.join(binRoot, "python");
  if (existsSync(pythonEntryPoint)) {
    return;
  }

  const candidates = [runtimeInfo.base_executable_name, runtimeInfo.executable_name, "python3"];
  const target = candidates.find((candidate) => candidate && existsSync(path.join(binRoot, candidate)));
  if (!target) {
    throw new Error(`No POSIX Python executable was found in ${binRoot}`);
  }
  symlinkSync(target, pythonEntryPoint);
}

function stagePythonRuntime({
  label,
  baseRuntimePath,
  venvPythonPath,
  destinationName,
  runtimeBundleRoot = bundleRoot,
  trimCpuRuntime = false,
  deduplicateCudaRuntime = false,
  lockFileName
}) {
  const runtimeInfo = probePythonRuntime(venvPythonPath);
  const destinationRoot = path.join(runtimeBundleRoot, destinationName);
  log(`Staging ${label} runtime from ${baseRuntimePath}`);
  ensureCleanDirectory(destinationRoot);

  if (process.platform === "win32") {
    copyWindowsRuntimeRoot(baseRuntimePath, destinationRoot);
  } else {
    copyPosixRuntimeRoot(baseRuntimePath, destinationRoot);
  }

  const purelibPath =
    process.platform === "win32" ? detectWindowsVenvPurelib(venvPythonPath) : runtimeInfo.purelib;
  const destinationPurelib =
    process.platform === "win32"
      ? path.join(destinationRoot, "Lib", "site-packages")
      : path.join(destinationRoot, "lib", runtimeInfo.version_tag, "site-packages");

  // The base interpreter can contain maintainer-global packages. Remove its
  // site-packages completely before copying the fresh, hash-locked venv.
  removePathIfPresent(destinationPurelib);
  log(`Copying isolated ${label} site-packages from ${purelibPath}`);
  overlayDirectoryContents(purelibPath, destinationPurelib);

  if (process.platform !== "win32") {
    ensurePosixPythonEntryPoint(destinationRoot, runtimeInfo);
  }

  pruneRuntimeTree(destinationRoot, runtimeInfo);
  if (trimCpuRuntime) {
    pruneCpuRuntimeSitePackages(destinationPurelib);
  }
  if (deduplicateCudaRuntime) {
    pruneRedundantCudaRuntimePackages(destinationPurelib);
  }
  validateStagedDistributions(destinationPurelib, lockFileName);
  ensureOwnerWritableTree(destinationRoot);

  return {
    destinationRoot,
    purelibPath,
    runtimeInfo
  };
}

function stageBackendSource(runtimeBundleRoot = bundleRoot) {
  const sourcePath = path.join(repoRoot, "backend");
  const destinationPath = path.join(runtimeBundleRoot, "backend");
  log(`Staging backend source from ${sourcePath}`);
  ensureCleanDirectory(destinationPath);
  copyDirectory(sourcePath, destinationPath);
}

function summarizeDirectory(directoryPath) {
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

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Directory(directoryPath) {
  const hash = createHash("sha256");

  function walk(currentPath) {
    const entries = readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => defaultFilter(path.join(currentPath, entry.name)))
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

function gitValue(args) {
  const result = execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
  if (!result) {
    throw new Error(`git ${args.join(" ")} returned no value.`);
  }
  return result;
}

let cachedBuildIdentity = null;

function buildIdentity() {
  if (cachedBuildIdentity) {
    return cachedBuildIdentity;
  }
  if (process.env.TRANSCRIPT_RESEARCH_STUDIO_BUILD_TAG || process.env.TRANSCRIPT_RESEARCH_STUDIO_BUILD_COMMIT) {
    throw new Error("Release tag and commit provenance are derived from Git and cannot be overridden.");
  }
  const commitSha = gitValue(["rev-parse", "HEAD"]);
  const expectedTag = `v${appVersion}`;
  let annotatedTagMatchesHead = false;
  try {
    const tagType = gitValue(["cat-file", "-t", `refs/tags/${expectedTag}`]);
    const taggedCommit = gitValue(["rev-parse", `${expectedTag}^{commit}`]);
    annotatedTagMatchesHead = tagType === "tag" && taggedCommit === commitSha;
  } catch {
    annotatedTagMatchesHead = false;
  }
  const qualification = process.env.TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD === "1";
  if (!annotatedTagMatchesHead && !qualification) {
    throw new Error(
      `Release packaging requires annotated tag ${expectedTag} at HEAD. Use the qualification release command before tagging.`
    );
  }
  const commitEpoch = Number(gitValue(["show", "-s", "--format=%ct", commitSha]));
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch <= 0) {
    throw new Error(`Could not derive a valid build epoch from commit ${commitSha}.`);
  }
  if (process.env.SOURCE_DATE_EPOCH && Number(process.env.SOURCE_DATE_EPOCH) !== commitEpoch) {
    throw new Error("SOURCE_DATE_EPOCH must match the verified source commit timestamp.");
  }
  cachedBuildIdentity = {
    tag: qualification ? `qualification-${commitSha.slice(0, 12)}` : expectedTag,
    commitSha,
    commitEpoch,
    qualification
  };
  return cachedBuildIdentity;
}

function buildProvenance({ runtimeProfile, runtimeInfo, lockFileName, buildTimeUtc }) {
  const identity = buildIdentity();
  const lockPath = path.join(repoRoot, lockFileName);
  if (!existsSync(lockPath)) {
    throw new Error(`Runtime lock is missing: ${lockPath}`);
  }
  return {
    manifest_version: 1,
    app_version: appVersion,
    tag: identity.tag,
    commit_sha: identity.commitSha,
    qualification_build: identity.qualification,
    platform: process.platform,
    architecture: process.arch,
    runtime_profile: runtimeProfile,
    python_version: runtimeInfo.version,
    dependency_lock: lockFileName,
    dependency_lock_hash: sha256File(lockPath),
    backend_source_hash: sha256Directory(path.join(repoRoot, "backend")),
    build_time_utc: buildTimeUtc
  };
}

function detectBundleInputs() {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error(`prepare_bundle_resources is not configured for platform ${process.platform}.`);
  }

  const releaseEnvironmentName = process.platform === "win32" ? "windows-cuda" : "macos-arm64";
  const releaseEnvironmentPython = process.platform === "win32"
    ? path.join(repoRoot, ".release-envs", releaseEnvironmentName, "Scripts", "python.exe")
    : path.join(repoRoot, ".release-envs", releaseEnvironmentName, "bin", "python");
  const sharedVenvCandidates = [
    process.env.TRANSCRIPT_RESEARCH_STUDIO_SHARED_VENV_PYTHON,
    process.env.TRANSCRIPT_RESEARCH_STUDIO_MAIN_VENV_PYTHON,
    releaseEnvironmentPython
  ].filter(Boolean);
  const sharedVenvPython = sharedVenvCandidates.find((candidate) => existsSync(candidate));
  if (!sharedVenvPython) {
    throw new Error(
      `Could not find the fresh ${releaseEnvironmentName} release environment. Run the matching npm runtime:* script first.`
    );
  }

  const sharedProbe = probePythonRuntime(sharedVenvPython);
  if (sharedProbe.version_major_minor !== "3.12") {
    throw new Error(
      `Shared runtime must use Python 3.12, but ${sharedVenvPython} reports ${sharedProbe.version_major_minor}.`
    );
  }

  const sharedBase =
    process.env.TRANSCRIPT_RESEARCH_STUDIO_BUNDLE_SHARED_BASE ||
    process.env.TRANSCRIPT_RESEARCH_STUDIO_BUNDLE_MAIN_BASE ||
    (process.platform === "win32" ? detectWindowsPythonBase("3.12") : sharedProbe.base_prefix);

  for (const requiredPath of [sharedBase, sharedVenvPython]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Required runtime input is missing: ${requiredPath}`);
    }
  }

  return {
    sharedBase,
    sharedVenvPython,
    windowsCpuVenvPython: detectWindowsCpuVenvPython()
  };
}

function detectWindowsCpuVenvPython() {
  if (process.platform !== "win32") {
    return null;
  }
  const candidates = [
    process.env.TRANSCRIPT_RESEARCH_STUDIO_WINDOWS_CPU_VENV_PYTHON,
    path.join(repoRoot, ".release-envs", "windows-cpu", "Scripts", "python.exe")
  ].filter(Boolean);
  const pythonPath = candidates.find((candidate) => existsSync(candidate));
  if (!pythonPath) {
    throw new Error("The fresh Windows CPU release environment is missing. Run npm run runtime:windows:cpu first.");
  }
  const probe = probePythonRuntime(pythonPath);
  if (probe.version_major_minor !== "3.12") {
    throw new Error(
      `Windows CPU runtime must use Python 3.12, but ${pythonPath} reports ${probe.version_major_minor}.`
    );
  }
  return pythonPath;
}

function main() {
  const inputs = detectBundleInputs();
  const identity = buildIdentity();
  const sharedProfile = process.platform === "win32" ? "windows-x64-cuda" : "macos-arm64-cpu";
  const sharedLock = process.platform === "win32" ? "requirements-win-gpu.txt" : "requirements-macos-cpu.txt";
  validateRuntimeProfile(inputs.sharedVenvPython, sharedProfile);
  if (process.platform === "win32") {
    validateRuntimeProfile(inputs.windowsCpuVenvPython, "windows-x64-cpu");
  }
  const buildTimeUtc = new Date(identity.commitEpoch * 1000).toISOString();
  clearGeneratedRuntimeOutputs();
  recreateOwnedGeneratedRoot(bundleRoot, repoRoot);
  removePathIfPresent(path.join(bundleRoot, "python-main"));
  removePathIfPresent(windowsCpuBundleRoot);

  const sharedRuntime = stagePythonRuntime({
    label: "shared",
    baseRuntimePath: inputs.sharedBase,
    venvPythonPath: inputs.sharedVenvPython,
    destinationName: "python-runtime",
    trimCpuRuntime: process.platform === "darwin",
    deduplicateCudaRuntime: process.platform === "win32",
    lockFileName: sharedLock
  });
  if (process.platform === "darwin") {
    assertStagedRuntimeSymlinks(sharedRuntime.destinationRoot);
    const removedAudioIoBackends = pruneUnusedMacosAudioIoBackends({
      runtimeRoot: sharedRuntime.destinationRoot,
      versionTag: sharedRuntime.runtimeInfo.version_tag,
      profile: sharedProfile
    });
    const removedHelpers = removeKnownIntelPythonHelpers(
      sharedRuntime.destinationRoot,
      sharedRuntime.runtimeInfo.version_major_minor
    );
    const normalization = normalizeStagedMacRuntime(sharedRuntime.destinationRoot);
    const sanitizedSearchPaths = sanitizeStagedMacRuntimeSearchPaths(sharedRuntime.destinationRoot);
    const entryPoints = assertStagedPythonEntrypoints(
      sharedRuntime.destinationRoot,
      sharedRuntime.runtimeInfo.version_major_minor
    );
    assertStagedRuntimeSymlinks(sharedRuntime.destinationRoot);
    for (const relativePath of removedHelpers) {
      log(`Removed staged Intel-only Python helper: ${relativePath}`);
    }
    for (const relativePath of removedAudioIoBackends) {
      log(`Removed unused staged macOS audio I/O backend: ${relativePath}`);
    }
    for (const relativePath of normalization.thinnedPaths) {
      log(`Thinned staged macOS Mach-O to arm64: ${relativePath}`);
    }
    for (const sanitized of sanitizedSearchPaths) {
      log(
        `Removed ${sanitized.removedSearchPathCount} absolute build runtime search path(s) from: ` +
        sanitized.relativePath
      );
    }
    log(`macOS Universal2 thinning: ${normalization.thinnedPaths.length} files converted to arm64-only`);
    log(
      `macOS runtime-search-path sanitization: ${sanitizedSearchPaths.reduce(
        (total, item) => total + item.removedSearchPathCount,
        0
      )} absolute build path(s) removed from ${sanitizedSearchPaths.length} Mach-O file(s)`
    );
    log(
      `macOS Mach-O normalization: ${normalization.machOPathsBefore.length} before thinning; ` +
      `${normalization.machOPaths.length} arm64-only files after thinning`
    );
    log(`macOS Python entry points: ${entryPoints.join(", ")}`);
  }
  stageBackendSource();

  const manifest = {
    ...buildProvenance({
      runtimeProfile: sharedProfile,
      runtimeInfo: sharedRuntime.runtimeInfo,
      lockFileName: sharedLock,
      buildTimeUtc
    }),
    generated_at: buildTimeUtc,
    runtime_layout: "shared",
    python_runtime_summary: summarizeDirectory(sharedRuntime.destinationRoot)
  };
  writeFileSync(path.join(bundleRoot, "bundle-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  log(`Bundle resources prepared at ${bundleRoot}`);
  log(`python-runtime: ${manifest.python_runtime_summary.fileCount} files`);

  if (inputs.windowsCpuVenvPython) {
    const cpuRuntime = stagePythonRuntime({
      label: "Windows CPU",
      baseRuntimePath: inputs.sharedBase,
      venvPythonPath: inputs.windowsCpuVenvPython,
      destinationName: "python-runtime",
      runtimeBundleRoot: windowsCpuBundleRoot,
      trimCpuRuntime: true,
      lockFileName: "requirements-win-cpu.txt"
    });
    stageBackendSource(windowsCpuBundleRoot);
    const cpuManifest = {
      ...buildProvenance({
        runtimeProfile: "windows-x64-cpu",
        runtimeInfo: cpuRuntime.runtimeInfo,
        lockFileName: "requirements-win-cpu.txt",
        buildTimeUtc
      }),
      generated_at: buildTimeUtc,
      runtime_layout: "shared",
      windows_runtime_variant: "cpu",
      python_runtime_summary: summarizeDirectory(cpuRuntime.destinationRoot)
    };
    writeFileSync(path.join(windowsCpuBundleRoot, "bundle-manifest.json"), JSON.stringify(cpuManifest, null, 2), "utf-8");
    log(`Windows CPU bundle resources prepared at ${windowsCpuBundleRoot}`);
    log(`windows-cpu python-runtime: ${cpuManifest.python_runtime_summary.fileCount} files`);
  }
}

main();
