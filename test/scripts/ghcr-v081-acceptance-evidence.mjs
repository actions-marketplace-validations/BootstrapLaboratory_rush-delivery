#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIXED_GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const SUBJECT_TAG = `sha-${FIXED_GIT_SHA}`;
const INVENTORY_EVENT_ORDER = "target-list-then-registry-version-id";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REFERENCE_PATTERN =
  /^ghcr\.io\/bootstraplaboratory\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/u;
const TARGETS = new Set(["control-plane-api", "matrix-worker", "matrix-later"]);

const [mode, ...args] = process.argv.slice(2);

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseTargets(source) {
  const targets = source.split(",");
  requireCondition(
    targets.length > 0 &&
      targets.every((target) => TARGETS.has(target)) &&
      new Set(targets).size === targets.length,
    "GHCR acceptance targets are invalid.",
  );
  return targets;
}

function validateCoordinates(registry, repositoryPrefix) {
  requireCondition(registry === "ghcr.io", "GHCR registry is invalid.");
  requireCondition(
    /^bootstraplaboratory\/rush-delivery-v081-acceptance\/v081-[a-z0-9-]+-[a-f0-9]{32}$/u.test(
      repositoryPrefix,
    ),
    "GHCR repository prefix is outside the project namespace.",
  );
}

