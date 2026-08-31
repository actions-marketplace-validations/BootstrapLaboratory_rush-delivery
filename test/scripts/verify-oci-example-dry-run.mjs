import { readFile } from "node:fs/promises";
import path from "node:path";

const [outputDirectory, expectedGitSha] = process.argv.slice(2);

if (!outputDirectory || !expectedGitSha) {
  throw new Error(
    "Usage: verify-oci-example-dry-run.mjs OUTPUT_DIRECTORY EXPECTED_GIT_SHA",
  );
}

const manifest = JSON.parse(
  await readFile(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
    "utf8",
  ),
);
const artifact = manifest.artifacts?.["control-plane-api"];

if (manifest.schema_version !== "rush-delivery-package-manifest/v2") {
  throw new Error("Dry-run manifest does not use the v2 schema.");
}
if (Object.keys(manifest.artifacts ?? {}).length !== 1) {
  throw new Error("Dry-run manifest must contain exactly one artifact.");
}
if (artifact?.kind !== "oci_image" || artifact.status !== "planned") {
  throw new Error("Dry-run artifact must be a planned OCI image.");
}
if (artifact.image !== "control-plane-api") {
  throw new Error("Dry-run artifact image name does not match the example.");
}
if (artifact.source_revision !== expectedGitSha) {
  throw new Error("Dry-run artifact source revision does not match.");
}
if (JSON.stringify(artifact.platforms) !== '["linux/amd64"]') {
  throw new Error("Dry-run artifact platform does not match the example.");
}

for (const liveOnlyField of ["digest", "evidence", "reference", "repository"]) {
  if (liveOnlyField in artifact) {
    throw new Error(
      `Provider-off dry run must not fabricate ${liveOnlyField}.`,
    );
  }
}

process.stdout.write("Canonical OCI example provider-off dry run verified.\n");
