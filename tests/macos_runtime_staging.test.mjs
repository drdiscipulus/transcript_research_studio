import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertStagedPythonEntrypoints,
  assertStagedRuntimeSymlinks,
  normalizeStagedMacRuntime,
  parseLipoArchitectures,
  parseMachORuntimeSearchPaths,
  pruneUnusedMacosAudioIoBackends,
  recreateOwnedGeneratedRoot,
  removeKnownIntelPythonHelpers,
  sanitizeStagedMacRuntimeSearchPaths
} from "../scripts/macos_runtime_staging.mjs";

const FAT_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);

function withTempRoot(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "transcript-research-macho-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeSyntheticMachO(filePath, architectures, mode = 0o644) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([FAT_MAGIC, Buffer.from(`\n${architectures.join(" ")}\n`)]));
  chmodSync(filePath, mode);
}

function syntheticArchitectures(filePath) {
  return readFileSync(filePath).subarray(4).toString("utf-8").trim();
}

function syntheticAppleTools(options = {}) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (options.failCommand === command) {
      throw new Error(`synthetic ${command} failure`);
    }
    if (command === "file") {
      return "Mach-O synthetic fixture";
    }
    if (command !== "lipo") {
      throw new Error(`unexpected command ${command}`);
    }
    if (args[0] === "-archs") {
      if (options.architectureOutput !== undefined) {
        return options.architectureOutput;
      }
      return syntheticArchitectures(args[1]);
    }
    assert.deepEqual(args.slice(0, 2), ["-thin", "arm64"]);
    const outputIndex = args.indexOf("-output");
    assert.notEqual(outputIndex, -1);
    const outputPath = args[outputIndex + 1];
    writeSyntheticMachO(outputPath, options.thinnedArchitectures || ["arm64"]);
    return "";
  };
  return { calls, runCommand };
}

function digest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const OPTIONAL_MACOS_AUDIO_IO_PATHS = [
  ...["4", "5", "6"].flatMap((version) => [
    `torio/lib/_torio_ffmpeg${version}.so`,
    `torio/lib/libtorio_ffmpeg${version}.so`
  ]),
  "torchaudio/lib/_torchaudio_sox.so",
  "torchaudio/lib/libtorchaudio_sox.so",
  ...["4", "5", "6", "7", "8"].flatMap((version) => [
    `torchcodec/libtorchcodec_core${version}.dylib`,
    `torchcodec/libtorchcodec_custom_ops${version}.dylib`,
    `torchcodec/libtorchcodec_pybind_ops${version}.so`
  ])
];

function stagedSitePackages(runtimeRoot) {
  return path.join(runtimeRoot, "lib", "python3.12", "site-packages");
}

function populateOptionalAudioIoFixture(runtimeRoot) {
  const sitePackagesRoot = stagedSitePackages(runtimeRoot);
  for (const relativePath of OPTIONAL_MACOS_AUDIO_IO_PATHS) {
    const filePath = path.join(sitePackagesRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `optional:${relativePath}`, "utf-8");
  }
  for (const relativePath of [
    "torchaudio/lib/_torchaudio.so",
    "torchaudio/lib/libtorchaudio.so",
    "torio/lib/ordinary_module.txt",
    "torchcodec/__init__.py",
    "torchcodec/.dylibs/libc++.1.0.dylib",
    "torchaudio-2.8.0.dist-info/METADATA"
  ]) {
    const filePath = path.join(sitePackagesRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `retained:${relativePath}`, "utf-8");
  }
  return sitePackagesRoot;
}

test("arm64-only Mach-O remains byte-for-byte unchanged", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "bin", "native");
    writeSyntheticMachO(filePath, ["arm64"], 0o755);
    const before = digest(filePath);
    const tools = syntheticAppleTools();
    const result = normalizeStagedMacRuntime(root, { runCommand: tools.runCommand });
    assert.equal(digest(filePath), before);
    assert.deepEqual(result.thinnedPaths, []);
    assert.equal(tools.calls.filter((call) => call[0] === "lipo" && call[1] === "-thin").length, 0);
  });
});

