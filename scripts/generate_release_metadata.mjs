import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function runtimeRootForPackage(root) {
  const windowsRuntime = path.join(root, "gen", "runtime");
  if (existsSync(windowsRuntime)) {
    return windowsRuntime;
  }
  const macRuntime = path.join(root, "Transcript Research Studio.app", "Contents", "Resources", "gen", "runtime");
  if (existsSync(macRuntime)) {
    return macRuntime;
  }
  throw new Error(`Could not locate the packaged runtime under ${root}.`);
}

function metadataField(text, name) {
  const prefix = `${name}:`;
  const line = text.split(/\r?\n/).find((value) => value.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

function noticeFiles(rootPath, maxDepth = 2) {
  if (!existsSync(rootPath)) {
    return [];
  }
  const notices = [];
  const seen = new Set();
  function walk(currentPath, depth) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^(licen[cs]e|copying|notice|copyright)([._-].*)?$/i.test(entry.name)) {
        continue;
      }
      const raw = readFileSync(entryPath);
      if (raw.length > 2 * 1024 * 1024 || raw.includes(0)) {
        continue;
      }
      const text = raw.toString("utf-8").trim();
      const digest = createHash("sha256").update(text).digest("hex");
      if (text && !seen.has(digest)) {
        seen.add(digest);
        notices.push({ file: path.relative(rootPath, entryPath).split(path.sep).join("/"), text });
      }
    }
  }
  walk(rootPath, 0);
  return notices;
}

function pythonInterpreterNotices(pythonRuntimeRoot) {
  const candidates = [
    ...noticeFiles(pythonRuntimeRoot, 1),
    ...noticeFiles(path.join(pythonRuntimeRoot, "Resources"), 4)
  ];
  const unique = new Map();
  for (const notice of candidates) {
    const digest = createHash("sha256").update(notice.text).digest("hex");
    unique.set(digest, notice);
  }
  return [...unique.values()];
}

function pythonComponents(runtimeRoot) {
  const pythonRoot = path.join(runtimeRoot, "python-runtime");
  const sitePackagesRoots = [];
  const windowsSitePackages = path.join(pythonRoot, "Lib", "site-packages");
  if (existsSync(windowsSitePackages)) {
    sitePackagesRoots.push(windowsSitePackages);
  }
  const libRoot = path.join(pythonRoot, "lib");
  if (existsSync(libRoot)) {
    for (const entry of readdirSync(libRoot, { withFileTypes: true })) {
      const candidate = path.join(libRoot, entry.name, "site-packages");
      if (entry.isDirectory() && existsSync(candidate)) {
        sitePackagesRoots.push(candidate);
      }
    }
  }

  const components = [];
  for (const sitePackagesRoot of sitePackagesRoots) {
    for (const entry of readdirSync(sitePackagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) {
        continue;
      }
      const metadataPath = path.join(sitePackagesRoot, entry.name, "METADATA");
      if (!existsSync(metadataPath)) {
        continue;
      }
      const metadata = readFileSync(metadataPath, "utf-8");
      const name = metadataField(metadata, "Name");
      const version = metadataField(metadata, "Version");
      if (!name || !version) {
        continue;
      }
      const license = metadataField(metadata, "License-Expression") || metadataField(metadata, "License") || "NOASSERTION";
      components.push({
        ecosystem: "pypi",
        name,
        version,
        license,
        notices: noticeFiles(path.join(sitePackagesRoot, entry.name), 3)
      });
    }
  }
  return components;
}

function npmComponents() {
  const lock = readJson(path.join(repoRoot, "package-lock.json"));
  const components = [];
  for (const [packagePath, value] of Object.entries(lock.packages || {})) {
    if (!packagePath.startsWith("node_modules/") || value.dev || !value.version) {
      continue;
    }
    const packageManifestPath = path.join(repoRoot, packagePath, "package.json");
    const manifest = existsSync(packageManifestPath) ? readJson(packageManifestPath) : {};
    const name = manifest.name || packagePath.slice("node_modules/".length);
    components.push({
      ecosystem: "npm",
      name,
      version: value.version,
      license: String(manifest.license || "NOASSERTION"),
      notices: noticeFiles(path.dirname(packageManifestPath), 1)
    });
  }
  return components;
}

function cargoComponents() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", path.join(repoRoot, "src-tauri", "Cargo.toml")],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, shell: false }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not resolve locked Rust metadata for the SBOM: ${result.stderr || result.stdout}`);
  }
  const metadata = JSON.parse(result.stdout);
  return metadata.packages
    .filter((dependency) => dependency.source && dependency.name !== "transcript_research_studio")
    .map((dependency) => ({
      ecosystem: "cargo",
      name: dependency.name,
      version: dependency.version,
      license: dependency.license || "NOASSERTION",
      notices: noticeFiles(path.dirname(dependency.manifest_path), 1)
    }));
}

