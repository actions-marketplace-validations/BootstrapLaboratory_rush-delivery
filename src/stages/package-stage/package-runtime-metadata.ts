import type { Directory } from "@dagger.io/dagger";

import { APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH } from "../../application-images/credential-capability.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import {
  createPackageManifest,
  formatPackageManifest,
} from "./package-manifest.ts";

const PACKAGE_MANIFEST_PATH = ".dagger/runtime/package-manifest.json";

function requirePackageArtifact(
  artifacts: ReadonlyMap<string, PackageManifestArtifact>,
  target: string,
): PackageManifestArtifact {
  const artifact = artifacts.get(target);

  if (artifact === undefined) {
    throw new Error(`Package target "${target}" did not produce an artifact.`);
  }

  return artifact;
}

export function writePackageRuntimeMetadata(
  repo: Directory,
  packagePlans: Array<{ target: string }>,
  artifacts: ReadonlyMap<string, PackageManifestArtifact>,
  credentialCapability: string | undefined,
): Directory {
  const orderedArtifacts = Object.fromEntries(
    packagePlans.map(({ target }) => [
      target,
      requirePackageArtifact(artifacts, target),
    ]),
  );
  const capabilityRepo =
    credentialCapability === undefined
      ? repo
      : repo.withNewFile(
          APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
          credentialCapability,
        );

  return capabilityRepo.withNewFile(
    PACKAGE_MANIFEST_PATH,
    formatPackageManifest(createPackageManifest(orderedArtifacts)),
  );
}
