import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, zstdDecompress } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const MAX_IMAGE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_LAYER_BYTES = 512 * 1024 * 1024;
const gunzipAsync = promisify(gunzip);
const zstdDecompressAsync = promisify(zstdDecompress);

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);

  return field
    .subarray(0, terminator < 0 ? field.length : terminator)
    .toString("utf8")
    .trimEnd();
}

function tarOctal(header, offset, length, label) {
  const value = tarString(header, offset, length).trim();

  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`${label} tar header has an invalid numeric field.`);
  }

  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} tar header has an unsafe numeric field.`);
  }

  return parsed;
}

function normalizeTarPath(value, label) {
  let normalized = value;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} tar entry has an unsafe path.`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`${label} tar entry has an unsafe path.`);
  }

  const safePath = segments.filter((segment) => segment !== ".").join("/");
  if (!safePath) {
    throw new Error(`${label} tar entry has an unsafe path.`);
  }

  return safePath;
}

function parsePaxPath(contents, label) {
  let offset = 0;
  let paxPath;

  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    if (space < 0) {
      throw new Error(`${label} PAX header is malformed.`);
    }

    const lengthSource = contents.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthSource)) {
      throw new Error(`${label} PAX header is malformed.`);
    }
    const recordLength = Number.parseInt(lengthSource, 10);
    const recordEnd = offset + recordLength;
    if (recordEnd > contents.length || contents[recordEnd - 1] !== 0x0a) {
      throw new Error(`${label} PAX header is malformed.`);
    }

    const record = contents.subarray(space + 1, recordEnd - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator < 1) {
      throw new Error(`${label} PAX header is malformed.`);
    }
    if (record.slice(0, separator) === "path") {
      paxPath = record.slice(separator + 1);
    }

    offset = recordEnd;
  }

  return paxPath;
}

function parseTarArchive(archive, label) {
  if (
    archive.length === 0 ||
    archive.length > MAX_IMAGE_ARCHIVE_BYTES ||
    archive.length % TAR_BLOCK_SIZE !== 0
  ) {
    throw new Error(`${label} tar size is invalid or exceeds its bound.`);
  }

  const entries = new Map();
  let offset = 0;
  let pendingPath;
  let entryCount = 0;

  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((value) => value === 0)) {
      break;
    }

    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== tarOctal(header, 148, 8, label)) {
      throw new Error(`${label} tar header checksum does not match.`);
    }

    const size = tarOctal(header, 124, 12, label);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (dataEnd > archive.length || dataStart + paddedSize > archive.length) {
      throw new Error(`${label} tar entry exceeds the archive boundary.`);
    }

    const type = String.fromCharCode(header[156] || 0x30);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const contents = archive.subarray(dataStart, dataEnd);

    if (type === "L") {
      pendingPath = contents.toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "x") {
      pendingPath = parsePaxPath(contents, label) ?? pendingPath;
    } else if (type === "0" || type === "\0" || type === "7") {
      const entryPath = normalizeTarPath(pendingPath ?? headerPath, label);
      pendingPath = undefined;
      if (entries.has(entryPath)) {
        throw new Error(`${label} tar contains a duplicate file path.`);
      }
      entries.set(entryPath, contents);
      entryCount += 1;
      if (entryCount > 10_000) {
        throw new Error(`${label} tar contains too many files.`);
      }
    } else if (type !== "g") {
      pendingPath = undefined;
    }

    offset = dataStart + paddedSize;
  }

  return entries;
}

