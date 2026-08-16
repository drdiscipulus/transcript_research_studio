import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const appPath =
  process.argv[2] ||
  path.join(repoRoot, "src-tauri", "target", "release", "bundle", "macos", "Transcript Research Studio.app");
const keychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE || "transcript-research-notary";

if (process.platform !== "darwin") {
  throw new Error("notarize_macos_bundle can only run on macOS.");
}
if (!existsSync(appPath)) {
  throw new Error(`App bundle is missing: ${appPath}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "transcript-research-notary-"));
const notaryZip = path.join(tempRoot, "Transcript Research Studio.app.zip");

try {
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, notaryZip]);
  run("xcrun", ["notarytool", "submit", notaryZip, "--keychain-profile", keychainProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  console.log(`Notarized and stapled ${appPath}`);
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
