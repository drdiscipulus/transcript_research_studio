import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 128, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return result.stdout;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runTimestampedCodesign(args) {
  const maxAttempts = 4;
  let lastOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync("codesign", args, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 128,
      stdio: "pipe"
    });
    lastOutput = `${result.stdout || ""}${result.stderr || ""}`;
    if (result.status === 0) {
      return;
    }
    if (result.error) {
      throw result.error;
    }
    if (!lastOutput.includes("The timestamp service is not available.") || attempt === maxAttempts) {
      throw new Error(`codesign ${args.join(" ")} failed:\n${lastOutput}`);
    }
    sleep(2000 * attempt);
  }
}

function findFiles(rootPath) {
  return run("find", [rootPath, "-type", "f", "-print0"])
    .split("\0")
    .filter(Boolean);
}

function fileKind(filePath) {
  return run("file", [filePath]).trim();
}

function removeNotarizationHostileBuildArtifacts(appPath, files) {
  for (const filePath of files) {
    const name = path.basename(filePath);
    if (name.endsWith(".a") || name.endsWith(".o") || name.endsWith(".pyc") || name.endsWith(".pyo")) {
      rmSync(filePath, { force: true });
    }
  }

  run("find", [appPath, "-type", "d", "-name", "__pycache__", "-prune", "-exec", "rm", "-rf", "{}", ";"]);
}

function machOFiles(rootPath) {
  return findFiles(rootPath)
    .filter((filePath) => fileKind(filePath).includes("Mach-O"))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function relativeLoaderPath(fromFile, toFile) {
  const fromDirectory = path.dirname(fromFile);
  const relativePath = path.relative(fromDirectory, toFile).split(path.sep).join("/");
  return relativePath.startsWith(".") ? `@loader_path/${relativePath}` : `@loader_path/${relativePath}`;
}

function linkedLibraries(filePath) {
  return run("otool", ["-L", filePath])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);
}

function dylibInstallName(filePath) {
  const result = spawnSync("otool", ["-D", filePath], { encoding: "utf-8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).find(Boolean) || null;
}

function rpaths(filePath) {
  const lines = run("otool", ["-l", filePath]).split(/\r?\n/);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") {
      continue;
    }
    for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = lines[cursor].trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/);
      if (match) {
        values.push(match[1]);
        break;
      }
    }
  }
  return values;
}

function isAllowedSystemPath(value) {
  const normalized = path.posix.normalize(value);
  return normalized === value && (normalized.startsWith("/System/Library/") || normalized.startsWith("/usr/lib/"));
}

