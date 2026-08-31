import * as assert from "node:assert/strict";
import { test } from "node:test";

import type {
  FilesystemPackageManifestArtifact,
  PlannedOciImagePackageManifestArtifact,
  PublishedOciImagePackageManifestArtifact,
} from "../src/model/package-manifest.ts";
import {
  buildArtifactRuntimeHandoff,
  buildSuccessfulDeployTargetResult,
} from "../src/stages/deploy/artifact-handoff.ts";

const sourceRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const evidenceDigest = `sha256:${"c".repeat(64)}`;
const repository = "registry.example/product/control-plane";
const reference = `${repository}@${imageDigest}`;

const plannedArtifact: PlannedOciImagePackageManifestArtifact = {
  image: "control-plane",
  kind: "oci_image",
  platforms: ["linux/amd64"],
  repository,
  source_revision: sourceRevision,
  status: "planned",
};

const publishedArtifact: PublishedOciImagePackageManifestArtifact = {
  digest: imageDigest,
  evidence: {
    provenance: {
      digest: evidenceDigest,
      format: "slsa-provenance-v1",
      path: ".dagger/runtime/evidence/control-plane/provenance.json",
      subject_digest: imageDigest,
    },
    sbom: {
      digest: evidenceDigest,
      format: "spdx-json",
      path: ".dagger/runtime/evidence/control-plane/sbom.spdx.json",
      subject_digest: imageDigest,
    },
    scan: {
      digest: evidenceDigest,
      path: ".dagger/runtime/evidence/control-plane/scan.json",
      policy: ["critical", "high"],
      result: "passed",
      scanner: "grype-test",
    },
    signature: {
      kind: "sigstore",
      reference,
      verified: true,
    },
  },
  image: "control-plane",
  kind: "oci_image",
  platforms: ["linux/amd64"],
  reference,
  repository,
  source_revision: sourceRevision,
  status: "published",
};

test("planned OCI handoff has intent but no published identity or evidence", () => {
  assert.deepStrictEqual(
    buildArtifactRuntimeHandoff("control-plane", plannedArtifact),
    {
      environment: {
        ARTIFACT_IMAGE_NAME: "control-plane",
        ARTIFACT_IMAGE_PLATFORMS_JSON: '["linux/amd64"]',
        ARTIFACT_IMAGE_REPOSITORY: repository,
        ARTIFACT_KIND: "oci_image",
        ARTIFACT_SOURCE_REVISION: sourceRevision,
      },
    },
  );
});

test("published OCI handoff exposes only immutable identity and owned evidence", () => {
  assert.deepStrictEqual(
    buildArtifactRuntimeHandoff("control-plane", publishedArtifact),
    {
      environment: {
        ARTIFACT_EVIDENCE_DIR:
          "/workspace/.dagger/runtime/evidence/control-plane",
        ARTIFACT_IMAGE_DIGEST: imageDigest,
        ARTIFACT_IMAGE_NAME: "control-plane",
        ARTIFACT_IMAGE_PLATFORMS_JSON: '["linux/amd64"]',
        ARTIFACT_IMAGE_REFERENCE: reference,
        ARTIFACT_IMAGE_REPOSITORY: repository,
        ARTIFACT_KIND: "oci_image",
        ARTIFACT_SOURCE_REVISION: sourceRevision,
      },
    },
  );
});

test("filesystem handoff preserves the legacy artifact path environment", () => {
  const artifact: FilesystemPackageManifestArtifact = {
    deploy_path: "apps/web/dist",
    kind: "directory",
    path: "apps/web/dist",
  };

  assert.deepStrictEqual(buildArtifactRuntimeHandoff("web", artifact), {
    artifactPath: "/workspace/apps/web/dist",
    environment: {
      ARTIFACT_PATH: "/workspace/apps/web/dist",
    },
  });
});

test("OCI deploy results never fabricate filesystem paths", () => {
  assert.deepStrictEqual(
    buildSuccessfulDeployTargetResult(
      plannedArtifact,
      undefined,
      "planned\n",
      "control-plane",
      1,
    ),
    {
      artifactImage: "control-plane",
      artifactKind: "oci_image",
      output: "planned\n",
      status: "success",
      target: "control-plane",
      wave: 1,
    },
  );
  assert.deepStrictEqual(
    buildSuccessfulDeployTargetResult(
      publishedArtifact,
      undefined,
      "deployed\n",
      "control-plane",
      2,
    ),
    {
      artifactImage: "control-plane",
      artifactKind: "oci_image",
      artifactReference: reference,
      output: "deployed\n",
      status: "success",
      target: "control-plane",
      wave: 2,
    },
  );
});

test("filesystem deploy result shape remains unchanged", () => {
  const artifact: FilesystemPackageManifestArtifact = {
    deploy_path: "deploy/server",
    kind: "archive",
    path: "deploy-target-server.tgz",
  };

  assert.deepStrictEqual(
    buildSuccessfulDeployTargetResult(
      artifact,
      "/workspace/deploy/server",
      "done\n",
      "server",
      1,
    ),
    {
      artifactPath: "/workspace/deploy/server",
      output: "done\n",
      status: "success",
      target: "server",
      wave: 1,
    },
  );
});
