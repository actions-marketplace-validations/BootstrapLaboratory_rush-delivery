import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const [mode, fixtureRootArgument, gitShaArgument, digestSeedArgument] =
  process.argv.slice(2);

const supportedModes = new Set([
  "filesystem",
  "oci-isolation",
  "reserved-env-attack",
  "live-multi-target-success",
  "live-multi-target-preparation-failure",
  "live-multi-target-finalization-failure",
  "live-single-target",
]);
const syntheticRushProjectIntegrities = new Map([
  [
    "matrix-later",
    "sha512-iJa6tPKt2LgEcayyG26Ur8K8w/vWB6Coqh2x2/2njvBiwneGwn7HQNLFfoeAQlQW+Mfguof6Zzl0tbfrw2DWmA==",
  ],
  [
    "matrix-worker",
    "sha512-KFc51UzVZl7vMg5JmYgaef1XfpGH5jG3sM0D0yruPGc5AhFDf61XYu3kJOFbLfbM/OjrS69PzUiGPicCX2Sa3Q==",
  ],
]);

if (!supportedModes.has(mode) || !fixtureRootArgument) {
  throw new Error(
    "Usage: build-oci-v081-matrix-fixture.mjs MODE FIXTURE_ROOT [GIT_SHA] [DIGEST_HEX_CHARACTER]",
  );
}

const fixtureRoot = path.resolve(fixtureRootArgument);
const gitSha = gitShaArgument ?? "0123456789abcdef0123456789abcdef01234567";
const digestSeed = digestSeedArgument ?? "a";

if (!/^[a-f0-9]{40}$/.test(gitSha)) {
  throw new Error(
    "Matrix fixture Git SHA must be 40 lowercase hex characters.",
  );
}
if (!/^[a-f0-9]$/.test(digestSeed)) {
  throw new Error(
    "Matrix fixture digest seed must be one lowercase hex character.",
  );
}

