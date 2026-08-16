import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readReleaseVersion } from "./release_identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const version = readReleaseVersion(repoRoot);
const releaseRoot = path.join(repoRoot, "src-tauri", "target", "release");
const bundleRoot = path.join(releaseRoot, "bundle");
const exportRoot = path.join(repoRoot, "release-artifacts", process.platform);
const installedRoot = path.join(exportRoot, "installed");
const portableMarkerName = ".transcript_research_studio_portable";
const portableDataDirectoryName = "transcript_research_studio_data";
const packagedUserGuideName = "README.md";
const licenseFileName = "LICENSE";
const windowsPortableBaseName = `transcript_research_studio_${version}_windows_x64_portable`;
const windowsCpuPortableName = `transcript_research_studio_${version}_windows_x64_cpu_portable`;
const windowsCudaPortableName = `transcript_research_studio_${version}_windows_x64_cuda_portable`;
const macPortableName = `transcript_research_studio_${version}_macos_arm64_portable`;

function readText(filePath) {
  return readFileSync(filePath, "utf-8");
}

function ensureCleanDirectory(directoryPath) {
  rmSync(directoryPath, { force: true, recursive: true });
  mkdirSync(directoryPath, { recursive: true });
}

function ensureDirectory(directoryPath) {
  mkdirSync(directoryPath, { recursive: true });
}

function copyPath(sourcePath, destinationPath) {
  if (process.platform === "darwin") {
    const result = spawnSync("ditto", [sourcePath, destinationPath], {
      stdio: "inherit"
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`ditto ${sourcePath} ${destinationPath} failed with exit code ${result.status}`);
    }
    return;
  }
  cpSync(sourcePath, destinationPath, { recursive: true, force: true });
}

function removePathIfPresent(targetPath) {
  rmSync(targetPath, { force: true, recursive: true });
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function findDirectoriesRecursively(rootPath, predicate) {
  const results = [];

  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (predicate(entryPath, entry.name)) {
        results.push(entryPath);
      }
      walk(entryPath);
    }
  }

  if (existsSync(rootPath)) {
    walk(rootPath);
  }
  return results;
}

function writePortableScaffold(portablePackageRoot) {
  copyPath(path.join(repoRoot, "docs", "user_guide.md"), path.join(portablePackageRoot, packagedUserGuideName));
  copyPath(path.join(repoRoot, licenseFileName), path.join(portablePackageRoot, licenseFileName));
  ensureDirectory(path.join(portablePackageRoot, portableDataDirectoryName));
  writeFileSync(
    path.join(portablePackageRoot, portableMarkerName),
    "Transcript Research Studio portable mode marker.\n",
    "utf-8"
  );
}

function annotateRuntimeVariant(packageRoot, variant) {
  const manifestPath = path.join(packageRoot, "gen", "runtime", "bundle-manifest.json");
  if (!existsSync(manifestPath)) {
    return;
  }
  const manifest = JSON.parse(readText(manifestPath));
  manifest.windows_runtime_variant = variant;
  manifest.windows_runtime_variant_note =
    variant === "cpu"
      ? "Independently built Windows CPU package using the exact hashed CPU dependency lock."
      : "Independently built Windows CUDA 12.8 package using the exact hashed CUDA dependency lock.";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

function generateReleaseMetadata(packageRoot) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "generate_release_metadata.mjs"), packageRoot],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not generate SBOM/notices for ${packageRoot}.`);
  }
}

function exportWindowsArtifacts() {
  const portableRoot = path.join(exportRoot, "portable");
  const legacyPackageRoot = path.join(portableRoot, windowsPortableBaseName);
  const cpuPackageRoot = path.join(portableRoot, windowsCpuPortableName);
  const cudaPackageRoot = path.join(portableRoot, windowsCudaPortableName);
  const executableSource = path.join(releaseRoot, "transcript_research_studio.exe");

  if (!existsSync(executableSource)) {
    throw new Error("No Windows release executable was found in src-tauri/target/release.");
  }

  const runtimeSource = firstExistingPath([
    path.join(releaseRoot, "gen", "runtime"),
    path.join(repoRoot, "src-tauri", "gen", "runtime")
  ]);
  if (!runtimeSource || !existsSync(runtimeSource)) {
    throw new Error("No staged runtime was found in release output or src-tauri/gen/runtime.");
  }
  const cpuRuntimeSource = firstExistingPath([
    path.join(repoRoot, "src-tauri", "gen", "runtime-windows-cpu")
  ]);

  rmSync(installedRoot, { force: true, recursive: true });
  ensureDirectory(portableRoot);
  removePathIfPresent(legacyPackageRoot);
  ensureCleanDirectory(cudaPackageRoot);
  ensureCleanDirectory(cpuPackageRoot);

  copyPath(executableSource, path.join(cudaPackageRoot, "transcript_research_studio.exe"));
  copyPath(runtimeSource, path.join(cudaPackageRoot, "gen", "runtime"));
  writePortableScaffold(cudaPackageRoot);
  annotateRuntimeVariant(cudaPackageRoot, "cuda");

  if (!cpuRuntimeSource) {
    throw new Error(
      "The independently built Windows CPU runtime is missing. Refusing to derive a CPU package from CUDA files."
    );
  }
  ensureCleanDirectory(cpuPackageRoot);
  copyPath(executableSource, path.join(cpuPackageRoot, "transcript_research_studio.exe"));
  copyPath(cpuRuntimeSource, path.join(cpuPackageRoot, "gen", "runtime"));
  writePortableScaffold(cpuPackageRoot);
  annotateRuntimeVariant(cpuPackageRoot, "cpu");
  generateReleaseMetadata(cudaPackageRoot);
  generateReleaseMetadata(cpuPackageRoot);
}

function exportMacArtifacts() {
  const portableRoot = path.join(exportRoot, "portable");
  const portablePackageRoot = path.join(portableRoot, macPortableName);

  rmSync(installedRoot, { force: true, recursive: true });
  ensureDirectory(portableRoot);
  ensureCleanDirectory(portablePackageRoot);

  const appBundle = firstExistingPath(
    findDirectoriesRecursively(bundleRoot, (_entryPath, name) => name === "Transcript Research Studio.app")
  );
  if (!appBundle) {
    throw new Error("No macOS .app bundle was found under src-tauri/target/release/bundle.");
  }

  copyPath(appBundle, path.join(portablePackageRoot, "Transcript Research Studio.app"));
  writePortableScaffold(portablePackageRoot);
  generateReleaseMetadata(portablePackageRoot);

}

function exportArtifacts() {
  if (!existsSync(releaseRoot)) {
    throw new Error("No Tauri release output was found. Run the production build first.");
  }

  ensureDirectory(exportRoot);

  if (process.platform === "win32") {
    exportWindowsArtifacts();
    return;
  }

  if (process.platform === "darwin") {
    exportMacArtifacts();
    return;
  }

  throw new Error(`Portable artifact export is not configured for platform ${process.platform}.`);
}

exportArtifacts();