function parseJsonBuffer(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function requiredArchiveEntry(entries, entryPath, label) {
  const normalizedPath = normalizeTarPath(entryPath, label);
  const contents = entries.get(normalizedPath);

  if (!contents) {
    throw new Error(`${label} is missing a required file.`);
  }

  return contents;
}

function readOciBlob(entries, descriptor, label) {
  if (
    !descriptor ||
    !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 0
  ) {
    throw new Error(`${label} descriptor is invalid.`);
  }

  const [algorithm, digest] = descriptor.digest.split(":");
  const contents = requiredArchiveEntry(
    entries,
    `blobs/${algorithm}/${digest}`,
    label,
  );
  const actualDigest = createHash("sha256").update(contents).digest("hex");

  if (contents.length !== descriptor.size || actualDigest !== digest) {
    throw new Error(`${label} descriptor does not match its blob.`);
  }

  return contents;
}

function resolveOciManifest(entries, index) {
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error(
      "Acceptance OCI image index must select exactly one manifest.",
    );
  }

  let descriptor = index.manifests[0];
  for (let depth = 0; depth < 3; depth += 1) {
    const contents = readOciBlob(
      entries,
      descriptor,
      "Acceptance OCI manifest",
    );
    const document = parseJsonBuffer(contents, "Acceptance OCI manifest");

    if (document.config && Array.isArray(document.layers)) {
      return { digest: descriptor.digest, manifest: document };
    }
    if (!Array.isArray(document.manifests) || document.manifests.length !== 1) {
      throw new Error(
        "Acceptance OCI image index has an unsupported manifest shape.",
      );
    }
    descriptor = document.manifests[0];
  }

  throw new Error("Acceptance OCI image index nesting exceeds its bound.");
}

function assertProtectedBufferAbsent(contents, label, protectedValues) {
  for (const protectedValue of protectedValues) {
    if (contents.includes(Buffer.from(protectedValue))) {
      throw new Error(`${label} contains a credential sentinel.`);
    }
  }
}

async function decompressLayer(contents, mediaType) {
  if (
    mediaType !== undefined &&
    (typeof mediaType !== "string" ||
      !/(?:\.tar|\.tar\+gzip|\.tar\+zstd|\.tar\.gzip)$/i.test(mediaType))
  ) {
    throw new Error(
      "Acceptance image layer compression format is unsupported.",
    );
  }

  const isGzip =
    /(?:gzip|estargz)/i.test(mediaType ?? "") ||
    (contents[0] === 0x1f && contents[1] === 0x8b);
  const isZstd =
    /zstd/i.test(mediaType ?? "") ||
    (contents[0] === 0x28 &&
      contents[1] === 0xb5 &&
      contents[2] === 0x2f &&
      contents[3] === 0xfd);

  if (isGzip && isZstd) {
    throw new Error(
      "Acceptance image layer has conflicting compression markers.",
    );
  }

  try {
    if (isGzip) {
      return await gunzipAsync(contents, {
        maxOutputLength: MAX_DECOMPRESSED_LAYER_BYTES,
      });
    }
    if (isZstd) {
      return await zstdDecompressAsync(contents, {
        maxOutputLength: MAX_DECOMPRESSED_LAYER_BYTES,
      });
    }
  } catch {
    throw new Error(
      "Acceptance image layer decompression failed or exceeded its bound.",
    );
  }

  if (contents.length > MAX_DECOMPRESSED_LAYER_BYTES) {
    throw new Error(
      "Acceptance image layer exceeds its decompressed-size bound.",
    );
  }
  return contents;
}

