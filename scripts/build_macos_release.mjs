import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error("release:macos can only run on macOS.");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

for (const [command, args] of [
  ["node", ["scripts/preflight_macos_release.mjs"]],
  ["npm", ["run", "tauri:build"]],
  ["npm", ["run", "macos:sign"]],
  ["npm", ["run", "macos:notarize"]],
  ["npm", ["run", "export:artifacts"]],
  ["npm", ["run", "package:artifacts"]],
  ["npm", ["run", "release:verify"]]
]) {
  run(command, args);
}
