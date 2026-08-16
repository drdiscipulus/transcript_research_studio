import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";

const MACH_O_MAGICS = new Set([
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe"
]);

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function compareDirectoryEntries(left, right) {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function stagedRelativePath(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Staged runtime path escapes its owned root.");
  }
  return relative.split(path.sep).join("/");
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 16,
    shell: false
  });
  if (result.error) {
    throw new Error(`${command} could not be executed.`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
  return result.stdout.trim();
}

function hasMachOMagic(filePath) {
  const descriptor = openSync(filePath, "r");
  const header = Buffer.alloc(4);
  try {
    return readSync(descriptor, header, 0, header.length, 0) === header.length && MACH_O_MAGICS.has(header.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function regularFilesWithoutFollowingSymlinks(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  let rootStat;
  try {
    rootStat = lstatSync(absoluteRoot);
  } catch {
    throw new Error("Staged runtime root cannot be inspected.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Staged runtime root must be an ordinary directory.");
  }
  const files = [];

  function walk(currentPath) {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true }).sort(compareDirectoryEntries);
    } catch {
      const relativePath = currentPath === absoluteRoot ? "." : stagedRelativePath(absoluteRoot, currentPath);
      throw new Error(`Staged runtime directory cannot be read: ${relativePath}.`);
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  walk(absoluteRoot);
  return files;
}

export function assertStagedRuntimeSymlinks(runtimeRoot) {
  const absoluteRoot = path.resolve(runtimeRoot);
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = lstatSync(absoluteRoot);
    canonicalRoot = realpathSync(absoluteRoot);
  } catch {
    throw new Error("Staged runtime root cannot be inspected.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Staged runtime root must be an ordinary directory.");
  }

  function walk(currentPath) {
    let entries;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true }).sort(compareDirectoryEntries);
    } catch {
      const relativePath = currentPath === absoluteRoot ? "." : stagedRelativePath(absoluteRoot, currentPath);
      throw new Error(`Staged runtime directory cannot be read: ${relativePath}.`);
    }
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const relativePath = stagedRelativePath(absoluteRoot, entryPath);
        let target;
        try {
          target = readlinkSync(entryPath);
        } catch {
          throw new Error(`Staged runtime symlink cannot be read: ${relativePath}.`);
        }
        if (path.isAbsolute(target)) {
          throw new Error(`Staged runtime symlink has an absolute target: ${relativePath}.`);
        }
        const candidate = path.resolve(path.dirname(entryPath), target);
        if (!isPathWithin(absoluteRoot, candidate)) {
          throw new Error(`Staged runtime symlink escapes its owned root: ${relativePath}.`);
        }
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(entryPath);
        } catch {
          throw new Error(`Staged runtime symlink is dangling or cyclic: ${relativePath}.`);
        }
        if (!isPathWithin(canonicalRoot, canonicalTarget)) {
          throw new Error(`Staged runtime symlink resolves outside its owned root: ${relativePath}.`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(absoluteRoot);
}

function isMachOFile(filePath, relativePath, runCommand) {
  let hasMagic;
  try {
    hasMagic = hasMachOMagic(filePath);
  } catch {
    throw new Error(`Staged runtime file cannot be inspected: ${relativePath}.`);
  }
  if (!hasMagic) {
    return false;
  }
  return runCommand("file", ["-b", filePath]).includes("Mach-O");
}

export function parseLipoArchitectures(output, relativePath = "staged Mach-O") {
  const architectures = String(output || "").trim().split(/\s+/u).filter(Boolean);
  if (
    architectures.length === 0 ||
    architectures.some((architecture) => !/^[A-Za-z0-9_]+$/u.test(architecture)) ||
    new Set(architectures).size !== architectures.length
  ) {
    throw new Error(`Malformed architecture output for ${relativePath}.`);
  }
  return architectures;
}

function architecturesFor(filePath, relativePath, runCommand) {
  return parseLipoArchitectures(runCommand("lipo", ["-archs", filePath]), relativePath);
}

function assertExactlyArm64(architectures, relativePath) {
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`Staged Mach-O is not arm64-only: ${relativePath} (${architectures.join(", ")}).`);
  }
}