test("Universal2 Mach-O is thinned once, verified, and retains executable permissions", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "bin with spaces", "universal runtime");
    const temporaryPath = path.join(root, "bin with spaces", ".universal runtime.arm64-test");
    writeSyntheticMachO(filePath, ["x86_64", "arm64"], 0o751);
    const originalInode = statSync(filePath).ino;
    const tools = syntheticAppleTools();
    const result = normalizeStagedMacRuntime(root, {
      runCommand: tools.runCommand,
      temporaryPathFor: () => temporaryPath
    });
    assert.equal(syntheticArchitectures(filePath), "arm64");
    assert.equal(statSync(filePath).mode & 0o777, 0o751);
    assert.notEqual(statSync(filePath).ino, originalInode);
    assert.equal(existsSync(temporaryPath), false);
    assert.deepEqual(result.thinnedPaths, ["bin with spaces/universal runtime"]);
    assert.equal(tools.calls.filter((call) => call[0] === "lipo" && call[1] === "-thin").length, 1);
  });
});

test("staged Mach-O traversal and thinning order is deterministic", () => {
  withTempRoot((root) => {
    writeSyntheticMachO(path.join(root, "lib", "z-last"), ["x86_64", "arm64"]);
    writeSyntheticMachO(path.join(root, "lib", "a-first"), ["x86_64", "arm64"]);
    const tools = syntheticAppleTools();
    const result = normalizeStagedMacRuntime(root, { runCommand: tools.runCommand });
    assert.deepEqual(result.machOPathsBefore, ["lib/a-first", "lib/z-last"]);
    assert.deepEqual(result.thinnedPaths, ["lib/a-first", "lib/z-last"]);
    assert.deepEqual(result.machOPaths, ["lib/a-first", "lib/z-last"]);
  });
});

test("x86-only Mach-O is rejected with its staged relative path", () => {
  withTempRoot((root) => {
    writeSyntheticMachO(path.join(root, "lib", "x86-only.dylib"), ["x86_64"]);
    const tools = syntheticAppleTools();
    let message = "";
    assert.throws(
      () => normalizeStagedMacRuntime(root, { runCommand: tools.runCommand }),
      (error) => {
        message = error.message;
        return /lacks an arm64 slice: lib\/x86-only\.dylib \(x86_64\)/u.test(error.message);
      }
    );
    assert.equal(message.includes(root), false);
  });
});

test("empty, malformed, and duplicate lipo architecture output is rejected", () => {
  for (const output of ["", "arm64 ???", "arm64 arm64"]) {
    assert.throws(() => parseLipoArchitectures(output, "bin/python"), /Malformed architecture output/u);
  }
});

test("Mach-O runtime search paths are parsed strictly without exposing load-command noise", () => {
  const output = `
Load command 1
          cmd LC_RPATH
      cmdsize 48
         path @loader_path/../lib (offset 12)
Load command 2
          cmd LC_RPATH
      cmdsize 48
         path /tmp/wheel-build/lib (offset 12)
`;
  assert.deepEqual(parseMachORuntimeSearchPaths(output), [
    "@loader_path/../lib",
    "/tmp/wheel-build/lib"
  ]);
  assert.throws(
    () => parseMachORuntimeSearchPaths("cmd LC_RPATH\ncmdsize 16", "lib/example.dylib"),
    /Malformed runtime search path metadata for lib\/example\.dylib/u
  );
});

test("Apple command failures propagate", () => {
  withTempRoot((root) => {
    writeSyntheticMachO(path.join(root, "lib", "fixture.dylib"), ["arm64"]);
    const tools = syntheticAppleTools({ failCommand: "lipo" });
    assert.throws(
      () => normalizeStagedMacRuntime(root, { runCommand: tools.runCommand }),
      /synthetic lipo failure/u
    );
  });
});

test("temporary thinning output is removed after verification failure", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "lib", "fixture.dylib");
    const temporaryPath = path.join(root, "lib", ".fixture.arm64-test");
    writeSyntheticMachO(filePath, ["x86_64", "arm64"]);
    const tools = syntheticAppleTools({ thinnedArchitectures: ["x86_64"] });
    assert.throws(
      () => normalizeStagedMacRuntime(root, {
        runCommand: tools.runCommand,
        temporaryPathFor: () => temporaryPath
      }),
      /not arm64-only/u
    );
    assert.equal(existsSync(temporaryPath), false);
    assert.equal(syntheticArchitectures(filePath), "x86_64 arm64");
  });
});

