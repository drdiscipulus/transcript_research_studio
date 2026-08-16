import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditMachODependencyGraph,
  inventoryBundledMachOCandidates,
  isPathWithin,
  makeMachOPortable,
  planMachODependencyGraph,
  resolveExternalMachODependency,
  resolveInventoryMachODependency,
  resolveBundledDependency,
  resolvePortableRpaths,
  resolveSafeSymlinkTarget
} from "../scripts/sign_macos_bundle.mjs";

function fixture() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ai-transcription-macos-paths-"));
  const appRoot = path.join(tempRoot, "Research.app");
  const executableDirectory = path.join(appRoot, "Contents", "MacOS");
  const frameworksDirectory = path.join(appRoot, "Contents", "Frameworks");
  const plugInsDirectory = path.join(appRoot, "Contents", "PlugIns");
  mkdirSync(executableDirectory, { recursive: true });
  mkdirSync(frameworksDirectory, { recursive: true });
  mkdirSync(plugInsDirectory, { recursive: true });
  const executable = path.join(executableDirectory, "research");
  const library = path.join(frameworksDirectory, "libresearch.dylib");
  const plugIn = path.join(plugInsDirectory, "plugin.dylib");
  writeFileSync(executable, "Mach-O fixture");
  writeFileSync(library, "Mach-O fixture");
  writeFileSync(plugIn, "Mach-O fixture");
  return { tempRoot, appRoot, executableDirectory, executable, frameworksDirectory, library, plugIn };
}

function dependencyCandidate(bundleRelativePath, originalInstallName) {
  return {
    canonicalPath: `/synthetic-bundle/${bundleRelativePath}`,
    bundleRelativePath,
    basename: path.posix.basename(bundleRelativePath),
    originalInstallName,
    originalDependencies: [],
    originalSearchPaths: []
  };
}

function graphCandidate(appRoot, filePath, {
  originalInstallName = null,
  originalDependencies = [],
  originalSearchPaths = []
} = {}) {
  const canonicalPath = realpathSync(filePath);
  return {
    canonicalPath,
    bundleRelativePath: path.relative(realpathSync(appRoot), canonicalPath).split(path.sep).join("/"),
    basename: path.basename(canonicalPath),
    originalInstallName,
    originalDependencies,
    originalSearchPaths
  };
}

function runAppleTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout || ""}${result.stderr || ""}`);
  return result.stdout;
}

test("dyld loader, executable, and rpath dependencies resolve to canonical bundled files", () => {
  const paths = fixture();
  try {
    for (const dependency of [
      "@loader_path/../Frameworks/libresearch.dylib",
      "@executable_path/../Frameworks/libresearch.dylib",
      "@rpath/libresearch.dylib"
    ]) {
      const targets = resolveBundledDependency({
        appRoot: paths.appRoot,
        filePath: paths.plugIn,
        executableDirectory: paths.executableDirectory,
        dependency,
        searchPaths: ["@executable_path/../Frameworks"]
      });
      assert.deepEqual(targets, [realpathSync(paths.library)]);
    }
    assert.deepEqual(resolveBundledDependency({
      appRoot: paths.appRoot,
      filePath: paths.executable,
      executableDirectory: paths.executableDirectory,
      dependency: "/usr/lib/libSystem.B.dylib",
      searchPaths: []
    }), []);
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("runtime-root Python wins regardless of order while wrong-basename historical identity matches are excluded", () => {
  const dependency = "/Library/Frameworks/Python.framework/Versions/3.12/Python";
  const library = dependencyCandidate("Contents/Resources/gen/runtime/python-runtime/Python", dependency);
  const launcher = dependencyCandidate(
    "Contents/Resources/gen/runtime/python-runtime/Resources/Python.app/Contents/MacOS/Python",
    null
  );
  const otherLibrary = dependencyCandidate("Contents/Frameworks/Python", "@rpath/Python");
  const differentlyNamedIdentityMatches = [
    dependencyCandidate("Contents/Resources/gen/runtime/python-runtime/lib/libpython3.12.dylib", dependency),
    dependencyCandidate(
      "Contents/Resources/gen/runtime/python-runtime/lib/python3.12/config-3.12-darwin/libpython3.12.dylib",
      dependency
    )
  ];
  for (const candidates of [
    [library, launcher, otherLibrary, ...differentlyNamedIdentityMatches],
    [...differentlyNamedIdentityMatches.toReversed(), otherLibrary, launcher, library]
  ]) {
    assert.equal(resolveExternalMachODependency({
      dependency,
      consumerRelativePath:
        "Contents/Resources/gen/runtime/python-runtime/Resources/Python.app/Contents/MacOS/Python",
      candidates
    }), library);
  }
  assert.throws(
    () => resolveExternalMachODependency({
      dependency,
      consumerRelativePath:
        "Contents/Resources/gen/runtime/python-runtime/Resources/Python.app/Contents/MacOS/Python",
      candidates: [launcher, ...differentlyNamedIdentityMatches]
    }),
    /multiple bundled libraries have its exact original install identity/u
  );
});

test("one global exact install identity resolves a versioned filename without ABI guessing", () => {
  const dependency = "@rpath/libavcodec.62.dylib";
  const exactIdentity = dependencyCandidate(
    "Contents/Frameworks/libavcodec.62.11.100.dylib",
    dependency
  );
  const similarIdentity = dependencyCandidate(
    "Contents/Frameworks/libavcodec.62.9.100.dylib",
    "@rpath/libavcodec.62.9.100.dylib"
  );
  const unrelated = dependencyCandidate("Contents/Frameworks/libother.dylib", "@rpath/libother.dylib");
  for (const candidates of [
    [similarIdentity, unrelated, exactIdentity],
    [exactIdentity, unrelated, similarIdentity]
  ]) {
    assert.equal(resolveInventoryMachODependency({
      dependency,
      consumerRelativePath: "Contents/PlugIns/consumer.dylib",
      candidates
    }), exactIdentity);
  }
  assert.throws(
    () => resolveInventoryMachODependency({
      dependency,
      consumerRelativePath: "Contents/PlugIns/consumer.dylib",
      candidates: [similarIdentity, unrelated]
    }),
    /no linkable bundled library has its basename or exact original install identity/u
  );
});

test("multiple global exact install identities fail without traversal-order selection", () => {
  const dependency = "@rpath/libavcodec.62.dylib";
  const first = dependencyCandidate("Contents/Frameworks/libavcodec.62.11.100.dylib", dependency);
  const second = dependencyCandidate("Contents/Resources/libavcodec.62.12.100.dylib", dependency);
  for (const candidates of [[first, second], [second, first]]) {
    assert.throws(
      () => resolveInventoryMachODependency({
        dependency,
        consumerRelativePath: "Contents/PlugIns/consumer.dylib",
        candidates
      }),
      (error) => {
        assert.match(error.message, /multiple bundled libraries have its exact original install identity/u);
        assert.match(error.message, /Contents\/Frameworks\/libavcodec\.62\.11\.100\.dylib/u);
        assert.match(error.message, /Contents\/Resources\/libavcodec\.62\.12\.100\.dylib/u);
        return true;
      }
    );
  }
});

test("duplicate exact install identities fail with bundle-relative paths only", () => {
  const dependency = "/Users/maintainer/Frameworks/libidentity.dylib";
  const candidates = [
    dependencyCandidate("Contents/Frameworks/first/libidentity.dylib", dependency),
    dependencyCandidate("Contents/Frameworks/second/libidentity.dylib", dependency)
  ];
  assert.throws(
    () => resolveExternalMachODependency({
      dependency,
      consumerRelativePath: "Contents/MacOS/research",
      candidates
    }),
    (error) => {
      assert.match(error.message, /multiple bundled libraries have the exact original install identity/u);
      assert.match(error.message, /Contents\/Frameworks\/first\/libidentity\.dylib/u);
      assert.match(error.message, /Contents\/Frameworks\/second\/libidentity\.dylib/u);
      assert.doesNotMatch(error.message, /\/Users\/maintainer/u);
      return true;
    }
  );
});

test("one linkable basename fallback succeeds and ignores an executable launcher", () => {
  const library = dependencyCandidate("Contents/Frameworks/libfallback.dylib", "@rpath/libfallback.dylib");
  const launcher = dependencyCandidate("Contents/Helpers/libfallback.dylib", null);
  assert.equal(resolveExternalMachODependency({
    dependency: "/opt/vendor/libfallback.dylib",
    consumerRelativePath: "Contents/MacOS/research",
    candidates: [launcher, library]
  }), library);
});

test("ambiguous linkable basename fallback fails without choosing by traversal order", () => {
  const first = dependencyCandidate("Contents/Frameworks/first/libfallback.dylib", "@rpath/first/libfallback.dylib");
  const second = dependencyCandidate("Contents/Frameworks/second/libfallback.dylib", "@rpath/second/libfallback.dylib");
  for (const candidates of [[first, second], [second, first]]) {
    assert.throws(
      () => resolveExternalMachODependency({
        dependency: "/opt/vendor/libfallback.dylib",
        consumerRelativePath: "Contents/MacOS/research",
        candidates
      }),
      /multiple linkable bundled libraries share its basename/u
    );
  }
});

test("external dependencies fail when only a same-basename executable exists", () => {
  const launcher = dependencyCandidate("Contents/Helpers/libmissing.dylib", null);
  assert.throws(
    () => resolveExternalMachODependency({
      dependency: "/opt/vendor/libmissing.dylib",
      consumerRelativePath: "Contents/MacOS/research",
      candidates: [launcher]
    }),
    /no linkable bundled library has its basename or exact original install identity/u
  );
});

test("unresolved @rpath dependencies use an order-independent identity-aware loader-path plan", () => {
  const paths = fixture();
  try {
    const dependency = "@rpath/libexample.dylib";
    const exactDirectory = path.join(paths.frameworksDirectory, "exact");
    const fallbackDirectory = path.join(paths.frameworksDirectory, "fallback");
    const helpersDirectory = path.join(paths.appRoot, "Contents", "Helpers");
    mkdirSync(exactDirectory, { recursive: true });
    mkdirSync(fallbackDirectory, { recursive: true });
    mkdirSync(helpersDirectory, { recursive: true });
    const exactLibrary = path.join(exactDirectory, "libexample.dylib");
    const fallbackLibrary = path.join(fallbackDirectory, "libexample.dylib");
    const wrongBasename = path.join(paths.frameworksDirectory, "libexample-alias.dylib");
    const sameBasenameExecutable = path.join(helpersDirectory, "libexample.dylib");
    for (const filePath of [exactLibrary, fallbackLibrary, wrongBasename, sameBasenameExecutable]) {
      writeFileSync(filePath, "Mach-O fixture");
    }

    const consumer = graphCandidate(paths.appRoot, paths.plugIn, {
      originalDependencies: [dependency]
    });
    const exact = graphCandidate(paths.appRoot, exactLibrary, {
      originalInstallName: dependency,
      originalDependencies: [dependency]
    });
    const fallback = graphCandidate(paths.appRoot, fallbackLibrary, {
      originalInstallName: "@rpath/alternate/libexample.dylib",
      originalDependencies: ["@rpath/alternate/libexample.dylib"]
    });
    const wrong = graphCandidate(paths.appRoot, wrongBasename, {
      originalInstallName: dependency,
      originalDependencies: [dependency]
    });
    const executable = graphCandidate(paths.appRoot, sameBasenameExecutable);

    for (const candidates of [
      [consumer, fallback, wrong, executable, exact],
      [exact, executable, wrong, fallback, consumer]
    ]) {
      assert.equal(resolveInventoryMachODependency({
        dependency,
        consumerRelativePath: consumer.bundleRelativePath,
        candidates
      }), exact);
      const audit = auditMachODependencyGraph({ appRoot: paths.appRoot, candidates });
      assert.equal(audit.issues.length, 0);
      assert.equal(audit.counts.inventoryRpath, 1);
      const consumerPlan = audit.filePlans.find((filePlan) => filePlan.consumer === consumer);
      assert.deepEqual(consumerPlan.rewrites, [{
        dependency,
        replacement: "@loader_path/../Frameworks/exact/libexample.dylib",
        target: realpathSync(exactLibrary)
      }]);
    }
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("@rpath inventory fallback rejects ambiguous and missing libraries with relative diagnostics", () => {
  const paths = fixture();
  try {
    const dependency = "@rpath/libexample.dylib";
    const firstDirectory = path.join(paths.frameworksDirectory, "first");
    const secondDirectory = path.join(paths.frameworksDirectory, "second");
    const helpersDirectory = path.join(paths.appRoot, "Contents", "Helpers");
    mkdirSync(firstDirectory, { recursive: true });
    mkdirSync(secondDirectory, { recursive: true });
    mkdirSync(helpersDirectory, { recursive: true });
    const firstLibrary = path.join(firstDirectory, "libexample.dylib");
    const secondLibrary = path.join(secondDirectory, "libexample.dylib");
    const wrongBasename = path.join(paths.frameworksDirectory, "libexample-alias.dylib");
    const executable = path.join(helpersDirectory, "libexample.dylib");
    for (const filePath of [firstLibrary, secondLibrary, wrongBasename, executable]) {
      writeFileSync(filePath, "Mach-O fixture");
    }
    const consumer = graphCandidate(paths.appRoot, paths.plugIn, { originalDependencies: [dependency] });
    const first = graphCandidate(paths.appRoot, firstLibrary, {
      originalInstallName: "@rpath/first/libexample.dylib",
      originalDependencies: ["@rpath/first/libexample.dylib"]
    });
    const second = graphCandidate(paths.appRoot, secondLibrary, {
      originalInstallName: "@rpath/second/libexample.dylib",
      originalDependencies: ["@rpath/second/libexample.dylib"]
    });
    const wrong = graphCandidate(paths.appRoot, wrongBasename, {
      originalInstallName: dependency,
      originalDependencies: [dependency]
    });
    const launcher = graphCandidate(paths.appRoot, executable);

    for (const candidates of [[consumer, first, second], [second, first, consumer]]) {
      const audit = auditMachODependencyGraph({ appRoot: paths.appRoot, candidates });
      assert.equal(audit.counts.ambiguous, 1);
      assert.equal(audit.counts.missing, 0);
      assert.match(audit.issues[0].message, /multiple linkable bundled libraries share its basename/u);
      assert.doesNotMatch(audit.issues[0].message, new RegExp(paths.tempRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.throws(
        () => planMachODependencyGraph({ appRoot: paths.appRoot, candidates }),
        /ambiguous=1, missing=0, unsafe=0/u
      );
    }

    const missingAudit = auditMachODependencyGraph({
      appRoot: paths.appRoot,
      candidates: [consumer, launcher]
    });
    assert.equal(missingAudit.counts.missing, 1);
    assert.match(missingAudit.issues[0].message, /no linkable bundled library has its basename or exact original install identity/u);
    assert.doesNotMatch(missingAudit.issues[0].message, /ai-transcription-macos-paths-/u);
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("portable @rpath resolution keeps one linkable target and rejects multiple targets", () => {
  const paths = fixture();
  try {
    const dependency = "@rpath/libresearch.dylib";
    const alternateDirectory = path.join(paths.appRoot, "Contents", "Alternate");
    mkdirSync(alternateDirectory, { recursive: true });
    const alternateLibrary = path.join(alternateDirectory, "libresearch.dylib");
    writeFileSync(alternateLibrary, "Mach-O fixture");
    const library = graphCandidate(paths.appRoot, paths.library, {
      originalInstallName: dependency,
      originalDependencies: [dependency]
    });
    const alternate = graphCandidate(paths.appRoot, alternateLibrary, {
      originalInstallName: "@rpath/alternate/libresearch.dylib",
      originalDependencies: ["@rpath/alternate/libresearch.dylib"]
    });
    const onePathConsumer = graphCandidate(paths.appRoot, paths.plugIn, {
      originalDependencies: [dependency],
      originalSearchPaths: ["@loader_path/../Frameworks"]
    });
    const onePathAudit = auditMachODependencyGraph({
      appRoot: paths.appRoot,
      candidates: [onePathConsumer, library, alternate]
    });
    assert.equal(onePathAudit.issues.length, 0);
    assert.equal(onePathAudit.counts.rpath, 1);
    assert.equal(onePathAudit.filePlans.find((filePlan) => filePlan.consumer === onePathConsumer).rewrites.length, 0);

    const multiplePathConsumer = {
      ...onePathConsumer,
      originalSearchPaths: ["@loader_path/../Frameworks", "@loader_path/../Alternate"]
    };
    const multiplePathAudit = auditMachODependencyGraph({
      appRoot: paths.appRoot,
      candidates: [multiplePathConsumer, library, alternate]
    });
    assert.equal(multiplePathAudit.counts.ambiguous, 1);
    assert.match(multiplePathAudit.issues[0].message, /multiple portable runtime search paths/u);
    assert.throws(
      () => resolveBundledDependency({
        appRoot: paths.appRoot,
        filePath: paths.plugIn,
        executableDirectory: paths.executableDirectory,
        dependency,
        searchPaths: ["@loader_path/../Frameworks", "@loader_path/../Alternate"]
      }),
      /resolves to multiple bundled targets/u
    );
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("dependency audit accepts a staged runtime root when no executable-relative edge exists", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ai-transcription-runtime-graph-"));
  try {
    const librariesDirectory = path.join(tempRoot, "lib");
    const extensionsDirectory = path.join(tempRoot, "site-packages", "example");
    mkdirSync(librariesDirectory, { recursive: true });
    mkdirSync(extensionsDirectory, { recursive: true });
    const libraryPath = path.join(librariesDirectory, "libexample.dylib");
    const extensionPath = path.join(extensionsDirectory, "extension.so");
    writeFileSync(libraryPath, "Mach-O fixture");
    writeFileSync(extensionPath, "Mach-O fixture");
    const dependency = "@rpath/libexample.dylib";
    const library = graphCandidate(tempRoot, libraryPath, {
      originalInstallName: dependency,
      originalDependencies: [dependency]
    });
    const extension = graphCandidate(tempRoot, extensionPath, {
      originalDependencies: [dependency],
      originalSearchPaths: ["@loader_path/../../lib"]
    });

    const audit = auditMachODependencyGraph({
      appRoot: tempRoot,
      candidates: [extension, library]
    });

    assert.equal(audit.issues.length, 0);
    assert.equal(audit.counts.rpath, 1);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("dependency planning rejects absolute and escaping runtime search paths without maintainer paths", () => {
  const paths = fixture();
  try {
    for (const searchPath of ["/Users/maintainer/lib", "@loader_path/../../.."] ) {
      const consumer = graphCandidate(paths.appRoot, paths.plugIn, {
        originalDependencies: ["@rpath/libresearch.dylib"],
        originalSearchPaths: [searchPath]
      });
      const library = graphCandidate(paths.appRoot, paths.library, {
        originalInstallName: "@rpath/libresearch.dylib",
        originalDependencies: ["@rpath/libresearch.dylib"]
      });
      const audit = auditMachODependencyGraph({ appRoot: paths.appRoot, candidates: [consumer, library] });
      assert.equal(audit.counts.unsafe, 1);
      assert.doesNotMatch(audit.issues[0].message, /\/Users\/maintainer/u);
      assert.doesNotMatch(audit.issues[0].message, /ai-transcription-macos-paths-/u);
    }
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("dyld resolution rejects exact-token spoofs, bundle escapes, and unresolved rpaths", () => {
  const paths = fixture();
  try {
    const outsideLibrary = path.join(paths.tempRoot, "outside.dylib");
    writeFileSync(outsideLibrary, "outside");
    const resolve = (dependency, searchPaths = ["@executable_path/../Frameworks"]) =>
      resolveBundledDependency({
        appRoot: paths.appRoot,
        filePath: paths.executable,
        executableDirectory: paths.executableDirectory,
        dependency,
        searchPaths
      });

    assert.throws(() => resolve("@loader_path_evil/libresearch.dylib"), /non-portable dependency/);
    assert.throws(() => resolve("@loader_path/../../../outside.dylib"), /escapes the app bundle/);
    assert.throws(() => resolve("/usr/lib/../local/libpoison.dylib"), /non-portable dependency/);
    assert.throws(() => resolve("@rpath/missing.dylib"), /does not resolve through any bundled runtime search path/);
    assert.throws(
      () => resolvePortableRpaths({
        appRoot: paths.appRoot,
        filePath: paths.executable,
        executableDirectory: paths.executableDirectory,
        searchPaths: ["@loader_path/../../.."]
      }),
      /escapes the app bundle/
    );
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("symlink targets must be relative and remain inside the bundle", () => {
  const paths = fixture();
  try {
    const linkPath = path.join(paths.appRoot, "Contents", "Links", "library");
    const safeTarget = resolveSafeSymlinkTarget(paths.appRoot, linkPath, "../../Contents/Frameworks/libresearch.dylib");
    assert.equal(safeTarget, paths.library);
    assert.throws(() => resolveSafeSymlinkTarget(paths.appRoot, linkPath, path.resolve(paths.library)), /Absolute symlink/);
    assert.throws(() => resolveSafeSymlinkTarget(paths.appRoot, linkPath, "../../../outside.dylib"), /escapes the app bundle/);
  } finally {
    rmSync(paths.tempRoot, { force: true, recursive: true });
  }
});

test("real Apple tools rewrite an external dylib identity to the library instead of a same-basename executable", {
  skip: process.platform !== "darwin" ? "requires macOS Apple tooling" : false
}, () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-macho-relink-"));
  try {
    const appRoot = path.join(tempRoot, "Fixture.app");
    const macOSDirectory = path.join(appRoot, "Contents", "MacOS");
    const frameworksDirectory = path.join(appRoot, "Contents", "Frameworks");
    const helpersDirectory = path.join(appRoot, "Contents", "Helpers");
    mkdirSync(macOSDirectory, { recursive: true });
    mkdirSync(frameworksDirectory, { recursive: true });
    mkdirSync(helpersDirectory, { recursive: true });

    const librarySource = path.join(tempRoot, "library.c");
    const launcherSource = path.join(tempRoot, "launcher.c");
    const consumerSource = path.join(tempRoot, "consumer.c");
    const externalIdentity = "/opt/transcript-research-fixture/libidentity.dylib";
    const library = path.join(frameworksDirectory, "libidentity.dylib");
    const differentlyNamedLibrary = path.join(frameworksDirectory, "libidentity-alias.dylib");
    const launcher = path.join(helpersDirectory, "libidentity.dylib");
    const consumer = path.join(macOSDirectory, "consumer");
    writeFileSync(librarySource, "int fixture_value(void) { return 7; }\n", "utf-8");
    writeFileSync(launcherSource, "int main(void) { return 0; }\n", "utf-8");
    writeFileSync(consumerSource, "int fixture_value(void); int main(void) { return fixture_value() == 7 ? 0 : 1; }\n", "utf-8");

    runAppleTool("xcrun", [
      "clang", "-arch", "arm64", "-dynamiclib", librarySource,
      `-Wl,-install_name,${externalIdentity}`, "-o", library
    ]);
    runAppleTool("xcrun", [
      "clang", "-arch", "arm64", "-dynamiclib", librarySource,
      `-Wl,-install_name,${externalIdentity}`, "-o", differentlyNamedLibrary
    ]);
    runAppleTool("xcrun", ["clang", "-arch", "arm64", launcherSource, "-o", launcher]);
    runAppleTool("xcrun", ["clang", "-arch", "arm64", consumerSource, library, "-o", consumer]);

    const files = [differentlyNamedLibrary, launcher, consumer, library];
    const candidates = inventoryBundledMachOCandidates(appRoot, files);
    assert.equal(candidates.find((candidate) => candidate.canonicalPath === realpathSync(library)).originalInstallName, externalIdentity);
    assert.equal(candidates.find((candidate) => candidate.canonicalPath === realpathSync(launcher)).originalInstallName, null);
    const dependencyPlan = planMachODependencyGraph({ appRoot, candidates });
    const plansByCanonicalPath = new Map(
      dependencyPlan.filePlans.map((filePlan) => [filePlan.consumer.canonicalPath, filePlan])
    );
    for (const filePath of [differentlyNamedLibrary, library, launcher, consumer]) {
      makeMachOPortable({
        filePath,
        candidates,
        dependencyPlan: plansByCanonicalPath.get(realpathSync(filePath))
      });
    }

    const dependencies = runAppleTool("otool", ["-L", consumer])
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/u, 1)[0])
      .filter(Boolean);
    const rewritten = dependencies.find((dependency) => dependency.includes("libidentity.dylib"));
    assert.equal(rewritten, "@loader_path/../Frameworks/libidentity.dylib");
    assert.doesNotMatch(rewritten, /Helpers/u);
    assert.deepEqual(resolveBundledDependency({
      appRoot,
      filePath: consumer,
      executableDirectory: macOSDirectory,
      dependency: rewritten,
      searchPaths: []
    }), [realpathSync(library)]);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("real Apple tools rewrite unresolved @rpath to a direct nested @loader_path target", {
  skip: process.platform !== "darwin" ? "requires macOS Apple tooling" : false
}, () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-rpath-relink-"));
  try {
    const appRoot = path.join(tempRoot, "Fixture.app");
    const macOSDirectory = path.join(appRoot, "Contents", "MacOS");
    const libraryDirectory = path.join(appRoot, "Contents", "Resources", "Libraries");
    const consumerDirectory = path.join(appRoot, "Contents", "PlugIns", "Codec", "Nested");
    mkdirSync(macOSDirectory, { recursive: true });
    mkdirSync(libraryDirectory, { recursive: true });
    mkdirSync(consumerDirectory, { recursive: true });

    const librarySource = path.join(tempRoot, "library.c");
    const consumerSource = path.join(tempRoot, "consumer.c");
    const dependency = "@rpath/libexample.dylib";
    const library = path.join(libraryDirectory, "libexample.dylib");
    const consumer = path.join(consumerDirectory, "libconsumer.dylib");
    writeFileSync(librarySource, "int fixture_value(void) { return 11; }\n", "utf-8");
    writeFileSync(consumerSource, "int fixture_value(void); int consumer_value(void) { return fixture_value(); }\n", "utf-8");

    runAppleTool("xcrun", [
      "clang", "-arch", "arm64", "-dynamiclib", librarySource,
      `-Wl,-install_name,${dependency}`, "-o", library
    ]);
    runAppleTool("xcrun", [
      "clang", "-arch", "arm64", "-dynamiclib", consumerSource, library,
      "-Wl,-install_name,@rpath/libconsumer.dylib", "-o", consumer
    ]);
    assert.doesNotMatch(runAppleTool("otool", ["-l", consumer]), /cmd LC_RPATH/u);
    assert.match(runAppleTool("otool", ["-L", consumer]), /@rpath\/libexample\.dylib/u);

    const files = [consumer, library];
    const candidates = inventoryBundledMachOCandidates(appRoot, files);
    const dependencyPlan = planMachODependencyGraph({ appRoot, candidates });
    assert.equal(dependencyPlan.counts.inventoryRpath, 1);
    assert.equal(dependencyPlan.issues.length, 0);
    const plansByCanonicalPath = new Map(
      dependencyPlan.filePlans.map((filePlan) => [filePlan.consumer.canonicalPath, filePlan])
    );
    for (const filePath of files) {
      makeMachOPortable({
        filePath,
        candidates,
        dependencyPlan: plansByCanonicalPath.get(realpathSync(filePath))
      });
    }

    const rewrittenDependencies = runAppleTool("otool", ["-L", consumer])
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => line.trim().split(/\s+\(/u, 1)[0])
      .filter(Boolean);
    const rewritten = rewrittenDependencies.find((value) => value.includes("libexample.dylib"));
    assert.equal(rewritten, "@loader_path/../../../Resources/Libraries/libexample.dylib");
    assert.equal(isPathWithin(realpathSync(appRoot), realpathSync(library)), true);
    assert.deepEqual(resolveBundledDependency({
      appRoot,
      filePath: consumer,
      executableDirectory: macOSDirectory,
      dependency: rewritten,
      searchPaths: []
    }), [realpathSync(library)]);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});