export function assertStagedRuntimeArm64Only(runtimeRoot, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  const machOPaths = [];
  for (const filePath of regularFilesWithoutFollowingSymlinks(runtimeRoot)) {
    const relativePath = stagedRelativePath(runtimeRoot, filePath);
    if (!isMachOFile(filePath, relativePath, runCommand)) {
      continue;
    }
    assertExactlyArm64(architecturesFor(filePath, relativePath, runCommand), relativePath);
    machOPaths.push(relativePath);
  }
  return machOPaths;
}

export function parseMachORuntimeSearchPaths(output, relativePath = "staged Mach-O") {
  const lines = String(output || "").split(/\r?\n/u);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") {
      continue;
    }
    let value = null;
    for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = lines[cursor].trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/u);
      if (match) {
        value = match[1];
        break;
      }
    }
    if (!value) {
      throw new Error(`Malformed runtime search path metadata for ${relativePath}.`);
    }
    values.push(value);
  }
  return values;
}

function isPortableRuntimeSearchPath(value) {
  return ["@loader_path", "@executable_path"].some(
    (token) => value === token || value.startsWith(`${token}/`)
  );
}

export function sanitizeStagedMacRuntimeSearchPaths(runtimeRoot, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  const temporaryPathFor = options.temporaryPathFor || ((filePath) =>
    path.join(path.dirname(filePath), `.${path.basename(filePath)}.rpath-${randomUUID()}`)
  );
  const sanitized = [];

  for (const filePath of regularFilesWithoutFollowingSymlinks(runtimeRoot)) {
    const relativePath = stagedRelativePath(runtimeRoot, filePath);
    if (!isMachOFile(filePath, relativePath, runCommand)) {
      continue;
    }
    const searchPaths = parseMachORuntimeSearchPaths(
      runCommand("otool", ["-l", filePath]),
      relativePath
    );
    const nonPortable = searchPaths.filter((value) => !isPortableRuntimeSearchPath(value));
    if (!nonPortable.length) {
      continue;
    }
    if (nonPortable.some((value) => !path.posix.isAbsolute(value))) {
      throw new Error(`Staged Mach-O has an unsafe runtime search path: ${relativePath}.`);
    }
    const absoluteSearchPaths = [...new Set(nonPortable)].sort();
    if (absoluteSearchPaths.length !== nonPortable.length) {
      throw new Error(`Staged Mach-O has duplicate non-portable runtime search paths: ${relativePath}.`);
    }

    const temporaryPath = temporaryPathFor(filePath);
    let temporaryPathExists = false;
    try {
      lstatSync(temporaryPath);
      temporaryPathExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Unsafe temporary runtime-search-path location for ${relativePath}.`);
      }
    }
    if (path.dirname(path.resolve(temporaryPath)) !== path.dirname(path.resolve(filePath)) || temporaryPathExists) {
      throw new Error(`Unsafe temporary runtime-search-path location for ${relativePath}.`);
    }
    let originalMode;
    try {
      originalMode = statSync(filePath).mode & 0o7777;
    } catch {
      throw new Error(`Staged Mach-O permissions cannot be inspected: ${relativePath}.`);
    }
    try {
      try {
        copyFileSync(filePath, temporaryPath);
        chmodSync(temporaryPath, originalMode);
      } catch {
        throw new Error(`Staged Mach-O cannot be copied for runtime-search-path sanitization: ${relativePath}.`);
      }
      for (const searchPath of absoluteSearchPaths) {
        runCommand("install_name_tool", ["-delete_rpath", searchPath, temporaryPath]);
      }
      // Wheel Mach-O files commonly arrive ad-hoc signed. install_name_tool
      // invalidates that integrity metadata, so restore only an ad-hoc seal for
      // the unsigned staged-runtime probe. The release signer later replaces it.
      runCommand("codesign", ["--force", "--sign", "-", temporaryPath]);
      runCommand("codesign", ["--verify", "--strict", temporaryPath]);
      const retainedSearchPaths = parseMachORuntimeSearchPaths(
        runCommand("otool", ["-l", temporaryPath]),
        relativePath
      );
      if (retainedSearchPaths.some((value) => !isPortableRuntimeSearchPath(value))) {
        throw new Error(`Staged Mach-O retains an unsafe runtime search path: ${relativePath}.`);
      }
      assertExactlyArm64(architecturesFor(temporaryPath, relativePath, runCommand), relativePath);
      try {
        renameSync(temporaryPath, filePath);
      } catch {
        throw new Error(`Staged Mach-O could not be atomically replaced: ${relativePath}.`);
      }
      sanitized.push(Object.freeze({
        relativePath,
        removedSearchPathCount: absoluteSearchPaths.length
      }));
    } finally {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        throw new Error(`Temporary runtime-search-path file could not be removed: ${relativePath}.`);
      }
    }
  }
  return sanitized;
}

export function normalizeStagedMacRuntime(runtimeRoot, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  const temporaryPathFor = options.temporaryPathFor || ((filePath) =>
    path.join(path.dirname(filePath), `.${path.basename(filePath)}.arm64-${randomUUID()}`)
  );
  const machOPathsBefore = [];
  const thinnedPaths = [];

  for (const filePath of regularFilesWithoutFollowingSymlinks(runtimeRoot)) {
    const relativePath = stagedRelativePath(runtimeRoot, filePath);
    if (!isMachOFile(filePath, relativePath, runCommand)) {
      continue;
    }
    machOPathsBefore.push(relativePath);
    const architectures = architecturesFor(filePath, relativePath, runCommand);
    if (architectures.length === 1 && architectures[0] === "arm64") {
      continue;
    }
    const architectureSet = new Set(architectures);
    if (!architectureSet.has("arm64")) {
      throw new Error(`Staged Mach-O lacks an arm64 slice: ${relativePath} (${architectures.join(", ")}).`);
    }
    if (architectures.length !== 2 || !architectureSet.has("x86_64")) {
      throw new Error(`Staged Mach-O has unsupported architectures: ${relativePath} (${architectures.join(", ")}).`);
    }

    const temporaryPath = temporaryPathFor(filePath);
    let temporaryPathExists = false;
    try {
      lstatSync(temporaryPath);
      temporaryPathExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Unsafe temporary Mach-O path for ${relativePath}.`);
      }
    }
    if (path.dirname(path.resolve(temporaryPath)) !== path.dirname(path.resolve(filePath)) || temporaryPathExists) {
      throw new Error(`Unsafe temporary Mach-O path for ${relativePath}.`);
    }
    let originalMode;
    try {
      originalMode = statSync(filePath).mode & 0o7777;
    } catch {
      throw new Error(`Staged Mach-O permissions cannot be inspected: ${relativePath}.`);
    }
    try {
      runCommand("lipo", ["-thin", "arm64", filePath, "-output", temporaryPath]);
      let temporaryStat;
      try {
        temporaryStat = lstatSync(temporaryPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          temporaryStat = null;
        } else {
          throw new Error(`Temporary Mach-O cannot be inspected: ${relativePath}.`);
        }
      }
      if (!temporaryStat || temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
        throw new Error(`lipo did not create an ordinary temporary file for ${relativePath}.`);
      }
      assertExactlyArm64(architecturesFor(temporaryPath, relativePath, runCommand), relativePath);
      try {
        chmodSync(temporaryPath, originalMode);
        renameSync(temporaryPath, filePath);
      } catch {
        throw new Error(`Staged Mach-O could not be atomically replaced: ${relativePath}.`);
      }
      assertExactlyArm64(architecturesFor(filePath, relativePath, runCommand), relativePath);
      thinnedPaths.push(relativePath);
    } finally {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        throw new Error(`Temporary Mach-O could not be removed: ${relativePath}.`);
      }
    }
  }

  const machOPaths = assertStagedRuntimeArm64Only(runtimeRoot, { runCommand });
  return { machOPaths, machOPathsBefore, thinnedPaths };
}