test("runtime walk does not follow symlinks outside the staged root", (t) => {
  withTempRoot((root) => {
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-macho-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "outside.dylib");
      writeSyntheticMachO(outsideFile, ["x86_64"]);
      try {
        symlinkSync(outsideFile, path.join(root, "linked.dylib"));
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`symlink fixture unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      const tools = syntheticAppleTools();
      const result = normalizeStagedMacRuntime(root, { runCommand: tools.runCommand });
      assert.deepEqual(result, { machOPaths: [], machOPathsBefore: [], thinnedPaths: [] });
      assert.deepEqual(tools.calls, []);
      assert.equal(syntheticArchitectures(outsideFile), "x86_64");
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });
});

test("valid internal runtime symlinks remain unchanged", (t) => {
  withTempRoot((root) => {
    const target = path.join(root, "lib", "python3.12");
    const link = path.join(root, "bin", "python");
    mkdirSync(path.dirname(link), { recursive: true });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture", "utf-8");
    try {
      symlinkSync("../lib/python3.12", link);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const originalTarget = readlinkSync(link);
    assertStagedRuntimeSymlinks(root);
    assert.equal(readlinkSync(link), originalTarget);
  });
});

test("dangling, cyclic, and escaping runtime symlinks are rejected with relative errors", (t) => {
  withTempRoot((root) => {
    const fixtures = [
      {
        name: "dangling",
        create(fixtureRoot) {
          symlinkSync("missing", path.join(fixtureRoot, "bad-link"));
        },
        pattern: /dangling or cyclic: bad-link/u
      },
      {
        name: "cyclic",
        create(fixtureRoot) {
          symlinkSync("second", path.join(fixtureRoot, "first"));
          symlinkSync("first", path.join(fixtureRoot, "second"));
        },
        pattern: /dangling or cyclic: first/u
      },
      {
        name: "escaping",
        create(fixtureRoot) {
          symlinkSync("../../outside", path.join(fixtureRoot, "bad-link"));
        },
        pattern: /escapes its owned root: bad-link/u
      }
    ];
    for (const fixture of fixtures) {
      const fixtureRoot = path.join(root, fixture.name);
      mkdirSync(fixtureRoot, { recursive: true });
      try {
        fixture.create(fixtureRoot);
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`symlink fixture unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      let message = "";
      assert.throws(
        () => assertStagedRuntimeSymlinks(fixtureRoot),
        (error) => {
          message = error.message;
          return fixture.pattern.test(error.message);
        }
      );
      assert.equal(message.includes(root), false);
    }
  });
});

test("only the exact staged Intel Python helper is removed", () => {
  withTempRoot((root) => {
    const exactHelper = path.join(root, "bin", "python3.12-intel64");
    const genericHelper = path.join(root, "bin", "python3-intel64");
    const otherVersion = path.join(root, "bin", "python3.11-intel64");
    const unrelated = path.join(root, "lib", "python3.12-intel64");
    for (const filePath of [exactHelper, genericHelper, otherVersion, unrelated]) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "fixture");
    }
    assert.deepEqual(removeKnownIntelPythonHelpers(root, "3.12"), [
      "bin/python3.12-intel64",
      "bin/python3-intel64"
    ]);
    assert.equal(existsSync(exactHelper), false);
    assert.equal(existsSync(genericHelper), false);
    assert.equal(existsSync(otherVersion), true);
    assert.equal(existsSync(unrelated), true);
  });
});

