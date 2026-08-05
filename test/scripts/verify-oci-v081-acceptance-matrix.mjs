import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const MAX_PROTECTED_SCAN_FILES = 20_000;
const MAX_PROTECTED_SCAN_BYTES = 1024 * 1024 * 1024;
const PROTECTED_PEM_CHUNK_CHARACTERS = 16;
const FIXED_GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const INVENTORY_EVENT_ORDER = "target-list-then-registry-version-id";

const [mode, ...args] = process.argv.slice(2);

function parsePossiblyEncodedJson(source) {
  const parsed = JSON.parse(source);
  return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function addProtectedValue(values, seen, value) {
  if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
    return;
  }
  seen.add(value);
  values.push(Buffer.from(value));
}

function parseFlatEnvironment(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf("=");
    requireCondition(
      separator > 0,
      "Live protected-values input contains an invalid flat-env line.",
    );
    const name = line.slice(0, separator);
    requireCondition(
      /^[A-Z_][A-Z0-9_]*$/u.test(name) && !entries.has(name),
      "Live protected-values input contains an invalid or duplicate name.",
    );
    entries.set(name, line.slice(separator + 1));
  }
  return entries;
}

async function loadLiveProtectedValues(
  protectedValuesFile,
  dockerConfigFile,
  allowUsername,
) {
  const protectedEntries = parseFlatEnvironment(
    await readFile(protectedValuesFile, "utf8"),
  );
  const requiredNames = [
    "OCI_MATRIX_USERNAME",
    "OCI_MATRIX_TOKEN",
    "OCI_MATRIX_SIGNING_KEY",
    "OCI_MATRIX_SIGNING_PASSWORD",
    "OCI_MATRIX_VERIFICATION_KEY",
  ];
  for (const name of requiredNames) {
    requireCondition(
      (protectedEntries.get(name)?.length ?? 0) > 0,
      `Live protected-values input is missing ${name}.`,
    );
  }

  const values = [];
  const seen = new Set();
  for (const name of requiredNames) {
    if (allowUsername && name === "OCI_MATRIX_USERNAME") {
      continue;
    }
    const value = protectedEntries.get(name);
    const decodedValue = value.replaceAll("\\n", "\n");
    addProtectedValue(values, seen, value);
    addProtectedValue(values, seen, decodedValue);
    addProtectedValue(
      values,
      seen,
      Buffer.from(value, "utf8").toString("base64"),
    );
    addProtectedValue(
      values,
      seen,
      Buffer.from(decodedValue, "utf8").toString("base64"),
    );
    if (
      name === "OCI_MATRIX_SIGNING_KEY" ||
      name === "OCI_MATRIX_VERIFICATION_KEY"
    ) {
      for (const line of decodedValue.split(/\r?\n/u)) {
        if (line.length < 12 || /^-----[A-Z -]+-----$/u.test(line)) {
          continue;
        }
        addProtectedValue(values, seen, line);
        addProtectedValue(
          values,
          seen,
          Buffer.from(line, "utf8").toString("base64"),
        );
        if (line.length > PROTECTED_PEM_CHUNK_CHARACTERS) {
          for (
            let offset = 0;
            offset + PROTECTED_PEM_CHUNK_CHARACTERS <= line.length;
            offset += 1
          ) {
            const chunk = line.slice(
              offset,
              offset + PROTECTED_PEM_CHUNK_CHARACTERS,
            );
            addProtectedValue(values, seen, chunk);
            addProtectedValue(
              values,
              seen,
              Buffer.from(chunk, "utf8").toString("base64"),
            );
          }
        }
      }
    }
  }

  const username = protectedEntries.get("OCI_MATRIX_USERNAME");
  const token = protectedEntries.get("OCI_MATRIX_TOKEN");
  const basicAuth = Buffer.from(`${username}:${token}`, "utf8").toString(
    "base64",
  );
  addProtectedValue(values, seen, basicAuth);
  addProtectedValue(values, seen, `Basic ${basicAuth}`);

  const dockerConfigSource = await readFile(dockerConfigFile, "utf8");
  let dockerConfig;
  try {
    dockerConfig = JSON.parse(dockerConfigSource);
  } catch {
    throw new Error("Live Docker-config protected input is not valid JSON.");
  }
  requireCondition(
    dockerConfig &&
      typeof dockerConfig === "object" &&
      !Array.isArray(dockerConfig) &&
      dockerConfig.auths &&
      typeof dockerConfig.auths === "object",
    "Live Docker-config protected input has no auth map.",
  );
  const compactDockerConfig = JSON.stringify(dockerConfig);
  for (const source of [
    dockerConfigSource,
    dockerConfigSource.trimEnd(),
    compactDockerConfig,
    `${compactDockerConfig}\n`,
  ]) {
    addProtectedValue(values, seen, source);
    addProtectedValue(
      values,
      seen,
      Buffer.from(source, "utf8").toString("base64"),
    );
  }
  for (const entry of Object.values(dockerConfig.auths)) {
    if (entry && typeof entry === "object" && typeof entry.auth === "string") {
      addProtectedValue(values, seen, entry.auth);
      addProtectedValue(values, seen, `Basic ${entry.auth}`);
    }
  }
  return values;
}

