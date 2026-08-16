import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetScript = process.argv[2] || "release:build";
const allowedScripts = new Set(["release:build", "release:macos"]);

if (!allowedScripts.has(targetScript)) {
  throw new Error(`Unsupported final release target: ${targetScript}`);
}
if (process.env.TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD === "1") {
  throw new Error(
    "Final release builds refuse TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD=1. Unset it before building final assets."
  );
}

const finalEnvironment = { ...process.env };
delete finalEnvironment.TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env: finalEnvironment
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, [path.join(__dirname, "verify_release_identity.mjs")]);

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? { command: process.execPath, args: [npmExecPath, "run", targetScript] }
  : process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `npm run ${targetScript}`] }
    : { command: "npm", args: ["run", targetScript] };
run(npmCommand.command, npmCommand.args);