async function inspectPublishedImageArchive(
  imageTarball,
  protectedValues,
  expectedDigest,
  inspectArchiveEnvelope = true,
) {
  const archive = await readFile(imageTarball);
  const entries = parseTarArchive(
    archive,
    "Acceptance published image archive",
  );
  let config;
  let layers;

  if (entries.has("index.json") && entries.has("oci-layout")) {
    const layout = parseJsonBuffer(
      requiredArchiveEntry(entries, "oci-layout", "Acceptance OCI layout"),
      "Acceptance OCI layout",
    );
    if (layout.imageLayoutVersion !== "1.0.0") {
      throw new Error("Acceptance OCI image layout version is unsupported.");
    }
    const index = parseJsonBuffer(
      requiredArchiveEntry(entries, "index.json", "Acceptance OCI image index"),
      "Acceptance OCI image index",
    );
    const resolvedManifest = resolveOciManifest(entries, index);
    if (expectedDigest && resolvedManifest.digest !== expectedDigest) {
      throw new Error(
        "Acceptance OCI image archive does not bind the published digest.",
      );
    }
    const manifest = resolvedManifest.manifest;
    config = readOciBlob(
      entries,
      manifest.config,
      "Acceptance OCI image config",
    );
    layers = manifest.layers.map((descriptor) => ({
      contents: readOciBlob(entries, descriptor, "Acceptance OCI image layer"),
      mediaType: descriptor.mediaType,
    }));
  } else if (entries.has("manifest.json")) {
    if (expectedDigest) {
      throw new Error(
        "Acceptance published image archive lacks OCI subject-digest binding.",
      );
    }
    const dockerManifest = parseJsonBuffer(
      requiredArchiveEntry(
        entries,
        "manifest.json",
        "Acceptance Docker image manifest",
      ),
      "Acceptance Docker image manifest",
    );
    if (!Array.isArray(dockerManifest) || dockerManifest.length !== 1) {
      throw new Error(
        "Acceptance Docker image archive must contain exactly one image.",
      );
    }

    const image = dockerManifest[0];
    if (typeof image.Config !== "string" || !Array.isArray(image.Layers)) {
      throw new Error("Acceptance Docker image manifest shape is invalid.");
    }
    config = requiredArchiveEntry(
      entries,
      image.Config,
      "Acceptance Docker image config",
    );
    layers = image.Layers.map((layerPath) => ({
      contents: requiredArchiveEntry(
        entries,
        layerPath,
        "Acceptance Docker image layer",
      ),
      mediaType: undefined,
    }));
  } else {
    throw new Error(
      "Acceptance published image archive format is unsupported.",
    );
  }

  assertProtectedBufferAbsent(
    config,
    "Acceptance published image config/history",
    protectedValues,
  );
  const parsedConfig = parseJsonBuffer(
    config,
    "Acceptance published image config/history",
  );
  if (
    !parsedConfig ||
    typeof parsedConfig !== "object" ||
    Array.isArray(parsedConfig)
  ) {
    throw new Error("Acceptance published image config is malformed.");
  }
  if (
    parsedConfig.history !== undefined &&
    !Array.isArray(parsedConfig.history)
  ) {
    throw new Error("Acceptance published image history is malformed.");
  }

  for (const layer of layers) {
    const decompressed = await decompressLayer(layer.contents, layer.mediaType);
    assertProtectedBufferAbsent(
      decompressed,
      "Acceptance published image filesystem",
      protectedValues,
    );
  }

  if (inspectArchiveEnvelope) {
    assertProtectedBufferAbsent(
      archive,
      "Acceptance published image archive",
      protectedValues,
    );
  }
}

function addProtectedValue(values, seen, value) {
  if (!value || seen.has(value)) {
    return;
  }

  seen.add(value);
  values.push(value);
}