export function removeKnownIntelPythonHelpers(pythonRuntimeRoot, versionMajorMinor) {
  if (!/^\d+\.\d+$/u.test(versionMajorMinor)) {
    throw new Error(`Invalid Python version for Intel helper cleanup: ${versionMajorMinor}.`);
  }
  const binRoot = path.join(path.resolve(pythonRuntimeRoot), "bin");
  const helperNames = [`python${versionMajorMinor}-intel64`, "python3-intel64"];
  const removed = [];
  for (const helperName of helperNames) {
    const helperPath = path.join(binRoot, helperName);
    let helperStat;
    try {
      helperStat = lstatSync(helperPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw new Error(`Intel Python helper cannot be inspected: bin/${helperName}.`);
    }
    if (helperStat.isDirectory()) {
      throw new Error(`Intel Python helper must not be a directory: ${path.basename(helperPath)}.`);
    }
    try {
      rmSync(helperPath, { force: false });
    } catch {
      throw new Error(`Intel Python helper cannot be removed: bin/${helperName}.`);
    }
    removed.push(`bin/${path.basename(helperPath)}`);
  }
  return removed;
}

const OPTIONAL_MACOS_AUDIO_IO_FAMILIES = Object.freeze([
  Object.freeze({
    directorySegments: Object.freeze(["torio", "lib"]),
    prunedFilenames: Object.freeze([4, 5, 6].flatMap((version) => [
      `_torio_ffmpeg${version}.so`,
      `libtorio_ffmpeg${version}.so`
    ]).sort()),
    retainedNativeFilenames: Object.freeze([])
  }),
  Object.freeze({
    directorySegments: Object.freeze(["torchaudio", "lib"]),
    prunedFilenames: Object.freeze([
      "_torchaudio_sox.so",
      "libtorchaudio_sox.so"
    ]),
    retainedNativeFilenames: Object.freeze([
      "_torchaudio.so",
      "libtorchaudio.so"
    ])
  }),
  Object.freeze({
    directorySegments: Object.freeze(["torchcodec"]),
    prunedFilenames: Object.freeze([4, 5, 6, 7, 8].flatMap((version) => [
      `libtorchcodec_core${version}.dylib`,
      `libtorchcodec_custom_ops${version}.dylib`,
      `libtorchcodec_pybind_ops${version}.so`
    ]).sort()),
    retainedNativeFilenames: Object.freeze([])
  })
]);

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ordinaryOwnedDirectory(rootPath, relativeSegments) {
  const absoluteRoot = path.resolve(rootPath);
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = lstatSync(absoluteRoot);
    canonicalRoot = realpathSync(absoluteRoot);
  } catch {
    throw new Error("Staged runtime root cannot be inspected for optional backend pruning.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Staged runtime root must be an ordinary directory for optional backend pruning.");
  }

  let currentPath = absoluteRoot;
  for (const segment of relativeSegments) {
    currentPath = path.join(currentPath, segment);
    const relativePath = path.relative(absoluteRoot, currentPath).split(path.sep).join("/");
    let currentStat;
    try {
      currentStat = lstatSync(currentPath);
    } catch {
      throw new Error(`Required staged package directory cannot be inspected: ${relativePath}.`);
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error(`Required staged package path must be an ordinary directory: ${relativePath}.`);
    }
    let canonicalPath;
    try {
      canonicalPath = realpathSync(currentPath);
    } catch {
      throw new Error(`Required staged package directory cannot be resolved: ${relativePath}.`);
    }
    if (!isPathWithin(canonicalRoot, canonicalPath)) {
      throw new Error(`Required staged package directory escapes the runtime: ${relativePath}.`);
    }
  }
  return currentPath;
}

