import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readReleaseVersion } from "./release_identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const version = readReleaseVersion(repoRoot);
const portableRoot = path.join(repoRoot, "release-artifacts", process.platform, "portable");
const cudaPartBytes = Number(process.env.TRANSCRIPT_RESEARCH_STUDIO_RELEASE_PART_BYTES || 1900 * 1024 * 1024);

function assertDirectory(directoryPath, description) {
  if (!existsSync(directoryPath)) {
    throw new Error(`${description} is missing: ${directoryPath}`);
  }
}

function packageNamesForPlatform() {
  if (process.platform === "win32") {
    return [
      `transcript_research_studio_${version}_windows_x64_cpu_portable`,
      `transcript_research_studio_${version}_windows_x64_cuda_portable`
    ];
  }

  if (process.platform === "darwin") {
    return [`transcript_research_studio_${version}_macos_arm64_portable`];
  }

  throw new Error(`Release artifact packaging is not configured for platform ${process.platform}.`);
}

function removeStalePortableFiles() {
  if (!existsSync(portableRoot)) {
    return;
  }
  for (const entry of readdirSync(portableRoot, { withFileTypes: true })) {
    if (entry.isFile()) {
      rmSync(path.join(portableRoot, entry.name), { force: true });
    }
  }
}

function checksumManifestName() {
  return process.platform === "win32" ? "SHA256SUMS-windows-x64.txt" : "SHA256SUMS-macos-arm64.txt";
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  updateHashFromFile(hash, filePath);
  return hash.digest("hex");
}

function updateHashFromFile(hash, filePath) {
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
}

function zipPackage(packageName) {
  const packageRoot = path.join(portableRoot, packageName);
  const zipPath = path.join(portableRoot, `${packageName}.zip`);
  assertDirectory(packageRoot, "Portable package");
  rmSync(zipPath, { force: true });

  let sourceDateEpoch = "";
  if (process.platform === "win32") {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "gen", "runtime", "bundle-manifest.json"), "utf-8"));
    sourceDateEpoch = String(Math.floor(Date.parse(manifest.build_time_utc) / 1000));
    if (!/^\d+$/.test(sourceDateEpoch)) {
      throw new Error(`Portable package has an invalid reproducible build time: ${manifest.build_time_utc}`);
    }
  }

  const zipCommand =
    process.platform === "darwin"
      ? ["ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", packageName, zipPath]]
      : ["py", ["-3.12", path.join(repoRoot, "scripts", "create_deterministic_zip.py"), packageRoot, zipPath]];
  const result = spawnSync(zipCommand[0], zipCommand[1], {
    cwd: portableRoot,
    stdio: "inherit",
    env: sourceDateEpoch ? { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch } : process.env
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not create ${zipPath}`);
  }
  return zipPath;
}

function splitCudaArchive(zipPath) {
  if (!Number.isSafeInteger(cudaPartBytes) || cudaPartBytes <= 0) {
    throw new Error(`Invalid TRANSCRIPT_RESEARCH_STUDIO_RELEASE_PART_BYTES value: ${cudaPartBytes}`);
  }
  const archiveSize = statSync(zipPath).size;
  const archiveDescriptor = openSync(zipPath, "r");
  const parts = [];
  try {
    let offset = 0;
    let partNumber = 1;
    while (offset < archiveSize) {
      const bytesToRead = Math.min(cudaPartBytes, archiveSize - offset);
      const partPath = `${zipPath}.part${String(partNumber).padStart(3, "0")}`;
      const partDescriptor = openSync(partPath, "w");
      const partHash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(8 * 1024 * 1024, bytesToRead));
      let partOffset = 0;
      try {
        while (partOffset < bytesToRead) {
          const chunkSize = Math.min(buffer.length, bytesToRead - partOffset);
          const bytesRead = readSync(archiveDescriptor, buffer, 0, chunkSize, offset + partOffset);
          if (!bytesRead) {
            throw new Error(`Could not read all bytes for CUDA archive part ${partNumber}.`);
          }
          writeSync(partDescriptor, buffer, 0, bytesRead);
          partHash.update(buffer.subarray(0, bytesRead));
          partOffset += bytesRead;
        }
      } finally {
        closeSync(partDescriptor);
      }
      parts.push({
        file_name: path.basename(partPath),
        size_bytes: partOffset,
        sha256: partHash.digest("hex")
      });
      offset += partOffset;
      partNumber += 1;
    }
  } finally {
    closeSync(archiveDescriptor);
  }

  const manifest = {
    schema_version: 1,
    archive_name: path.basename(zipPath),
    archive_size_bytes: archiveSize,
    archive_sha256: sha256File(zipPath),
    part_size_limit_bytes: cudaPartBytes,
    parts
  };
  const manifestPath = `${zipPath}.parts.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const reconstructionHash = createHash("sha256");
  for (const part of parts) {
    updateHashFromFile(reconstructionHash, path.join(portableRoot, part.file_name));
  }
  if (reconstructionHash.digest("hex") !== manifest.archive_sha256) {
    throw new Error("CUDA archive parts did not reconstruct to the original SHA-256 digest.");
  }
  return manifestPath;
}

function writeChecksums() {
  const checksumCandidates = readdirSync(portableRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("SHA256SUMS-"))
    .filter((name) => name.endsWith(".zip") || /\.zip\.part\d+$/.test(name) || name.endsWith(".json") || name.endsWith(".md") || name === "reassemble_cuda.ps1")
    .sort();
  const lines = checksumCandidates.map((name) => `${sha256File(path.join(portableRoot, name))}  ${name}`);
  writeFileSync(path.join(portableRoot, checksumManifestName()), `${lines.join("\n")}\n`, "utf-8");
}

function publishPackageMetadata(packageName) {
  const packageRoot = path.join(portableRoot, packageName);
  copyFileSync(
    path.join(packageRoot, "SBOM.cdx.json"),
    path.join(portableRoot, `${packageName}.SBOM.cdx.json`)
  );
  copyFileSync(
    path.join(packageRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(portableRoot, `${packageName}.THIRD_PARTY_NOTICES.md`)
  );
}

function main() {
  assertDirectory(portableRoot, "Portable release root");
  removeStalePortableFiles();
  let cudaZipPath = null;
  for (const packageName of packageNamesForPlatform()) {
    const zipPath = zipPackage(packageName);
    publishPackageMetadata(packageName);
    if (process.platform === "win32" && packageName.includes("_cuda_portable")) {
      cudaZipPath = zipPath;
    }
  }
  if (cudaZipPath) {
    splitCudaArchive(cudaZipPath);
    // The complete CUDA archive exceeds GitHub's per-asset limit. Keep only
    // the deterministic parts and their reconstruction metadata as the
    // publishable release assets.
    rmSync(cudaZipPath, { force: true });
    const helperPath = path.join(portableRoot, "reassemble_cuda.ps1");
    copyFileSync(path.join(repoRoot, "scripts", "reassemble_cuda.ps1"), helperPath);
  }
  writeChecksums();
}

main();