async function writePrivateFile(filePath, contents) {
  await writeFile(filePath, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function parseFlatEnvironment(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf("=");
    requireCondition(
      separator > 0,
      "Credential profile contains an invalid line.",
    );
    const name = line.slice(0, separator);
    requireCondition(
      /^[A-Z_][A-Z0-9_]*$/u.test(name) && !values.has(name),
      "Credential profile contains an invalid or duplicate name.",
    );
    values.set(name, line.slice(separator + 1));
  }
  return values;
}

function normalizeVersion(version) {
  requireCondition(
    version && typeof version === "object" && !Array.isArray(version),
    "GHCR returned a malformed package version.",
  );
  requireCondition(
    Number.isSafeInteger(version.id) && version.id > 0,
    "GHCR package version has an invalid identifier.",
  );
  requireCondition(
    typeof version.name === "string" && DIGEST_PATTERN.test(version.name),
    "GHCR package version has an invalid digest.",
  );
  requireCondition(
    typeof version.created_at === "string" &&
      Number.isFinite(Date.parse(version.created_at)),
    "GHCR package version has an invalid creation timestamp.",
  );
  const tags = version.metadata?.container?.tags;
  requireCondition(
    Array.isArray(tags) && tags.every((tag) => typeof tag === "string"),
    "GHCR package version has an invalid tag inventory.",
  );
  return {
    createdAt: version.created_at,
    digest: version.name,
    id: version.id,
    tags,
  };
}

function normalizeVersionInventory(source) {
  requireCondition(
    Array.isArray(source),
    "GHCR version inventory must be an array.",
  );
  const containsPages = source.some((entry) => Array.isArray(entry));
  requireCondition(
    !containsPages || source.every((entry) => Array.isArray(entry)),
    "GHCR paginated version inventory is malformed.",
  );
  const entries = containsPages ? source.flat() : source;
  return entries.map(normalizeVersion);
}

async function readPackageVersions(snapshotDirectory, targets) {
  const byTarget = new Map();
  for (const [index, target] of targets.entries()) {
    const source = JSON.parse(
      await readFile(path.join(snapshotDirectory, `${index}.json`), "utf8"),
    );
    const versions = normalizeVersionInventory(source);
    requireCondition(
      new Set(versions.map(({ id }) => id)).size === versions.length,
      "GHCR version inventory contains duplicate identifiers.",
    );
    byTarget.set(target, versions);
  }
  return byTarget;
}

function isSubjectVersion(version) {
  return version.tags.includes(SUBJECT_TAG);
}

function requireCompleteCosignPackageVersions(versions, target) {
  requireCondition(
    versions.filter((version) => !isSubjectVersion(version)).length >= 3,
    `GHCR does not yet expose the three Cosign package versions for ${target}.`,
  );
}

function evidenceVersion(version) {
  return {
    created_at: version.createdAt,
    digest: version.digest,
    registry_version_id: version.id,
    subject: isSubjectVersion(version),
    tags: [...version.tags],
  };
}

function repositoryRecord(registry, repositoryPrefix, target, versions) {
  const subjects = versions.filter(isSubjectVersion);
  const record = {
    inspected: true,
    package_version_count: versions.length,
    publication_count: subjects.length,
    versions: versions.map(evidenceVersion),
  };
  if (subjects.length === 1) {
    const subject = subjects[0];
    record.reference = `${registry}/${repositoryPrefix}/${target}@${subject.digest}`;
    record.subject_digest = subject.digest;
    record.registry_created_at = subject.createdAt;
    record.registry_version_id = subject.id;
  }
  return record;
}

async function buildInventoryPlan(
  assertion,
  registry,
  repositoryPrefix,
  targetsCsv,
  snapshotDirectory,
  evidencePath,
  verificationPath,
) {
  requireCondition(
    assertion === "zero" ||
      assertion === "success" ||
      assertion === "ordered-partial",
    "GHCR inventory assertion is invalid.",
  );
  validateCoordinates(registry, repositoryPrefix);
  const targets = parseTargets(targetsCsv);
  const versionsByTarget = await readPackageVersions(
    snapshotDirectory,
    targets,
  );
  const repositories = {};
  const verificationReferences = [];

  for (const [index, target] of targets.entries()) {
    const versions = versionsByTarget.get(target);
    const subjects = versions.filter(isSubjectVersion);
    const record = repositoryRecord(
      registry,
      repositoryPrefix,
      target,
      versions,
    );
    if (assertion === "zero") {
      requireCondition(
        versions.length === 0,
        `GHCR unexpectedly contains a package version for ${target}.`,
      );
    } else if (assertion === "success") {
      requireCondition(
        subjects.length === 1,
        `GHCR does not contain exactly one subject publication for ${target}.`,
      );
      requireCompleteCosignPackageVersions(versions, target);
      record.signature_verified = true;
      record.spdx_attestation_verified = true;
      record.provenance_attestation_verified = true;
      verificationReferences.push(record.reference);
    } else if (index === 0) {
      requireCondition(
        subjects.length === 1,
        "GHCR does not contain the completed first publication.",
      );
      requireCompleteCosignPackageVersions(versions, target);
      record.signature_verified = true;
      record.spdx_attestation_verified = true;
      record.provenance_attestation_verified = true;
      verificationReferences.push(record.reference);
    } else if (index === 1) {
      requireCondition(
        subjects.length === 1,
        "GHCR does not contain exactly one published subject for the failed target.",
      );
      requireCondition(
        versions.length === 1,
        "GHCR failed target contains non-subject package versions after the injected boundary.",
      );
      record.status = "published-then-failed";
    } else {
      requireCondition(
        versions.length === 0,
        "GHCR contains a package version for a skipped target.",
      );
    }
    repositories[target] = record;
  }

  const versionEvents = targets.flatMap((target) =>
    versionsByTarget.get(target).map((version) => ({
      created_at: version.createdAt,
      digest: version.digest,
      operation: isSubjectVersion(version)
        ? "subject-published"
        : "package-version-present",
      registry_version_id: version.id,
      subject: isSubjectVersion(version),
      tags: [...version.tags],
      target,
    })),
  );
  const targetOrder = new Map(targets.map((target, index) => [target, index]));
  // This is a canonical serialization order, not an inference about mutation
  // chronology across independent GHCR packages.
  versionEvents.sort(
    (left, right) =>
      targetOrder.get(left.target) - targetOrder.get(right.target) ||
      left.registry_version_id - right.registry_version_id,
  );
  const events = versionEvents.map((event, index) => ({
    ...event,
    sequence: index + 1,
  }));
  if (assertion === "zero") {
    requireCondition(
      events.length === 0,
      "Zero inventory contains mutation events.",
    );
  }

  for (const reference of verificationReferences) {
    requireCondition(
      REFERENCE_PATTERN.test(reference),
      "GHCR verification reference is invalid.",
    );
  }
  await writePrivateFile(
    evidencePath,
    `${JSON.stringify({
      assertion,
      event_order: INVENTORY_EVENT_ORDER,
      events,
      registry,
      repositories,
      repository_prefix: repositoryPrefix,
      targets,
    })}\n`,
  );
  await writePrivateFile(
    verificationPath,
    `${JSON.stringify(verificationReferences)}\n`,
  );
}

async function extractVerificationKey(environmentPath, outputPath) {
  const values = parseFlatEnvironment(await readFile(environmentPath, "utf8"));
  const encodedKey = values.get("OCI_MATRIX_VERIFICATION_KEY");
  requireCondition(
    typeof encodedKey === "string" && encodedKey.length > 0,
    "Credential profile has no verification key.",
  );
  const key = encodedKey.replaceAll("\\n", "\n");
  requireCondition(
    key.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
      key.includes("\n-----END PUBLIC KEY-----"),
    "Credential profile verification key is malformed.",
  );
  await writePrivateFile(outputPath, key.endsWith("\n") ? key : `${key}\n`);
}

async function printVerificationReferences(verificationPath) {
  const references = JSON.parse(await readFile(verificationPath, "utf8"));
  requireCondition(
    Array.isArray(references) &&
      references.every(
        (reference) =>
          typeof reference === "string" && REFERENCE_PATTERN.test(reference),
      ),
    "GHCR verification plan is malformed.",
  );
  for (const reference of references) {
    process.stdout.write(`${reference}\n`);
  }
}

async function initializeProfileMaterial(materialDirectory) {
  await mkdir(materialDirectory, { mode: 0o700 });
  for (const name of ["primary", "secondary", "wrong"]) {
    await writePrivateFile(
      path.join(materialDirectory, `${name}.password`),
      `v081-${name}-${randomBytes(24).toString("hex")}\n`,
    );
  }
}

function escapedEnvironmentValue(value) {
  requireCondition(
    !value.includes("\0"),
    "Credential value contains a NUL byte.",
  );
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\\n");
}

async function readTrimmedSecret(filePath) {
  const value = (await readFile(filePath, "utf8")).trimEnd();
  requireCondition(
    value.length >= 32 && !value.includes("\n") && !value.includes("\r"),
    "Generated signing password is malformed.",
  );
  return value;
}

async function buildProfiles(outputDirectory, materialDirectory, registry) {
  requireCondition(registry === "ghcr.io", "Profile registry must be ghcr.io.");
  const username = process.env.GITHUB_ACTOR;
  const token = process.env.GITHUB_TOKEN;
  requireCondition(
    typeof username === "string" &&
      username.length <= 100 &&
      /^[A-Za-z0-9_.@\[\]-]+$/u.test(username),
    "GITHUB_ACTOR is invalid for GHCR authentication.",
  );
  requireCondition(
    typeof token === "string" && token.length >= 32 && !/[\r\n]/u.test(token),
    "GITHUB_TOKEN is invalid for GHCR authentication.",
  );
  const primaryPassword = await readTrimmedSecret(
    path.join(materialDirectory, "primary.password"),
  );
  const secondaryPassword = await readTrimmedSecret(
    path.join(materialDirectory, "secondary.password"),
  );
  const wrongPassword = await readTrimmedSecret(
    path.join(materialDirectory, "wrong.password"),
  );
  requireCondition(
    new Set([primaryPassword, secondaryPassword, wrongPassword]).size === 3,
    "Generated signing passwords are not unique.",
  );
  const primaryPrivate = await readFile(
    path.join(materialDirectory, "primary", "cosign.key"),
    "utf8",
  );
  const primaryPublic = await readFile(
    path.join(materialDirectory, "primary", "cosign.pub"),
    "utf8",
  );
  const secondaryPublic = await readFile(
    path.join(materialDirectory, "secondary", "cosign.pub"),
    "utf8",
  );
  requireCondition(
    primaryPrivate.startsWith(
      "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\n",
    ) &&
      primaryPrivate.includes("\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----"),
    "Generated private key has unexpected framing.",
  );
  for (const publicKey of [primaryPublic, secondaryPublic]) {
    requireCondition(
      publicKey.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
        publicKey.includes("\n-----END PUBLIC KEY-----"),
      "Generated public key has unexpected framing.",
    );
  }

  const malformedPrivate = "not-a-pem-private-key";
  const malformedPublic = "not-a-pem-public-key";
  const invalidPrivate = [
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "not-a-valid-encrypted-private-key",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "",
  ].join("\n");
  const scenarios = new Map([
    [
      "malformed-private-pem",
      [malformedPrivate, primaryPassword, primaryPublic],
    ],
    [
      "malformed-public-pem",
      [primaryPrivate, primaryPassword, malformedPublic],
    ],
    ["wrong-signing-password", [primaryPrivate, wrongPassword, primaryPublic]],
    ["invalid-key", [invalidPrivate, primaryPassword, primaryPublic]],
    ["mismatched-key", [primaryPrivate, primaryPassword, secondaryPublic]],
    ["multi-target-success", [primaryPrivate, primaryPassword, primaryPublic]],
    [
      "multi-target-preparation-failure",
      [primaryPrivate, primaryPassword, primaryPublic],
    ],
    [
      "multi-target-finalization-failure",
      [primaryPrivate, primaryPassword, primaryPublic],
    ],
  ]);
  const scenarioDirectory = path.join(outputDirectory, "scenarios");
  await mkdir(scenarioDirectory, { mode: 0o700 });
  for (const [scenario, [privateKey, password, publicKey]] of scenarios) {
    const contents = [
      `OCI_MATRIX_USERNAME=${escapedEnvironmentValue(username)}`,
      `OCI_MATRIX_TOKEN=${escapedEnvironmentValue(token)}`,
      `OCI_MATRIX_SIGNING_KEY=${escapedEnvironmentValue(privateKey)}`,
      `OCI_MATRIX_SIGNING_PASSWORD=${escapedEnvironmentValue(password)}`,
      `OCI_MATRIX_VERIFICATION_KEY=${escapedEnvironmentValue(publicKey)}`,
      "",
    ].join("\n");
    await writePrivateFile(
      path.join(scenarioDirectory, `${scenario}.env`),
      contents,
    );
  }
  const auth = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
  await writePrivateFile(
    path.join(outputDirectory, "registry-auth.json"),
    `${JSON.stringify({ auths: { [registry]: { auth } } })}\n`,
  );
}

async function writeCleanupEvidence(
  registry,
  repositoryPrefix,
  targetsCsv,
  statusDirectory,
  outputPath,
) {
  validateCoordinates(registry, repositoryPrefix);
  const targets = parseTargets(targetsCsv);
  const repositories = {};
  for (const [index, target] of targets.entries()) {
    requireCondition(
      (await readFile(
        path.join(statusDirectory, `${index}.status`),
        "utf8",
      )) === "absent\n",
      `GHCR cleanup did not prove ${target} absent.`,
    );
    repositories[target] = {
      inspected: true,
      package_absent: true,
      remaining_publication_count: 0,
    };
  }
  await writePrivateFile(
    outputPath,
    `${JSON.stringify({
      assertion: "cleanup",
      cleanup_completed: true,
      registry,
      repositories,
      repository_prefix: repositoryPrefix,
    })}\n`,
  );
}

switch (mode) {
  case "inventory-plan":
    await buildInventoryPlan(...args);
    break;
  case "extract-verification-key":
    await extractVerificationKey(...args);
    break;
  case "print-verification-references":
    await printVerificationReferences(...args);
    break;
  case "initialize-profile-material":
    await initializeProfileMaterial(...args);
    break;
  case "build-profiles":
    await buildProfiles(...args);
    break;
  case "cleanup-evidence":
    await writeCleanupEvidence(...args);
    break;
  default:
    throw new Error(
      "Usage: ghcr-v081-acceptance-evidence.mjs inventory-plan|extract-verification-key|print-verification-references|initialize-profile-material|build-profiles|cleanup-evidence ...",
    );
}