export function pruneUnusedMacosAudioIoBackends({ runtimeRoot, versionTag, profile }) {
  if (profile !== "macos-arm64-cpu") {
    return [];
  }
  if (!/^python3\.12$/u.test(versionTag)) {
    throw new Error(`Invalid Python runtime tag for optional backend pruning: ${versionTag}.`);
  }

  const sitePackagesSegments = ["lib", versionTag, "site-packages"];
  const sitePackagesRoot = ordinaryOwnedDirectory(runtimeRoot, sitePackagesSegments);
  const removalPlan = [];
  for (const family of OPTIONAL_MACOS_AUDIO_IO_FAMILIES) {
    const directorySegments = [...sitePackagesSegments, ...family.directorySegments];
    const familyDirectory = ordinaryOwnedDirectory(runtimeRoot, directorySegments);
    const canonicalFamilyDirectory = realpathSync(familyDirectory);
    const entries = readdirSync(familyDirectory, { withFileTypes: true }).sort(compareDirectoryEntries);
    const nativeEntries = entries.filter((entry) => /\.(?:dylib|so)(?:\.\d+)*$/u.test(entry.name));
    const nativeNames = nativeEntries.map((entry) => entry.name).sort();
    const stagedInventory = [...family.prunedFilenames, ...family.retainedNativeFilenames].sort();
    const prunedInventory = [...family.retainedNativeFilenames].sort();
    const isFreshLockedInventory = sameOrderedValues(nativeNames, stagedInventory);
    const isAlreadyPrunedInventory = sameOrderedValues(nativeNames, prunedInventory);
    if (!isFreshLockedInventory && !isAlreadyPrunedInventory) {
      const familyPath = family.directorySegments.join("/");
      throw new Error(`Optional native backend inventory does not match the locked layout: ${familyPath}.`);
    }
    if (isAlreadyPrunedInventory) {
      continue;
    }
    const prunedFilenameSet = new Set(family.prunedFilenames);
    for (const entry of nativeEntries.filter((candidate) => prunedFilenameSet.has(candidate.name))) {
      const candidatePath = path.join(familyDirectory, entry.name);
      const relativePath = stagedRelativePath(runtimeRoot, candidatePath);
      let candidateStat;
      try {
        candidateStat = lstatSync(candidatePath);
      } catch {
        throw new Error(`Optional native backend cannot be inspected: ${relativePath}.`);
      }
      if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
        throw new Error(`Optional native backend must be an ordinary staged file: ${relativePath}.`);
      }
      let canonicalCandidate;
      try {
        canonicalCandidate = realpathSync(candidatePath);
      } catch {
        throw new Error(`Optional native backend cannot be resolved: ${relativePath}.`);
      }
      if (
        !isPathWithin(realpathSync(sitePackagesRoot), canonicalCandidate) ||
        !isPathWithin(canonicalFamilyDirectory, canonicalCandidate)
      ) {
        throw new Error(`Optional native backend escapes its staged package directory: ${relativePath}.`);
      }
      removalPlan.push({ candidatePath, relativePath });
    }
  }
  const removedPaths = [];
  for (const item of removalPlan) {
    try {
      rmSync(item.candidatePath, { force: false });
    } catch {
      throw new Error(`Optional native backend cannot be removed: ${item.relativePath}.`);
    }
    removedPaths.push(item.relativePath);
  }
  return removedPaths;
}

