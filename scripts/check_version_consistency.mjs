import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTomlSectionString } from "./release_identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT = {
  name: "Transcript Research Studio",
  nodePackage: "transcript-research-studio",
  rustPackage: "transcript_research_studio",
  pythonDistribution: "transcript-research-sidecar",
  tauriIdentifier: "de.jensschueler.transcript-research-studio",
  repositoryUrl: "https://github.com/drdiscipulus/transcript-research-studio"
};

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: cannot read valid JSON (${error.message}).`);
  }
}

function requireString(value, location) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}: expected a non-empty version string.`);
  }
  return value;
}

function readPythonIdentityConstant(name) {
  const relativePath = "backend/sidecar_server/product_identity.py";
  let source;
  try {
    source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath}: cannot be read (${error.message}).`);
  }
  const matches = [...source.matchAll(new RegExp(`^${name}\\s*=\\s*"([^\"]+)"\\s*$`, "gmu"))];
  if (matches.length !== 1) {
    throw new Error(`${relativePath}: expected exactly one ${name} constant, found ${matches.length}.`);
  }
  return requireString(matches[0][1], `${relativePath}#${name}`);
}

function readCargoLockPackageVersion(relativePath, packageName) {
  let source;
  try {
    source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath}: cannot be read (${error.message}).`);
  }

  const packages = [];
  let currentPackage = null;

  function finishPackage() {
    if (currentPackage) packages.push(currentPackage);
    currentPackage = null;
  }

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (/^\s*\[\[package\]\]\s*$/u.test(line)) {
      finishPackage();
      currentPackage = { name: null, version: null };
      continue;
    }
    if (/^\s*\[\[/u.test(line)) {
      finishPackage();
      continue;
    }
    if (!currentPackage || /^\s*(?:#|$)/u.test(line)) continue;

    const field = line.match(/^\s*(name|version)\s*=\s*"([^"]+)"\s*$/u);
    if (field) {
      const key = field[1];
      if (currentPackage[key] !== null) {
        throw new Error(`${relativePath}:${index + 1}: duplicate ${key} in [[package]] entry.`);
      }
      currentPackage[key] = field[2];
    } else if (/^\s*(?:name|version)\s*=/u.test(line)) {
      throw new Error(`${relativePath}:${index + 1}: package name and version must be quoted strings.`);
    }
  }
  finishPackage();

  const matches = packages.filter((entry) => entry.name === packageName);
  if (matches.length !== 1) {
    throw new Error(
      `${relativePath}: expected exactly one [[package]] named "${packageName}", found ${matches.length}.`
    );
  }
  return requireString(matches[0].version, `${relativePath}#${packageName}.version`);
}

function parseReleaseVersion(value, location) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/u);
  if (!match) {
    throw new Error(
      `${location}: unsupported version "${value}"; expected MAJOR.MINOR.PATCH or ` +
        "MAJOR.MINOR.PATCH-(alpha|beta|rc).NUMBER."
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    prereleaseNumber: match[5] === undefined ? null : Number(match[5])
  };
}

function parsePythonVersion(value, location) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$/u);
  if (!match) {
    throw new Error(
      `${location}: unsupported PEP 440 version "${value}"; expected MAJOR.MINOR.PATCH ` +
        "with an optional aN, bN, or rcN suffix."
    );
  }
  const labels = { a: "alpha", b: "beta", rc: "rc" };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? labels[match[4]] : null,
    prereleaseNumber: match[5] === undefined ? null : Number(match[5])
  };
}

function sameVersion(left, right) {
  return (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch &&
    left.prerelease === right.prerelease &&
    left.prereleaseNumber === right.prereleaseNumber
  );
}