async function loadProtectedValues(protectedValuesFile, dockerConfigFile) {
  const protectedValuesSource = await readFile(protectedValuesFile, "utf8");
  const protectedEntries = new Map();

  for (const line of protectedValuesSource.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator < 1) {
      throw new Error(
        "Protected-values file contains an invalid flat-env line.",
      );
    }

    protectedEntries.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const protectedValues = [];
  const seen = new Set();

  for (const flatValue of protectedEntries.values()) {
    addProtectedValue(protectedValues, seen, flatValue);
    if (flatValue.includes("\\n")) {
      addProtectedValue(
        protectedValues,
        seen,
        flatValue.replaceAll("\\n", "\n"),
      );
    }
  }

  const username = protectedEntries.get("RD_OCI_GHCR_USERNAME");
  const token = protectedEntries.get("RD_OCI_GHCR_TOKEN");

  if (username && token) {
    addProtectedValue(
      protectedValues,
      seen,
      Buffer.from(`${username}:${token}`, "utf8").toString("base64"),
    );
  }

  if (dockerConfigFile) {
    const dockerConfig = await readFile(dockerConfigFile);
    const dockerConfigSource = dockerConfig.toString("utf8");
    const compactDockerConfig = dockerConfigSource.trimEnd();

    addProtectedValue(protectedValues, seen, dockerConfigSource);
    addProtectedValue(protectedValues, seen, compactDockerConfig);
    addProtectedValue(protectedValues, seen, dockerConfig.toString("base64"));
    addProtectedValue(
      protectedValues,
      seen,
      Buffer.from(compactDockerConfig, "utf8").toString("base64"),
    );

    let parsedDockerConfig;
    try {
      parsedDockerConfig = JSON.parse(dockerConfigSource);
    } catch {
      throw new Error(
        "Docker configuration used by acceptance is not valid JSON.",
      );
    }

    for (const entry of Object.values(parsedDockerConfig.auths ?? {})) {
      if (typeof entry?.auth === "string") {
        addProtectedValue(protectedValues, seen, entry.auth);
      }
    }
  }

  return protectedValues;
}

async function assertProtectedValuesAbsent(filePath, label, protectedValues) {
  const contents = await readFile(filePath);

  for (const protectedValue of protectedValues) {
    if (contents.includes(Buffer.from(protectedValue))) {
      throw new Error(`${label} contains a credential sentinel.`);
    }
  }
}

if (process.argv[2] === "--assert-image-runtime-protected-absent") {
  const [imageTarball, protectedValuesFile] = process.argv.slice(3);

  if (!imageTarball || !protectedValuesFile) {
    throw new Error(
      "Usage: verify-oci-acceptance.mjs --assert-image-runtime-protected-absent IMAGE_TARBALL PROTECTED_VALUES_FILE",
    );
  }

  const protectedValues = await loadProtectedValues(protectedValuesFile);
  await inspectPublishedImageArchive(
    imageTarball,
    protectedValues,
    undefined,
    false,
  );
  process.stdout.write("OCI acceptance image runtime is redacted.\n");
  process.exit(0);
}

if (process.argv[2] === "--assert-image-protected-absent") {
  const [imageTarball, protectedValuesFile, dockerConfigFile] =
    process.argv.slice(3);

  if (!imageTarball || !protectedValuesFile) {
    throw new Error(
      "Usage: verify-oci-acceptance.mjs --assert-image-protected-absent IMAGE_TARBALL PROTECTED_VALUES_FILE [DOCKER_CONFIG_FILE]",
    );
  }

  const protectedValues = await loadProtectedValues(
    protectedValuesFile,
    dockerConfigFile,
  );
  await inspectPublishedImageArchive(imageTarball, protectedValues);
  process.stdout.write("OCI acceptance image archive is redacted.\n");
  process.exit(0);
}

if (process.argv[2] === "--assert-protected-absent") {
  const [inspectedFile, protectedValuesFile, dockerConfigFile] =
    process.argv.slice(3);

  if (!inspectedFile || !protectedValuesFile || !dockerConfigFile) {
    throw new Error(
      "Usage: verify-oci-acceptance.mjs --assert-protected-absent FILE PROTECTED_VALUES_FILE DOCKER_CONFIG_FILE",
    );
  }

  const protectedValues = await loadProtectedValues(
    protectedValuesFile,
    dockerConfigFile,
  );
  await assertProtectedValuesAbsent(
    inspectedFile,
    "OCI acceptance captured output",
    protectedValues,
  );
  process.stdout.write("OCI acceptance captured output is redacted.\n");
  process.exit(0);
}

const [
  outputDirectory,
  expectedGitSha,
  protectedValuesFile,
  expectedRepository,
  imageTarball,
  deployResultFile,
  dockerConfigFile,
] = process.argv.slice(2);