test("macOS profile pruning removes only the current optional native audio I/O families", () => {
  withTempRoot((root) => {
    const sourceRoot = path.join(root, "source-runtime");
    const stagedRoot = path.join(root, "staged-runtime");
    const sourceSitePackages = populateOptionalAudioIoFixture(sourceRoot);
    const stagedSitePackagesRoot = populateOptionalAudioIoFixture(stagedRoot);
    const sourceDigests = new Map(OPTIONAL_MACOS_AUDIO_IO_PATHS.map((relativePath) => [
      relativePath,
      digest(path.join(sourceSitePackages, relativePath))
    ]));

    const removed = pruneUnusedMacosAudioIoBackends({
      runtimeRoot: stagedRoot,
      versionTag: "python3.12",
      profile: "macos-arm64-cpu"
    });
    const expectedRemoved = [
      ...OPTIONAL_MACOS_AUDIO_IO_PATHS.filter((relativePath) => relativePath.startsWith("torio/")).sort(),
      ...OPTIONAL_MACOS_AUDIO_IO_PATHS.filter((relativePath) => relativePath.startsWith("torchaudio/")).sort(),
      ...OPTIONAL_MACOS_AUDIO_IO_PATHS.filter((relativePath) => relativePath.startsWith("torchcodec/")).sort()
    ].map((relativePath) => `lib/python3.12/site-packages/${relativePath}`);
    assert.deepEqual(removed, expectedRemoved);

    for (const relativePath of OPTIONAL_MACOS_AUDIO_IO_PATHS) {
      assert.equal(existsSync(path.join(stagedSitePackagesRoot, relativePath)), false, relativePath);
      assert.equal(digest(path.join(sourceSitePackages, relativePath)), sourceDigests.get(relativePath), relativePath);
    }
    for (const relativePath of [
      "torchaudio/lib/_torchaudio.so",
      "torchaudio/lib/libtorchaudio.so",
      "torio/lib/ordinary_module.txt",
      "torchcodec/__init__.py",
      "torchcodec/.dylibs/libc++.1.0.dylib",
      "torchaudio-2.8.0.dist-info/METADATA"
    ]) {
      assert.equal(existsSync(path.join(stagedSitePackagesRoot, relativePath)), true, relativePath);
    }
    assert.deepEqual(pruneUnusedMacosAudioIoBackends({
      runtimeRoot: stagedRoot,
      versionTag: "python3.12",
      profile: "macos-arm64-cpu"
    }), []);
  });
});

test("optional audio I/O pruning rejects locked-layout drift before deleting any backend", () => {
  for (const mutateFixture of [
    (sitePackagesRoot) => rmSync(
      path.join(sitePackagesRoot, "torio", "lib", "_torio_ffmpeg4.so"),
      { force: true }
    ),
    (sitePackagesRoot) => writeFileSync(
      path.join(sitePackagesRoot, "torchcodec", "libtorchcodec_core9.dylib"),
      "future-layout",
      "utf-8"
    ),
    (sitePackagesRoot) => {
      for (const relativePath of OPTIONAL_MACOS_AUDIO_IO_PATHS.filter((candidate) =>
        candidate.startsWith("torchcodec/")
      )) {
        rmSync(path.join(sitePackagesRoot, relativePath), { force: true });
      }
      writeFileSync(
        path.join(sitePackagesRoot, "torchcodec", "renamed_native_backend.so"),
        "renamed-future-layout",
        "utf-8"
      );
    }
  ]) {
    withTempRoot((root) => {
      const stagedRoot = path.join(root, "staged-runtime");
      const sitePackagesRoot = populateOptionalAudioIoFixture(stagedRoot);
      mutateFixture(sitePackagesRoot);
      const existingBackends = OPTIONAL_MACOS_AUDIO_IO_PATHS.filter((relativePath) =>
        existsSync(path.join(sitePackagesRoot, relativePath))
      );
      const unexpectedBackends = [
        "torchcodec/libtorchcodec_core9.dylib",
        "torchcodec/renamed_native_backend.so"
      ].filter((relativePath) => existsSync(path.join(sitePackagesRoot, relativePath)));

      assert.throws(
        () => pruneUnusedMacosAudioIoBackends({
          runtimeRoot: stagedRoot,
          versionTag: "python3.12",
          profile: "macos-arm64-cpu"
        }),
        /inventory does not match the locked layout/u
      );
      for (const relativePath of existingBackends) {
        assert.equal(existsSync(path.join(sitePackagesRoot, relativePath)), true, relativePath);
      }
      for (const relativePath of unexpectedBackends) {
        assert.equal(existsSync(path.join(sitePackagesRoot, relativePath)), true, relativePath);
      }
    });
  }
});

