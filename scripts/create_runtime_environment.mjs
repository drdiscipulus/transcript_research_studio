import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const releaseEnvsRoot = path.join(repoRoot, ".release-envs");
const requestedProfile = process.argv.find((value) => value.startsWith("--profile="))?.split("=", 2)[1];
const recreate = process.argv.includes("--recreate");

const profiles = {
  "windows-cpu": {
    platform: "win32",
    lock: "requirements-win-cpu.txt",
    torchIndex: "https://download.pytorch.org/whl/cpu",
    torchSuffix: "+cpu"
  },
  "windows-cuda": {
    platform: "win32",
    lock: "requirements-win-gpu.txt",
    torchIndex: "https://download.pytorch.org/whl/cu128",
    torchSuffix: "+cu128"
  },
  "macos-arm64": {
    platform: "darwin",
    lock: "requirements-macos-cpu.txt",
    torchIndex: "https://download.pytorch.org/whl/cpu",
    torchSuffix: ""
  }
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    shell: false,
    ...options
  });
  if (result.error || result.status !== 0) {
    throw new Error("Python project source layout could not be inspected.");
  }
  return result.stdout.trim();
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function inspectPythonProjectSourceInputs(python, sourceRoot) {
  const script = `
import glob
import json
import pathlib
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
with (root / "pyproject.toml").open("rb") as handle:
    configuration = tomllib.load(handle)

project = configuration.get("project", {})
setuptools = configuration.get("tool", {}).get("setuptools", {})
packages = setuptools.get("packages")
if not isinstance(packages, list) or not packages or not all(isinstance(item, str) and item.strip() for item in packages):
    raise SystemExit("pyproject.toml must define an explicit tool.setuptools.packages list")

package_directory = setuptools.get("package-dir", {})
if not isinstance(package_directory, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in package_directory.items()):
    raise SystemExit("pyproject.toml contains an invalid tool.setuptools.package-dir mapping")

inputs = {"pyproject.toml"}
package_inputs = set()
default_package_root = pathlib.PurePosixPath(package_directory.get("", ""))
for package in packages:
    package = package.strip()
    mapped = package_directory.get(package)
    if mapped is not None:
        package_inputs.add(pathlib.PurePosixPath(mapped))
    else:
        package_inputs.add(default_package_root / pathlib.PurePosixPath(*package.split(".")))

for candidate in sorted(package_inputs, key=lambda item: (len(item.parts), item.as_posix())):
    if not any(parent == candidate or parent in candidate.parents for parent in map(pathlib.PurePosixPath, inputs)):
        inputs.add(candidate.as_posix())

def add_metadata_file(value):
    if isinstance(value, str):
        inputs.add(pathlib.PurePosixPath(value).as_posix())
    elif isinstance(value, dict) and isinstance(value.get("file"), str):
        inputs.add(pathlib.PurePosixPath(value["file"]).as_posix())

add_metadata_file(project.get("readme"))
add_metadata_file(project.get("license"))

license_patterns = project.get("license-files") or setuptools.get("license-files")
if license_patterns is None:
    license_patterns = ["LICEN[CS]E*", "COPYING*", "NOTICE*", "AUTHORS*"]
if not isinstance(license_patterns, list) or not all(isinstance(item, str) for item in license_patterns):
    raise SystemExit("pyproject.toml contains invalid license file patterns")
for pattern in license_patterns:
    for candidate in glob.glob(str(root / pattern)):
        candidate_path = pathlib.Path(candidate)
        if candidate_path.is_file():
            inputs.add(candidate_path.relative_to(root).as_posix())

print(json.dumps(sorted(inputs)))
  `.trim();
  const output = runCaptured(python, ["-c", script, sourceRoot], { cwd: sourceRoot });
  let inputs;
  try {
    inputs = JSON.parse(output);
  } catch {
    throw new Error("Python project source layout returned invalid metadata.");
  }
  if (!Array.isArray(inputs) || !inputs.length || inputs.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("Python project source layout returned invalid inputs.");
  }
  return inputs;
}

function copyControlledProjectInput(sourceRoot, temporaryRoot, relativeInput) {
  const normalizedInput = path.normalize(relativeInput);
  if (
    path.isAbsolute(relativeInput) ||
    normalizedInput === ".." ||
    normalizedInput.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Python project source input escapes its repository root.");
  }
  const sourcePath = path.join(sourceRoot, normalizedInput);
  if (!existsSync(sourcePath)) {
    throw new Error(`Required local project input is missing: ${relativeInput}`);
  }
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const canonicalSource = realpathSync(sourcePath);
  if (!isPathWithin(canonicalSourceRoot, canonicalSource)) {
    throw new Error(`Required local project input escapes the repository: ${relativeInput}`);
  }

  const generatedNames = new Set([
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "build",
    "dist"
  ]);
  const filter = (candidatePath) => {
    const name = path.basename(candidatePath);
    return !(
      generatedNames.has(name) ||
      name.endsWith(".egg-info") ||
      name.startsWith("__editable__") ||
      name === "direct_url.json" ||
      name.endsWith(".pyc") ||
      name.endsWith(".pyo")
    );
  };
  const destinationPath = path.join(temporaryRoot, normalizedInput);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, {
    recursive: lstatSync(sourcePath).isDirectory(),
    force: true,
    verbatimSymlinks: true,
    filter
  });
}

