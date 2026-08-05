import type { DeployTargetResult } from "../../model/deploy-result.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import { FRAMEWORK_EVIDENCE_WORKSPACE_PATH } from "./runtime-workspace.ts";

export type ArtifactRuntimeHandoff = {
  artifactPath?: string;
  environment: Record<string, string>;
};

export function buildArtifactRuntimeHandoff(
  target: string,
  artifact: PackageManifestArtifact,
): ArtifactRuntimeHandoff {
  if (artifact.kind !== "oci_image") {
    const artifactPath = `/workspace/${artifact.deploy_path}`;

    return {
      artifactPath,
      environment: {
        ARTIFACT_PATH: artifactPath,
      },
    };
  }

  const environment: Record<string, string> = {
    ARTIFACT_IMAGE_NAME: artifact.image,
    ARTIFACT_IMAGE_PLATFORMS_JSON: JSON.stringify(artifact.platforms),
    ARTIFACT_KIND: "oci_image",
    ARTIFACT_SOURCE_REVISION: artifact.source_revision,
  };

  if (artifact.repository !== undefined) {
    environment.ARTIFACT_IMAGE_REPOSITORY = artifact.repository;
  }

  if (artifact.status === "published") {
    environment.ARTIFACT_EVIDENCE_DIR = `${FRAMEWORK_EVIDENCE_WORKSPACE_PATH}/${target}`;
    environment.ARTIFACT_IMAGE_DIGEST = artifact.digest;
    environment.ARTIFACT_IMAGE_REFERENCE = artifact.reference;
  }

  return { environment };
}

export function buildSuccessfulDeployTargetResult(
  artifact: PackageManifestArtifact,
  artifactPath: string | undefined,
  output: string,
  target: string,
  wave: number,
): DeployTargetResult {
  if (artifact.kind === "oci_image") {
    return {
      artifactImage: artifact.image,
      artifactKind: "oci_image",
      ...(artifact.status === "published"
        ? { artifactReference: artifact.reference }
        : {}),
      output,
      status: "success",
      target,
      wave,
    };
  }

  if (artifactPath === undefined) {
    throw new Error(
      `Filesystem deploy result for target "${target}" requires an artifact path.`,
    );
  }

  return {
    artifactPath,
    output,
    status: "success",
    target,
    wave,
  };
}
