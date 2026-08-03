import { assertKnownKeys } from "../../metadata/parse-utils.ts";
import {
  PACKAGE_MANIFEST_SCHEMA_V2,
  type FilesystemPackageManifestArtifact,
  type OciImagePackageManifestArtifact,
  type PackageEvidenceDocument,
  type PackageImageEvidence,
  type PackageManifest,
  type PackageManifestArtifact,
  type PackageScanEvidence,
  type PackageSignatureEvidence,
} from "../../model/package-manifest.ts";
import type { VulnerabilitySeverity } from "../../model/package-target.ts";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const OCI_IMAGE_NAME_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const OCI_PLATFORM_PATTERN =
  /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9._-]+)?$/;
const OCI_REPOSITORY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const VULNERABILITY_SEVERITIES = new Set<VulnerabilitySeverity>([
  "critical",
  "high",
  "low",
  "medium",
  "negligible",
]);

function parseObject(rawValue: unknown, name: string): Record<string, unknown> {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(`${name} must be a JSON object.`);
  }

  return rawValue as Record<string, unknown>;
}

function parseRequiredString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return rawValue;
}

function parseDeployPath(rawValue: unknown, name: string): string {
  const deployPath = parseRequiredString(rawValue, name);

  if (deployPath.startsWith("/")) {
    throw new Error(`${name} must be relative.`);
  }

  return deployPath;
}

function parseNormalizedRepositoryPath(
  rawValue: unknown,
  name: string,
): string {
  const value = parseRequiredString(rawValue, name);

  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(`${name} must be a normalized repository-relative path.`);
  }

  return value;
}

function parseDigest(rawValue: unknown, name: string): string {
  const digest = parseRequiredString(rawValue, name);

  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${name} must be a lowercase sha256 digest.`);
  }

  return digest;
}

function parseSourceRevision(rawValue: unknown, name: string): string {
  const revision = parseRequiredString(rawValue, name);

  if (!FULL_GIT_SHA_PATTERN.test(revision)) {
    throw new Error(`${name} must be a full lowercase Git commit SHA.`);
  }

  return revision;
}

function parseImage(rawValue: unknown, name: string): string {
  const image = parseRequiredString(rawValue, name);

  if (!OCI_IMAGE_NAME_PATTERN.test(image)) {
    throw new Error(`${name} must be a normalized relative OCI image name.`);
  }

  return image;
}

function parseRepository(rawValue: unknown, name: string): string {
  const repository = parseRequiredString(rawValue, name);

  if (!OCI_REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `${name} must be an OCI repository without a scheme, tag, or digest.`,
    );
  }

  return repository;
}

function parsePlatforms(rawValue: unknown, name: string): [string] {
  if (!Array.isArray(rawValue) || rawValue.length !== 1) {
    throw new Error(`${name} must contain exactly one platform.`);
  }

  const platform = parseRequiredString(rawValue[0], `${name} entry`);

  if (!OCI_PLATFORM_PATTERN.test(platform)) {
    throw new Error(`${name} entry must be a normalized OCI platform.`);
  }

  return [platform];
}

function parseEvidencePath(
  rawValue: unknown,
  name: string,
  target: string,
): string {
  const evidencePath = parseRequiredString(rawValue, name);
  const prefix = `.dagger/runtime/evidence/${target}/`;

  if (
    !evidencePath.startsWith(prefix) ||
    evidencePath
      .slice(prefix.length)
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${name} must stay inside "${prefix}".`);
  }

  return evidencePath;
}

function parseEvidenceDocument(
  rawValue: unknown,
  name: string,
  target: string,
  imageDigest: string,
  expectedFormat: string,
): PackageEvidenceDocument {
  const value = parseObject(rawValue, name);
  assertKnownKeys(
    value,
    ["digest", "format", "path", "subject_digest"],
    name,
  );
  const format = parseRequiredString(value.format, `${name} format`);

  if (format !== expectedFormat) {
    throw new Error(`${name} format must be "${expectedFormat}".`);
  }

  const subjectDigest = parseDigest(
    value.subject_digest,
    `${name} subject_digest`,
  );

  if (subjectDigest !== imageDigest) {
    throw new Error(`${name} subject_digest must match the image digest.`);
  }

  return {
    digest: parseDigest(value.digest, `${name} digest`),
    format,
    path: parseEvidencePath(value.path, `${name} path`, target),
    subject_digest: subjectDigest,
  };
}