function assertProtectedBufferAbsent(contents, protectedValues) {
  for (const protectedValue of protectedValues) {
    requireCondition(
      !contents.includes(protectedValue),
      "Live matrix retained output contains a credential sentinel.",
    );
  }
}

async function assertProtectedPathAbsent(inspectedPath, protectedValues) {
  const pending = [inspectedPath];
  let inspectedFiles = 0;
  let inspectedBytes = 0;

  while (pending.length > 0) {
    const candidate = pending.pop();
    const metadata = await lstat(candidate);
    if (metadata.isDirectory()) {
      const entries = await readdir(candidate);
      entries.sort().reverse();
      for (const entry of entries) {
        pending.push(path.join(candidate, entry));
      }
      continue;
    }

    inspectedFiles += 1;
    requireCondition(
      inspectedFiles <= MAX_PROTECTED_SCAN_FILES,
      "Live matrix protected-output scan exceeded its file-count bound.",
    );
    if (metadata.isSymbolicLink()) {
      const target = Buffer.from(await readlink(candidate), "utf8");
      inspectedBytes += target.length;
      requireCondition(
        inspectedBytes <= MAX_PROTECTED_SCAN_BYTES,
        "Live matrix protected-output scan exceeded its byte bound.",
      );
      assertProtectedBufferAbsent(target, protectedValues);
      continue;
    }
    requireCondition(
      metadata.isFile(),
      "Live matrix retained output contains an unsupported file type.",
    );
    inspectedBytes += metadata.size;
    requireCondition(
      inspectedBytes <= MAX_PROTECTED_SCAN_BYTES,
      "Live matrix protected-output scan exceeded its byte bound.",
    );
    assertProtectedBufferAbsent(await readFile(candidate), protectedValues);
  }
}

async function verifyProtectedCapture(
  inspectedPath,
  protectedValuesFile,
  dockerConfigFile,
  allowUsername,
) {
  requireCondition(
    allowUsername === "true" || allowUsername === "false",
    "Live protected-output scan requires an explicit username policy.",
  );
  await assertProtectedPathAbsent(
    inspectedPath,
    await loadLiveProtectedValues(
      protectedValuesFile,
      dockerConfigFile,
      allowUsername === "true",
    ),
  );
}

async function verifyCredentialFailureProfile(scenario, protectedValuesFile) {
  const entries = parseFlatEnvironment(
    await readFile(protectedValuesFile, "utf8"),
  );
  const privateKey = (entries.get("OCI_MATRIX_SIGNING_KEY") ?? "").replaceAll(
    "\\n",
    "\n",
  );
  const publicKey = (
    entries.get("OCI_MATRIX_VERIFICATION_KEY") ?? ""
  ).replaceAll("\\n", "\n");
  const privateMarkers =
    privateKey.includes("-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----") &&
    privateKey.includes("-----END ENCRYPTED SIGSTORE PRIVATE KEY-----");
  const publicMarkers =
    publicKey.includes("-----BEGIN PUBLIC KEY-----") &&
    publicKey.includes("-----END PUBLIC KEY-----");

  requireCondition(
    (entries.get("OCI_MATRIX_USERNAME")?.length ?? 0) > 0 &&
      (entries.get("OCI_MATRIX_TOKEN")?.length ?? 0) > 0 &&
      (entries.get("OCI_MATRIX_SIGNING_PASSWORD")?.length ?? 0) > 0,
    "Live credential-failure profile is missing a required credential.",
  );
  switch (scenario) {
    case "malformed-private-pem":
      requireCondition(
        !privateMarkers && publicMarkers,
        "Malformed-private-PEM scenario has the wrong marker profile.",
      );
      break;
    case "malformed-public-pem":
      requireCondition(
        privateMarkers && !publicMarkers,
        "Malformed-public-PEM scenario has the wrong marker profile.",
      );
      break;
    case "wrong-signing-password":
    case "invalid-key":
    case "mismatched-key":
      requireCondition(
        privateMarkers && publicMarkers,
        `Live ${scenario} scenario requires marker-valid key inputs.`,
      );
      break;
    default:
      throw new Error("Live credential-failure profile is unsupported.");
  }
}

