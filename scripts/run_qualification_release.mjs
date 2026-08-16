import { spawnSync } from "node:child_process";

const targetScript = process.argv[2] || "release:build";
const allowedScripts = new Set(["release:build", "release:macos"]);
if (!allowedScripts.has(targetScript)) {
  throw new Error(`Unsupported qualification release target: ${targetScript}`);
}

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? { command: process.execPath, args: [npmExecPath, "run", targetScript] }
  : process.platform === "win32"
    ? { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `npm run ${targetScript}`] }
    : { command: "npm", args: ["run", targetScript] };
const result = spawnSync(npmCommand.command, npmCommand.args, {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, TRANSCRIPT_RESEARCH_STUDIO_QUALIFICATION_BUILD: "1" }
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
