import { createHash } from "node:crypto";

import {
  getOwnPackageManifestArtifact,
  type PackageManifest,
} from "../../model/package-manifest.ts";
import { validatePackageManifest } from "../package-stage/package-manifest.ts";

const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export function assertPackageManifestDeployPreflight(
  selectedTargets: string[],
  packageManifest: PackageManifest,
  gitSha: string,
  dryRun: boolean,
): void {
  const validatedManifest = validatePackageManifest(packageManifest);
  const normalizedGitSha = gitSha.toLowerCase();

  for (const target of selectedTargets) {
    const artifact = getOwnPackageManifestArtifact(validatedManifest, target);

    if (artifact === undefined) {
      throw new Error(
        `package manifest does not define artifact for target "${target}".`,
      );
    }

    if (artifact.kind !== "oci_image") {
      continue;
    }

    if (!FULL_GIT_SHA_PATTERN.test(normalizedGitSha)) {
      throw new Error(
        "Deploying an OCI artifact requires gitSha to be a full 40-character Git commit SHA.",
      );
    }

    if (artifact.source_revision !== normalizedGitSha) {
      throw new Error(
        `OCI artifact source revision "${artifact.source_revision}" for target "${target}" does not match deploy gitSha "${gitSha}".`,
      );
    }

    if (!dryRun && artifact.status !== "published") {
      throw new Error(
        `Live deploy requires a published OCI artifact for target "${target}".`,
      );
    }
  }
}

export async function assertPackageManifestEvidenceIntegrity(
  selectedTargets: string[],
  packageManifest: PackageManifest,
  readEvidence: (path: string) => Promise<string>,
): Promise<void> {
  const validatedManifest = validatePackageManifest(packageManifest);

  for (const target of selectedTargets) {
    const artifact = getOwnPackageManifestArtifact(validatedManifest, target);

    if (artifact?.kind !== "oci_image" || artifact.status !== "published") {
      continue;
    }

    for (const [kind, evidence] of Object.entries({
      provenance: artifact.evidence.provenance,
      sbom: artifact.evidence.sbom,
      scan: artifact.evidence.scan,
    })) {
      let contents: string;

      try {
        contents = await readEvidence(evidence.path);
      } catch {
        throw new Error(
          `OCI artifact ${kind} evidence file for target "${target}" is missing or unreadable at "${evidence.path}".`,
        );
      }

      const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;

      if (digest !== evidence.digest) {
        throw new Error(
          `OCI artifact ${kind} evidence hash for target "${target}" does not match manifest digest for "${evidence.path}".`,
        );
      }
    }
  }
}
