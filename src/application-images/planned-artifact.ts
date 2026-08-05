import type { OciRegistryProviderDefinition } from "../model/application-image.ts";
import type { PlannedOciImagePackageManifestArtifact } from "../model/package-manifest.ts";
import type { OciImagePackagePlan } from "../stages/package-stage/package-action-plan.ts";
import { normalizeCredentialFreeRepositoryLocator } from "../source/repository-locator.ts";
import { buildApplicationImageRepository } from "./reference.ts";

const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export function normalizeApplicationImageGitSha(gitSha: string): string {
  const normalized = gitSha.toLowerCase();

  if (!FULL_GIT_SHA_PATTERN.test(normalized)) {
    throw new Error(
      "OCI image packaging requires a full 40-character Git commit SHA.",
    );
  }

  return normalized;
}

export function normalizeApplicationImageSourceUrl(
  sourceRepositoryUrl?: string,
): string {
  if (sourceRepositoryUrl === undefined || sourceRepositoryUrl.length === 0) {
    return "";
  }

  return normalizeCredentialFreeRepositoryLocator(
    sourceRepositoryUrl,
    "OCI image source repository URL",
  );
}

export function createPlannedApplicationImageArtifact(
  plan: OciImagePackagePlan,
  gitSha: string,
  provider?: OciRegistryProviderDefinition,
): PlannedOciImagePackageManifestArtifact {
  return {
    image: plan.image,
    kind: "oci_image",
    platforms: [plan.platform],
    ...(provider === undefined
      ? {}
      : { repository: buildApplicationImageRepository(provider, plan.image) }),
    source_revision: normalizeApplicationImageGitSha(gitSha),
    status: "planned",
  };
}
