import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const expectedTag = `v${packageJson.version}`;

if (process.env.TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD === "1") {
  throw new Error(
    "Final release identity verification refuses TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD=1. Unset it before building final assets."
  );
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8", shell: false });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

const status = git(["status", "--porcelain", "--untracked-files=all"]);
if (status) {
  throw new Error("Final release builds require a clean Git working tree.");
}

// ^{tag} deliberately rejects a lightweight tag: release identity must be an
// annotated tag whose peeled commit is exactly the checked-out source.
git(["rev-parse", "--verify", `refs/tags/${expectedTag}^{tag}`]);
const head = git(["rev-parse", "HEAD"]);
const taggedCommit = git(["rev-list", "-n", "1", expectedTag]);
if (head !== taggedCommit) {
  throw new Error(`${expectedTag} points to ${taggedCommit}, but HEAD is ${head}.`);
}

process.stdout.write(`Release identity verified: ${expectedTag} at ${head}.\n`);
