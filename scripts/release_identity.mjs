import { readFileSync } from "node:fs";
import path from "node:path";

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/u;
const PYTHON_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$/u;

function requireManifestString(value, location, pattern, expectation) {
  if (typeof value !== "string" || value.trim() === "" || !pattern.test(value)) {
    throw new Error(`${location}: expected ${expectation}.`);
  }
  return value;
}

export function readTomlSectionString(repoRoot, relativePath, sectionName, fieldName) {
  const location = `${relativePath}#[${sectionName}].${fieldName}`;
  let source;
  try {
    source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath}: cannot be read (${error.message}).`);
  }

  let activeSection = "";
  const values = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (section) {
      activeSection = section[1].trim();
      continue;
    }
    if (activeSection !== sectionName || /^\s*(?:#|$)/u.test(line)) {
      continue;
    }
    const assignment = line.match(new RegExp(`^\\s*${fieldName}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "u"));
    if (assignment) {
      values.push({ line: index + 1, value: assignment[1] });
    } else if (new RegExp(`^\\s*${fieldName}\\s*=`, "u").test(line)) {
      throw new Error(`${relativePath}:${index + 1}: ${fieldName} must be a quoted string.`);
    }
  }

  if (values.length !== 1) {
    throw new Error(`${location}: expected exactly one value, found ${values.length}.`);
  }
  if (values[0].value.trim() === "") {
    throw new Error(`${location}: expected a non-empty string.`);
  }
  return values[0].value;
}

export function readReleaseVersion(repoRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`package.json: cannot read valid JSON (${error.message}).`);
  }
  return requireManifestString(
    manifest.version,
    "package.json#version",
    RELEASE_VERSION_PATTERN,
    "a release version such as 1.0.0-beta.1"
  );
}

export function readPythonProjectIdentity(repoRoot) {
  const name = readTomlSectionString(repoRoot, "pyproject.toml", "project", "name");
  const version = readTomlSectionString(repoRoot, "pyproject.toml", "project", "version");
  return {
    name,
    version: requireManifestString(
      version,
      "pyproject.toml#[project].version",
      PYTHON_VERSION_PATTERN,
      "a PEP 440 version"
    )
  };
}
