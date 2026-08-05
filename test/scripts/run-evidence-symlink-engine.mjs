#!/usr/bin/env node

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "../../sdk/core.js";
import { APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH } from "../../src/application-images/credential-capability.ts";
import { COSIGN_PREFLIGHT_BUSYBOX_IMAGE } from "../../src/application-images/cosign-plan.ts";
import {
  assertFrameworkRuntimePathsAreCanonical,
  canonicalizeFrameworkRuntime,
  withoutFrameworkEvidence,
} from "../../src/runtime/framework-runtime.ts";

const FRAMEWORK_EVIDENCE_PATH = ".dagger/runtime/evidence";
const PACKAGE_MANIFEST_PATH = ".dagger/runtime/package-manifest.json";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");

function runDagger(args) {
  return spawnSync("dagger", ["-m", REPOSITORY_ROOT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DAGGER_NO_NAG: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });
}

function daggerFailureSummary(result) {
  return `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .slice(-4_000);
}

async function runPublicPackageAndDryDeployRegression() {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-framework-runtime."),
  );

  try {
    const fixtureRoot = path.join(temporaryRoot, "fixture");
    const packagedRoot = path.join(temporaryRoot, "packaged");
    const aliasedRoot = path.join(temporaryRoot, "aliased");
    const ciPlanPath = path.join(temporaryRoot, "ci-plan.json");

    await cp(
      path.join(REPOSITORY_ROOT, "examples/oci-application-image-rush-repo"),
      fixtureRoot,
      { recursive: true },
    );
    await mkdir(path.join(fixtureRoot, ".dagger/generated-output"), {
      recursive: true,
    });
    await mkdir(path.join(fixtureRoot, ".dagger/runtime/stale-directory"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixtureRoot, ".dagger/generated-output/artifact.txt"),
      "built-directory-artifact\n",
    );
    await writeFile(
      path.join(fixtureRoot, ".dagger/runtime/stale-directory/stale.json"),
      "stale-runtime\n",
    );
    await writeFile(
      path.join(fixtureRoot, ".dagger/package/targets/control-plane-api.yaml"),
      [
        "name: control-plane-api",
        "artifact:",
        "  kind: directory",
        "  path: .dagger/generated-output",
        "",
      ].join("\n"),
    );
    await writeFile(
      ciPlanPath,
      `${JSON.stringify(
        {
          affected_projects_by_deploy_target: {
            "control-plane-api": [],
          },
          deploy_targets: ["control-plane-api"],
          mode: "release",
          pr_base_sha: "",
          release_targets: [],
          validate_targets: [],
        },
        null,
        2,
      )}\n`,
    );

    const packageResult = runDagger([
      "call",
      "package-deploy-targets",
      `--repo=${fixtureRoot}`,
      `--ci-plan-file=${ciPlanPath}`,
      "export",
      `--path=${packagedRoot}`,
    ]);

    assert.equal(
      packageResult.status,
      0,
      `public Package regression failed:\n${daggerFailureSummary(packageResult)}`,
    );
    assert.equal(
      await readFile(
        path.join(packagedRoot, ".dagger/generated-output/artifact.txt"),
        "utf8",
      ),
      "built-directory-artifact\n",
    );
    assert.equal(
      (
        await lstat(
          path.join(packagedRoot, ".dagger/runtime/stale-directory"),
        ).catch(() => undefined)
      )?.isDirectory() ?? false,
      false,
    );
    assert.equal(
      (await lstat(path.join(packagedRoot, ".dagger"))).isSymbolicLink(),
      false,
    );
    assert.equal(
      (await lstat(path.join(packagedRoot, ".dagger/runtime"))).isDirectory(),
      true,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(packagedRoot, PACKAGE_MANIFEST_PATH), "utf8"),
      ),
      {
        artifacts: {
          "control-plane-api": {
            deploy_path: ".dagger/generated-output",
            kind: "directory",
            path: ".dagger/generated-output",
          },
        },
      },
    );

    await cp(packagedRoot, aliasedRoot, { recursive: true });
    await mkdir(path.join(aliasedRoot, "redirect"));
    await rename(
      path.join(aliasedRoot, ".dagger/runtime"),
      path.join(aliasedRoot, "redirect/runtime"),
    );
    await symlink(
      "../redirect/runtime",
      path.join(aliasedRoot, ".dagger/runtime"),
    );

    const deployResult = runDagger([
      "call",
      "deploy-release",
      `--repo=${aliasedRoot}`,
      "--git-sha=",
      '--release-targets-json=["control-plane-api"]',
      `--package-manifest-file=${path.join(
        aliasedRoot,
        PACKAGE_MANIFEST_PATH,
      )}`,
    ]);
    const deployFailure = daggerFailureSummary(deployResult);

    assert.notEqual(
      deployResult.status,
      0,
      "dry-run Deploy unexpectedly accepted an aliased framework runtime",
    );
    assert.match(
      deployFailure,
      /Rush Delivery runtime path "\.dagger\/runtime" must not be a symbolic link\./,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await runPublicPackageAndDryDeployRegression();

await connect(async (client) => {
  const preBuildRepo = client
    .directory()
    .withNewFile(".dagger/source-only.txt", "pre-build-only\n")
    .withNewFile(
      ".dagger/runtime/ci-plan.json",
      "pre-package-runtime-must-be-replaced\n",
    );

  const attackCases = [
    {
      name: "evidence-root-symlink",
      repo: client
        .directory()
        .withNewFile(".dagger/changed-by-build", "untrusted\n")
        .withNewDirectory(".dagger/runtime")
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n")
        .withSymlink("../../redirect", FRAMEWORK_EVIDENCE_PATH),
    },
    {
      name: "evidence-target-symlink",
      repo: client
        .directory()
        .withNewFile(".dagger/changed-by-build", "untrusted\n")
        .withNewDirectory(FRAMEWORK_EVIDENCE_PATH)
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n")
        .withSymlink("../../../redirect", `${FRAMEWORK_EVIDENCE_PATH}/image`),
    },
    {
      name: "runtime-parent-symlink",
      repo: client
        .directory()
        .withNewFile(".dagger/changed-by-build", "untrusted\n")
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n")
        .withSymlink("../redirect", ".dagger/runtime"),
    },
    {
      name: "stale-runtime-file",
      repo: client
        .directory()
        .withNewFile(".dagger/runtime", "stale-runtime-file\n")
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n"),
    },
    {
      name: "stale-runtime-directory",
      repo: client
        .directory()
        .withNewFile(".dagger/runtime/stale.json", "stale-runtime\n")
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n"),
    },
    {
      name: "metadata-parent-symlink",
      repo: client
        .directory()
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n")
        .withSymlink("redirect", ".dagger"),
    },
    {
      name: "stale-evidence-directory",
      repo: client
        .directory()
        .withNewFile(".dagger/changed-by-build", "untrusted\n")
        .withNewFile(
          `${FRAMEWORK_EVIDENCE_PATH}/stale/scan.json`,
          "stale-evidence\n",
        )
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n"),
    },
    {
      name: "stale-evidence-file",
      repo: client
        .directory()
        .withNewFile(".dagger/changed-by-build", "untrusted\n")
        .withNewFile(FRAMEWORK_EVIDENCE_PATH, "stale-evidence-file\n")
        .withNewFile("redirect/stale.txt", "redirect-sentinel\n"),
    },
  ];

  for (const attack of attackCases) {
    const postBuildRepo = attack.repo
      .withNewFile(".dagger/generated-output/artifact.txt", "built-artifact\n")
      .withNewFile(
        ".dagger/application-images/providers.yaml",
        "post-build-provider\n",
      )
      .withNewFile(".dagger/changed-by-build", "post-build-metadata\n");
    const redirectDigest = await postBuildRepo.directory("redirect").digest();
    const canonicalRepo = (
      await canonicalizeFrameworkRuntime(preBuildRepo, postBuildRepo)
    )
      .withNewFile(APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH, "capability\n")
      .withNewFile(PACKAGE_MANIFEST_PATH, "manifest\n")
      .withNewFile(
        `${FRAMEWORK_EVIDENCE_PATH}/image/scan.json`,
        "fresh-evidence\n",
      );

    await client
      .container()
      .from(COSIGN_PREFLIGHT_BUSYBOX_IMAGE)
      .withMountedDirectory("/repo", canonicalRepo)
      .withExec([
        "/bin/sh",
        "-ceu",
        [
          "test ! -L /repo/.dagger",
          "test ! -L /repo/.dagger/runtime",
          "test ! -L /repo/.dagger/runtime/evidence",
          "test ! -L /repo/.dagger/runtime/evidence/image",
          'test "$(cat /repo/.dagger/application-images/providers.yaml)" = post-build-provider',
          'test "$(cat /repo/.dagger/generated-output/artifact.txt)" = built-artifact',
          'test "$(cat /repo/.dagger/changed-by-build)" = post-build-metadata',
          "test ! -e /repo/.dagger/source-only.txt",
          "test ! -e /repo/.dagger/runtime/ci-plan.json",
          'test "$(cat /repo/.dagger/runtime/application-image-credential-capability.json)" = capability',
          'test "$(cat /repo/.dagger/runtime/package-manifest.json)" = manifest',
          'test "$(cat /repo/.dagger/runtime/evidence/image/scan.json)" = fresh-evidence',
          "test ! -e /repo/.dagger/runtime/evidence/stale",
          'test "$(cat /repo/redirect/stale.txt)" = redirect-sentinel',
          "test ! -e /repo/redirect/scan.json",
          "test ! -e /repo/redirect/image/scan.json",
        ].join("\n"),
      ])
      .sync();

    assert.equal(
      await canonicalRepo.directory("redirect").digest(),
      redirectDigest,
      `${attack.name} changed its symlink redirect target`,
    );
  }

  const servicesMesh = "services:\n  image:\n    deploy_after: []\n";
  const filesystemManifest = JSON.stringify({
    artifacts: {
      image: {
        deploy_path: "dist",
        kind: "directory",
        path: "dist",
      },
    },
  });
  const aliasedDeployBundles = [
    client
      .directory()
      .withNewFile("redirect/deploy/services-mesh.yaml", servicesMesh)
      .withNewFile("redirect/runtime/package-manifest.json", filesystemManifest)
      .withNewFile("redirect/runtime/evidence/other/scan.json", "secret\n")
      .withSymlink("redirect", ".dagger"),
    client
      .directory()
      .withNewFile(".dagger/deploy/services-mesh.yaml", servicesMesh)
      .withNewFile("redirect/package-manifest.json", filesystemManifest)
      .withNewFile("redirect/evidence/other/scan.json", "secret\n")
      .withSymlink("../redirect", ".dagger/runtime"),
    client
      .directory()
      .withNewFile(".dagger/deploy/services-mesh.yaml", servicesMesh)
      .withNewFile(PACKAGE_MANIFEST_PATH, filesystemManifest)
      .withNewFile("redirect/other/scan.json", "secret\n")
      .withSymlink("../../redirect", FRAMEWORK_EVIDENCE_PATH),
  ];

  for (const aliasedBundle of aliasedDeployBundles) {
    await assert.rejects(
      assertFrameworkRuntimePathsAreCanonical(aliasedBundle),
      /must not be a symbolic link/,
    );
    await assert.rejects(
      withoutFrameworkEvidence(aliasedBundle),
      /must not be a symbolic link/,
    );
  }

  const packagedRepo = client
    .directory()
    .withNewFile(".dagger/application-images/providers.yaml", "trusted\n")
    .withNewFile(".dagger/runtime/package-manifest.json", "manifest\n")
    .withNewFile(
      `${FRAMEWORK_EVIDENCE_PATH}/other/scan.json`,
      "sibling-evidence\n",
    )
    .withNewFile("safe/ordinary.txt", "ordinary-runtime-file\n")
    .withSymlink(
      `../${FRAMEWORK_EVIDENCE_PATH}/other/scan.json`,
      "safe/evidence-link",
    );

  assert.equal(
    await packagedRepo.file("safe/evidence-link").contents(),
    "sibling-evidence\n",
  );

  const evidenceFreeRepo = await withoutFrameworkEvidence(packagedRepo);
  const safeOutput = await client
    .container()
    .from(COSIGN_PREFLIGHT_BUSYBOX_IMAGE)
    .withMountedFile(
      "/run/ordinary.txt",
      evidenceFreeRepo.file("safe/ordinary.txt"),
    )
    .withExec(["/bin/cat", "/run/ordinary.txt"])
    .stdout();

  assert.equal(safeOutput, "ordinary-runtime-file\n");
  assert.equal(
    await evidenceFreeRepo
      .file(".dagger/runtime/package-manifest.json")
      .contents(),
    "manifest\n",
  );
  assert.equal(await evidenceFreeRepo.exists(FRAMEWORK_EVIDENCE_PATH), false);
  await assert.rejects(
    client
      .container()
      .from(COSIGN_PREFLIGHT_BUSYBOX_IMAGE)
      .withMountedFile(
        "/run/evidence-link",
        evidenceFreeRepo.file("safe/evidence-link"),
      )
      .withExec(["/bin/cat", "/run/evidence-link"])
      .sync(),
  );
});

process.stdout.write("Evidence symlink engine regression passed.\n");
