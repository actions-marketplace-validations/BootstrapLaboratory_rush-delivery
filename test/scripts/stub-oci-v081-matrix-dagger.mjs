#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const callIndex = args.indexOf("call");
let entrypointIndex = callIndex + 1;
if (args[entrypointIndex] === "--json") {
  entrypointIndex += 1;
}
const entrypoint = args[entrypointIndex];

function option(name) {
  const prefix = `--${name}=`;
  return args
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

async function writeManifest(outputDirectory, manifest) {
  await mkdir(path.join(outputDirectory, ".dagger/runtime"), {
    recursive: true,
  });
  await writeFile(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function sha256(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function parseFlatEnvironment(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function livePackage(repo, outputDirectory) {
  await cp(repo, outputDirectory, { recursive: true });
  const deployEnvFile = option("deploy-env-file");
  const plan = JSON.parse(await readFile(path.join(repo, "ci/oci-plan.json")));
  const targets = plan.deploy_targets;
  const providerSource = await readFile(
    path.join(repo, ".dagger/application-images/providers.yaml"),
    "utf8",
  );
  const registry = /^\s*registry:\s*(\S+)$/mu.exec(providerSource)?.[1];
  const repositoryPrefix = /^\s*repository_prefix:\s*(\S+)$/mu.exec(
    providerSource,
  )?.[1];
  if (!deployEnvFile || !registry || !repositoryPrefix) {
    throw new Error("Matrix Dagger stub live inputs are incomplete.");
  }
  const credentials = parseFlatEnvironment(
    await readFile(deployEnvFile, "utf8"),
  );
  const privateKey = credentials.OCI_MATRIX_SIGNING_KEY ?? "";
  const publicKey = credentials.OCI_MATRIX_VERIFICATION_KEY ?? "";
  const signingPassword = credentials.OCI_MATRIX_SIGNING_PASSWORD ?? "";

  process.stdout.write("matrix stub captured safe package stdout\n");
  process.stderr.write("matrix stub captured safe package stderr\n");
  if (process.env.OCI_V081_MATRIX_STUB_LEAK_VALUE) {
    process.stdout.write(`${process.env.OCI_V081_MATRIX_STUB_LEAK_VALUE}\n`);
  }
  if (!privateKey.includes("BEGIN ENCRYPTED SIGSTORE PRIVATE KEY")) {
    process.stderr.write(
      "Application image signing env OCI_MATRIX_SIGNING_KEY must contain the expected PEM key.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!publicKey.includes("BEGIN PUBLIC KEY")) {
    process.stderr.write(
      "Application image signing env OCI_MATRIX_VERIFICATION_KEY must contain the expected PEM key.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (signingPassword.includes("WRONG_PASSWORD")) {
    process.stderr.write(
      'Application image provider "matrix" Cosign preflight failed for signing password.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (privateKey.includes("INVALID_PRIVATE")) {
    process.stderr.write(
      'Application image provider "matrix" Cosign preflight failed for signing private key.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (publicKey.includes("MISMATCH_PUBLIC")) {
    process.stderr.write(
      'Application image provider "matrix" Cosign preflight failed for signing/verification key pair.\n',
    );
    process.exitCode = 1;
    return;
  }
  try {
    await readFile(
      path.join(repo, ".dagger/application-images/grype-invalid.yaml"),
    );
    process.stderr.write(
      "OCI application image preparation failed: Grype scan/policy.\n",
    );
    process.exitCode = 1;
    return;
  } catch {
    // Only the preparation-failure fixture owns this deliberately malformed file.
  }
  if (targets.length === 3) {
    process.stderr.write(
      [
        'OCI package target "matrix-worker" failed during registry publish.',
        `Earlier published target "control-plane-api": ${registry}/${repositoryPrefix}/control-plane-api@sha256:${"1".repeat(64)}.`,
        `Failed target "matrix-worker" published reference: ${registry}/${repositoryPrefix}/matrix-worker@sha256:${"2".repeat(64)}`,
        'Later target "matrix-later" was not started.',
        "OCI publication is nontransactional.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const artifacts = {};
  for (const [index, target] of targets.entries()) {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    const repository = `${registry}/${repositoryPrefix}/${target}`;
    const reference = `${repository}@${digest}`;
    const evidenceRoot = `.dagger/runtime/evidence/${target}`;
    const evidenceContents = {
      provenance: `${JSON.stringify({ target, type: "provenance" })}\n`,
      sbom: `${JSON.stringify({ spdxVersion: "SPDX-2.3", target })}\n`,
      scan: `${JSON.stringify({ matches: [], target })}\n`,
    };
    await mkdir(path.join(outputDirectory, evidenceRoot), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(outputDirectory, evidenceRoot, "provenance.json"),
        evidenceContents.provenance,
      ),
      writeFile(
        path.join(outputDirectory, evidenceRoot, "sbom.spdx.json"),
        evidenceContents.sbom,
      ),
      writeFile(
        path.join(outputDirectory, evidenceRoot, "scan.json"),
        evidenceContents.scan,
      ),
    ]);
    artifacts[target] = {
      digest,
      evidence: {
        provenance: {
          digest: sha256(evidenceContents.provenance),
          path: `${evidenceRoot}/provenance.json`,
        },
        sbom: {
          digest: sha256(evidenceContents.sbom),
          path: `${evidenceRoot}/sbom.spdx.json`,
        },
        scan: {
          digest: sha256(evidenceContents.scan),
          path: `${evidenceRoot}/scan.json`,
        },
        signature: { reference, verified: true },
      },
      kind: "oci_image",
      reference,
      repository,
      status: "published",
    };
  }
  await writeManifest(outputDirectory, { artifacts });
}

async function exportPackage() {
  const repo = option("repo");
  const outputDirectory = option("path");
  const provider = option("application-image-provider");
  if (!repo || !outputDirectory) {
    throw new Error("Matrix Dagger stub requires repo and export path.");
  }
  if (provider === "matrix") {
    await livePackage(repo, outputDirectory);
    return;
  }
  await cp(repo, outputDirectory, { recursive: true });
  if (provider === "ghcr") {
    await writeManifest(outputDirectory, {
      artifacts: {
        "control-plane-api": {
          image: "control-plane-api",
          kind: "oci_image",
          platforms: ["linux/amd64"],
          repository:
            "ghcr.io/example/rush-delivery-tutorial/control-plane-api",
          source_revision:
            option("git-sha") ?? "0123456789abcdef0123456789abcdef01234567",
          status: "planned",
        },
      },
      schema_version: "rush-delivery-package-manifest/v2",
    });
    return;
  }
  await writeManifest(outputDirectory, {
    artifacts: {
      "control-plane-api": {
        deploy_path: "apps/control-plane-api/dist",
        kind: "directory",
        path: "apps/control-plane-api/dist",
      },
    },
  });
}

function emitJsonResult(result) {
  process.stdout.write(`${JSON.stringify(JSON.stringify(result, null, 2))}\n`);
}

async function deployResult() {
  const repo = option("repo");
  if (!repo) {
    throw new Error("Matrix Dagger stub Deploy requires repo.");
  }
  const attackMetadataPath = path.join(
    repo,
    ".dagger/deploy/targets/image-a.yaml",
  );
  try {
    if (
      (await readFile(attackMetadataPath, "utf8")).includes(
        "attacker-controlled",
      )
    ) {
      process.stderr.write(
        "ARTIFACT_IMAGE_REFERENCE is a reserved framework-owned environment variable.\n",
      );
      process.exitCode = 1;
      return;
    }
  } catch {
    // Filesystem-only fixtures do not define image-a.
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(repo, ".dagger/runtime/package-manifest.json"),
      "utf8",
    ),
  );
  if (manifest.schema_version === undefined) {
    emitJsonResult({
      dryRun: false,
      environment: "matrix",
      plan: {
        selectedTargets: ["control-plane-api"],
        waves: [[{ target: "control-plane-api" }]],
      },
      results: [
        {
          artifactPath: "/workspace/apps/control-plane-api/dist",
          output:
            "MATRIX_FILESYSTEM_DEPLOY_OK:/workspace/apps/control-plane-api/dist\n",
          status: "success",
          target: "control-plane-api",
          wave: 1,
        },
      ],
    });
    return;
  }

  const imageA = manifest.artifacts["image-a"];
  const imageB = manifest.artifacts["image-b"];
  emitJsonResult({
    dryRun: false,
    environment: "matrix",
    plan: {
      selectedTargets: ["image-a", "image-b", "filesystem"],
      waves: [
        [
          { target: "image-a" },
          { target: "image-b" },
          { target: "filesystem" },
        ],
      ],
    },
    results: [
      {
        artifactImage: "image-a",
        artifactKind: "oci_image",
        artifactReference: imageA.reference,
        output: `MATRIX_IMAGE_A_ISOLATED:${imageA.reference}\n`,
        status: "success",
        target: "image-a",
        wave: 1,
      },
      {
        artifactImage: "image-b",
        artifactKind: "oci_image",
        artifactReference: imageB.reference,
        output: `MATRIX_IMAGE_B_ISOLATED:${imageB.reference}\n`,
        status: "success",
        target: "image-b",
        wave: 1,
      },
      {
        artifactPath: "/workspace/matrix/filesystem-output",
        output:
          "MATRIX_FILESYSTEM_ISOLATED:/workspace/matrix/filesystem-output\n",
        status: "success",
        target: "filesystem",
        wave: 1,
      },
    ],
  });
}

if (callIndex < 0 || !entrypoint) {
  throw new Error("Matrix Dagger stub expected a call entrypoint.");
}

switch (entrypoint) {
  case "package-deploy-targets":
  case "build-and-package-deploy-targets":
    await exportPackage();
    break;
  case "workflow":
    emitJsonResult({
      dryRun: true,
      environment: "matrix",
      plan: {
        selectedTargets: ["control-plane-api"],
        waves: [[{ target: "control-plane-api" }]],
      },
      results: [
        {
          artifactPath: "/workspace/apps/control-plane-api/dist",
          output: "filesystem dry-run summary\n",
          status: "success",
          target: "control-plane-api",
          wave: 1,
        },
      ],
    });
    break;
  case "deploy-release":
    await deployResult();
    break;
  default:
    throw new Error(`Matrix Dagger stub does not support ${entrypoint}.`);
}
