import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installLocalProjectFromOwnedContext } from "../scripts/create_runtime_environment.mjs";

const sourceInputs = () => ["pyproject.toml", "README.md", "LICENSE", "backend"];

function assertNoNewRootBuildMetadata(sourceRoot) {
  for (const relativePath of [
    "build",
    "transcript_research_sidecar.egg-info",
    "__editable__transcript_research_sidecar.py",
    "direct_url.json"
  ]) {
    assert.equal(existsSync(path.join(sourceRoot, relativePath)), false, relativePath);
  }
}

function projectFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "transcript-research-project-install-"));
  mkdirSync(path.join(root, "backend", "sidecar_server", "resources"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf-8");
  writeFileSync(path.join(root, "LICENSE"), "Fixture license\n", "utf-8");
  writeFileSync(
    path.join(root, "pyproject.toml"),
    [
      "[build-system]",
      'requires = ["setuptools==80.9.0"]',
      'build-backend = "setuptools.build_meta"',
      "",
      "[project]",
      'name = "transcript-research-sidecar"',
      'version = "1.0.0b1"'
    ].join("\n"),
    "utf-8"
  );
  writeFileSync(path.join(root, "backend", "__init__.py"), "__version__ = '1.0.0b1'\n", "utf-8");
  writeFileSync(path.join(root, "backend", "sidecar_server", "resource.py"), "VALUE = 1\n", "utf-8");
  return root;
}

test("runtime project install uses an owned temporary context and preserves package identity", () => {
  const sourceRoot = projectFixture();
  let installRoot = null;
  try {
    installLocalProjectFromOwnedContext({
      python: "fixture-python",
      sourceRoot,
      inspectSourceInputs: sourceInputs,
      runCommand(command, args, options) {
        installRoot = args.at(-1);
        assert.equal(command, "fixture-python");
        assert.deepEqual(args.slice(0, -1), [
          "-m", "pip", "install", "--no-deps", "--no-build-isolation"
        ]);
        assert.equal(options.cwd, installRoot);
        assert.equal(args.includes("-e"), false);
        const stagedProject = readFileSync(path.join(installRoot, "pyproject.toml"), "utf-8");
        assert.match(stagedProject, /name = "transcript-research-sidecar"/u);
        assert.match(stagedProject, /version = "1\.0\.0b1"/u);
        assert.equal(existsSync(path.join(installRoot, "backend", "__init__.py")), true);
        assert.equal(existsSync(path.join(installRoot, "backend", "sidecar_server", "resource.py")), true);
        assert.equal(existsSync(path.join(installRoot, "backend", "__pycache__")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "generated.egg-info")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "direct_url.json")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "__editable__fixture.py")), false);
        mkdirSync(path.join(installRoot, "build", "lib"), { recursive: true });
      }
    });
    assert.ok(installRoot);
    assert.equal(existsSync(installRoot), false);
    assertNoNewRootBuildMetadata(sourceRoot);
  } finally {
    rmSync(sourceRoot, { force: true, recursive: true });
  }
});

test("failed runtime project install removes its owned context without dirtying the source root", () => {
  const sourceRoot = projectFixture();
  let installRoot = null;
  try {
    assert.throws(
      () => installLocalProjectFromOwnedContext({
        python: "fixture-python",
        sourceRoot,
        inspectSourceInputs: sourceInputs,
        runCommand(_command, args) {
          installRoot = args.at(-1);
          mkdirSync(path.join(installRoot, "build", "lib"), { recursive: true });
          throw new Error("synthetic wheel failure");
        }
      }),
      /synthetic wheel failure/u
    );
    assert.ok(installRoot);
    assert.equal(existsSync(installRoot), false);
    assertNoNewRootBuildMetadata(sourceRoot);
  } finally {
    rmSync(sourceRoot, { force: true, recursive: true });
  }
});

test("runtime project install never deletes a pre-existing unowned source build directory", () => {
  const sourceRoot = projectFixture();
  const sentinel = path.join(sourceRoot, "build", "owned-by-someone-else");
  try {
    mkdirSync(path.dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "keep", "utf-8");
    installLocalProjectFromOwnedContext({
      python: "fixture-python",
      sourceRoot,
      inspectSourceInputs: sourceInputs,
      runCommand() {}
    });
    assert.equal(readFileSync(sentinel, "utf-8"), "keep");
  } finally {
    rmSync(sourceRoot, { force: true, recursive: true });
  }
});

test("runtime source context follows inspected package inputs and excludes generated metadata", () => {
  const sourceRoot = projectFixture();
  const extraPackage = path.join(sourceRoot, "sidecar_extra");
  try {
    mkdirSync(extraPackage, { recursive: true });
    writeFileSync(path.join(extraPackage, "__init__.py"), "VALUE = 2\n", "utf-8");
    for (const generatedPath of [
      path.join(sourceRoot, "backend", "__pycache__", "module.pyc"),
      path.join(sourceRoot, "backend", "generated.egg-info", "PKG-INFO"),
      path.join(sourceRoot, "backend", "direct_url.json"),
      path.join(sourceRoot, "backend", "__editable__fixture.py")
    ]) {
      mkdirSync(path.dirname(generatedPath), { recursive: true });
      writeFileSync(generatedPath, "generated", "utf-8");
    }

    installLocalProjectFromOwnedContext({
      python: "fixture-python",
      sourceRoot,
      inspectSourceInputs: () => [...sourceInputs(), "sidecar_extra"],
      runCommand(_command, args) {
        const installRoot = args.at(-1);
        assert.equal(existsSync(path.join(installRoot, "sidecar_extra", "__init__.py")), true);
        assert.equal(existsSync(path.join(installRoot, "backend", "__pycache__")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "generated.egg-info")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "direct_url.json")), false);
        assert.equal(existsSync(path.join(installRoot, "backend", "__editable__fixture.py")), false);
      }
    });
  } finally {
    rmSync(sourceRoot, { force: true, recursive: true });
  }
});