export function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function dyldTokenSuffix(value, token) {
  if (value === token) {
    return "";
  }
  const prefix = `${token}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function canonicalBundleTarget(appRoot, candidatePath, description, expectedKind) {
  const absoluteRoot = path.resolve(appRoot);
  const canonicalRoot = realpathSync(absoluteRoot);
  const absoluteCandidate = path.resolve(candidatePath);
  if (!isPathWithin(absoluteRoot, absoluteCandidate) && !isPathWithin(canonicalRoot, absoluteCandidate)) {
    throw new Error(`${description} escapes the app bundle: ${absoluteCandidate}`);
  }
  if (!existsSync(absoluteCandidate)) {
    throw new Error(`${description} does not resolve to a bundled target: ${absoluteCandidate}`);
  }

  const canonicalCandidate = realpathSync(absoluteCandidate);
  if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error(`${description} resolves outside the app bundle: ${canonicalCandidate}`);
  }

  const targetStat = statSync(canonicalCandidate);
  if (expectedKind === "file" && !targetStat.isFile()) {
    throw new Error(`${description} must resolve to a bundled file: ${canonicalCandidate}`);
  }
  if (expectedKind === "directory" && !targetStat.isDirectory()) {
    throw new Error(`${description} must resolve to a bundled directory: ${canonicalCandidate}`);
  }
  return canonicalCandidate;
}

function resolveAnchoredDyldPath(value, token, anchorPath, appRoot, description, expectedKind) {
  const suffix = dyldTokenSuffix(value, token);
  if (suffix === null) {
    return null;
  }
  if (!suffix) {
    if (expectedKind === "directory") {
      return canonicalBundleTarget(appRoot, anchorPath, description, expectedKind);
    }
    throw new Error(`${description} is missing a target after ${token}: ${value}`);
  }
  return canonicalBundleTarget(appRoot, path.resolve(anchorPath, suffix), description, expectedKind);
}

export function resolvePortableRpaths({ appRoot, filePath, executableDirectory, searchPaths }) {
  return searchPaths.map((searchPath) => {
    const description = `Runtime search path for ${filePath} (${searchPath})`;
    const loaderTarget = resolveAnchoredDyldPath(
      searchPath,
      "@loader_path",
      path.dirname(filePath),
      appRoot,
      description,
      "directory"
    );
    if (loaderTarget) {
      return loaderTarget;
    }
    const executableTarget = resolveAnchoredDyldPath(
      searchPath,
      "@executable_path",
      executableDirectory,
      appRoot,
      description,
      "directory"
    );
    if (executableTarget) {
      return executableTarget;
    }
    throw new Error(`Bundled Mach-O has an unsafe runtime search path: ${filePath} -> ${searchPath}`);
  });
}

export function resolveBundledDependency({ appRoot, filePath, executableDirectory, dependency, searchPaths }) {
  if (isAllowedSystemPath(dependency)) {
    return [];
  }

  const description = `Mach-O dependency ${filePath} -> ${dependency}`;
  const loaderTarget = resolveAnchoredDyldPath(
    dependency,
    "@loader_path",
    path.dirname(filePath),
    appRoot,
    description,
    "file"
  );
  if (loaderTarget) {
    return [loaderTarget];
  }
  const executableTarget = resolveAnchoredDyldPath(
    dependency,
    "@executable_path",
    executableDirectory,
    appRoot,
    description,
    "file"
  );
  if (executableTarget) {
    return [executableTarget];
  }

  const rpathSuffix = dyldTokenSuffix(dependency, "@rpath");
  if (rpathSuffix !== null) {
    if (!rpathSuffix) {
      throw new Error(`${description} is missing a target after @rpath.`);
    }
    const resolvedSearchPaths = resolvePortableRpaths({
      appRoot,
      filePath,
      executableDirectory,
      searchPaths
    });
    if (!resolvedSearchPaths.length) {
      throw new Error(`${description} has no runtime search paths.`);
    }
    const resolvedTargets = [];
    const canonicalRoot = realpathSync(appRoot);
    for (const searchRoot of resolvedSearchPaths) {
      const candidate = path.resolve(searchRoot, rpathSuffix);
      if (!isPathWithin(canonicalRoot, candidate)) {
        throw new Error(`${description} escapes the app bundle through @rpath: ${candidate}`);
      }
      if (existsSync(candidate)) {
        resolvedTargets.push(canonicalBundleTarget(appRoot, candidate, description, "file"));
      }
    }
    if (!resolvedTargets.length) {
      throw new Error(`${description} does not resolve through any bundled runtime search path.`);
    }
    const uniqueTargets = [...new Set(resolvedTargets)];
    if (uniqueTargets.length > 1) {
      throw new Error(`${description} resolves to multiple bundled targets through runtime search paths.`);
    }
    return uniqueTargets;
  }

  throw new Error(`Bundled Mach-O has a non-portable dependency: ${filePath} -> ${dependency}`);
}

export function resolveSafeSymlinkTarget(rootPath, linkPath, target) {
  if (path.isAbsolute(target)) {
    throw new Error(`Absolute symlink is not allowed in the app bundle: ${linkPath} -> ${target}`);
  }
  const candidate = path.resolve(path.dirname(linkPath), target);
  if (!isPathWithin(rootPath, candidate)) {
    throw new Error(`Symlink escapes the app bundle: ${linkPath} -> ${target}`);
  }
  return candidate;
}

export function assertSafeBundleSymlinks(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  const canonicalRoot = realpathSync(absoluteRoot);
  if (lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error(`App bundle root must not be a symlink: ${absoluteRoot}`);
  }

  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(entryPath);
        resolveSafeSymlinkTarget(absoluteRoot, entryPath, target);
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(entryPath);
        } catch (error) {
          throw new Error(`Symlink is dangling or cyclic in the app bundle: ${entryPath} -> ${target} (${error.message})`);
        }
        if (!isPathWithin(canonicalRoot, canonicalTarget)) {
          throw new Error(`Symlink resolves outside the app bundle: ${entryPath} -> ${canonicalTarget}`);
        }
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(absoluteRoot);
}

function canonicalMachOCandidate(appRoot, filePath) {
  const absoluteRoot = path.resolve(appRoot);
  const canonicalRoot = realpathSync(absoluteRoot);
  const absoluteCandidate = path.resolve(filePath);
  if (!isPathWithin(absoluteRoot, absoluteCandidate) && !isPathWithin(canonicalRoot, absoluteCandidate)) {
    throw new Error("Bundled Mach-O candidate is outside the app bundle.");
  }
  if (!existsSync(absoluteCandidate) || !statSync(absoluteCandidate).isFile()) {
    throw new Error("Bundled Mach-O candidate is not an ordinary bundled file.");
  }

  const canonicalPath = realpathSync(absoluteCandidate);
  if (!isPathWithin(canonicalRoot, canonicalPath)) {
    throw new Error("Bundled Mach-O candidate resolves outside the app bundle.");
  }
  const bundleRelativePath = path.relative(canonicalRoot, canonicalPath).split(path.sep).join("/");
  if (!bundleRelativePath || bundleRelativePath === ".." || bundleRelativePath.startsWith("../")) {
    throw new Error("Bundled Mach-O candidate has an invalid bundle-relative path.");
  }
  return { canonicalPath, bundleRelativePath };
}

export function inventoryBundledMachOCandidates(appRoot, files) {
  return files.map((filePath) => {
    const candidate = canonicalMachOCandidate(appRoot, filePath);
    return Object.freeze({
      ...candidate,
      basename: path.basename(candidate.canonicalPath),
      originalInstallName: dylibInstallName(candidate.canonicalPath),
      originalDependencies: Object.freeze(linkedLibraries(candidate.canonicalPath)),
      originalSearchPaths: Object.freeze(rpaths(candidate.canonicalPath))
    });
  });
}

function safeCandidatePaths(candidates) {
  return candidates.map((candidate) => candidate.bundleRelativePath).sort().join(", ");
}

export function resolveInventoryMachODependency({ dependency, consumerRelativePath, candidates }) {
  const dependencyBasename = path.posix.basename(dependency);
  const linkableBasenameMatches = candidates.filter(
    (candidate) => candidate.originalInstallName && candidate.basename === dependencyBasename
  );
  const exactIdentityMatches = linkableBasenameMatches.filter(
    (candidate) => candidate.originalInstallName === dependency
  );
  if (exactIdentityMatches.length === 1) {
    return exactIdentityMatches[0];
  }
  if (exactIdentityMatches.length > 1) {
    throw dependencyResolutionError(
      "ambiguous",
      `Cannot safely relink dependency ${dependencyBasename} for ${consumerRelativePath}: ` +
      `multiple bundled libraries have the exact original install identity (${safeCandidatePaths(exactIdentityMatches)}).`
    );
  }
  if (linkableBasenameMatches.length === 1) {
    return linkableBasenameMatches[0];
  }
  if (linkableBasenameMatches.length > 1) {
    throw dependencyResolutionError(
      "ambiguous",
      `Cannot safely relink dependency ${dependencyBasename} for ${consumerRelativePath}: ` +
      `multiple linkable bundled libraries share its basename (${safeCandidatePaths(linkableBasenameMatches)}).`
    );
  }
  const globalIdentityMatches = candidates.filter(
    (candidate) => candidate.originalInstallName === dependency
  );
  if (globalIdentityMatches.length === 1) {
    return globalIdentityMatches[0];
  }
  if (globalIdentityMatches.length > 1) {
    throw dependencyResolutionError(
      "ambiguous",
      `Cannot safely relink dependency ${dependencyBasename} for ${consumerRelativePath}: ` +
      `multiple bundled libraries have its exact original install identity (${safeCandidatePaths(globalIdentityMatches)}).`
    );
  }
  throw dependencyResolutionError(
    "missing",
    `Cannot safely relink dependency ${dependencyBasename} for ${consumerRelativePath}: ` +
    "no linkable bundled library has its basename or exact original install identity."
  );
}

export function resolveExternalMachODependency(options) {
  return resolveInventoryMachODependency(options);
}

export function executableDirectoryForFile(filePath, appRoot) {
  let currentPath = path.dirname(realpathSync(filePath));
  const canonicalRoot = realpathSync(path.resolve(appRoot));
  while (isPathWithin(canonicalRoot, currentPath)) {
    if (path.basename(currentPath) === "Contents" && path.basename(path.dirname(currentPath)).endsWith(".app")) {
      const candidate = path.join(currentPath, "MacOS");
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }
  throw new Error("Cannot determine @executable_path for a bundled Mach-O file.");
}

function dependencyResolutionError(kind, message) {
  const error = new Error(message);
  error.dependencyResolutionKind = kind;
  return error;
}

function safePlannedBundleTarget({
  appRoot,
  candidatePath,
  description,
  expectedKind,
  missingAllowed = false
}) {
  const absoluteRoot = path.resolve(appRoot);
  const canonicalRoot = realpathSync(absoluteRoot);
  const absoluteCandidate = path.resolve(candidatePath);
  if (!isPathWithin(absoluteRoot, absoluteCandidate) && !isPathWithin(canonicalRoot, absoluteCandidate)) {
    throw dependencyResolutionError("unsafe", `${description} escapes the app bundle.`);
  }
  if (!existsSync(absoluteCandidate)) {
    if (missingAllowed) {
      return null;
    }
    throw dependencyResolutionError("missing", `${description} does not resolve inside the app bundle.`);
  }

  const canonicalCandidate = realpathSync(absoluteCandidate);
  if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
    throw dependencyResolutionError("unsafe", `${description} resolves outside the app bundle.`);
  }
  const targetStat = statSync(canonicalCandidate);
  if (expectedKind === "file" && !targetStat.isFile()) {
    throw dependencyResolutionError("missing", `${description} does not resolve to a bundled file.`);
  }
  if (expectedKind === "directory" && !targetStat.isDirectory()) {
    throw dependencyResolutionError("missing", `${description} does not resolve to a bundled directory.`);
  }
  return canonicalCandidate;
}

function plannedAnchoredTarget({
  appRoot,
  value,
  token,
  anchorPath,
  description,
  expectedKind,
  missingAllowed = false
}) {
  const suffix = dyldTokenSuffix(value, token);
  if (suffix === null) {
    return null;
  }
  if (!suffix) {
    if (expectedKind === "directory") {
      return safePlannedBundleTarget({
        appRoot,
        candidatePath: anchorPath,
        description,
        expectedKind,
        missingAllowed
      });
    }
    throw dependencyResolutionError("missing", `${description} is missing a target after ${token}.`);
  }
  return safePlannedBundleTarget({
    appRoot,
    candidatePath: path.resolve(anchorPath, suffix),
    description,
    expectedKind,
    missingAllowed
  });
}

function originalPortableRpaths({ appRoot, consumer, executableDirectory }) {
  return consumer.originalSearchPaths.map((searchPath) => {
    const description = `Runtime search path for ${consumer.bundleRelativePath}`;
    const loaderTarget = plannedAnchoredTarget({
      appRoot,
      value: searchPath,
      token: "@loader_path",
      anchorPath: path.dirname(consumer.canonicalPath),
      description,
      expectedKind: "directory"
    });
    if (loaderTarget) {
      return loaderTarget;
    }
    const executableTarget = plannedAnchoredTarget({
      appRoot,
      value: searchPath,
      token: "@executable_path",
      anchorPath: executableDirectory,
      description,
      expectedKind: "directory"
    });
    if (executableTarget) {
      return executableTarget;
    }
    throw dependencyResolutionError(
      "unsafe",
      `Bundled Mach-O has an unsafe runtime search path: ${consumer.bundleRelativePath}.`
    );
  });
}

function inventoryTargetOrResolutionError({ dependency, consumer, candidates }) {
  try {
    return resolveInventoryMachODependency({
      dependency,
      consumerRelativePath: consumer.bundleRelativePath,
      candidates
    });
  } catch (error) {
    if (error.dependencyResolutionKind) {
      throw error;
    }
    throw dependencyResolutionError("unsafe", "Bundled dependency inventory resolution failed safely.");
  }
}

function planCandidateDependency({
  appRoot,
  consumer,
  executableDirectory,
  resolvedSearchPaths,
  dependency,
  candidates,
  candidatesByCanonicalPath
}) {
  if (isAllowedSystemPath(dependency)) {
    return { disposition: "system", dependency, replacement: null, target: null };
  }

  const dependencyBasename = path.posix.basename(dependency);
  const description = `Mach-O dependency ${dependencyBasename} for ${consumer.bundleRelativePath}`;
  const loaderTarget = plannedAnchoredTarget({
    appRoot,
    value: dependency,
    token: "@loader_path",
    anchorPath: path.dirname(consumer.canonicalPath),
    description,
    expectedKind: "file"
  });
  if (loaderTarget) {
    if (!candidatesByCanonicalPath.has(loaderTarget)) {
      throw dependencyResolutionError("missing", `${description} does not resolve to a bundled Mach-O file.`);
    }
    return { disposition: "loaderPath", dependency, replacement: null, target: loaderTarget };
  }

  const executableTarget = plannedAnchoredTarget({
    appRoot,
    value: dependency,
    token: "@executable_path",
    anchorPath: executableDirectory,
    description,
    expectedKind: "file"
  });
  if (executableTarget) {
    if (!candidatesByCanonicalPath.has(executableTarget)) {
      throw dependencyResolutionError("missing", `${description} does not resolve to a bundled Mach-O file.`);
    }
    return { disposition: "executablePath", dependency, replacement: null, target: executableTarget };
  }

  const rpathSuffix = dyldTokenSuffix(dependency, "@rpath");
  if (rpathSuffix !== null) {
    if (!rpathSuffix) {
      throw dependencyResolutionError("missing", `${description} is missing a target after @rpath.`);
    }
    const rpathTargets = [...new Set(resolvedSearchPaths
      .map((searchRoot) => safePlannedBundleTarget({
        appRoot,
        candidatePath: path.resolve(searchRoot, rpathSuffix),
        description,
        expectedKind: "file",
        missingAllowed: true
      }))
      .filter(Boolean))]
      .map((target) => candidatesByCanonicalPath.get(target))
      .filter((target) => target?.originalInstallName);

    if (rpathTargets.length === 1) {
      return {
        disposition: "rpath",
        dependency,
        replacement: null,
        target: rpathTargets[0].canonicalPath
      };
    }
    if (rpathTargets.length > 1) {
      throw dependencyResolutionError(
        "ambiguous",
        `Cannot safely resolve dependency ${dependencyBasename} for ${consumer.bundleRelativePath}: ` +
        `multiple portable runtime search paths reach linkable libraries (${safeCandidatePaths(rpathTargets)}).`
      );
    }

    const target = inventoryTargetOrResolutionError({ dependency, consumer, candidates });
    return {
      disposition: "inventoryRpath",
      dependency,
      replacement: relativeLoaderPath(consumer.canonicalPath, target.canonicalPath),
      target: target.canonicalPath
    };
  }

  if (dependency.startsWith("/")) {
    const target = inventoryTargetOrResolutionError({ dependency, consumer, candidates });
    return {
      disposition: "externalInventory",
      dependency,
      replacement: relativeLoaderPath(consumer.canonicalPath, target.canonicalPath),
      target: target.canonicalPath
    };
  }

  throw dependencyResolutionError(
    "unsafe",
    `Bundled Mach-O contains an unsafe relative dependency: ${consumer.bundleRelativePath}.`
  );
}

export function auditMachODependencyGraph({ appRoot, candidates }) {
  const candidatesByCanonicalPath = new Map(
    candidates.map((candidate) => [candidate.canonicalPath, candidate])
  );
  const counts = {
    system: 0,
    loaderPath: 0,
    executablePath: 0,
    rpath: 0,
    inventoryRpath: 0,
    externalInventory: 0,
    ambiguous: 0,
    missing: 0,
    unsafe: 0
  };
  const issues = [];
  const filePlans = [];

  for (const consumer of candidates) {
    const needsExecutableDirectory = [
      ...consumer.originalSearchPaths,
      ...consumer.originalDependencies
    ].some((value) => dyldTokenSuffix(value, "@executable_path") !== null);
    const executableDirectory = needsExecutableDirectory
      ? executableDirectoryForFile(consumer.canonicalPath, appRoot)
      : null;
    let resolvedSearchPaths;
    try {
      resolvedSearchPaths = originalPortableRpaths({ appRoot, consumer, executableDirectory });
    } catch (error) {
      const kind = error.dependencyResolutionKind || "unsafe";
      counts[kind] += 1;
      issues.push(Object.freeze({
        kind,
        consumerRelativePath: consumer.bundleRelativePath,
        dependencyBasename: null,
        message: error.message
      }));
      filePlans.push(Object.freeze({ consumer, dispositions: Object.freeze([]), rewrites: Object.freeze([]) }));
      continue;
    }

    const dispositions = [];
    const rewrites = [];
    let skippedInstallName = false;
    for (const dependency of consumer.originalDependencies) {
      if (!skippedInstallName && consumer.originalInstallName && dependency === consumer.originalInstallName) {
        skippedInstallName = true;
        continue;
      }
      try {
        const disposition = Object.freeze(planCandidateDependency({
          appRoot,
          consumer,
          executableDirectory,
          resolvedSearchPaths,
          dependency,
          candidates,
          candidatesByCanonicalPath
        }));
        counts[disposition.disposition] += 1;
        dispositions.push(disposition);
        if (disposition.replacement) {
          rewrites.push(Object.freeze({
            dependency: disposition.dependency,
            replacement: disposition.replacement,
            target: disposition.target
          }));
        }
      } catch (error) {
        const kind = error.dependencyResolutionKind || "unsafe";
        counts[kind] += 1;
        issues.push(Object.freeze({
          kind,
          consumerRelativePath: consumer.bundleRelativePath,
          dependencyBasename: path.posix.basename(dependency),
          message: error.message
        }));
      }
    }
    filePlans.push(Object.freeze({
      consumer,
      dispositions: Object.freeze(dispositions),
      rewrites: Object.freeze(rewrites)
    }));
  }

  return Object.freeze({
    counts: Object.freeze(counts),
    issues: Object.freeze(issues),
    filePlans: Object.freeze(filePlans)
  });
}

export function planMachODependencyGraph(options) {
  const audit = auditMachODependencyGraph(options);
  if (audit.issues.length) {
    const issueCounts = ["ambiguous", "missing", "unsafe"]
      .map((kind) => `${kind}=${audit.counts[kind]}`)
      .join(", ");
    const examples = audit.issues.slice(0, 5).map((issue) => issue.message).join("\n");
    throw new Error(`Bundled Mach-O dependency planning failed (${issueCounts}).\n${examples}`);
  }
  return audit;
}

function validateMachODependencyGraph(appRoot, codeFiles) {
  const bundledMachOIdentities = new Map(
    codeFiles.map((filePath) => {
      const canonicalPath = realpathSync(filePath);
      return [canonicalPath, dylibInstallName(canonicalPath)];
    })
  );
  for (const filePath of codeFiles) {
    const executableDirectory = executableDirectoryForFile(filePath, appRoot);
    const searchPaths = rpaths(filePath);
    resolvePortableRpaths({ appRoot, filePath, executableDirectory, searchPaths });

    const installName = dylibInstallName(filePath);
    let skippedInstallName = false;
    for (const dependency of linkedLibraries(filePath)) {
      if (!skippedInstallName && installName && dependency === installName) {
        skippedInstallName = true;
        continue;
      }
      const targets = resolveBundledDependency({
        appRoot,
        filePath,
        executableDirectory,
        dependency,
        searchPaths
      });
      for (const target of targets) {
        if (!bundledMachOIdentities.has(target)) {
          throw new Error(`Mach-O dependency resolves to a non-Mach-O bundled file: ${filePath} -> ${dependency} -> ${target}`);
        }
        if (!bundledMachOIdentities.get(target)) {
          throw new Error(`Mach-O dependency resolves to a non-linkable bundled executable: ${filePath} -> ${dependency} -> ${target}`);
        }
      }
    }
  }
}

export function makeMachOPortable({ filePath, candidates, dependencyPlan }) {
  const canonicalFilePath = realpathSync(filePath);
  const currentCandidate = candidates.find((candidate) => candidate.canonicalPath === canonicalFilePath);
  if (!currentCandidate) {
    throw new Error("Bundled Mach-O is missing from the original candidate inventory.");
  }
  if (!dependencyPlan || dependencyPlan.consumer !== currentCandidate) {
    throw new Error("Bundled Mach-O is missing its immutable dependency plan.");
  }
  const safeFilePath = currentCandidate.bundleRelativePath;
  const architectures = run("lipo", ["-archs", filePath]).trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Bundled Mach-O must be arm64-only: ${safeFilePath} (${architectures.join(", ") || "unknown"})`);
  }

  const installName = dylibInstallName(filePath);
  if (installName && !installName.startsWith("@") && !isAllowedSystemPath(installName)) {
    run("install_name_tool", ["-id", `@rpath/${path.basename(filePath)}`, filePath]);
  }

  for (const rewrite of dependencyPlan.rewrites) {
    run("install_name_tool", [
      "-change",
      rewrite.dependency,
      rewrite.replacement,
      filePath
    ]);
  }

  for (const rpath of rpaths(filePath)) {
    const isPortable = rpath.startsWith("@loader_path") || rpath.startsWith("@executable_path");
    if (!isPortable) {
      throw new Error(`Bundled Mach-O has an unsafe runtime search path: ${safeFilePath}.`);
    }
  }
}