function parseSeverityPolicy(
  rawValue: unknown,
  name: string,
): VulnerabilitySeverity[] {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty array.`);
  }

  const policy: VulnerabilitySeverity[] = [];

  for (const rawEntry of rawValue) {
    const entry = parseRequiredString(rawEntry, `${name} entry`);

    if (!VULNERABILITY_SEVERITIES.has(entry as VulnerabilitySeverity)) {
      throw new Error(`${name} contains unsupported severity "${entry}".`);
    }

    if (policy.includes(entry as VulnerabilitySeverity)) {
      throw new Error(`${name} entries must be unique.`);
    }

    policy.push(entry as VulnerabilitySeverity);
  }

  return policy;
}

function parseScanEvidence(
  rawValue: unknown,
  target: string,
): PackageScanEvidence {
  const name = `Package manifest OCI artifact "${target}" scan evidence`;
  const value = parseObject(rawValue, name);
  assertKnownKeys(
    value,
    ["digest", "path", "policy", "result", "scanner"],
    name,
  );
  const result = parseRequiredString(value.result, `${name} result`);

  if (result !== "passed") {
    throw new Error(`${name} result must be "passed".`);
  }

  return {
    digest: parseDigest(value.digest, `${name} digest`),
    path: parseEvidencePath(value.path, `${name} path`, target),
    policy: parseSeverityPolicy(value.policy, `${name} policy`),
    result,
    scanner: parseRequiredString(value.scanner, `${name} scanner`),
  };
}

function parseSignatureEvidence(
  rawValue: unknown,
  target: string,
  imageReference: string,
): PackageSignatureEvidence {
  const name = `Package manifest OCI artifact "${target}" signature evidence`;
  const value = parseObject(rawValue, name);
  assertKnownKeys(value, ["kind", "reference", "verified"], name);

  if (value.kind !== "sigstore") {
    throw new Error(`${name} kind must be "sigstore".`);
  }

  const reference = parseRequiredString(value.reference, `${name} reference`);

  if (reference !== imageReference) {
    throw new Error(`${name} reference must match the image reference.`);
  }

  if (value.verified !== true) {
    throw new Error(`${name} verified must be true.`);
  }

  return {
    kind: "sigstore",
    reference,
    verified: true,
  };
}

function parseImageEvidence(
  rawValue: unknown,
  target: string,
  imageDigest: string,
  imageReference: string,
): PackageImageEvidence {
  const name = `Package manifest OCI artifact "${target}" evidence`;
  const value = parseObject(rawValue, name);
  assertKnownKeys(value, ["provenance", "sbom", "scan", "signature"], name);

  return {
    provenance: parseEvidenceDocument(
      value.provenance,
      `${name} provenance`,
      target,
      imageDigest,
      "slsa-provenance-v1",
    ),
    sbom: parseEvidenceDocument(
      value.sbom,
      `${name} sbom`,
      target,
      imageDigest,
      "spdx-json",
    ),
    scan: parseScanEvidence(value.scan, target),
    signature: parseSignatureEvidence(
      value.signature,
      target,
      imageReference,
    ),
  };
}

function parseLegacyFilesystemArtifact(
  rawValue: unknown,
  target: string,
): FilesystemPackageManifestArtifact {
  const value = parseObject(
    rawValue,
    `Package manifest artifact "${target}"`,
  );
  const kind = parseRequiredString(
    value.kind,
    `Package manifest artifact "${target}" kind`,
  );

  switch (kind) {
    case "archive":
    case "directory":
      return {
        deploy_path: parseDeployPath(
          value.deploy_path,
          `Package manifest artifact "${target}" deploy_path`,
        ),
        kind,
        path: parseRequiredString(
          value.path,
          `Package manifest artifact "${target}" path`,
        ),
      };
    default:
      throw new Error(
        `Package manifest artifact "${target}" kind must be "archive" or "directory".`,
      );
  }
}

function parseV2FilesystemArtifact(
  rawValue: unknown,
  target: string,
): FilesystemPackageManifestArtifact {
  const value = parseObject(
    rawValue,
    `Package manifest artifact "${target}"`,
  );
  assertKnownKeys(
    value,
    ["deploy_path", "kind", "path"],
    `Package manifest artifact "${target}"`,
  );
  const artifact = parseLegacyFilesystemArtifact(value, target);

  return {
    deploy_path: parseNormalizedRepositoryPath(
      artifact.deploy_path,
      `Package manifest artifact "${target}" deploy_path`,
    ),
    kind: artifact.kind,
    path: parseNormalizedRepositoryPath(
      artifact.path,
      `Package manifest artifact "${target}" path`,
    ),
  };
}

function parseV2OciArtifact(
  rawValue: unknown,
  target: string,
): OciImagePackageManifestArtifact {
  const name = `Package manifest OCI artifact "${target}"`;
  const value = parseObject(rawValue, name);
  const status = parseRequiredString(value.status, `${name} status`);

  if (status === "planned") {
    assertKnownKeys(
      value,
      [
        "image",
        "kind",
        "platforms",
        "repository",
        "source_revision",
        "status",
      ],
      name,
    );

    return {
      image: parseImage(value.image, `${name} image`),
      kind: "oci_image",
      platforms: parsePlatforms(value.platforms, `${name} platforms`),
      ...(value.repository === undefined
        ? {}
        : { repository: parseRepository(value.repository, `${name} repository`) }),
      source_revision: parseSourceRevision(
        value.source_revision,
        `${name} source_revision`,
      ),
      status,
    };
  }

  if (status === "published") {
    assertKnownKeys(
      value,
      [
        "digest",
        "evidence",
        "image",
        "kind",
        "platforms",
        "reference",
        "repository",
        "source_revision",
        "status",
      ],
      name,
    );
    const repository = parseRepository(value.repository, `${name} repository`);
    const digest = parseDigest(value.digest, `${name} digest`);
    const reference = parseRequiredString(value.reference, `${name} reference`);

    if (reference !== `${repository}@${digest}`) {
      throw new Error(`${name} reference must equal repository@digest.`);
    }

    return {
      digest,
      evidence: parseImageEvidence(value.evidence, target, digest, reference),
      image: parseImage(value.image, `${name} image`),
      kind: "oci_image",
      platforms: parsePlatforms(value.platforms, `${name} platforms`),
      reference,
      repository,
      source_revision: parseSourceRevision(
        value.source_revision,
        `${name} source_revision`,
      ),
      status,
    };
  }

  throw new Error(`${name} status must be "planned" or "published".`);
}

function parseArtifacts(
  rawValue: unknown,
  versioned: boolean,
): Record<string, PackageManifestArtifact> {
  const artifactsValue = parseObject(
    rawValue,
    'Package manifest field "artifacts"',
  );

  return Object.fromEntries(
    Object.entries(artifactsValue).map(([target, artifact]) => {
      if (target.length === 0) {
        throw new Error(
          'Package manifest field "artifacts" must use non-empty target names.',
        );
      }

      if (!versioned) {
        return [target, parseLegacyFilesystemArtifact(artifact, target)];
      }

      const value = parseObject(
        artifact,
        `Package manifest artifact "${target}"`,
      );

      return [
        target,
        value.kind === "oci_image"
          ? parseV2OciArtifact(value, target)
          : parseV2FilesystemArtifact(value, target),
      ];
    }),
  );
}

export function validatePackageManifest(rawValue: unknown): PackageManifest {
  const value = parseObject(rawValue, "Package manifest");

  if (!("artifacts" in value)) {
    throw new Error('Package manifest field "artifacts" must be an object.');
  }

  if (value.schema_version === undefined) {
    return {
      artifacts: parseArtifacts(value.artifacts, false),
    };
  }

  assertKnownKeys(value, ["artifacts", "schema_version"], "Package manifest");

  if (value.schema_version !== PACKAGE_MANIFEST_SCHEMA_V2) {
    throw new Error(
      `Package manifest schema_version must be "${PACKAGE_MANIFEST_SCHEMA_V2}".`,
    );
  }

  return {
    schema_version: PACKAGE_MANIFEST_SCHEMA_V2,
    artifacts: parseArtifacts(value.artifacts, true),
  };
}

export function parsePackageManifest(source: string): PackageManifest {
  return validatePackageManifest(JSON.parse(source));
}

export function formatPackageManifest(manifest: PackageManifest): string {
  return `${JSON.stringify(validatePackageManifest(manifest), null, 2)}\n`;
}

export function createPackageManifest(
  artifacts: Record<string, PackageManifestArtifact>,
): PackageManifest {
  return Object.values(artifacts).some(
    (artifact) => artifact.kind === "oci_image",
  )
    ? {
        schema_version: PACKAGE_MANIFEST_SCHEMA_V2,
        artifacts,
      }
    : { artifacts };
}

export function createEmptyPackageManifest(): PackageManifest {
  return {
    artifacts: {},
  };
}