export function assertStagedPythonEntrypoints(pythonRuntimeRoot, versionMajorMinor, options = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  const absoluteRoot = path.resolve(pythonRuntimeRoot);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(absoluteRoot);
  } catch {
    throw new Error("Staged Python runtime root cannot be resolved.");
  }
  const binRoot = path.join(absoluteRoot, "bin");
  const entryPointNames = [...new Set(["python", "python3", `python${versionMajorMinor}`])];
  const validated = [];
  for (const name of entryPointNames) {
    const entryPoint = path.join(binRoot, name);
    let entryStat;
    try {
      entryStat = lstatSync(entryPoint);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Staged Python runtime is missing bin/${name}.`);
      }
      throw new Error(`Staged Python entry point cannot be inspected: bin/${name}.`);
    }
    if (entryStat.isDirectory()) {
      throw new Error(`Staged Python entry point is not a file: bin/${name}.`);
    }
    if (entryStat.isSymbolicLink() && path.isAbsolute(readlinkSync(entryPoint))) {
      throw new Error(`Staged Python entry point uses an absolute symlink: bin/${name}.`);
    }
    let canonicalEntryPoint;
    let canonicalEntryPointStat;
    try {
      canonicalEntryPoint = realpathSync(entryPoint);
      canonicalEntryPointStat = statSync(canonicalEntryPoint);
    } catch {
      throw new Error(`Staged Python entry point is dangling or invalid: bin/${name}.`);
    }
    if (!isPathWithin(canonicalRoot, canonicalEntryPoint) || !canonicalEntryPointStat.isFile()) {
      throw new Error(`Staged Python entry point escapes the runtime: bin/${name}.`);
    }
    if (!isMachOFile(canonicalEntryPoint, `bin/${name}`, runCommand)) {
      throw new Error(`Staged Python entry point is not Mach-O: bin/${name}.`);
    }
    assertExactlyArm64(architecturesFor(canonicalEntryPoint, `bin/${name}`, runCommand), `bin/${name}`);
    validated.push(`bin/${name}`);
  }
  return validated;
}

export function recreateOwnedGeneratedRoot(targetPath, repositoryRoot) {
  const absoluteTarget = path.resolve(targetPath);
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const relativeParent = path.join("src-tauri", "gen");
  const absoluteExpectedParent = path.join(absoluteRepositoryRoot, relativeParent);
  const absoluteExpected = path.join(absoluteExpectedParent, "runtime");
  if (absoluteTarget !== absoluteExpected || absoluteExpected === path.parse(absoluteExpected).root) {
    throw new Error("Refusing to clean an unowned generated runtime root.");
  }

  let repositoryStat;
  let canonicalRepositoryRoot;
  try {
    repositoryStat = lstatSync(absoluteRepositoryRoot);
    canonicalRepositoryRoot = realpathSync(absoluteRepositoryRoot);
  } catch {
    throw new Error("Repository root cannot be inspected for generated-runtime cleanup.");
  }
  if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) {
    throw new Error("Repository root must be an ordinary directory for generated-runtime cleanup.");
  }

  let currentParent = absoluteRepositoryRoot;
  for (const segment of relativeParent.split(path.sep)) {
    currentParent = path.join(currentParent, segment);
    let segmentStat;
    try {
      segmentStat = lstatSync(currentParent);
    } catch {
      throw new Error("Generated-runtime parent cannot be inspected.");
    }
    if (segmentStat.isSymbolicLink() || !segmentStat.isDirectory()) {
      throw new Error("Generated-runtime parent must contain only ordinary directories.");
    }
  }
  let canonicalExpectedParent;
  try {
    canonicalExpectedParent = realpathSync(absoluteExpectedParent);
  } catch {
    throw new Error("Generated-runtime parent cannot be resolved.");
  }
  if (!isPathWithin(canonicalRepositoryRoot, canonicalExpectedParent)) {
    throw new Error("Generated-runtime parent resolves outside the repository.");
  }

  let targetStat = null;
  try {
    targetStat = lstatSync(absoluteTarget);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Generated runtime root cannot be inspected.");
    }
  }
  if (targetStat) {
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error("Generated runtime root must be an ordinary directory.");
    }
    let canonicalTarget;
    try {
      canonicalTarget = realpathSync(absoluteTarget);
    } catch {
      throw new Error("Generated runtime root cannot be resolved.");
    }
    if (canonicalTarget !== path.join(canonicalExpectedParent, "runtime")) {
      throw new Error("Generated runtime root resolves outside its owned repository path.");
    }
  }
  try {
    rmSync(absoluteTarget, { force: true, recursive: true });
    mkdirSync(absoluteTarget, { recursive: true });
  } catch {
    throw new Error("Generated runtime root could not be recreated.");
  }
  let recreatedStat;
  let canonicalRecreatedRoot;
  try {
    recreatedStat = lstatSync(absoluteTarget);
    canonicalRecreatedRoot = realpathSync(absoluteTarget);
  } catch {
    throw new Error("Recreated generated runtime root cannot be inspected.");
  }
  if (recreatedStat.isSymbolicLink() || canonicalRecreatedRoot !== path.join(canonicalExpectedParent, "runtime")) {
    throw new Error("Generated runtime root was not recreated at its owned repository path.");
  }
  return absoluteTarget;
}
