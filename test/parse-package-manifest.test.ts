import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPackageManifest,
  formatPackageManifest,
  parsePackageManifest,
  validatePackageManifest,
} from "../src/stages/package-stage/package-manifest.ts";

const imageDigest = `sha256:${"a".repeat(64)}`;
const documentDigest = `sha256:${"b".repeat(64)}`;
const scanDigest = `sha256:${"c".repeat(64)}`;
const sourceRevision = "d".repeat(40);
const repository = "registry.example.test/example/platform/server";
const reference = `${repository}@${imageDigest}`;

function publishedOciArtifact() {
  return {
    digest: imageDigest,
    evidence: {
      provenance: {
        digest: documentDigest,
        format: "slsa-provenance-v1",
        path: ".dagger/runtime/evidence/server/provenance.json",
        subject_digest: imageDigest,
      },
      sbom: {
        digest: documentDigest,
        format: "spdx-json",
        path: ".dagger/runtime/evidence/server/sbom.spdx.json",
        subject_digest: imageDigest,
      },
      scan: {
        digest: scanDigest,
        path: ".dagger/runtime/evidence/server/scan.json",
        policy: ["high", "critical"],
        result: "passed",
        scanner: "grype-v1",
      },
      signature: {
        kind: "sigstore",
        reference,
        verified: true,
      },
    },
    image: "server",
    kind: "oci_image",
    platforms: ["linux/amd64"],
    reference,
    repository,
    source_revision: sourceRevision,
    status: "published",
  };
}

test("parses package manifest artifacts", () => {
  assert.deepStrictEqual(
    parsePackageManifest(`{
      "artifacts": {
        "server": {
          "kind": "archive",
          "path": "deploy-target-server.tgz",
          "deploy_path": "common/deploy/server"
        },
        "webapp": {
          "kind": "directory",
          "path": "apps/webapp/dist",
          "deploy_path": "apps/webapp/dist"
        }
      }
    }`),
    {
      artifacts: {
        server: {
          deploy_path: "common/deploy/server",
          kind: "archive",
          path: "deploy-target-server.tgz",
        },
        webapp: {
          deploy_path: "apps/webapp/dist",
          kind: "directory",
          path: "apps/webapp/dist",
        },
      },
    },
  );
});

test("fails when deploy_path is absolute", () => {
  assert.throws(
    () =>
      parsePackageManifest(`{
        "artifacts": {
          "server": {
            "kind": "archive",
            "path": "deploy-target-server.tgz",
            "deploy_path": "/workspace/common/deploy/server"
          }
        }
      }`),
    /deploy_path must be relative/,
  );
});

test("fails when artifact kind is unsupported", () => {
  assert.throws(
    () =>
      parsePackageManifest(`{
        "artifacts": {
          "server": {
            "kind": "container",
            "path": "deploy-target-server.tgz",
            "deploy_path": "common/deploy/server"
          }
        }
      }`),
    /kind must be "archive" or "directory"/,
  );
});

test("formats normalized package manifest JSON", () => {
  assert.equal(
    formatPackageManifest({
      artifacts: {
        server: {
          deploy_path: "common/deploy/server",
          kind: "archive",
          path: "deploy-target-server.tgz",
        },
      },
    }),
    `{
  "artifacts": {
    "server": {
      "deploy_path": "common/deploy/server",
      "kind": "archive",
      "path": "deploy-target-server.tgz"
    }
  }
}
`,
  );
});

test("validates package manifest objects", () => {
  assert.deepStrictEqual(
    validatePackageManifest({
      artifacts: {
        webapp: {
          deploy_path: "apps/webapp/dist",
          kind: "directory",
          path: "apps/webapp/dist",
        },
      },
    }),
    {
      artifacts: {
        webapp: {
          deploy_path: "apps/webapp/dist",
          kind: "directory",
          path: "apps/webapp/dist",
        },
      },
    },
  );
});