if (
  !outputDirectory ||
  !expectedGitSha ||
  !protectedValuesFile ||
  !expectedRepository
) {
  throw new Error(
    "Usage: verify-oci-acceptance.mjs OUTPUT_DIRECTORY EXPECTED_GIT_SHA PROTECTED_VALUES_FILE EXPECTED_REPOSITORY [IMAGE_TARBALL DEPLOY_RESULT_FILE DOCKER_CONFIG_FILE]",
  );
}

const protectedValues = await loadProtectedValues(
  protectedValuesFile,
  dockerConfigFile,
);

const manifestPath = path.join(
  outputDirectory,
  ".dagger/runtime/package-manifest.json",
);
const manifestSource = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestSource);
const artifact = manifest.artifacts?.["control-plane-api"];

if (manifest.schema_version !== "rush-delivery-package-manifest/v2") {
  throw new Error("Acceptance manifest does not use the v2 schema.");
}
if (Object.keys(manifest.artifacts ?? {}).length !== 1) {
  throw new Error(
    "Acceptance manifest must contain exactly one image artifact.",
  );
}
if (artifact?.kind !== "oci_image" || artifact.status !== "published") {
  throw new Error("Acceptance image was not marked published.");
}
if (artifact.image !== "control-plane-api") {
  throw new Error("Acceptance image name does not match the canonical target.");
}
if (
  !Array.isArray(artifact.platforms) ||
  artifact.platforms.length !== 1 ||
  artifact.platforms[0] !== "linux/amd64"
) {
  throw new Error("Acceptance image platform is not the canonical platform.");
}
if (artifact.source_revision !== expectedGitSha) {
  throw new Error("Acceptance image source revision does not match.");
}
if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
  throw new Error("Acceptance image digest is not canonical.");
}
if (artifact.reference !== `${artifact.repository}@${artifact.digest}`) {
  throw new Error("Acceptance image reference is not repository@digest.");
}
if (artifact.repository !== expectedRepository) {
  throw new Error(
    "Acceptance image repository does not match the disposable namespace.",
  );
}
if (artifact.reference.includes(":sha-")) {
  throw new Error("Acceptance manifest exposed a mutable navigation tag.");
}
if (artifact.evidence?.signature?.verified !== true) {
  throw new Error("Acceptance signature was not verified.");
}
if (
  artifact.evidence.signature.kind !== "sigstore" ||
  artifact.evidence.signature.reference !== artifact.reference
) {
  throw new Error(
    "Acceptance signature evidence does not bind the image subject.",
  );
}

const expectedEvidence = {
  provenance: {
    format: "slsa-provenance-v1",
    path: ".dagger/runtime/evidence/control-plane-api/provenance.json",
  },
  sbom: {
    format: "spdx-json",
    path: ".dagger/runtime/evidence/control-plane-api/sbom.spdx.json",
  },
  scan: {
    path: ".dagger/runtime/evidence/control-plane-api/scan.json",
  },
};

for (const [name, evidence] of Object.entries({
  provenance: artifact.evidence.provenance,
  sbom: artifact.evidence.sbom,
  scan: artifact.evidence.scan,
})) {
  if (evidence.path !== expectedEvidence[name].path) {
    throw new Error(
      `${name} evidence path is not target-scoped and canonical.`,
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(evidence.digest)) {
    throw new Error(`${name} evidence digest is not canonical.`);
  }
  if (
    name !== "scan" &&
    (evidence.format !== expectedEvidence[name].format ||
      evidence.subject_digest !== artifact.digest)
  ) {
    throw new Error(
      `${name} evidence does not bind the expected subject and format.`,
    );
  }

  const evidencePath = path.resolve(outputDirectory, evidence.path);
  const relativeEvidencePath = path.relative(outputDirectory, evidencePath);

  if (
    relativeEvidencePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeEvidencePath)
  ) {
    throw new Error(`${name} evidence path escapes the package bundle.`);
  }
  const contents = await readFile(evidencePath);
  const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;

  if (digest !== evidence.digest) {
    throw new Error(`${name} evidence digest does not match its local file.`);
  }

  for (const protectedValue of protectedValues) {
    if (contents.includes(Buffer.from(protectedValue))) {
      throw new Error(`${name} evidence contains a credential sentinel.`);
    }
  }
}