async function writeFixtureFile(relativePath, contents, modeBits) {
  const destination = path.join(fixtureRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  if (modeBits !== undefined) {
    await chmod(destination, modeBits);
  }
}

async function removeFixturePath(relativePath) {
  await rm(path.join(fixtureRoot, relativePath), {
    force: true,
    recursive: true,
  });
}

function sha256(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function writeCiPlan(targets) {
  const affectedProjects = Object.fromEntries(
    targets.map((target) => [target, ["control-plane-api"]]),
  );
  await writeFixtureFile(
    "ci/oci-plan.json",
    `${JSON.stringify(
      {
        affected_projects_by_deploy_target: affectedProjects,
        deploy_targets: targets,
        mode: "release",
        pr_base_sha: "",
        release_targets: [],
        validate_targets: [],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeServicesMesh(targets) {
  await writeFixtureFile(
    ".dagger/deploy/services-mesh.yaml",
    [
      "services:",
      ...targets.flatMap((target) => [`  ${target}:`, "    deploy_after: []"]),
      "",
    ].join("\n"),
  );
}

async function ensureRushProject(packageName) {
  const rushConfigurationPath = path.join(fixtureRoot, "rush.json");
  const rushConfiguration = JSON.parse(
    await readFile(rushConfigurationPath, "utf8"),
  );

  if (
    !rushConfiguration.projects.some(
      (project) => project.packageName === packageName,
    )
  ) {
    rushConfiguration.projects.push({
      packageName,
      projectFolder: `apps/${packageName}`,
    });
    await writeFixtureFile(
      "rush.json",
      `${JSON.stringify(rushConfiguration, null, 2)}\n`,
    );
  }

  await writeFixtureFile(
    `apps/${packageName}/package.json`,
    `${JSON.stringify(
      {
        name: packageName,
        private: true,
        scripts: {
          build: 'node -e ""',
          lint: 'node -e ""',
          test: 'node -e ""',
          verify: 'node -e ""',
        },
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
}

async function addSyntheticRushProjects(packageNames) {
  for (const packageName of packageNames) {
    await ensureRushProject(packageName);
  }

  const lockfilePath = path.join(
    fixtureRoot,
    "common/config/rush/pnpm-lock.yaml",
  );
  let lockfile = await readFile(lockfilePath, "utf8");
  const importerAnchor = [
    "      '@rush-temp/control-plane-api':",
    "        specifier: file:./projects/control-plane-api.tgz",
    "        version: file:projects/control-plane-api.tgz",
  ].join("\n");
  const packageAnchor = [
    "  '@rush-temp/control-plane-api@file:projects/control-plane-api.tgz':",
    "    resolution: {integrity: sha512-tJm1cp+Y6SoKHtclH387sCYuFV81UoDMPIQQMukjE7Z+qml4UzJ6jUjmdQT65rNtYihGPG0GEKGLoEEPx1LYkQ==, tarball: file:projects/control-plane-api.tgz}",
    "    version: 0.0.0",
  ].join("\n");
  const snapshotAnchor =
    "  '@rush-temp/control-plane-api@file:projects/control-plane-api.tgz': {}";
  const sortedNames = [...packageNames].sort();

  for (const anchor of [importerAnchor, packageAnchor, snapshotAnchor]) {
    if (lockfile.split(anchor).length !== 2) {
      throw new Error(
        "Canonical Rush lockfile does not match the live matrix fixture contract.",
      );
    }
  }
  const importerEntries = sortedNames
    .map((packageName) =>
      [
        `      '@rush-temp/${packageName}':`,
        `        specifier: file:./projects/${packageName}.tgz`,
        `        version: file:projects/${packageName}.tgz`,
      ].join("\n"),
    )
    .join("\n");
  const packageEntries = sortedNames
    .map((packageName) => {
      const integrity = syntheticRushProjectIntegrities.get(packageName);
      if (integrity === undefined) {
        throw new Error("Synthetic Rush project integrity is unavailable.");
      }
      return [
        `  '@rush-temp/${packageName}@file:projects/${packageName}.tgz':`,
        `    resolution: {integrity: ${integrity}, tarball: file:projects/${packageName}.tgz}`,
        "    version: 0.0.0",
      ].join("\n");
    })
    .join("\n\n");
  const snapshotEntries = sortedNames
    .map(
      (packageName) =>
        `  '@rush-temp/${packageName}@file:projects/${packageName}.tgz': {}`,
    )
    .join("\n\n");

  lockfile = lockfile
    .replace(importerAnchor, `${importerAnchor}\n${importerEntries}`)
    .replace(packageAnchor, `${packageAnchor}\n\n${packageEntries}`)
    .replace(snapshotAnchor, `${snapshotAnchor}\n\n${snapshotEntries}`);
  await writeFixtureFile("common/config/rush/pnpm-lock.yaml", lockfile);
}

async function buildFilesystemFixture() {
  await removeFixturePath(".dagger/application-images");
  await removeFixturePath(".dagger/runtime");
  await writeFixtureFile(
    ".dagger/package/targets/control-plane-api.yaml",
    [
      "name: control-plane-api",
      "artifact:",
      "  kind: directory",
      "  path: apps/control-plane-api/dist",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    ".dagger/deploy/targets/control-plane-api.yaml",
    [
      "name: control-plane-api",
      "deploy_script: matrix/deploy-filesystem.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  workspace:",
      "    mode: full",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    "matrix/deploy-filesystem.sh",
    `#!/usr/bin/env bash
set -euo pipefail

[[ -n \${ARTIFACT_PATH-} ]]
[[ -z \${ARTIFACT_KIND+x} ]]
[[ -z \${ARTIFACT_EVIDENCE_DIR+x} ]]
cmp "\${ARTIFACT_PATH}/payload.txt" "/workspace/apps/control-plane-api/src/payload.txt"
printf 'MATRIX_FILESYSTEM_DEPLOY_OK:%s\\n' "\${ARTIFACT_PATH}"
`,
    0o755,
  );
  await writeCiPlan(["control-plane-api"]);
}

async function writeLiveTarget(target, invalidGrypeConfiguration) {
  const ignoreFile = invalidGrypeConfiguration
    ? ".dagger/application-images/grype-invalid.yaml"
    : ".dagger/application-images/grype.yaml";
  await writeFixtureFile(
    `.dagger/package/targets/${target}.yaml`,
    [
      `name: ${target}`,
      "artifact:",
      "  kind: oci_image",
      "  context: apps/control-plane-api",
      "  dockerfile: apps/control-plane-api/Dockerfile",
      `  image: ${target}`,
      "  platform: linux/amd64",
      "  scan:",
      "    fail_on:",
      "      - high",
      "      - critical",
      `    ignore_file: ${ignoreFile}`,
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    `.dagger/deploy/targets/${target}.yaml`,
    [
      `name: ${target}`,
      "deploy_script: deploy/consume-image.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  workspace:",
      "    files:",
      "      - deploy/consume-image.sh",
      "",
    ].join("\n"),
  );
}

async function buildLiveMultiTargetFixture(injectPreparationFailure) {
  await removeFixturePath(".dagger/runtime");
  await addSyntheticRushProjects(["matrix-worker"]);
  await writeLiveTarget("control-plane-api", false);
  await writeLiveTarget("matrix-worker", injectPreparationFailure);
  if (injectPreparationFailure) {
    await writeFixtureFile(
      ".dagger/application-images/grype-invalid.yaml",
      "ignore: [\n",
    );
  }
  await writeServicesMesh(["control-plane-api", "matrix-worker"]);
  await writeCiPlan(["control-plane-api", "matrix-worker"]);
}

async function buildLiveFinalizationFailureFixture() {
  await removeFixturePath(".dagger/runtime");
  await addSyntheticRushProjects(["matrix-worker", "matrix-later"]);
  for (const target of ["control-plane-api", "matrix-worker", "matrix-later"]) {
    await writeLiveTarget(target, false);
  }
  await writeServicesMesh([
    "control-plane-api",
    "matrix-worker",
    "matrix-later",
  ]);
  await writeCiPlan(["control-plane-api", "matrix-worker", "matrix-later"]);
}

function publishedArtifact(target, evidence) {
  const digest = `sha256:${digestSeed.repeat(64)}`;
  const repository = `registry.example/rush-delivery-matrix/${target}`;
  const reference = `${repository}@${digest}`;

  return {
    digest,
    evidence: {
      provenance: {
        digest: sha256(evidence.provenance),
        format: "slsa-provenance-v1",
        path: `.dagger/runtime/evidence/${target}/provenance.json`,
        subject_digest: digest,
      },
      sbom: {
        digest: sha256(evidence.sbom),
        format: "spdx-json",
        path: `.dagger/runtime/evidence/${target}/sbom.spdx.json`,
        subject_digest: digest,
      },
      scan: {
        digest: sha256(evidence.scan),
        path: `.dagger/runtime/evidence/${target}/scan.json`,
        policy: ["high", "critical"],
        result: "passed",
        scanner: "grype-0.116.1",
      },
      signature: {
        kind: "sigstore",
        reference,
        verified: true,
      },
    },
    image: target,
    kind: "oci_image",
    platforms: ["linux/amd64"],
    reference,
    repository,
    source_revision: gitSha,
    status: "published",
  };
}

async function writeEvidence(target) {
  const evidence = {
    provenance: `${JSON.stringify({ gitSha, target, type: "provenance" })}\n`,
    sbom: `${JSON.stringify({ spdxVersion: "SPDX-2.3", target })}\n`,
    scan: `${JSON.stringify({ matches: [], target })}\n`,
  };
  const evidenceRoot = `.dagger/runtime/evidence/${target}`;
  await Promise.all([
    writeFixtureFile(`${evidenceRoot}/provenance.json`, evidence.provenance),
    writeFixtureFile(`${evidenceRoot}/sbom.spdx.json`, evidence.sbom),
    writeFixtureFile(`${evidenceRoot}/scan.json`, evidence.scan),
  ]);
  return evidence;
}

function imageDeployScript(target, otherTarget) {
  return `#!/usr/bin/env bash
set -euo pipefail

[[ \${ARTIFACT_KIND} == oci_image ]]
[[ \${ARTIFACT_EVIDENCE_DIR} == "/workspace/.dagger/runtime/evidence/${target}" ]]
[[ -z \${ARTIFACT_PATH+x} ]]
for evidence_file in provenance.json sbom.spdx.json scan.json; do
  [[ -f "\${ARTIFACT_EVIDENCE_DIR}/\${evidence_file}" ]]
done
[[ ! -e "/workspace/.dagger/runtime/evidence/${otherTarget}" ]]
printf 'MATRIX_${target.toUpperCase().replaceAll("-", "_")}_ISOLATED:%s\\n' "\${ARTIFACT_IMAGE_REFERENCE}"
`;
}

async function buildOciIsolationFixture(reservedEnvAttack) {
  await removeFixturePath(".dagger/package/targets/control-plane-api.yaml");
  await removeFixturePath(".dagger/runtime");
  await removeFixturePath(".dagger/deploy/targets/control-plane-api.yaml");
  await writeServicesMesh(["image-a", "image-b", "filesystem"]);

  const rushConfiguration = JSON.parse(
    await readFile(path.join(fixtureRoot, "rush.json"), "utf8"),
  );
  rushConfiguration.projects.push(
    { packageName: "image-a", projectFolder: "apps/image-a" },
    { packageName: "image-b", projectFolder: "apps/image-b" },
    { packageName: "filesystem", projectFolder: "apps/filesystem" },
  );
  await writeFixtureFile(
    "rush.json",
    `${JSON.stringify(rushConfiguration, null, 2)}\n`,
  );
  for (const target of ["image-a", "image-b", "filesystem"]) {
    await writeFixtureFile(
      `apps/${target}/package.json`,
      `${JSON.stringify(
        { name: target, private: true, version: "1.0.0" },
        null,
        2,
      )}\n`,
    );
  }
  for (const target of ["image-a", "image-b"]) {
    await writeFixtureFile(
      `.dagger/package/targets/${target}.yaml`,
      [
        `name: ${target}`,
        "artifact:",
        "  kind: oci_image",
        "  context: apps/control-plane-api",
        "  dockerfile: apps/control-plane-api/Dockerfile",
        `  image: ${target}`,
        "  platform: linux/amd64",
        "  scan:",
        "    fail_on:",
        "      - high",
        "      - critical",
        "    ignore_file: .dagger/application-images/grype.yaml",
        "",
      ].join("\n"),
    );
  }
  await writeFixtureFile(
    ".dagger/package/targets/filesystem.yaml",
    [
      "name: filesystem",
      "artifact:",
      "  kind: directory",
      "  path: matrix/filesystem-output",
      "",
    ].join("\n"),
  );

  const imageAEvidence = await writeEvidence("image-a");
  const imageBEvidence = await writeEvidence("image-b");
  const manifest = {
    artifacts: {
      "image-a": publishedArtifact("image-a", imageAEvidence),
      "image-b": publishedArtifact("image-b", imageBEvidence),
      filesystem: {
        deploy_path: "matrix/filesystem-output",
        kind: "directory",
        path: "matrix/filesystem-output",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  await writeFixtureFile(
    ".dagger/runtime/package-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFixtureFile(
    ".dagger/deploy/targets/image-a.yaml",
    [
      "name: image-a",
      "deploy_script: matrix/deploy-image-a.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      ...(reservedEnvAttack
        ? ["  env:", "    ARTIFACT_IMAGE_REFERENCE: attacker-controlled"]
        : []),
      "  workspace:",
      "    mode: full",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    ".dagger/deploy/targets/image-b.yaml",
    [
      "name: image-b",
      "deploy_script: matrix/deploy-image-b.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  workspace:",
      "    dirs:",
      "      - .dagger",
      "      - matrix",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    ".dagger/deploy/targets/filesystem.yaml",
    [
      "name: filesystem",
      "deploy_script: matrix/deploy-filesystem-isolation.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  workspace:",
      "    mode: full",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    "matrix/deploy-image-a.sh",
    imageDeployScript("image-a", "image-b"),
    0o751,
  );
  await writeFixtureFile(
    "matrix/deploy-image-b.sh",
    imageDeployScript("image-b", "image-a"),
    0o751,
  );
  await writeFixtureFile(
    "matrix/deploy-filesystem-isolation.sh",
    `#!/usr/bin/env bash
set -euo pipefail

[[ -n \${ARTIFACT_PATH-} ]]
[[ -z \${ARTIFACT_EVIDENCE_DIR+x} ]]
[[ -z \${ARTIFACT_KIND+x} ]]
[[ ! -e /workspace/.dagger/runtime/evidence ]]
[[ -f "\${ARTIFACT_PATH}/payload.txt" ]]
printf 'MATRIX_FILESYSTEM_ISOLATED:%s\\n' "\${ARTIFACT_PATH}"
`,
    0o751,
  );
  await writeFixtureFile(
    "matrix/filesystem-output/payload.txt",
    `filesystem-${gitSha}\n`,
  );
  await removeFixturePath("matrix/current");
  await symlink("deploy-image-a.sh", path.join(fixtureRoot, "matrix/current"));
}

switch (mode) {
  case "filesystem":
    await buildFilesystemFixture();
    break;
  case "oci-isolation":
    await buildOciIsolationFixture(false);
    break;
  case "reserved-env-attack":
    await buildOciIsolationFixture(true);
    break;
  case "live-multi-target-success":
    await buildLiveMultiTargetFixture(false);
    break;
  case "live-multi-target-preparation-failure":
    await buildLiveMultiTargetFixture(true);
    break;
  case "live-multi-target-finalization-failure":
    await buildLiveFinalizationFailureFixture();
    break;
  case "live-single-target":
    await removeFixturePath(".dagger/runtime");
    break;
}

// Fail early if fixture derivation accidentally removed the canonical Rush project.
await readFile(path.join(fixtureRoot, "rush.json"), "utf8");
