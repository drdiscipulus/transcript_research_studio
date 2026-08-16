import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeEngineCompatibility } from "./node_engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const nodeRuntime = assertNodeEngineCompatibility(manifest, process.version);
const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf-8"));

for (const [packagePath, locked] of Object.entries(lock.packages || {})) {
  if (!packagePath || locked.link || !locked.version) {
    continue;
  }
  const manifestPath = path.join(repoRoot, packagePath, "package.json");
  if (!existsSync(manifestPath)) {
    if (locked.optional) {
      continue;
    }
    throw new Error(`Locked Node package is missing from node_modules: ${packagePath}`);
  }
  const installed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (installed.version !== locked.version) {
    throw new Error(`${packagePath} is ${installed.version}, but package-lock.json requires ${locked.version}.`);
  }
}

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? { command: process.execPath, args: [npmExecPath, "ls", "--all", "--json"] }
  : process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm ls --all --json"] }
    : { command: "npm", args: ["ls", "--all", "--json"] };
const tree = spawnSync(npmCommand.command, npmCommand.args, {
  cwd: repoRoot,
  encoding: "utf-8",
  maxBuffer: 64 * 1024 * 1024,
  shell: false
});
if (tree.error) {
  throw tree.error;
}
if (tree.status !== 0) {
  throw new Error(`node_modules is not a clean package-lock installation. Run npm ci.\n${tree.stderr || tree.stdout}`);
}

process.stdout.write(
  `Node ${nodeRuntime.detectedVersion} satisfies package.json engines.node (${nodeRuntime.requiredEngine}), and the installation matches package-lock.json.\n`
);