try {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const tauriConfig = readJson("src-tauri/tauri.conf.json");

  const sourceVersion = requireString(packageJson.version, "package.json#version");
  const releaseVersion = parseReleaseVersion(sourceVersion, "package.json#version");
  const exactVersions = [
    ["package-lock.json#version", packageLock.version],
    ["package-lock.json#packages[\"\"].version", packageLock.packages?.[""]?.version],
    ["src-tauri/tauri.conf.json#version", tauriConfig.version],
    ["src-tauri/Cargo.toml#[package].version", readTomlSectionString(repoRoot, "src-tauri/Cargo.toml", "package", "version")],
    [
      "src-tauri/Cargo.lock#transcript_research_studio.version",
      readCargoLockPackageVersion("src-tauri/Cargo.lock", "transcript_research_studio")
    ]
  ];

  const mismatches = [];
  const identityChecks = [
    ["package.json#name", packageJson.name, PRODUCT.nodePackage],
    ["package-lock.json#name", packageLock.name, PRODUCT.nodePackage],
    ["package-lock.json#packages[\"\"].name", packageLock.packages?.[""].name, PRODUCT.nodePackage],
    ["package.json#repository.type", packageJson.repository?.type, "git"],
    ["package.json#repository.url", packageJson.repository?.url, `git+${PRODUCT.repositoryUrl}.git`],
    ["package.json#homepage", packageJson.homepage, PRODUCT.repositoryUrl],
    ["package.json#bugs.url", packageJson.bugs?.url, `${PRODUCT.repositoryUrl}/issues`],
    ["src-tauri/tauri.conf.json#productName", tauriConfig.productName, PRODUCT.name],
    ["src-tauri/tauri.conf.json#identifier", tauriConfig.identifier, PRODUCT.tauriIdentifier],
    [
      "src-tauri/Cargo.toml#[package].repository",
      readTomlSectionString(repoRoot, "src-tauri/Cargo.toml", "package", "repository"),
      PRODUCT.repositoryUrl
    ],
    [
      "pyproject.toml#[project.urls].Homepage",
      readTomlSectionString(repoRoot, "pyproject.toml", "project.urls", "Homepage"),
      PRODUCT.repositoryUrl
    ],
    [
      "pyproject.toml#[project.urls].Repository",
      readTomlSectionString(repoRoot, "pyproject.toml", "project.urls", "Repository"),
      PRODUCT.repositoryUrl
    ],
    [
      "pyproject.toml#[project.urls].Issues",
      readTomlSectionString(repoRoot, "pyproject.toml", "project.urls", "Issues"),
      `${PRODUCT.repositoryUrl}/issues`
    ]
  ];
  for (const [location, actual, expected] of identityChecks) {
    if (actual !== expected) {
      mismatches.push(`${location} is "${actual}" (expected "${expected}")`);
    }
  }
  for (const [location, rawValue] of exactVersions) {
    const value = requireString(rawValue, location);
    parseReleaseVersion(value, location);
    if (value !== sourceVersion) {
      mismatches.push(`${location} is "${value}" (expected "${sourceVersion}")`);
    }
  }

  const pythonValue = readTomlSectionString(repoRoot, "pyproject.toml", "project", "version");
  const pythonVersion = parsePythonVersion(pythonValue, "pyproject.toml#[project].version");
  if (!sameVersion(releaseVersion, pythonVersion)) {
    mismatches.push(
      `pyproject.toml#[project].version is "${pythonValue}" (not equivalent to "${sourceVersion}")`
    );
  }
  if (readTomlSectionString(repoRoot, "pyproject.toml", "project", "name") !== PRODUCT.pythonDistribution) {
    mismatches.push(`pyproject.toml#[project].name is not "${PRODUCT.pythonDistribution}"`);
  }
  if (readTomlSectionString(repoRoot, "src-tauri/Cargo.toml", "package", "name") !== PRODUCT.rustPackage) {
    mismatches.push(`src-tauri/Cargo.toml#[package].name is not "${PRODUCT.rustPackage}"`);
  }
  const productIdentityChecks = [
    ["PRODUCT_NAME", PRODUCT.name],
    ["PRODUCT_VERSION", sourceVersion],
    ["PYTHON_DISTRIBUTION_NAME", PRODUCT.pythonDistribution],
    ["SERVER_IDENTIFIER", "TranscriptResearchSidecar"]
  ];
  for (const [name, expected] of productIdentityChecks) {
    const actual = readPythonIdentityConstant(name);
    if (actual !== expected) {
      mismatches.push(`backend/sidecar_server/product_identity.py#${name} is "${actual}" (expected "${expected}")`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Version mismatch:\n- ${mismatches.join("\n- ")}`);
  }

  process.stdout.write(`Versions are consistent: ${sourceVersion} (Python ${pythonValue}).\n`);
} catch (error) {
  process.stderr.write(`Version consistency check failed: ${error.message}\n`);
  process.exitCode = 1;
}
