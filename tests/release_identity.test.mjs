import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readPythonProjectIdentity,
  readReleaseVersion,
  readTomlSectionString
} from "../scripts/release_identity.mjs";

function withProject(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), "transcript-research-identity-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      writeFileSync(path.join(root, relativePath), contents, "utf8");
    }
    callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("release identity reads project and package fields from their authoritative sections", () => {
  withProject({
    "package.json": JSON.stringify({ version: "2.3.4-beta.5" }),
      "pyproject.toml": [
        "[tool.example]",
        'name = "unrelated-name"',
        'version = "9.9.9"',
        "",
      "[project]",
      'name = "transcript-research-sidecar"',
      'version = "2.3.4b5"'
      ].join("\n"),
      "Cargo.toml": [
        "[package.metadata]",
        'name = "unrelated-package"',
        'version = "9.9.9"',
        "",
        "[package]",
        'name = "transcript-research-studio"',
        'version = "2.3.4-beta.5"'
      ].join("\n")
  }, (root) => {
    assert.equal(readReleaseVersion(root), "2.3.4-beta.5");
      assert.deepEqual(readPythonProjectIdentity(root), {
        name: "transcript-research-sidecar",
        version: "2.3.4b5"
      });
      assert.equal(readTomlSectionString(root, "Cargo.toml", "package", "name"), "transcript-research-studio");
      assert.equal(readTomlSectionString(root, "Cargo.toml", "package", "version"), "2.3.4-beta.5");
  });
});

test("release identity rejects duplicate and unquoted authoritative TOML fields", () => {
  withProject({
    "pyproject.toml": [
      "[project]",
      'name = "transcript-research-sidecar"',
      'name = "duplicate"',
      'version = "2.3.4b5"'
    ].join("\n"),
    "Cargo.toml": [
      "[package]",
      "name = transcript-research-studio",
      'version = "2.3.4-beta.5"'
    ].join("\n")
  }, (root) => {
    assert.throws(
      () => readTomlSectionString(root, "pyproject.toml", "project", "name"),
      /expected exactly one value/u
    );
    assert.throws(
      () => readTomlSectionString(root, "Cargo.toml", "package", "name"),
      /must be a quoted string/u
    );
  });
});

test("release identity rejects absent or invalid manifest versions", () => {
  withProject({ "package.json": JSON.stringify({ version: " " }) }, (root) => {
    assert.throws(() => readReleaseVersion(root), /package\.json#version/);
  });
  withProject({ "package.json": JSON.stringify({ version: "0.1" }) }, (root) => {
    assert.throws(() => readReleaseVersion(root), /package\.json#version/);
  });
});

test("release identity rejects missing or non-PEP-440 Python project metadata", () => {
  withProject({
    "pyproject.toml": "[project]\nname = \"transcript-research-sidecar\"\n"
  }, (root) => {
    assert.throws(() => readPythonProjectIdentity(root), /project\]\.version/);
  });
  withProject({
    "pyproject.toml": "[project]\nname = \"transcript-research-sidecar\"\nversion = \"1.0.0-beta.1\"\n"
  }, (root) => {
    assert.throws(() => readPythonProjectIdentity(root), /PEP 440/);
  });
});