test("failed runtime-search-path sanitization preserves the original and removes its temporary file", () => {
  withTempRoot((root) => {
    const runtimeRoot = path.join(root, "runtime");
    const filePath = path.join(runtimeRoot, "lib", "libfixture.dylib");
    const temporaryPath = path.join(runtimeRoot, "lib", ".libfixture.rpath-test");
    writeSyntheticMachO(filePath, ["arm64"], 0o755);
    const before = digest(filePath);
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === "file") {
        return "Mach-O synthetic fixture";
      }
      if (command === "otool") {
        return "cmd LC_RPATH\npath /tmp/wheel-build/lib (offset 12)";
      }
      if (command === "install_name_tool") {
        writeFileSync(args.at(-1), Buffer.concat([readFileSync(args.at(-1)), Buffer.from("modified")]));
        return "";
      }
      if (command === "codesign" && args[0] === "--force") {
        throw new Error("synthetic codesign failure");
      }
      throw new Error(`unexpected command ${command}`);
    };

    assert.throws(
      () => sanitizeStagedMacRuntimeSearchPaths(runtimeRoot, {
        runCommand,
        temporaryPathFor: () => temporaryPath
      }),
      /synthetic codesign failure/u
    );
    assert.equal(digest(filePath), before);
    assert.equal(existsSync(temporaryPath), false);
    assert.equal(calls.filter((call) => call[0] === "install_name_tool").length, 1);
  });
});

test("optional audio I/O pruning is macOS-profile-specific", () => {
  withTempRoot((root) => {
    const stagedRoot = path.join(root, "staged-runtime");
    const sitePackagesRoot = populateOptionalAudioIoFixture(stagedRoot);
    assert.deepEqual(pruneUnusedMacosAudioIoBackends({
      runtimeRoot: stagedRoot,
      versionTag: "python3.12",
      profile: "windows-x64-cpu"
    }), []);
    for (const relativePath of OPTIONAL_MACOS_AUDIO_IO_PATHS) {
      assert.equal(existsSync(path.join(sitePackagesRoot, relativePath)), true, relativePath);
    }
  });
});