if (
  artifact.evidence.scan.result !== "passed" ||
  artifact.evidence.scan.scanner !== "grype-0.116.1" ||
  JSON.stringify(artifact.evidence.scan.policy) !==
    JSON.stringify(["high", "critical"])
) {
  throw new Error(
    "Acceptance scan evidence does not record the exact policy contract.",
  );
}

for (const protectedValue of protectedValues) {
  if (manifestSource.includes(protectedValue)) {
    throw new Error("Acceptance manifest contains a credential sentinel.");
  }
}

const sbom = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.sbom.path),
    "utf8",
  ),
);
const scan = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.scan.path),
    "utf8",
  ),
);
const provenance = JSON.parse(
  await readFile(
    path.join(outputDirectory, artifact.evidence.provenance.path),
    "utf8",
  ),
);

if (sbom.spdxVersion !== "SPDX-2.3") {
  throw new Error("Acceptance SBOM is not SPDX 2.3 JSON.");
}
if (!Array.isArray(scan.matches)) {
  throw new Error("Acceptance scan is not a Grype JSON report.");
}
if (scan.matches.length !== 0) {
  throw new Error(
    "Acceptance scratch image unexpectedly contains a vulnerability finding.",
  );
}
if (
  provenance.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit !==
  expectedGitSha
) {
  throw new Error("Acceptance provenance does not bind the source revision.");
}
if (!provenance.runDetails?.metadata?.invocationId?.endsWith(artifact.digest)) {
  throw new Error("Acceptance provenance does not bind the published digest.");
}
if (
  provenance.buildDefinition?.buildType !==
    "https://bootstraplaboratory.github.io/rush-delivery/build-types/oci-image/v0.9.1" ||
  provenance.runDetails?.builder?.id !==
    "https://github.com/BootstrapLaboratory/rush-delivery@v0.9.1"
) {
  throw new Error(
    "Acceptance provenance does not identify the v0.9.1 builder contract.",
  );
}

async function assertBundleContainsNoProtectedValues(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await assertBundleContainsNoProtectedValues(entryPath);
    } else if (entry.isFile()) {
      await assertProtectedValuesAbsent(
        entryPath,
        "Acceptance package bundle",
        protectedValues,
      );
    }
  }
}

await assertBundleContainsNoProtectedValues(outputDirectory);

if (imageTarball) {
  await inspectPublishedImageArchive(
    imageTarball,
    protectedValues,
    artifact.digest,
  );
}

if (deployResultFile) {
  const encodedDeployResult = JSON.parse(
    await readFile(deployResultFile, "utf8"),
  );
  const deployResult = JSON.parse(encodedDeployResult);
  const result = deployResult.results?.[0];

  if (
    deployResult.dryRun !== false ||
    deployResult.environment !== "acceptance" ||
    deployResult.results?.length !== 1 ||
    result?.status !== "success" ||
    result.target !== "control-plane-api" ||
    result.wave !== 1 ||
    result.artifactKind !== "oci_image" ||
    result.artifactImage !== "control-plane-api" ||
    result.artifactReference !== artifact.reference ||
    "artifactPath" in result
  ) {
    throw new Error(
      "Acceptance Deploy result does not preserve the OCI digest-only contract.",
    );
  }

  if (
    result.output !==
    `control-plane-api accepted immutable image: ${artifact.reference}\n`
  ) {
    throw new Error(
      "Acceptance Deploy script did not consume the immutable reference unchanged.",
    );
  }

  await assertProtectedValuesAbsent(
    deployResultFile,
    "Acceptance Deploy result",
    protectedValues,
  );
}

process.stdout.write(
  `OCI acceptance verified ${artifact.reference} with signed evidence${deployResultFile ? " and digest-only Deploy" : ""}.\n`,
);
