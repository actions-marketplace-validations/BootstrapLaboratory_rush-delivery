import type { VulnerabilitySeverity } from "./package-target.ts";

export const PACKAGE_MANIFEST_SCHEMA_V2 =
  "rush-delivery-package-manifest/v2" as const;

export type FilesystemPackageManifestArtifact =
  | {
      deploy_path: string;
      kind: "archive";
      path: string;
    }
  | {
      deploy_path: string;
      kind: "directory";
      path: string;
    };

export type PackageEvidenceDocument = {
  digest: string;
  format: string;
  path: string;
  subject_digest: string;
};

export type PackageScanEvidence = {
  digest: string;
  path: string;
  policy: VulnerabilitySeverity[];
  result: "passed";
  scanner: string;
};

export type PackageSignatureEvidence = {
  kind: "sigstore";
  reference: string;
  verified: true;
};

export type PackageImageEvidence = {
  provenance: PackageEvidenceDocument;
  sbom: PackageEvidenceDocument;
  scan: PackageScanEvidence;
  signature: PackageSignatureEvidence;
};

export type PlannedOciImagePackageManifestArtifact = {
  image: string;
  kind: "oci_image";
  platforms: [string];
  repository?: string;
  source_revision: string;
  status: "planned";
};

export type PublishedOciImagePackageManifestArtifact = {
  digest: string;
  evidence: PackageImageEvidence;
  image: string;
  kind: "oci_image";
  platforms: [string];
  reference: string;
  repository: string;
  source_revision: string;
  status: "published";
};

export type OciImagePackageManifestArtifact =
  | PlannedOciImagePackageManifestArtifact
  | PublishedOciImagePackageManifestArtifact;

export type PackageManifestArtifact =
  | FilesystemPackageManifestArtifact
  | OciImagePackageManifestArtifact;

export type PackageManifest = {
  artifacts: Record<string, PackageManifestArtifact>;
  schema_version?: typeof PACKAGE_MANIFEST_SCHEMA_V2;
};

export function getOwnPackageManifestArtifact(
  manifest: PackageManifest,
  target: string,
): PackageManifestArtifact | undefined {
  return Object.hasOwn(manifest.artifacts, target)
    ? manifest.artifacts[target]
    : undefined;
}