function signCode(filePath, identity) {
  runTimestampedCodesign(["--force", "--timestamp", "--options", "runtime", "--sign", identity, filePath]);
}

function summarizeDirectory(directoryPath) {
  let fileCount = 0;
  let totalBytes = 0;
  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        fileCount += 1;
        totalBytes += statSync(entryPath).size;
      }
    }
  }
  walk(directoryPath);
  return { fileCount, totalBytes };
}

function refreshRuntimeManifest(runtimeRoot, pythonRuntimeRoot) {
  const manifestPath = path.join(runtimeRoot, "bundle-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.python_runtime_summary = summarizeDirectory(pythonRuntimeRoot);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function main() {
  const appPath =
    process.argv[2] ||
    path.join(repoRoot, "src-tauri", "target", "release", "bundle", "macos", "Transcript Research Studio.app");
  const identity = process.env.APPLE_SIGNING_IDENTITY;

  if (process.platform !== "darwin") {
    throw new Error("sign_macos_bundle can only run on macOS.");
  }
  if (!identity) {
    throw new Error("APPLE_SIGNING_IDENTITY is required.");
  }
  if (!existsSync(appPath)) {
    throw new Error(`App bundle is missing: ${appPath}`);
  }

  assertSafeBundleSymlinks(appPath);
  const files = findFiles(appPath);
  removeNotarizationHostileBuildArtifacts(appPath, files);

  const pythonRuntimeRoot = path.join(appPath, "Contents", "Resources", "gen", "runtime", "python-runtime");
  let codeFiles = machOFiles(appPath);
  const candidates = inventoryBundledMachOCandidates(appPath, codeFiles);
  const dependencyPlan = planMachODependencyGraph({ appRoot: appPath, candidates });
  const plansByCanonicalPath = new Map(
    dependencyPlan.filePlans.map((filePlan) => [filePlan.consumer.canonicalPath, filePlan])
  );
  for (const filePath of codeFiles) {
    makeMachOPortable({
      filePath,
      candidates,
      dependencyPlan: plansByCanonicalPath.get(realpathSync(filePath))
    });
  }

  codeFiles = machOFiles(appPath);
  validateMachODependencyGraph(appPath, codeFiles);
  for (const filePath of codeFiles) {
    signCode(filePath, identity);
  }

  refreshRuntimeManifest(path.dirname(pythonRuntimeRoot), pythonRuntimeRoot);
  runTimestampedCodesign(["--force", "--timestamp", "--options", "runtime", "--sign", identity, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "pipe" });

  console.log(`Signed ${codeFiles.length} nested Mach-O files and verified ${appPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
