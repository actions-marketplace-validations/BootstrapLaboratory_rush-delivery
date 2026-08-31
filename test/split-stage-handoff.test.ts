import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import type {
  PackageManifest,
  PublishedOciImagePackageManifestArtifact,
} from "../src/model/package-manifest.ts";
import {
  APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
  formatApplicationImageCredentialCapability,
  parseApplicationImageCredentialCapability,
} from "../src/application-images/credential-capability.ts";
import type { ProtectedApplicationImageCredential } from "../src/application-images/environment-boundary.ts";
import { buildArtifactRuntimeHandoff } from "../src/stages/deploy/artifact-handoff.ts";
import {
  assertPackageManifestDeployPreflight,
  assertPackageManifestEvidenceIntegrity,
} from "../src/stages/deploy/package-manifest-preflight.ts";
import {
  formatPackageManifest,
  parsePackageManifest,
} from "../src/stages/package-stage/package-manifest.ts";

const execFileAsync = promisify(execFile);
const gitSha = "0123456789abcdef0123456789abcdef01234567";
const imageDigest = `sha256:${"a".repeat(64)}`;
const repository = "registry.example/product/control-plane";
const reference = `${repository}@${imageDigest}`;
const protectedCredentials: ProtectedApplicationImageCredential[] = [
  {
    field: "username_env",
    name: "RELEASE_USERNAME",
    provider: "release",
  },
  { field: "token_env", name: "RELEASE_TOKEN", provider: "release" },
  {
    field: "signing_key_env",
    name: "RELEASE_SIGNING_KEY",
    provider: "release",
  },
  {
    field: "signing_password_env",
    name: "RELEASE_SIGNING_PASSWORD",
    provider: "release",
  },
  {
    field: "verification_key_env",
    name: "RELEASE_VERIFICATION_KEY",
    provider: "release",
  },
];

function sha256(contents: string | Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertContainedArchivePath(memberPath: string): void {
  const normalized = memberPath.replace(/\\/g, "/").replace(/^\.\//, "");

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(
      `Package bundle member escapes restoration root: ${memberPath}`,
    );
  }
}

async function assertSafeArchiveMemberPaths(
  archivePath: string,
): Promise<void> {
  const { stderr, stdout } = await execFileAsync(
    "tar",
    ["--list", "--gzip", "--file", archivePath],
    { encoding: "utf8" },
  );

  if (stderr.includes("Removing leading")) {
    throw new Error("Package bundle contains an absolute or escaping path.");
  }

  for (const memberPath of stdout.split("\n").filter(Boolean)) {
    assertContainedArchivePath(memberPath);
  }
}

function assertLexicallyContainedLink(
  restorationRoot: string,
  linkPath: string,
  target: string,
): void {
  if (path.isAbsolute(target)) {
    throw new Error(
      `Package bundle link escapes restoration root: ${linkPath}`,
    );
  }

  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  const relativeTarget = path.relative(restorationRoot, resolvedTarget);

  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `Package bundle link escapes restoration root: ${linkPath}`,
    );
  }
}

async function assertSafeRestoredTree(
  restorationRoot: string,
  currentPath: string = restorationRoot,
): Promise<void> {
  for (const entry of await readdir(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    const status = await lstat(entryPath);

    if (status.isSymbolicLink()) {
      assertLexicallyContainedLink(
        restorationRoot,
        entryPath,
        await readlink(entryPath),
      );
      continue;
    }

    if (status.isDirectory()) {
      await assertSafeRestoredTree(restorationRoot, entryPath);
      continue;
    }

    if (!status.isFile()) {
      throw new Error(
        `Package bundle contains unsupported entry: ${entryPath}`,
      );
    }
  }
}

async function restoreTrustedPackageBundle(
  archivePath: string,
  expectedChecksum: string,
  destination: string,
): Promise<void> {
  const actualChecksum = await sha256File(archivePath);

  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      "Package bundle checksum does not match protected release metadata.",
    );
  }

  await assertSafeArchiveMemberPaths(archivePath);

  if (await pathExists(destination)) {
    throw new Error("Package bundle destination already exists.");
  }

  const destinationParent = path.dirname(destination);
  await mkdir(destinationParent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(destinationParent, ".package-bundle-restore-"),
  );

  try {
    await execFileAsync(
      "tar",
      [
        "--extract",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        stagingDirectory,
        "--no-same-owner",
        "--delay-directory-restore",
      ],
      { encoding: "utf8" },
    );
    await assertSafeRestoredTree(stagingDirectory);
    await rename(stagingDirectory, destination);
  } catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