async function verifyNamedDryRun(outputDirectory) {
  const manifest = await readJson(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
  );
  const artifact = manifest.artifacts?.["control-plane-api"];

  requireCondition(
    manifest.schema_version === "rush-delivery-package-manifest/v2",
    "Named-provider dry run must emit package-manifest v2.",
  );
  requireCondition(
    artifact?.kind === "oci_image" && artifact.status === "planned",
    "Named-provider dry run must emit planned OCI intent.",
  );
  requireCondition(
    artifact.repository ===
      "ghcr.io/example/rush-delivery-tutorial/control-plane-api",
    "Named-provider dry run repository is not canonical.",
  );
  for (const forbidden of ["digest", "evidence", "reference"]) {
    requireCondition(
      !(forbidden in artifact),
      `Named-provider dry run must not emit ${forbidden}.`,
    );
  }
}

async function verifyPlannedMultiTarget(outputDirectory, targetsCsv) {
  const targets = parseTargets(targetsCsv);
  const manifest = await readJson(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
  );

  requireCondition(
    manifest.schema_version === "rush-delivery-package-manifest/v2" &&
      JSON.stringify(Object.keys(manifest.artifacts ?? {})) ===
        JSON.stringify(targets),
    "Provider-off multi-target smoke has the wrong manifest or target order.",
  );
  for (const target of targets) {
    const artifact = manifest.artifacts[target];
    requireCondition(
      artifact?.kind === "oci_image" &&
        artifact.image === target &&
        artifact.status === "planned" &&
        artifact.source_revision === FIXED_GIT_SHA &&
        JSON.stringify(artifact.platforms) === JSON.stringify(["linux/amd64"]),
      `Provider-off multi-target smoke has invalid intent for ${target}.`,
    );
    for (const forbidden of ["digest", "evidence", "reference", "repository"]) {
      requireCondition(
        !(forbidden in artifact),
        `Provider-off multi-target smoke must not emit ${forbidden}.`,
      );
    }
  }
}

async function verifyFilesystemPackage(outputDirectory) {
  const manifest = await readJson(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
  );
  requireCondition(
    manifest.schema_version === undefined,
    "Filesystem-only package manifest must preserve the legacy shape.",
  );
  requireCondition(
    JSON.stringify(manifest.artifacts) ===
      JSON.stringify({
        "control-plane-api": {
          deploy_path: "apps/control-plane-api/dist",
          kind: "directory",
          path: "apps/control-plane-api/dist",
        },
      }),
    "Filesystem-only package artifact changed shape.",
  );
}

async function verifyFilesystemDeploy(resultFile, expectedDryRun) {
  const result = parsePossiblyEncodedJson(await readFile(resultFile, "utf8"));
  const target = result.results?.[0];
  requireCondition(
    result.dryRun === expectedDryRun && result.results?.length === 1,
    "Filesystem Deploy result has the wrong mode or target count.",
  );
  requireCondition(
    target?.target === "control-plane-api" &&
      target.status === "success" &&
      target.artifactPath === "/workspace/apps/control-plane-api/dist",
    "Filesystem Deploy result does not preserve the legacy artifact path.",
  );
  requireCondition(
    !("artifactKind" in target) && !("artifactImage" in target),
    "Filesystem Deploy result unexpectedly contains OCI result fields.",
  );
  if (!expectedDryRun) {
    requireCondition(
      target.output ===
        "MATRIX_FILESYSTEM_DEPLOY_OK:/workspace/apps/control-plane-api/dist\n",
      "Filesystem live Deploy script did not consume the packaged directory.",
    );
  }
}

