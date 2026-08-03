import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [outputDirectory, expectedGitSha, ...sentinels] = process.argv.slice(2);

if (!outputDirectory || !expectedGitSha) {
  throw new Error(
    "Usage: verify-oci-acceptance.mjs OUTPUT_DIRECTORY EXPECTED_GIT_SHA [SENTINEL...]",
  );
}

const manifestPath = path.join(
  outputDirectory,
  ".dagger/runtime/package-manifest.json",
);
const manifestSource = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestSource);
const artifact = manifest.artifacts?.["control-plane-api"];

if (manifest.schema_version !== "rush-delivery-package-manifest/v2") {
  throw new Error("Acceptance manifest does not use the v2 schema.");
}
if (Object.keys(manifest.artifacts ?? {}).length !== 1) {
  throw new Error(
    "Acceptance manifest must contain exactly one image artifact.",
  );
}
if (artifact?.kind !== "oci_image" || artifact.status !== "published") {
  throw new Error("Acceptance image was not marked published.");
}
if (artifact.source_revision !== expectedGitSha) {
  throw new Error("Acceptance image source revision does not match.");
}
if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
  throw new Error("Acceptance image digest is not canonical.");
}
if (artifact.reference !== `${artifact.repository}@${artifact.digest}`) {
  throw new Error("Acceptance image reference is not repository@digest.");
}
if (artifact.reference.includes(":sha-")) {
  throw new Error("Acceptance manifest exposed a mutable navigation tag.");
}
if (artifact.evidence?.signature?.verified !== true) {
  throw new Error("Acceptance signature was not verified.");
}

for (const [name, evidence] of Object.entries({
  provenance: artifact.evidence.provenance,
  sbom: artifact.evidence.sbom,
  scan: artifact.evidence.scan,
})) {
  const evidencePath = path.join(outputDirectory, evidence.path);
  const contents = await readFile(evidencePath);
  const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;

  if (digest !== evidence.digest) {
    throw new Error(`${name} evidence digest does not match its local file.`);
  }

  for (const sentinel of sentinels) {
    if (sentinel && contents.includes(Buffer.from(sentinel))) {
      throw new Error(`${name} evidence contains a credential sentinel.`);
    }
  }
}

for (const sentinel of sentinels) {
  if (sentinel && manifestSource.includes(sentinel)) {
    throw new Error("Acceptance manifest contains a credential sentinel.");
  }
}

const sbom = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.sbom.path),
    "utf8",
  ),
);
const scan = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.scan.path),
    "utf8",
  ),
);
const provenance = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.provenance.path),
    "utf8",
  ),
);

if (sbom.spdxVersion !== "SPDX-2.3") {
  throw new Error("Acceptance SBOM is not SPDX 2.3 JSON.");
}
if (!Array.isArray(scan.matches)) {
  throw new Error("Acceptance scan is not a Grype JSON report.");
}
if (
  provenance.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit !==
  expectedGitSha
) {
  throw new Error("Acceptance provenance does not bind the source revision.");
}
if (!provenance.runDetails?.metadata?.invocationId?.endsWith(artifact.digest)) {
  throw new Error("Acceptance provenance does not bind the published digest.");
}

process.stdout.write(
  `OCI acceptance verified ${artifact.reference} with signed evidence.\n`,
);