test("rejects inherited artifacts in direct package manifest models", () => {
  const manifest = Object.create({
    artifacts: {
      webapp: {
        deploy_path: "apps/webapp/dist",
        kind: "directory",
        path: "apps/webapp/dist",
      },
    },
  });

  assert.throws(
    () => validatePackageManifest(manifest),
    /Package manifest field "artifacts" must be an object\./,
  );
});

test("preserves legacy unknown-field compatibility", () => {
  assert.deepStrictEqual(
    parsePackageManifest(`{
      "legacy_extension": true,
      "artifacts": {
        "webapp": {
          "kind": "directory",
          "path": "apps/webapp/dist",
          "deploy_path": "apps/webapp/dist",
          "legacy_extension": true
        }
      }
    }`),
    {
      artifacts: {
        webapp: {
          deploy_path: "apps/webapp/dist",
          kind: "directory",
          path: "apps/webapp/dist",
        },
      },
    },
  );
});

test("parses a planned OCI image manifest", () => {
  assert.deepStrictEqual(
    validatePackageManifest({
      schema_version: "rush-delivery-package-manifest/v2",
      artifacts: {
        server: {
          image: "server",
          kind: "oci_image",
          platforms: ["linux/amd64"],
          source_revision: sourceRevision,
          status: "planned",
        },
      },
    }),
    {
      artifacts: {
        server: {
          image: "server",
          kind: "oci_image",
          platforms: ["linux/amd64"],
          source_revision: sourceRevision,
          status: "planned",
        },
      },
      schema_version: "rush-delivery-package-manifest/v2",
    },
  );
});

test("parses a published OCI image manifest with verified evidence", () => {
  const manifest = validatePackageManifest({
    schema_version: "rush-delivery-package-manifest/v2",
    artifacts: {
      server: {
        digest: imageDigest,
        evidence: {
          provenance: {
            digest: documentDigest,
            format: "slsa-provenance-v1",
            path: ".dagger/runtime/evidence/server/provenance.json",
            subject_digest: imageDigest,
          },
          sbom: {
            digest: documentDigest,
            format: "spdx-json",
            path: ".dagger/runtime/evidence/server/sbom.spdx.json",
            subject_digest: imageDigest,
          },
          scan: {
            digest: scanDigest,
            path: ".dagger/runtime/evidence/server/scan.json",
            policy: ["high", "critical"],
            result: "passed",
            scanner: "grype-v1",
          },
          signature: {
            kind: "sigstore",
            reference,
            verified: true,
          },
        },
        image: "server",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        reference,
        repository,
        source_revision: sourceRevision,
        status: "published",
      },
    },
  });

  assert.equal(manifest.artifacts.server.kind, "oci_image");
  assert.equal(manifest.schema_version, "rush-delivery-package-manifest/v2");
});

test("rejects non-portable OCI evidence paths at runtime", () => {
  const manifest = {
    schema_version: "rush-delivery-package-manifest/v2",
    artifacts: {
      server: {
        digest: imageDigest,
        evidence: {
          provenance: {
            digest: documentDigest,
            format: "slsa-provenance-v1",
            path: ".dagger/runtime/evidence/server/provenance.json",
            subject_digest: imageDigest,
          },
          sbom: {
            digest: documentDigest,
            format: "spdx-json",
            path: ".dagger/runtime/evidence/server/sbom file.spdx.json",
            subject_digest: imageDigest,
          },
          scan: {
            digest: scanDigest,
            path: ".dagger/runtime/evidence/server/scan.json",
            policy: ["high", "critical"],
            result: "passed",
            scanner: "grype-v1",
          },
          signature: {
            kind: "sigstore",
            reference,
            verified: true,
          },
        },
        image: "server",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        reference,
        repository,
        source_revision: sourceRevision,
        status: "published",
      },
    },
  };

  assert.throws(
    () => validatePackageManifest(manifest),
    /sbom path must stay inside/,
  );
});

