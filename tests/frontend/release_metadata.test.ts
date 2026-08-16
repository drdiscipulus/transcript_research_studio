import { describe, expect, it } from "vitest";

// @ts-expect-error The release helper is intentionally plain ESM used by Node.
import { componentPurl, deterministicUuid, validateSbom } from "../../scripts/generate_release_metadata.mjs";

describe("release metadata helpers", () => {
  it("builds RFC 4122 version-5 UUIDs deterministically", () => {
    const uuid = deterministicUuid("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(uuid).toBe("01234567-89ab-5def-8123-456789abcdef");
  });

  it("encodes scoped npm purls as namespace and package name", () => {
    expect(componentPurl({ ecosystem: "npm", name: "@example/research-tool", version: "1.2.3" }))
      .toBe("pkg:npm/%40example/research-tool@1.2.3");
  });

  it("accepts a minimal valid SBOM and rejects a duplicate purl", () => {
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: "urn:uuid:01234567-89ab-5def-8123-456789abcdef",
      version: 1,
      components: [{ name: "CPython", version: "3.12.10", purl: "pkg:generic/CPython@3.12.10" }]
    };
    expect(() => validateSbom(sbom)).not.toThrow();
    expect(() => validateSbom({ ...sbom, components: [...sbom.components, ...sbom.components] })).toThrow();
  });
});