async function verifyIsolationDeploy(
  resultFile,
  manifestFile,
  expectedManifestDigest,
) {
  const result = parsePossiblyEncodedJson(await readFile(resultFile, "utf8"));
  const byTarget = Object.fromEntries(
    (result.results ?? []).map((entry) => [entry.target, entry]),
  );
  requireCondition(
    result.dryRun === false && result.results?.length === 3,
    "Isolation Deploy must execute all three live targets.",
  );
  requireCondition(
    byTarget["image-a"]?.output.startsWith("MATRIX_IMAGE_A_ISOLATED:"),
    "Full-workspace OCI target did not prove target-scoped evidence.",
  );
  requireCondition(
    byTarget["image-b"]?.output.startsWith("MATRIX_IMAGE_B_ISOLATED:"),
    "Partial-workspace OCI target did not prove target-scoped evidence.",
  );
  requireCondition(
    byTarget.filesystem?.output ===
      "MATRIX_FILESYSTEM_ISOLATED:/workspace/matrix/filesystem-output\n",
    "Mixed filesystem target observed OCI evidence or lost its artifact.",
  );
  requireCondition(
    byTarget["image-a"].artifactReference.includes("@sha256:") &&
      byTarget["image-b"].artifactReference.includes("@sha256:"),
    "OCI isolation result lost digest-only references.",
  );
  requireCondition(
    (await sha256File(manifestFile)) === expectedManifestDigest,
    "Deploy mutated the restored package manifest.",
  );
}

async function verifyReservedAttack(logFile) {
  const source = await readFile(logFile, "utf8");
  requireCondition(
    /ARTIFACT_IMAGE_REFERENCE|framework-owned|reserved/u.test(source),
    "Reserved-env attack did not produce the expected ownership diagnostic.",
  );
  requireCondition(
    !source.includes("MATRIX_IMAGE_A_ISOLATED:"),
    "Reserved-env attack reached project Deploy execution.",
  );
}

function parseTargets(targetsCsv) {
  const targets = targetsCsv.split(",").filter(Boolean);
  requireCondition(
    targets.length > 0 && new Set(targets).size === targets.length,
    "Live matrix expected-target list is invalid.",
  );
  return targets;
}

function expectedInventoryEvent(target, version) {
  return {
    created_at: version.created_at,
    digest: version.digest,
    operation: version.subject
      ? "subject-published"
      : "package-version-present",
    registry_version_id: version.registry_version_id,
    subject: version.subject,
    tags: version.tags,
    target,
  };
}

function inventoryEventLedgerKey(event) {
  return JSON.stringify({
    created_at: event.created_at,
    digest: event.digest,
    operation: event.operation,
    registry_version_id: event.registry_version_id,
    subject: event.subject,
    tags: event.tags,
    target: event.target,
  });
}

