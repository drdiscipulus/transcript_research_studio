import assert from "node:assert/strict";
import test from "node:test";
import { assertNodeEngineCompatibility } from "../scripts/node_engine.mjs";

const node24Manifest = { engines: { node: "24.x" } };

test("accepts every valid Node 24 patch release", () => {
  assert.deepEqual(assertNodeEngineCompatibility(node24Manifest, "v24.0.0"), {
    requiredEngine: "24.x",
    detectedVersion: "v24.0.0"
  });
  assert.doesNotThrow(() => assertNodeEngineCompatibility(node24Manifest, "v24.99.123"));
});

test("rejects lower and higher Node major versions with required and detected values", () => {
  assert.throws(
    () => assertNodeEngineCompatibility(node24Manifest, "v23.11.0"),
    /Node 24\.x is required; detected v23\.11\.0\./u
  );
  assert.throws(
    () => assertNodeEngineCompatibility(node24Manifest, "v25.0.0"),
    /Node 24\.x is required; detected v25\.0\.0\./u
  );
});

test("rejects malformed detected versions", () => {
  for (const detectedVersion of ["24.1.0", "v24", "current", ""]) {
    assert.throws(
      () => assertNodeEngineCompatibility(node24Manifest, detectedVersion),
      /Node 24\.x is required; detected/u
    );
  }
});

test("rejects missing or unsupported Node engine declarations", () => {
  for (const manifest of [{}, { engines: {} }, { engines: { node: ">=24" } }, { engines: { node: "24" } }]) {
    assert.throws(
      () => assertNodeEngineCompatibility(manifest, "v24.15.0"),
      /must declare the required Node engine as "<major>\.x"; detected v24\.15\.0\./u
    );
  }
});