test("optional audio I/O pruning rejects an escaping candidate without touching its target", (t) => {
  withTempRoot((root) => {
    const stagedRoot = path.join(root, "staged-runtime");
    populateOptionalAudioIoFixture(stagedRoot);
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-audio-io-outside-"));
    try {
      const outsideFile = path.join(outsideRoot, "outside.so");
      const unsafeCandidate = path.join(stagedSitePackages(stagedRoot), "torio", "lib", "_torio_ffmpeg4.so");
      writeFileSync(outsideFile, "outside", "utf-8");
      rmSync(unsafeCandidate, { force: true });
      try {
        symlinkSync(outsideFile, unsafeCandidate);
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`symlink fixture unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      let message = "";
      assert.throws(
        () => pruneUnusedMacosAudioIoBackends({
          runtimeRoot: stagedRoot,
          versionTag: "python3.12",
          profile: "macos-arm64-cpu"
        }),
        (error) => {
          message = error.message;
          return /must be an ordinary staged file/u.test(error.message);
        }
      );
      assert.equal(message.includes(root), false);
      assert.equal(readFileSync(outsideFile, "utf-8"), "outside");
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });
});

test("Intel helper cleanup never masks an unexpected x86-only Mach-O", () => {
  withTempRoot((root) => {
    const helper = path.join(root, "bin", "python3.12-intel64");
    const unexpected = path.join(root, "lib", "unexpected native dependency");
    writeSyntheticMachO(helper, ["x86_64"], 0o755);
    writeSyntheticMachO(unexpected, ["x86_64"]);
    assert.deepEqual(removeKnownIntelPythonHelpers(root, "3.12"), ["bin/python3.12-intel64"]);
    assert.equal(existsSync(helper), false);
    const tools = syntheticAppleTools();
    assert.throws(
      () => normalizeStagedMacRuntime(root, { runCommand: tools.runCommand }),
      /lacks an arm64 slice: lib\/unexpected native dependency \(x86_64\)/u
    );
  });
});

test("Intel helper cleanup cannot leave a dangling retained entry point", (t) => {
  withTempRoot((root) => {
    const helper = path.join(root, "bin", "python3.12-intel64");
    const entryPoint = path.join(root, "bin", "python");
    writeSyntheticMachO(helper, ["x86_64"], 0o755);
    try {
      symlinkSync("python3.12-intel64", entryPoint);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assertStagedRuntimeSymlinks(root);
    removeKnownIntelPythonHelpers(root, "3.12");
    assert.throws(
      () => assertStagedRuntimeSymlinks(root),
      /dangling or cyclic: bin\/python/u
    );
  });
});

test("retained Python entry points remain internal, valid, and arm64", (t) => {
  withTempRoot((root) => {
    const executable = path.join(root, "bin", "python3.12");
    writeSyntheticMachO(executable, ["arm64"], 0o755);
    try {
      symlinkSync("python3.12", path.join(root, "bin", "python"));
      symlinkSync("python3.12", path.join(root, "bin", "python3"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const tools = syntheticAppleTools();
    assert.deepEqual(
      assertStagedPythonEntrypoints(root, "3.12", { runCommand: tools.runCommand }),
      ["bin/python", "bin/python3", "bin/python3.12"]
    );
  });
});

test("clean staging removes nested stale content only from the exact owned generated root", () => {
  withTempRoot((root) => {
    const repositoryRoot = path.join(root, "repository with spaces");
    const ownedRoot = path.join(repositoryRoot, "src-tauri", "gen", "runtime");
    const sibling = path.join(repositoryRoot, "src-tauri", "gen", "unrelated");
    mkdirSync(ownedRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    for (const stalePath of [
      path.join(ownedRoot, "stale-sentinel"),
      path.join(ownedRoot, "old", "bundle-manifest.json"),
      path.join(ownedRoot, "python-runtime", "sample", "media.wav"),
      path.join(ownedRoot, "previous-venv", "pyvenv.cfg")
    ]) {
      mkdirSync(path.dirname(stalePath), { recursive: true });
      writeFileSync(stalePath, "stale");
    }
    writeFileSync(path.join(sibling, "keep"), "keep");
    recreateOwnedGeneratedRoot(ownedRoot, repositoryRoot);
    assert.deepEqual(readdirSync(ownedRoot), []);
    assert.equal(existsSync(path.join(sibling, "keep")), true);
    let message = "";
    assert.throws(
      () => recreateOwnedGeneratedRoot(sibling, repositoryRoot),
      (error) => {
        message = error.message;
        return /Refusing to clean an unowned generated runtime root/u.test(error.message);
      }
    );
    assert.equal(message.includes(root), false);
  });
});

test("generated runtime cleanup rejects root and parent symlinks without touching their targets", (t) => {
  withTempRoot((root) => {
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-cleanup-outside-"));
    try {
      const outsideSentinel = path.join(outsideRoot, "keep");
      writeFileSync(outsideSentinel, "keep", "utf-8");

      const repositoryRoot = path.join(root, "repository");
      const generatedParent = path.join(repositoryRoot, "src-tauri", "gen");
      const ownedRoot = path.join(generatedParent, "runtime");
      mkdirSync(generatedParent, { recursive: true });
      try {
        symlinkSync(outsideRoot, ownedRoot, "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
          t.skip(`symlink fixture unavailable: ${error.code}`);
          return;
        }
        throw error;
      }
      assert.throws(
        () => recreateOwnedGeneratedRoot(ownedRoot, repositoryRoot),
        /runtime root must be an ordinary directory/u
      );
      assert.equal(readFileSync(outsideSentinel, "utf-8"), "keep");

      rmSync(ownedRoot, { force: true });
      rmSync(generatedParent, { recursive: true });
      symlinkSync(outsideRoot, generatedParent, "dir");
      assert.throws(
        () => recreateOwnedGeneratedRoot(ownedRoot, repositoryRoot),
        /parent must contain only ordinary directories/u
      );
      assert.equal(readFileSync(outsideSentinel, "utf-8"), "keep");
    } finally {
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });
});

test("real Apple clang and lipo fixtures normalize Universal2 and reject x86-only", {
  skip: process.platform !== "darwin" ? "requires macOS Apple tooling" : false
}, () => {
  withTempRoot((root) => {
    const source = path.join(root, "fixture.c");
    const arm64 = path.join(root, "arm64-fixture");
    const x86 = path.join(root, "x86-fixture");
    const runtimeRoot = path.join(root, "runtime");
    const retainedArm64 = path.join(runtimeRoot, "bin", "arm64-fixture");
    const universal = path.join(runtimeRoot, "lib", "universal-fixture");
    writeFileSync(source, "int main(void) { return 0; }\n", "utf-8");
    mkdirSync(path.dirname(retainedArm64), { recursive: true });
    mkdirSync(path.dirname(universal), { recursive: true });

    for (const [architecture, output] of [["arm64", arm64], ["x86_64", x86]]) {
      const compilation = spawnSync("xcrun", ["clang", "-arch", architecture, source, "-o", output], {
        encoding: "utf-8"
      });
      assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);
    }
    const creation = spawnSync("lipo", ["-create", arm64, x86, "-output", universal], { encoding: "utf-8" });
    assert.equal(creation.status, 0, creation.stderr || creation.stdout);
    writeFileSync(retainedArm64, readFileSync(arm64));
    chmodSync(retainedArm64, 0o755);
    const arm64Digest = digest(retainedArm64);

    const normalized = normalizeStagedMacRuntime(runtimeRoot);
    assert.equal(digest(retainedArm64), arm64Digest);
    assert.deepEqual(normalized.thinnedPaths, ["lib/universal-fixture"]);
    assert.equal(spawnSync("lipo", ["-archs", universal], { encoding: "utf-8" }).stdout.trim(), "arm64");

    const x86Root = path.join(root, "x86-runtime");
    const x86Only = path.join(x86Root, "lib", "x86-only");
    mkdirSync(path.dirname(x86Only), { recursive: true });
    writeFileSync(x86Only, readFileSync(x86));
    assert.throws(() => normalizeStagedMacRuntime(x86Root), /lacks an arm64 slice: lib\/x86-only/u);
  });
});

test("real Apple tooling atomically removes absolute wheel-build rpaths", {
  skip: process.platform !== "darwin" ? "requires macOS Apple tooling" : false
}, () => {
  withTempRoot((root) => {
    const source = path.join(root, "fixture.c");
    const runtimeRoot = path.join(root, "runtime");
    const library = path.join(runtimeRoot, "lib", "libfixture.dylib");
    mkdirSync(path.dirname(library), { recursive: true });
    writeFileSync(source, "int fixture(void) { return 1; }\n", "utf-8");
    const compilation = spawnSync("xcrun", [
      "clang",
      "-arch", "arm64",
      "-dynamiclib",
      source,
      "-Wl,-rpath,/tmp/transcript-research-wheel-build/lib",
      "-Wl,-rpath,@loader_path/portable",
      "-o", library
    ], { encoding: "utf-8" });
    assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);
    chmodSync(library, 0o755);

    const sanitized = sanitizeStagedMacRuntimeSearchPaths(runtimeRoot);
    assert.deepEqual(sanitized, [{
      relativePath: "lib/libfixture.dylib",
      removedSearchPathCount: 1
    }]);
    assert.equal(statSync(library).mode & 0o777, 0o755);
    const inspection = spawnSync("otool", ["-l", library], { encoding: "utf-8" });
    assert.equal(inspection.status, 0, inspection.stderr || inspection.stdout);
    assert.deepEqual(parseMachORuntimeSearchPaths(inspection.stdout), ["@loader_path/portable"]);
    const signature = spawnSync("codesign", ["--verify", "--strict", library], { encoding: "utf-8" });
    assert.equal(signature.status, 0, signature.stderr || signature.stdout);
    assert.deepEqual(sanitizeStagedMacRuntimeSearchPaths(runtimeRoot), []);
  });
});