async function readInventory(
  inventoryFile,
  assertion,
  targets,
  expectedRegistry,
  expectedRepositoryPrefix,
) {
  const inventory = await readJson(inventoryFile);
  requireCondition(
    typeof expectedRegistry === "string" &&
      expectedRegistry.length > 0 &&
      typeof expectedRepositoryPrefix === "string" &&
      expectedRepositoryPrefix.length > 0,
    "Registry inventory verification requires expected namespace coordinates.",
  );
  requireCondition(
    inventory.assertion === assertion,
    "Registry inventory evidence has the wrong assertion kind.",
  );
  requireCondition(
    typeof inventory.repositories === "object" &&
      inventory.repositories !== null,
    "Registry inventory evidence must contain repository results.",
  );
  requireCondition(
    JSON.stringify(Object.keys(inventory.repositories).sort()) ===
      JSON.stringify([...targets].sort()),
    "Registry inventory evidence must cover exactly the expected targets.",
  );
  requireCondition(
    inventory.event_order === INVENTORY_EVENT_ORDER &&
      Array.isArray(inventory.events),
    "Registry inventory evidence must contain a canonical event ledger.",
  );
  requireCondition(
    inventory.registry === expectedRegistry &&
      inventory.repository_prefix === expectedRepositoryPrefix &&
      JSON.stringify(inventory.targets) === JSON.stringify(targets),
    "Registry inventory evidence does not bind the expected namespace.",
  );
  const expectedEvents = [];
  for (const target of targets) {
    const repository = inventory.repositories[target];
    requireCondition(
      repository?.inspected === true &&
        Number.isSafeInteger(repository.package_version_count) &&
        repository.package_version_count >= 0 &&
        Array.isArray(repository.versions) &&
        repository.versions.length === repository.package_version_count &&
        repository.versions.every(
          (version) =>
            version &&
            typeof version === "object" &&
            typeof version.created_at === "string" &&
            Number.isFinite(Date.parse(version.created_at)) &&
            typeof version.digest === "string" &&
            /^sha256:[a-f0-9]{64}$/u.test(version.digest) &&
            Number.isSafeInteger(version.registry_version_id) &&
            version.registry_version_id > 0 &&
            typeof version.subject === "boolean" &&
            Array.isArray(version.tags) &&
            version.tags.every((tag) => typeof tag === "string") &&
            version.subject === version.tags.includes(`sha-${FIXED_GIT_SHA}`),
        ) &&
        new Set(
          repository.versions.map((version) => version.registry_version_id),
        ).size === repository.versions.length &&
        repository.publication_count ===
          repository.versions.filter((version) => version.subject).length,
      `Registry inventory has an incomplete package-version inventory for ${target}.`,
    );
    expectedEvents.push(
      ...repository.versions.map((version) =>
        expectedInventoryEvent(target, version),
      ),
    );
  }
  for (const [index, event] of inventory.events.entries()) {
    requireCondition(
      event &&
        typeof event === "object" &&
        event.sequence === index + 1 &&
        typeof event.created_at === "string" &&
        Number.isFinite(Date.parse(event.created_at)) &&
        typeof event.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(event.digest) &&
        Number.isSafeInteger(event.registry_version_id) &&
        event.registry_version_id > 0 &&
        typeof event.subject === "boolean" &&
        Array.isArray(event.tags) &&
        event.tags.every((tag) => typeof tag === "string") &&
        (event.operation === "subject-published" ||
          event.operation === "package-version-present") &&
        targets.includes(event.target),
      `Registry inventory event ${index} is malformed.`,
    );
  }
  const targetOrder = new Map(targets.map((target, index) => [target, index]));
  // Version IDs only provide a stable per-package tie-breaker here. This
  // canonical ledger must not be interpreted as cross-package chronology.
  expectedEvents.sort(
    (left, right) =>
      targetOrder.get(left.target) - targetOrder.get(right.target) ||
      left.registry_version_id - right.registry_version_id,
  );
  requireCondition(
    JSON.stringify(expectedEvents.map(inventoryEventLedgerKey)) ===
      JSON.stringify(inventory.events.map(inventoryEventLedgerKey)),
    "Registry inventory event ledger does not exactly match package versions.",
  );
  return inventory;
}

function assertZeroInventory(inventory, targets) {
  for (const target of targets) {
    requireCondition(
      inventory.repositories[target]?.package_version_count === 0 &&
        inventory.repositories[target]?.publication_count === 0 &&
        Array.isArray(inventory.repositories[target]?.versions) &&
        inventory.repositories[target].versions.length === 0,
      `Registry inventory found package versions for ${target}.`,
    );
  }
  requireCondition(
    inventory.events.length === 0,
    "Zero-publication inventory must not contain mutation events.",
  );
}

function hasCompleteCosignPackageVersions(repository) {
  return (
    repository.versions.filter((version) => version.subject).length === 1 &&
    repository.versions.filter((version) => !version.subject).length >= 3
  );
}