function componentKey(component) {
  return `${component.ecosystem}:${component.name.toLowerCase()}:${component.version}`;
}

export function deterministicUuid(hexDigest) {
  const bytes = Buffer.from(hexDigest.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function componentPurl(component) {
  const version = encodeURIComponent(component.version);
  if (component.ecosystem === "npm" && component.name.startsWith("@") && component.name.includes("/")) {
    const [scope, packageName] = component.name.split("/", 2);
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${version}`;
  }
  return `pkg:${component.ecosystem}/${encodeURIComponent(component.name)}@${version}`;
}

function noticeSection(component) {
  const lines = [
    `## ${component.ecosystem}: ${component.name} ${component.version}`,
    "",
    `Declared license: ${component.license}`,
    ""
  ];
  if (!component.notices?.length) {
    lines.push("No separate license file was exposed by the installed package metadata.", "");
    return lines;
  }
  for (const notice of component.notices) {
    lines.push(`### ${notice.file}`, "");
    lines.push(...notice.text.split(/\r?\n/).map((line) => `    ${line}`), "");
  }
  return lines;
}

export function validateSbom(sbom) {
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || sbom.version !== 1) {
    throw new Error("Generated SBOM does not declare CycloneDX 1.5 correctly.");
  }
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sbom.serialNumber)) {
    throw new Error(`Generated SBOM serial number is not an RFC 4122 version-5 UUID: ${sbom.serialNumber}`);
  }
  const purls = new Set();
  for (const component of sbom.components || []) {
    if (!component.name || !component.version || !component.purl || purls.has(component.purl)) {
      throw new Error(`Generated SBOM contains an invalid or duplicate component: ${component.purl || component.name}`);
    }
    purls.add(component.purl);
  }
  if (!(sbom.components || []).some((component) => component.purl.startsWith("pkg:generic/CPython@"))) {
    throw new Error("Generated SBOM must include the bundled CPython interpreter.");
  }
}

function main() {
  if (!packageRoot || !existsSync(packageRoot)) {
    throw new Error("Usage: node scripts/generate_release_metadata.mjs PACKAGE_ROOT");
  }
  const runtimeRoot = runtimeRootForPackage(packageRoot);
  const manifest = readJson(path.join(runtimeRoot, "bundle-manifest.json"));
  const unique = new Map();
  const pythonRuntimeRoot = path.join(runtimeRoot, "python-runtime");
  const cpython = {
    ecosystem: "generic",
    name: "CPython",
    version: manifest.python_version,
    license: "Python-2.0",
    notices: pythonInterpreterNotices(pythonRuntimeRoot)
  };
  if (!cpython.notices.length) {
    throw new Error("The bundled CPython runtime does not expose a license file for THIRD_PARTY_NOTICES.md.");
  }
  for (const component of [cpython, ...pythonComponents(runtimeRoot), ...npmComponents(), ...cargoComponents()]) {
    unique.set(componentKey(component), component);
  }
  const components = [...unique.values()].sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(components.map(({ notices: _notices, ...component }) => component)))
    .digest("hex");
  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${deterministicUuid(fingerprint)}`,
    version: 1,
    metadata: {
      timestamp: manifest.build_time_utc,
      component: {
        type: "application",
        name: "Transcript Research Studio",
        version: manifest.app_version,
        licenses: [{ license: { id: "GPL-3.0-or-later" } }]
      },
      properties: [
        { name: "ai-transcription:commit", value: manifest.commit_sha },
        { name: "ai-transcription:runtime-profile", value: manifest.runtime_profile },
        { name: "ai-transcription:dependency-lock-sha256", value: manifest.dependency_lock_hash }
      ]
    },
    components: components.map((component) => ({
      type: "library",
      name: component.name,
      version: component.version,
      purl: componentPurl(component),
      licenses: component.license === "NOASSERTION" ? [] : [{ license: { name: component.license } }]
    }))
  };
  validateSbom(sbom);
  writeFileSync(path.join(packageRoot, "SBOM.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf-8");

  const noticeLines = [
    "# Third-Party Notices",
    "",
    `Generated for Transcript Research Studio ${manifest.app_version} (${manifest.runtime_profile}).`,
    "",
    "Transcript Research Studio is licensed under GPL-3.0-or-later. The portable package also contains",
    "the following third-party components. License identifiers are taken from installed package metadata.",
    "License, notice, and copyright files exposed by the packaged Python distributions and by the npm and",
    "Cargo source packages used to build the application are aggregated below.",
    "",
    "| Ecosystem | Component | Version | Declared license |",
    "|---|---|---:|---|",
    ...components.map((component) =>
      `| ${component.ecosystem} | ${component.name.replaceAll("|", "\\|")} | ${component.version} | ${component.license.replaceAll("|", "\\|")} |`
    ),
    "",
    ...components.flatMap(noticeSection)
  ];
  writeFileSync(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), noticeLines.join("\n"), "utf-8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
