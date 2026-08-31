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

test("rejects inherited object keys when the selected artifact is absent", () => {
  assert.throws(
    () =>
      assertPackageManifestDeployPreflight(
        ["constructor"],
        { artifacts: {} },
        "legacy-short-sha",
        false,
      ),
    /does not define artifact for target "constructor"/,
  );
});

test("verifies every local OCI evidence document before deploy", async () => {
  const contents = '{"verified":true}\n';
  const paths: string[] = [];

  await assert.doesNotReject(() =>
    assertPackageManifestEvidenceIntegrity(
      ["image"],
      publishedManifest(contents),
      async (path) => {
        paths.push(path);
        return contents;
      },
    ),
  );
  assert.deepStrictEqual(paths, [
    ".dagger/runtime/evidence/image/provenance.json",
    ".dagger/runtime/evidence/image/sbom.spdx.json",
    ".dagger/runtime/evidence/image/scan.json",
  ]);
});

test("rejects tampered OCI evidence before deploy", async () => {
  await assert.rejects(
    () =>
      assertPackageManifestEvidenceIntegrity(
        ["image"],
        publishedManifest('{"verified":true}\n'),
        async () => '{"tampered":true}\n',
      ),
    /evidence hash.*does not match manifest digest/,
  );
});

test("reports missing evidence by target, kind, and path", async () => {
  const contents = '{"verified":true}\n';

  await assert.rejects(
    () =>
      assertPackageManifestEvidenceIntegrity(
        ["image"],
        publishedManifest(contents),
        async (path) => {
          if (path.endsWith("scan.json")) {
            throw new Error("not found");
          }

          return contents;
        },
      ),
    /scan evidence file for target "image" is missing or unreadable at "\.dagger\/runtime\/evidence\/image\/scan\.json"/,
  );
});

test("filesystem artifacts in a mixed manifest do not read OCI evidence", async () => {
  const contents = '{"verified":true}\n';
  const manifest = publishedManifest(contents);
  manifest.artifacts.filesystem = {
    deploy_path: "apps/filesystem/dist",
    kind: "directory",
    path: "apps/filesystem/dist",
  };
  const paths: string[] = [];

  await assertPackageManifestEvidenceIntegrity(
    ["filesystem", "image"],
    manifest,
    async (path) => {
      paths.push(path);
      return contents;
    },
  );

  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.includes("/evidence/image/")));
});

test("validates manifest trust invariants before reading evidence", async () => {
  const contents = '{"verified":true}\n';
  const invalidCases: Array<{
    expected: RegExp;
    mutate: (manifest: PackageManifest) => PackageManifest;
  }> = [
    {
      expected:
        /sbom path must stay inside "\.dagger\/runtime\/evidence\/image\/"/,
      mutate: (manifest) => {
        const artifact = manifest.artifacts.image;
        assert.equal(artifact.kind, "oci_image");
        assert.equal(artifact.status, "published");
        artifact.evidence.sbom.path =
          ".dagger/runtime/evidence/other/sbom.spdx.json";
        return manifest;
      },
    },
    {
      expected: /provenance path must stay inside/,
      mutate: (manifest) => {
        const artifact = manifest.artifacts.image;
        assert.equal(artifact.kind, "oci_image");
        assert.equal(artifact.status, "published");
        artifact.evidence.provenance.path =
          ".dagger/runtime/evidence/image/../other/provenance.json";
        return manifest;
      },
    },
    {
      expected: /reference must equal repository@digest/,
      mutate: (manifest) => {
        const artifact = manifest.artifacts.image;
        assert.equal(artifact.kind, "oci_image");
        assert.equal(artifact.status, "published");
        artifact.reference = `${artifact.repository}:latest`;
        return manifest;
      },
    },
    {
      expected: /signature evidence verified must be true/,
      mutate: (manifest) => {
        const artifact = manifest.artifacts.image;
        assert.equal(artifact.kind, "oci_image");
        assert.equal(artifact.status, "published");
        (artifact.evidence.signature as { verified: boolean }).verified = false;
        return manifest;
      },
    },
    {
      expected: /evidence sbom subject_digest must match the image digest/,
      mutate: (manifest) => {
        const artifact = manifest.artifacts.image;
        assert.equal(artifact.kind, "oci_image");
        assert.equal(artifact.status, "published");
        artifact.evidence.sbom.subject_digest = `sha256:${"b".repeat(64)}`;
        return manifest;
      },
    },
  ];

  for (const { expected, mutate } of invalidCases) {
    let readCount = 0;
    const manifest = mutate(structuredClone(publishedManifest(contents)));

    await assert.rejects(
      () =>
        assertPackageManifestEvidenceIntegrity(
          ["image"],
          manifest,
          async () => {
            readCount += 1;
            return contents;
          },
        ),
      expected,
    );
    assert.equal(readCount, 0);
  }
});

test("rejects unsafe OCI target keys before resolving evidence paths", () => {
  const manifest = publishedManifest('{"verified":true}\n');
  const artifact = manifest.artifacts.image;
  const unsafeManifest = {
    artifacts: {
      "..": artifact,
    },
    schema_version: "rush-delivery-package-manifest/v2",
  } as PackageManifest;

  assert.throws(
    () =>
      assertPackageManifestDeployPreflight(
        [".."],
        unsafeManifest,
        gitSha,
        false,
      ),
    /target "\.\." must be a safe evidence path segment/,
  );
});
