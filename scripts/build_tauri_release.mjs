import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const nodeInstall = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "verify_node_install.mjs")], {
  cwd: repoRoot,
  encoding: "utf-8",
  shell: false
});
if (nodeInstall.error) {
  throw nodeInstall.error;
}
if (nodeInstall.status !== 0) {
  throw new Error(nodeInstall.stderr || nodeInstall.stdout || "Node dependency verification failed.");
}

const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: repoRoot,
  encoding: "utf-8",
  shell: false
});
if (status.error) {
  throw status.error;
}
if (status.status !== 0) {
  throw new Error(status.stderr || "Could not verify the Git working tree.");
}
if (status.stdout.trim()) {
  throw new Error("Release builds require a clean Git working tree. Commit or remove all changes first.");
}

const buildArgs = process.platform === "win32"
  ? ["build", "--no-bundle"]
  : ["build", "--bundles", "app"];

const result = spawnSync("tauri", buildArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
