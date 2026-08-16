const NODE_ENGINE_PATTERN = /^(\d+)\.x$/u;
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/u;

function detectedLabel(detectedVersion) {
  return typeof detectedVersion === "string" && detectedVersion.trim()
    ? detectedVersion
    : "an invalid version value";
}

export function assertNodeEngineCompatibility(manifest, detectedVersion) {
  const requiredEngine = manifest?.engines?.node;
  const engineMatch = typeof requiredEngine === "string"
    ? requiredEngine.match(NODE_ENGINE_PATTERN)
    : null;

  if (!engineMatch) {
    throw new Error(
      `package.json must declare the required Node engine as "<major>.x"; detected ${detectedLabel(detectedVersion)}.`
    );
  }

  const versionMatch = typeof detectedVersion === "string"
    ? detectedVersion.match(NODE_VERSION_PATTERN)
    : null;
  if (!versionMatch || versionMatch[1] !== engineMatch[1]) {
    throw new Error(`Node ${requiredEngine} is required; detected ${detectedLabel(detectedVersion)}.`);
  }

  return {
    requiredEngine,
    detectedVersion
  };
}