async function verifyLiveSuccess(
  outputDirectory,
  inventoryFile,
  targetsCsv,
  expectedRegistry,
  expectedRepositoryPrefix,
) {
  const targets = parseTargets(targetsCsv);
  const inventory = await readInventory(
    inventoryFile,
    "success",
    targets,
    expectedRegistry,
    expectedRepositoryPrefix,
  );
  const manifest = await readJson(
    path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
  );
  requireCondition(
    JSON.stringify(Object.keys(manifest.artifacts)) === JSON.stringify(targets),
    "Live multi-target manifest order does not match selected target order.",
  );

  for (const target of targets) {
    const artifact = manifest.artifacts[target];
    const repositoryInventory = inventory.repositories[target];
    requireCondition(
      artifact?.kind === "oci_image" &&
        artifact.status === "published" &&
        artifact.reference === `${artifact.repository}@${artifact.digest}` &&
        artifact.evidence?.signature?.verified === true &&
        artifact.evidence.signature.reference === artifact.reference,
      `Live multi-target artifact ${target} is not digest-published.`,
    );
    requireCondition(
      repositoryInventory.publication_count === 1 &&
        hasCompleteCosignPackageVersions(repositoryInventory) &&
        repositoryInventory.subject_digest === artifact.digest &&
        repositoryInventory.reference === artifact.reference &&
        repositoryInventory.signature_verified === true &&
        repositoryInventory.spdx_attestation_verified === true &&
        repositoryInventory.provenance_attestation_verified === true,
      `Independent registry evidence is incomplete for ${target}.`,
    );
    requireCondition(
      inventory.events.filter(
        (event) =>
          event.target === target && event.operation === "subject-published",
      ).length === 1,
      `Independent registry evidence must contain one subject publication for ${target}.`,
    );
    for (const evidenceName of ["provenance", "sbom", "scan"]) {
      const evidence = artifact.evidence[evidenceName];
      const contents = await readFile(
        path.join(outputDirectory, evidence.path),
      );
      requireCondition(
        evidence.digest ===
          `sha256:${await sha256File(path.join(outputDirectory, evidence.path))}`,
        `Local ${evidenceName} evidence digest is invalid for ${target}.`,
      );
      requireCondition(
        contents.length > 0,
        `${evidenceName} evidence is empty.`,
      );
    }
  }
}

const LIVE_PREPUBLICATION_FAILURE_PATTERNS = new Map([
  [
    "malformed-private-pem",
    /Application image signing env OCI_MATRIX_SIGNING_KEY must contain the expected PEM key/u,
  ],
  [
    "malformed-public-pem",
    /Application image signing env OCI_MATRIX_VERIFICATION_KEY must contain the expected PEM key/u,
  ],
  ["wrong-signing-password", /Cosign preflight failed for signing password/u],
  ["invalid-key", /Cosign preflight failed for signing private key/u],
  [
    "mismatched-key",
    /Cosign preflight failed for signing\/verification key pair/u,
  ],
  [
    "multi-target-preparation-failure",
    /OCI application image preparation failed|Grype scan\/policy/u,
  ],
]);

async function verifyLiveFailure(
  scenario,
  logFile,
  inventoryFile,
  targetsCsv,
  expectedRegistry,
  expectedRepositoryPrefix,
) {
  const targets = parseTargets(targetsCsv);
  const log = await readFile(logFile, "utf8");
  const expectedPattern = LIVE_PREPUBLICATION_FAILURE_PATTERNS.get(scenario);

  if (expectedPattern !== undefined) {
    requireCondition(
      expectedPattern.test(log),
      `Live ${scenario} did not fail at the required prepublication stage.`,
    );
    assertZeroInventory(
      await readInventory(
        inventoryFile,
        "zero",
        targets,
        expectedRegistry,
        expectedRepositoryPrefix,
      ),
      targets,
    );
    return;
  }

  requireCondition(
    scenario === "ordered-finalization" && targets.length === 3,
    "Ordered-finalization verification requires three targets.",
  );
  requireCondition(
    log.includes(`Earlier published target "${targets[0]}"`) &&
      log.includes(`OCI package target "${targets[1]}" failed`) &&
      log.includes(`Later target "${targets[2]}" was not started`) &&
      /nontransactional/u.test(log),
    "Finalization failure log does not identify completed, failed, and skipped targets.",
  );
  const inventory = await readInventory(
    inventoryFile,
    "ordered-partial",
    targets,
    expectedRegistry,
    expectedRepositoryPrefix,
  );
  requireCondition(
    inventory.repositories[targets[0]].publication_count === 1 &&
      hasCompleteCosignPackageVersions(inventory.repositories[targets[0]]) &&
      inventory.repositories[targets[0]].signature_verified === true &&
      inventory.repositories[targets[0]].spdx_attestation_verified === true &&
      inventory.repositories[targets[0]].provenance_attestation_verified ===
        true,
    "Earlier target is not independently proven complete.",
  );
  requireCondition(
    inventory.events.filter(
      (event) =>
        event.target === targets[0] && event.operation === "subject-published",
    ).length === 1,
    "Earlier target must have exactly one subject publication event.",
  );
  requireCondition(
    inventory.repositories[targets[1]].inspected === true &&
      inventory.repositories[targets[1]].package_version_count === 1 &&
      inventory.repositories[targets[1]].publication_count === 1 &&
      inventory.repositories[targets[1]].versions.length === 1 &&
      inventory.repositories[targets[1]].versions[0].subject === true &&
      inventory.repositories[targets[1]].status === "published-then-failed" &&
      typeof inventory.repositories[targets[1]].subject_digest === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(
        inventory.repositories[targets[1]].subject_digest,
      ) &&
      typeof inventory.repositories[targets[1]].reference === "string" &&
      inventory.repositories[targets[1]].reference.endsWith(
        `@${inventory.repositories[targets[1]].subject_digest}`,
      ),
    "Failed target is not independently proven published before failure.",
  );
  requireCondition(
    inventory.events.filter(
      (event) =>
        event.target === targets[1] && event.operation === "subject-published",
    ).length === 1,
    "Failed target must have exactly one subject publication event.",
  );
  requireCondition(
    log.includes(
      `Failed target "${targets[1]}" published reference: ${inventory.repositories[targets[1]].reference}`,
    ),
    "Finalization failure log does not bind the failed target's published reference.",
  );
  requireCondition(
    inventory.repositories[targets[2]].package_version_count === 0 &&
      inventory.repositories[targets[2]].publication_count === 0 &&
      Array.isArray(inventory.repositories[targets[2]].versions) &&
      inventory.repositories[targets[2]].versions.length === 0 &&
      !inventory.events.some((event) => event.target === targets[2]),
    "Later skipped target was mutated.",
  );
}