function assertSafeEnvironmentPath(environmentPath) {
  const relative = path.relative(releaseEnvsRoot, environmentPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify an unsafe runtime environment path: ${environmentPath}`);
  }
}

function lockedRequirementBlock(lockContents, packageName) {
  const lines = lockContents.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${packageName}==`));
  if (start === -1) {
    throw new Error(`Could not find the locked ${packageName} requirement.`);
  }
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length && lines[index].trimStart().startsWith("--hash=sha256:"); index += 1) {
    block.push(lines[index]);
  }
  if (block.length === 1) {
    throw new Error(`The locked ${packageName} requirement does not include hashes.`);
  }
  return block.join("\n");
}

function installTorchPackages(python, lockPath, torchIndex) {
  const requirements = ["torch", "torchaudio"]
    .map((packageName) => lockedRequirementBlock(readFileSync(lockPath, "utf-8"), packageName))
    .join("\n");
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-studio-torch-"));
  const requirementsPath = path.join(temporaryRoot, "torch-requirements.txt");
  try {
    writeFileSync(requirementsPath, `${requirements}\n`, "utf-8");
    run(python, [
      "-m", "pip", "install",
      "--require-hashes",
      "--no-deps",
      "--index-url", torchIndex,
      "-r", requirementsPath
    ]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function installLocalProjectFromOwnedContext({
  python,
  sourceRoot = repoRoot,
  runCommand = run,
  inspectSourceInputs = inspectPythonProjectSourceInputs,
  temporaryParent = tmpdir()
}) {
  const temporaryRoot = mkdtempSync(path.join(temporaryParent, "transcript-research-sidecar-source-"));
  try {
    const inputs = inspectSourceInputs(python, sourceRoot);
    for (const relativeInput of inputs) {
      copyControlledProjectInput(sourceRoot, temporaryRoot, relativeInput);
    }
    runCommand(
      python,
      ["-m", "pip", "install", "--no-deps", "--no-build-isolation", temporaryRoot],
      { cwd: temporaryRoot }
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const profileName = requestedProfile || (process.platform === "darwin" ? "macos-arm64" : "windows-cpu");
  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown profile ${profileName}. Expected one of: ${Object.keys(profiles).join(", ")}`);
  }
  if (profile.platform !== process.platform) {
    throw new Error(`${profileName} must be built on ${profile.platform}, not ${process.platform}.`);
  }

  const environmentPath = path.join(releaseEnvsRoot, profileName);
  assertSafeEnvironmentPath(environmentPath);
  if (existsSync(environmentPath)) {
    if (!recreate) {
      throw new Error(`${environmentPath} already exists. Pass --recreate to build it from scratch.`);
    }
    rmSync(environmentPath, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    run("py", ["-3.12", "-m", "venv", environmentPath]);
  } else {
    run("python3.12", ["-m", "venv", environmentPath]);
  }

  const python = process.platform === "win32"
    ? path.join(environmentPath, "Scripts", "python.exe")
    : path.join(environmentPath, "bin", "python");
  const lockPath = path.join(repoRoot, profile.lock);
  installTorchPackages(python, lockPath, profile.torchIndex);
  run(python, ["-m", "pip", "install", "--require-hashes", "-r", lockPath]);
  installLocalProjectFromOwnedContext({ python });

  const probe = [
    "import importlib.metadata as m, json, platform, sys, torch, torchaudio",
    "expected={'faster-whisper':'1.2.1','pyannote-audio':'4.0.4','av':'17.0.1','huggingface-hub':'0.36.2'}",
    "actual={name:m.version(name) for name in expected}",
    "assert actual == expected, (actual, expected)",
    "assert sys.version_info[:2] == (3, 12), sys.version",
    `assert torch.__version__ == '2.8.0${profile.torchSuffix}', torch.__version__`,
    `assert torchaudio.__version__ == '2.8.0${profile.torchSuffix}', torchaudio.__version__`,
    "print(json.dumps({'python':platform.python_version(),'machine':platform.machine(),'torch':torch.__version__,'torchaudio':torchaudio.__version__,**actual}, sort_keys=True))"
  ].join("; ");
  run(python, ["-c", probe]);
  process.stdout.write(`Fresh ${profileName} runtime environment created at ${environmentPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
