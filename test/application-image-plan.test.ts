import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPlannedApplicationImageArtifact,
  normalizeApplicationImageSourceUrl,
} from "../src/application-images/planned-artifact.ts";
import { assertSafeApplicationImageTarget } from "../src/application-images/evidence-target.ts";
import { isolateApplicationImagePreparationCoordinates } from "../src/application-images/preparation-boundary.ts";
import type { OciRegistryProviderDefinition } from "../src/model/application-image.ts";
import type { OciImagePackagePlan } from "../src/stages/package-stage/package-action-plan.ts";
import { formatPackageManifest } from "../src/stages/package-stage/package-manifest.ts";

const gitSha = "0123456789abcdef0123456789abcdef01234567";
const plan: OciImagePackagePlan = {
  context: ".",
  dockerfile: "Dockerfile",
  image: "control-plane-api",
  platform: "linux/amd64",
  scan: { fail_on: ["high", "critical"] },
};

test("provider-off dry run emits relative OCI intent", () => {
  assert.deepEqual(createPlannedApplicationImageArtifact(plan, gitSha), {
    image: "control-plane-api",
    kind: "oci_image",
    platforms: ["linux/amd64"],
    source_revision: gitSha,
    status: "planned",
  });
});

test("named-provider dry run emits canonical repository without credentials", () => {
  const sentinel = "SENTINEL_REGISTRY_SECRET_7be349";
  const provider: OciRegistryProviderDefinition = {
    kind: "oci_registry",
    registry: "registry.example",
    repository_prefix: "example/platform",
    signing_key_env: "OCI_SIGNING_KEY",
    signing_password_env: "OCI_SIGNING_PASSWORD",
    token_env: "OCI_TOKEN",
    username_env: "OCI_USERNAME",
    verification_key_env: "OCI_SIGNING_PUBLIC_KEY",
  };
  const artifact = createPlannedApplicationImageArtifact(
    plan,
    gitSha,
    provider,
  );
  const output = formatPackageManifest({
    schema_version: "rush-delivery-package-manifest/v2",
    artifacts: { api: artifact },
  });

  assert.match(
    output,
    /"repository": "registry\.example\/example\/platform\/control-plane-api"/,
  );
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.doesNotMatch(output, /digest|evidence|reference/);
});

test("planned OCI artifacts require a full source revision", () => {
  assert.throws(
    () => createPlannedApplicationImageArtifact(plan, "short"),
    /full 40-character Git commit SHA/,
  );
});

test("legacy single-image preparation receives no provider capability", () => {
  const providerSecretHandle = { sentinel: "must-not-cross-prepare-boundary" };
  const isolated = isolateApplicationImagePreparationCoordinates({
    dryRun: false,
    gitSha,
    provider: {
      dockerConfig: providerSecretHandle,
      name: "release",
      registryToken: providerSecretHandle,
      signingKey: providerSecretHandle,
      signingPassword: providerSecretHandle,
      verificationKey: providerSecretHandle,
    } as never,
    sourceRepositoryUrl: "https://github.com/example/project.git",
  });

  assert.deepEqual(isolated, {
    gitSha,
    sourceRepositoryUrl: "https://github.com/example/project.git",
  });
  assert.equal(
    Object.values(isolated).some(
      (value) => (value as unknown) === providerSecretHandle,
    ),
    false,
  );
  assert.equal("provider" in isolated, false);
  assert.equal("dryRun" in isolated, false);
});

test("unsafe OCI target path segments fail before image planning or preparation", () => {
  for (const target of [".", "..", "nested/image"]) {
    assert.throws(
      () => assertSafeApplicationImageTarget(target),
      /cannot be used as an evidence directory name/,
    );
  }
});

test("OCI provenance source locators cannot carry credential-like URL channels", () => {
  assert.equal(
    normalizeApplicationImageSourceUrl(
      "https://github.com/BootstrapLaboratory/rush-delivery.git",
    ),
    "https://github.com/BootstrapLaboratory/rush-delivery.git",
  );
  assert.equal(
    normalizeApplicationImageSourceUrl(
      "git@github.com:BootstrapLaboratory/rush-delivery.git",
    ),
    "git@github.com:BootstrapLaboratory/rush-delivery.git",
  );

  const sentinel = "SENTINEL_SOURCE_TOKEN_3d479f";
  for (const unsafe of [
    `https://${sentinel}@github.com/example/repo.git`,
    `https://github.com/example/repo.git?token=${sentinel}`,
    `https://github.com/example/repo.git#${sentinel}`,
    `x-access-token:${sentinel}@github.com/example/repo.git`,
  ]) {
    let message = "";

    assert.throws(
      () => normalizeApplicationImageSourceUrl(unsafe),
      (error) => {
        message = error instanceof Error ? error.message : String(error);
        return true;
      },
    );
    assert.equal(message.includes(sentinel), false);
  }
});