test("rejects trailing OCI evidence separators at runtime", () => {
  const artifact = publishedOciArtifact();
  artifact.evidence.scan.path += "/";

  assert.throws(
    () =>
      validatePackageManifest({
        artifacts: { server: artifact },
        schema_version: "rush-delivery-package-manifest/v2",
      }),
    /scan evidence path must stay inside/,
  );
});

test("requires exact OCI evidence document formats at runtime", () => {
  const wrongProvenance = publishedOciArtifact();
  wrongProvenance.evidence.provenance.format = "spdx-json";
  assert.throws(
    () =>
      validatePackageManifest({
        artifacts: { server: wrongProvenance },
        schema_version: "rush-delivery-package-manifest/v2",
      }),
    /provenance format must be "slsa-provenance-v1"/,
  );

  const wrongSbom = publishedOciArtifact();
  wrongSbom.evidence.sbom.format = "slsa-provenance-v1";
  assert.throws(
    () =>
      validatePackageManifest({
        artifacts: { server: wrongSbom },
        schema_version: "rush-delivery-package-manifest/v2",
      }),
    /sbom format must be "spdx-json"/,
  );
});

test("rejects mutable or inconsistent published OCI references", () => {
  assert.throws(
    () =>
      validatePackageManifest({
        schema_version: "rush-delivery-package-manifest/v2",
        artifacts: {
          server: {
            digest: imageDigest,
            evidence: {},
            image: "server",
            kind: "oci_image",
            platforms: ["linux/amd64"],
            reference: `${repository}:latest`,
            repository,
            source_revision: sourceRevision,
            status: "published",
          },
        },
      }),
    /reference must equal repository@digest/,
  );
});

test("rejects unknown v2 artifact fields", () => {
  assert.throws(
    () =>
      validatePackageManifest({
        schema_version: "rush-delivery-package-manifest/v2",
        artifacts: {
          server: {
            image: "server",
            kind: "oci_image",
            platforms: ["linux/amd64"],
            source_revision: sourceRevision,
            status: "planned",
            token: "secret",
          },
        },
      }),
    /unsupported field: token/,
  );
});

test("selects v2 only when an OCI artifact is present", () => {
  assert.deepStrictEqual(
    createPackageManifest({
      webapp: {
        deploy_path: "apps/webapp/dist",
        kind: "directory",
        path: "apps/webapp/dist",
      },
    }),
    {
      artifacts: {
        webapp: {
          deploy_path: "apps/webapp/dist",
          kind: "directory",
          path: "apps/webapp/dist",
        },
      },
    },
  );

  assert.equal(
    createPackageManifest({
      server: {
        image: "server",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        source_revision: sourceRevision,
        status: "planned",
      },
    }).schema_version,
    "rush-delivery-package-manifest/v2",
  );
});

test("rejects path traversal in mixed v2 filesystem artifacts", () => {
  assert.throws(
    () =>
      validatePackageManifest({
        schema_version: "rush-delivery-package-manifest/v2",
        artifacts: {
          webapp: {
            deploy_path: "../outside",
            kind: "directory",
            path: "apps/webapp/dist",
          },
        },
      }),
    /normalized repository-relative path/,
  );
});

test("rejects non-normalized mixed v2 filesystem artifact paths", () => {
  for (const [field, value] of [
    ["deploy_path", "apps/webapp/dist/"],
    ["path", "apps/webapp/.."],
  ] as const) {
    const artifact = {
      deploy_path: "apps/webapp/dist",
      kind: "directory",
      path: "apps/webapp/dist",
      [field]: value,
    };

    assert.throws(
      () =>
        validatePackageManifest({
          artifacts: { webapp: artifact },
          schema_version: "rush-delivery-package-manifest/v2",
        }),
      /normalized repository-relative path/,
      `${field}=${value} must fail`,
    );
  }
});
