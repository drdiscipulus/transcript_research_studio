import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupProbeProcess,
  cleanupProbeFailures,
  buildProbeFailure,
  expectedPublishedAssetNames,
  parseChecksumManifest,
  terminateChildAndWait,
  verifyNoForbiddenContent,
  verifyChecksumEntries
} from "../scripts/verify_release_artifacts.mjs";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function checksumLine(name, contents) {
  return `${digest(contents)}  ${name}`;
}

class SyntheticChild extends EventEmitter {
  constructor({ spawned = true, alreadyExited = false, exitOnKill = true, exitOnForceKill = exitOnKill } = {}) {
    super();
    this.pid = spawned ? 4242 : undefined;
    this.exitCode = alreadyExited ? 0 : null;
    this.signalCode = null;
    this.exitOnKill = exitOnKill;
    this.exitOnForceKill = exitOnForceKill;
    this.killCalls = [];
  }

  kill(signal = "SIGTERM") {
    this.killCalls.push(signal);
    if (this.exitOnKill || (signal === "SIGKILL" && this.exitOnForceKill)) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

test("release probe termination waits for exit and removes listeners", async () => {
  const child = new SyntheticChild();
  const outcome = await terminateChildAndWait(child, 100);
  assert.equal(outcome.kind, "terminated");
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("release probe termination reports bounded cleanup failure", async () => {
  const child = new SyntheticChild({ exitOnKill: false, exitOnForceKill: false });
  const outcome = await terminateChildAndWait(child, 10);
  assert.equal(outcome.kind, "termination-unconfirmed");
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("release probe termination confirms exit after bounded force kill", async () => {
  const child = new SyntheticChild({ exitOnKill: false, exitOnForceKill: true });
  const outcome = await terminateChildAndWait(child, 10);
  assert.equal(outcome.kind, "force-killed");
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("release probe cleanup distinguishes never-spawned and already-exited processes", async () => {
  const neverSpawned = new SyntheticChild({ spawned: false });
  let neverSpawnedRemoved = false;
  const missingOutcome = await cleanupProbeProcess(
    neverSpawned,
    () => { neverSpawnedRemoved = true; },
    10
  );
  assert.equal(missingOutcome.outcome.kind, "not-spawned");
  assert.equal(neverSpawnedRemoved, true);
  assert.deepEqual(neverSpawned.killCalls, []);

  const alreadyExited = new SyntheticChild({ alreadyExited: true });
  let alreadyExitedRemoved = false;
  const exitedOutcome = await cleanupProbeProcess(
    alreadyExited,
    () => { alreadyExitedRemoved = true; },
    10
  );
  assert.equal(exitedOutcome.outcome.kind, "already-exited");
  assert.equal(exitedOutcome.outcome.exitCode, 0);
  assert.equal(alreadyExitedRemoved, true);
  assert.deepEqual(alreadyExited.killCalls, []);
});

test("release probe cleanup removes isolation data only after child exit", async () => {
  const child = new SyntheticChild();
  const events = [];
  child.on("exit", () => events.push("exit"));
  const cleanup = await cleanupProbeProcess(child, () => events.push("remove"), 100);
  assert.equal(cleanup.outcome.kind, "terminated");
  assert.equal(cleanup.removalError, null);
  assert.deepEqual(events, ["exit", "remove"]);
});

test("release probe cleanup never removes isolation data while the child may be alive", async () => {
  const child = new SyntheticChild({ exitOnKill: false, exitOnForceKill: false });
  let removed = false;
  const cleanup = await cleanupProbeProcess(child, () => { removed = true; }, 10);
  assert.equal(cleanup.outcome.kind, "termination-unconfirmed");
  assert.equal(removed, false);
});

test("release probe cleanup surfaces temporary-directory removal failure", async () => {
  const cleanup = await cleanupProbeProcess(
    new SyntheticChild(),
    () => { throw new Error("synthetic removal failure"); },
    100
  );
  assert.equal(cleanup.outcome.kind, "terminated");
  assert.match(cleanup.removalError.message, /synthetic removal failure/);
});

test("release probe failure reporting preserves combined facts and redacts tokens", () => {
  const failure = buildProbeFailure(
    [
      { stage: "health verification", error: new Error("health failed") },
      { stage: "process cleanup", error: new Error("cleanup failed") },
      { stage: "portable-data cleanup", error: new Error("removal failed") }
    ],
    "stderr included synthetic-secret-token",
    "synthetic-secret-token"
  );
  assert.match(failure.message, /health failed/);
  assert.match(failure.message, /cleanup failed/);
  assert.match(failure.message, /removal failed/);
  assert.match(failure.message, /\[redacted\]/);
  assert.doesNotMatch(failure.message, /synthetic-secret-token/);
});

test("release secret scan allows Hugging Face helpers but rejects token-shaped values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "transcript-research-studio-secret-scan-"));
  try {
    const sourcePath = path.join(root, "hf_credentials.py");
    writeFileSync(sourcePath, "from huggingface_hub import hf_hub_download\n", "utf-8");
    assert.doesNotThrow(() => verifyNoForbiddenContent(root));

    writeFileSync(sourcePath, "token = 'hf_abcdefghijklmnopqrst'\n", "utf-8");
    assert.throws(() => verifyNoForbiddenContent(root), /Credential-looking secret/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release content scan excludes Python runtime source but keeps application source checks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "transcript-research-studio-runtime-scan-"));
  try {
    const runtimeSource = path.join(root, "python-runtime", "Lib", "ntpath.py");
    mkdirSync(path.dirname(runtimeSource), { recursive: true });
    writeFileSync(runtimeSource, "example = 'C:\\Users\\example'\n", "utf-8");
    assert.doesNotThrow(() => verifyNoForbiddenContent(root));

    const applicationSource = path.join(root, "backend", "source.py");
    mkdirSync(path.dirname(applicationSource), { recursive: true });
    writeFileSync(applicationSource, "example = 'C:\\Users\\example'\n", "utf-8");
    assert.throws(() => verifyNoForbiddenContent(root), /Absolute maintainer path/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release probe cleanup classification rejects early exit and accepts verifier termination", () => {
  const earlyExit = cleanupProbeFailures([], null, {
    outcome: { kind: "already-exited", exitCode: 0, signalCode: null },
    removalError: null
  });
  assert.equal(earlyExit.length, 1);
  assert.match(earlyExit[0].error.message, /exited before verifier cleanup \(0\)/);

  assert.deepEqual(cleanupProbeFailures([], null, {
    outcome: { kind: "terminated", exitCode: null, signalCode: "SIGTERM" },
    removalError: null
  }), []);
});

test("release probe cleanup classification preserves lifecycle, termination, and removal failures", () => {
  const lifecycleError = new Error("synthetic spawn failure");
  const failures = cleanupProbeFailures([], lifecycleError, {
    outcome: {
      kind: "termination-unconfirmed",
      errors: [new Error("term timeout"), new Error("kill timeout")]
    },
    removalError: new Error("directory removal failed")
  });
  assert.equal(failures.length, 3);
  assert.equal(failures[0].error, lifecycleError);
  assert.match(failures[1].error.message, /term timeout; kill timeout/);
  assert.match(failures[2].error.message, /directory removal failed/);
});

test("checksum parser rejects traversal, separators, absolute paths, and duplicates", () => {
  const hash = "a".repeat(64);
  for (const name of ["../asset.zip", "folder/asset.zip", "folder\\asset.zip", path.resolve("asset.zip"), " asset.zip", "asset.zip ", `asset${String.fromCharCode(0x7f)}.zip`]) {
    assert.throws(() => parseChecksumManifest(`${hash}  ${name}\n`), /Unsafe checksum asset name/);
  }
  assert.throws(
    () => parseChecksumManifest(`${hash}  asset.zip\n${hash}  asset.zip\n`),
    /Duplicate checksum asset entry/
  );
});

test("checksum duplicate handling is explicitly platform-sensitive", () => {
  const hash = "a".repeat(64);
  const manifest = `${hash}  Asset.zip\n${hash}  asset.zip\n`;
  assert.throws(
    () => parseChecksumManifest(manifest, { caseSensitive: false }),
    /Duplicate checksum asset entry/
  );
  assert.equal(parseChecksumManifest(manifest, { caseSensitive: true }).size, 2);
});

test("checksum verification requires every expected asset and permits unrelated entries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-checksum-test-"));
  try {
    writeFileSync(path.join(root, "expected.zip"), "expected");
    writeFileSync(path.join(root, "other-platform.zip"), "other");
    const manifest = [
      checksumLine("expected.zip", "expected"),
      checksumLine("other-platform.zip", "other")
    ].join("\n");
    const entries = verifyChecksumEntries(root, manifest, ["expected.zip"]);
    assert.equal(entries.size, 2);
    assert.throws(
      () => verifyChecksumEntries(root, checksumLine("other-platform.zip", "other"), ["expected.zip"]),
      /missing from the checksum manifest/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("checksum verification rejects duplicate logical expected assets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-checksum-test-"));
  try {
    writeFileSync(path.join(root, "expected.zip"), "expected");
    assert.throws(
      () => verifyChecksumEntries(
        root,
        checksumLine("expected.zip", "expected"),
        ["expected.zip", "EXPECTED.ZIP"],
        { caseSensitive: false }
      ),
      /Duplicate expected release asset/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("checksum verification rejects symlink assets without hashing their targets", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-checksum-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ai-transcription-checksum-outside-"));
  try {
    const outsideAsset = path.join(outside, "outside.zip");
    const linkedAsset = path.join(root, "linked.zip");
    writeFileSync(outsideAsset, "outside");
    try {
      symlinkSync(outsideAsset, linkedAsset, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => verifyChecksumEntries(
        root,
        checksumLine("linked.zip", "outside"),
        ["linked.zip"]
      ),
      /ordinary file/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("checksum verification rejects digest mismatches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-checksum-test-"));
  try {
    writeFileSync(path.join(root, "asset.zip"), "actual");
    assert.throws(
      () => verifyChecksumEntries(root, checksumLine("asset.zip", "different"), ["asset.zip"]),
      /checksum mismatch/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Windows checksum expectations include every CUDA part declared by the manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-cuda-checksum-test-"));
  try {
    const archivePath = path.join(root, "studio_cuda.zip");
    writeFileSync(`${archivePath}.parts.json`, JSON.stringify({
      parts: [
        { file_name: "studio_cuda.zip.part001" },
        { file_name: "studio_cuda.zip.part002" }
      ]
    }));
    const expected = expectedPublishedAssetNames(
      [{ variant: "cuda", packageName: "studio_cuda", portableRoot: root, archivePath }],
      "win32"
    );
    assert.ok(expected.includes("studio_cuda.zip.parts.json"));
    assert.ok(expected.includes("reassemble_cuda.ps1"));
    assert.ok(expected.includes("studio_cuda.zip.part001"));
    assert.ok(expected.includes("studio_cuda.zip.part002"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("expected release assets reject duplicate package metadata", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-expected-assets-test-"));
  try {
    assert.throws(
      () => expectedPublishedAssetNames(
        [
          { variant: "cpu", packageName: "studio", portableRoot: root, archivePath: path.join(root, "cpu.zip") },
          { variant: "other", packageName: "STUDIO", portableRoot: root, archivePath: path.join(root, "other.zip") }
        ],
        "win32"
      ),
      /Expected release asset collision/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("expected release assets reject duplicate platform archives", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-expected-assets-test-"));
  try {
    assert.throws(
      () => expectedPublishedAssetNames(
        [
          { variant: "cpu", packageName: "studio_cpu", portableRoot: root, archivePath: path.join(root, "studio.zip") },
          { variant: "other", packageName: "studio_other", portableRoot: root, archivePath: path.join(root, "STUDIO.ZIP") }
        ],
        "win32"
      ),
      /Expected release asset collision/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

for (const [label, collidingPart] of [
  ["reassembly helper", "reassemble_cuda.ps1"],
  ["parts manifest", "studio_cuda.zip.parts.json"],
  ["package metadata", "studio_cuda.SBOM.cdx.json"]
]) {
  test(`CUDA part names cannot collide with ${label}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "ai-transcription-cuda-collision-test-"));
    try {
      const archivePath = path.join(root, "studio_cuda.zip");
      writeFileSync(`${archivePath}.parts.json`, JSON.stringify({
        parts: [{ file_name: collidingPart }]
      }));
      assert.throws(
        () => expectedPublishedAssetNames(
          [{ variant: "cuda", packageName: "studio_cuda", portableRoot: root, archivePath }],
          "win32"
        ),
        /collision/
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
}