async function verifyLiveCleanup(
  cleanupEvidenceFile,
  registry,
  repositoryPrefix,
  targetsCsv,
) {
  const targets = parseTargets(targetsCsv);
  const evidence = await readJson(cleanupEvidenceFile);
  requireCondition(
    evidence.assertion === "cleanup" &&
      evidence.cleanup_completed === true &&
      evidence.registry === registry &&
      evidence.repository_prefix === repositoryPrefix,
    "Live cleanup evidence does not bind the disposable namespace.",
  );
  requireCondition(
    JSON.stringify(Object.keys(evidence.repositories ?? {}).sort()) ===
      JSON.stringify([...targets].sort()),
    "Live cleanup evidence does not cover exactly the expected targets.",
  );
  for (const target of targets) {
    requireCondition(
      evidence.repositories[target]?.inspected === true &&
        evidence.repositories[target]?.package_absent === true &&
        evidence.repositories[target]?.remaining_publication_count === 0,
      `Live cleanup evidence did not prove ${target} absent.`,
    );
  }
}

async function verifyLiveZeroInventory(
  inventoryFile,
  targetsCsv,
  expectedRegistry,
  expectedRepositoryPrefix,
) {
  const targets = parseTargets(targetsCsv);
  assertZeroInventory(
    await readInventory(
      inventoryFile,
      "zero",
      targets,
      expectedRegistry,
      expectedRepositoryPrefix,
    ),
    targets,
  );
}

switch (mode) {
  case "credential-failure-profile":
    await verifyCredentialFailureProfile(args[0], args[1]);
    break;
  case "protected-capture":
    await verifyProtectedCapture(args[0], args[1], args[2], args[3]);
    break;
  case "named-dry":
    await verifyNamedDryRun(args[0]);
    break;
  case "planned-multi":
    await verifyPlannedMultiTarget(args[0], args[1]);
    break;
  case "filesystem-package":
    await verifyFilesystemPackage(args[0]);
    break;
  case "filesystem-deploy":
    await verifyFilesystemDeploy(args[0], args[1] === "true");
    break;
  case "isolation-deploy":
    await verifyIsolationDeploy(args[0], args[1], args[2]);
    break;
  case "reserved-env-attack":
    await verifyReservedAttack(args[0]);
    break;
  case "live-success":
    await verifyLiveSuccess(args[0], args[1], args[2], args[3], args[4]);
    break;
  case "live-failure":
    await verifyLiveFailure(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
      args[5],
    );
    break;
  case "live-cleanup":
    await verifyLiveCleanup(args[0], args[1], args[2], args[3]);
    break;
  case "live-zero-inventory":
    await verifyLiveZeroInventory(args[0], args[1], args[2], args[3]);
    break;
  default:
    throw new Error(
      "Usage: verify-oci-v081-acceptance-matrix.mjs credential-failure-profile|protected-capture|named-dry|planned-multi|filesystem-package|filesystem-deploy|isolation-deploy|reserved-env-attack|live-success|live-failure|live-cleanup|live-zero-inventory ...",
    );
}
