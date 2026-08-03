import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { PackageManifest } from "../src/model/package-manifest.ts";
import { createHash } from "node:crypto";

import {
  assertPackageManifestDeployPreflight,
  assertPackageManifestEvidenceIntegrity,
} from "../src/stages/deploy/package-manifest-preflight.ts";

const gitSha = "0123456789abcdef0123456789abcdef01234567";

function plannedManifest(): PackageManifest {
  return {
    schema_version: "rush-delivery-package-manifest/v2",
    artifacts: {
      image: {
        image: "example/image",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        source_revision: gitSha,
        status: "planned",
      },
    },
  };
}

function publishedManifest(contents: string): PackageManifest {
  const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const reference = `registry.example/product/image@${imageDigest}`;

  return {
    schema_version: "rush-delivery-package-manifest/v2",
    artifacts: {
      image: {
        digest: imageDigest,
        evidence: {
          provenance: {
            digest,
            format: "slsa-provenance-v1",
            path: ".dagger/runtime/evidence/image/provenance.json",
            subject_digest: imageDigest,
          },
          sbom: {
            digest,
            format: "spdx-json",
            path: ".dagger/runtime/evidence/image/sbom.spdx.json",
            subject_digest: imageDigest,
          },
          scan: {
            digest,
            path: ".dagger/runtime/evidence/image/scan.json",
            policy: ["critical"],
            result: "passed",
            scanner: "grype-test",
          },
          signature: {
            kind: "sigstore",
            reference,
            verified: true,
          },
        },
        image: "image",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        reference,
        repository: "registry.example/product/image",
        source_revision: gitSha,
        status: "published",
      },
    },
  };
}

test("accepts planned OCI artifacts only for dry-run deploy", () => {
  assert.doesNotThrow(() =>
    assertPackageManifestDeployPreflight(
      ["image"],
      plannedManifest(),
      gitSha,
      true,
    ),
  );

  assert.throws(
    () =>
      assertPackageManifestDeployPreflight(
        ["image"],
        plannedManifest(),
        gitSha,
        false,
      ),
    /requires a published OCI artifact/,
  );
});

test("rejects OCI source mismatches before deployment", () => {
  assert.throws(
    () =>
      assertPackageManifestDeployPreflight(
        ["image"],
        plannedManifest(),
        "abcdef0123456789abcdef0123456789abcdef01",
        true,
      ),
    /does not match deploy gitSha/,
  );
});

test("preserves legacy filesystem preflight behavior", () => {
  assert.doesNotThrow(() =>
    assertPackageManifestDeployPreflight(
      ["webapp"],
      {
        artifacts: {
          webapp: {
            deploy_path: "apps/webapp/dist",
            kind: "directory",
            path: "apps/webapp/dist",
          },
        },
      },
      "legacy-short-sha",
      false,
    ),
  );
});

test("verifies every local OCI evidence document before deploy", async () => {
  const contents = '{"verified":true}\n';

  await assert.doesNotReject(() =>
    assertPackageManifestEvidenceIntegrity(
      ["image"],
      publishedManifest(contents),
      async () => contents,
    ),
  );
});

test("rejects tampered OCI evidence before deploy", async () => {
  await assert.rejects(
    () =>
      assertPackageManifestEvidenceIntegrity(
        ["image"],
        publishedManifest('{"verified":true}\n'),
        async () => '{"tampered":true}\n',
      ),
    /evidence digest.*does not match/,
  );
});
