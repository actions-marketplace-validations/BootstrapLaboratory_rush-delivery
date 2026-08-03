import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { PackageManifest } from "../src/model/package-manifest.ts";
import { assertPackageManifestDeployPreflight } from "../src/stages/deploy/package-manifest-preflight.ts";

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