function publishedManifest(
  evidence: Record<"provenance" | "sbom" | "scan", string>,
): PackageManifest {
  const artifact: PublishedOciImagePackageManifestArtifact = {
    digest: imageDigest,
    evidence: {
      provenance: {
        digest: sha256(evidence.provenance),
        format: "slsa-provenance-v1",
        path: ".dagger/runtime/evidence/control-plane/provenance.json",
        subject_digest: imageDigest,
      },
      sbom: {
        digest: sha256(evidence.sbom),
        format: "spdx-json",
        path: ".dagger/runtime/evidence/control-plane/sbom.spdx.json",
        subject_digest: imageDigest,
      },
      scan: {
        digest: sha256(evidence.scan),
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
    source_revision: gitSha,
    status: "published",
  };

  return {
    artifacts: { "control-plane": artifact },
    schema_version: "rush-delivery-package-manifest/v2",
  };
}

async function createPackageArchive(
  sourceDirectory: string,
  archivePath: string,
): Promise<void> {
  await execFileAsync(
    "tar",
    [
      "--create",
      "--gzip",
      "--format=posix",
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "--file",
      archivePath,
      "--directory",
      sourceDirectory,
      ".",
    ],
    { encoding: "utf8" },
  );
}

test("trusted split-stage bundle preserves identity, modes, symlinks, and digest handoff", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-split-stage-"),
  );
  const packagedDirectory = path.join(temporaryRoot, "packaged");
  const archivePath = path.join(temporaryRoot, "package-bundle.tar.gz");
  const restoredDirectory = path.join(temporaryRoot, "restored", "bundle");
  const evidence = {
    provenance: '{"predicateType":"https://slsa.dev/provenance/v1"}\n',
    sbom: '{"spdxVersion":"SPDX-2.3"}\n',
    scan: '{"matches":[]}\n',
  };

  try {
    const evidenceDirectory = path.join(
      packagedDirectory,
      ".dagger/runtime/evidence/control-plane",
    );
    const deployDirectory = path.join(packagedDirectory, "deploy");
    await mkdir(evidenceDirectory, { recursive: true });
    await mkdir(deployDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(evidenceDirectory, "provenance.json"),
        evidence.provenance,
      ),
      writeFile(path.join(evidenceDirectory, "sbom.spdx.json"), evidence.sbom),
      writeFile(path.join(evidenceDirectory, "scan.json"), evidence.scan),
      writeFile(
        path.join(packagedDirectory, ".dagger/runtime/package-manifest.json"),
        formatPackageManifest(publishedManifest(evidence)),
      ),
      writeFile(
        path.join(
          packagedDirectory,
          APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
        ),
        formatApplicationImageCredentialCapability(protectedCredentials),
      ),
      writeFile(
        path.join(deployDirectory, "deploy.sh"),
        '#!/bin/sh\nset -eu\nprintf "%s\\n" "$ARTIFACT_IMAGE_REFERENCE"\n',
      ),
    ]);
    await chmod(path.join(deployDirectory, "deploy.sh"), 0o751);
    await symlink("deploy.sh", path.join(deployDirectory, "current"));
    await createPackageArchive(packagedDirectory, archivePath);

    // Both values model protected release metadata stored outside the bundle.
    const expectedArchiveChecksum = await sha256File(archivePath);
    const independentlyExpectedGitSha = gitSha;

    await assert.rejects(
      () =>
        restoreTrustedPackageBundle(
          archivePath,
          `sha256:${"0".repeat(64)}`,
          restoredDirectory,
        ),
      /checksum does not match protected release metadata/,
    );
    assert.equal(await pathExists(restoredDirectory), false);

    await restoreTrustedPackageBundle(
      archivePath,
      expectedArchiveChecksum,
      restoredDirectory,
    );

    const restoredScript = path.join(restoredDirectory, "deploy/deploy.sh");
    const restoredLink = path.join(restoredDirectory, "deploy/current");
    assert.equal((await lstat(restoredScript)).mode & 0o777, 0o751);
    assert.equal((await lstat(restoredLink)).isSymbolicLink(), true);
    assert.equal(await readlink(restoredLink), "deploy.sh");

    const manifest = parsePackageManifest(
      await readFile(
        path.join(restoredDirectory, ".dagger/runtime/package-manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      parseApplicationImageCredentialCapability(
        await readFile(
          path.join(
            restoredDirectory,
            APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
          ),
          "utf8",
        ),
      ),
      protectedCredentials,
    );
    assertPackageManifestDeployPreflight(
      ["control-plane"],
      manifest,
      independentlyExpectedGitSha,
      false,
    );
    await assertPackageManifestEvidenceIntegrity(
      ["control-plane"],
      manifest,
      (evidencePath) =>
        readFile(path.join(restoredDirectory, evidencePath), "utf8"),
    );

    const artifact = manifest.artifacts["control-plane"];
    assert.equal(artifact.kind, "oci_image");
    const handoff = buildArtifactRuntimeHandoff("control-plane", artifact);
    const { stdout } = await execFileAsync(restoredLink, [], {
      encoding: "utf8",
      env: {
        ...handoff.environment,
        GIT_SHA: independentlyExpectedGitSha,
        PATH: process.env.PATH,
      },
    });

    assert.equal(stdout, `${reference}\n`);
    assert.equal(handoff.environment.ARTIFACT_IMAGE_REFERENCE, reference);
    assert.match(reference, /@sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("split-stage restoration rejects an escaping symlink before atomic rename", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-split-stage-link-"),
  );
  const sourceDirectory = path.join(temporaryRoot, "source");
  const archivePath = path.join(temporaryRoot, "escaping-link.tar.gz");
  const destination = path.join(temporaryRoot, "restored", "bundle");

  try {
    await mkdir(path.join(sourceDirectory, "deploy"), { recursive: true });
    await symlink("../../outside", path.join(sourceDirectory, "deploy/escape"));
    await createPackageArchive(sourceDirectory, archivePath);
    const expectedChecksum = await sha256File(archivePath);

    await assert.rejects(
      () =>
        restoreTrustedPackageBundle(archivePath, expectedChecksum, destination),
      /link escapes restoration root/,
    );
    assert.equal(await pathExists(destination), false);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("split-stage restoration rejects an escaping member path before extraction", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-split-stage-path-"),
  );
  const sourceDirectory = path.join(temporaryRoot, "source");
  const archivePath = path.join(temporaryRoot, "escaping-path.tar.gz");
  const destination = path.join(temporaryRoot, "restored", "bundle");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(path.join(sourceDirectory, "safe.txt"), "safe\n");
    await execFileAsync(
      "tar",
      [
        "--create",
        "--gzip",
        "--file",
        archivePath,
        "--transform=s,^safe.txt$,../escape.txt,",
        "--directory",
        sourceDirectory,
        "safe.txt",
      ],
      { encoding: "utf8" },
    );
    const expectedChecksum = await sha256File(archivePath);

    await assert.rejects(
      () =>
        restoreTrustedPackageBundle(archivePath, expectedChecksum, destination),
      /absolute or escaping path|member escapes restoration root/,
    );
    assert.equal(await pathExists(destination), false);
    assert.equal(
      await pathExists(path.join(temporaryRoot, "escape.txt")),
      false,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
