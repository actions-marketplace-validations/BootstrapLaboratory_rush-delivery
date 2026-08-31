import type { Directory } from "@dagger.io/dagger";

import type { ApplicationImageProvidersDefinition } from "../model/application-image.ts";
import type { ResolvedApplicationImageCoordinates } from "../model/application-image.ts";
import type { NpmReleaseDefinition } from "../model/npm-release.ts";
import {
  getOwnPackageManifestArtifact,
  type PackageManifest,
} from "../model/package-manifest.ts";
import { loadDeployTargetDefinition } from "../stages/deploy/load-deploy-metadata.ts";
import type { PreparedPackageTarget } from "../stages/package-stage/package-planning.ts";
import {
  assertNoApplicationImageCredentialProjections,
  assertApplicationImageCoordinateNameSeparation,
  collectApplicationImageCredentialNames,
  collectDeployRuntimeCredentialProjectionIssues,
  collectNpmReleaseCredentialProjectionIssues,
  collectPackageBuildCredentialProjectionIssues,
  type ProtectedApplicationImageCredential,
} from "./environment-boundary.ts";
import { loadOptionalApplicationImageCredentialCapability } from "./credential-capability.ts";
import { loadApplicationImageProviders } from "./load-providers.ts";
import { parseApplicationImageProvider } from "./options.ts";
import { selectApplicationImageProvider } from "./provider-selection.ts";
import { resolveApplicationImageCoordinates } from "./coordinates.ts";

export type ApplicationImageProviderActivation = {
  coordinates?: ResolvedApplicationImageCoordinates;
  name: string;
  protectedCredentials: ProtectedApplicationImageCredential[];
  providers?: ApplicationImageProvidersDefinition;
};

export type ActivateApplicationImageProviderOptions = {
  applicationImageProvider?: string;
  dryRun: boolean;
  hostEnv?: Record<string, string>;
  npmReleaseDefinition?: NpmReleaseDefinition;
  protectedEnvironmentNames?: string[];
};

export async function activateApplicationImageProvider(
  repo: Directory,
  packageTargets: PreparedPackageTarget[],
  options: ActivateApplicationImageProviderOptions,
): Promise<ApplicationImageProviderActivation | undefined> {
  const ociTargets = packageTargets.filter(({ plan }) => "oci" in plan);

  if (ociTargets.length === 0) {
    return undefined;
  }

  const name = parseApplicationImageProvider(
    options.applicationImageProvider ?? "off",
  );

  if (name === "off") {
    if (!options.dryRun) {
      throw new Error(
        "Live OCI image packaging requires applicationImageProvider to select a configured provider.",
      );
    }

    return {
      name,
      protectedCredentials: [],
    };
  }

  const providers = await loadApplicationImageProviders(repo);
  const selected = selectApplicationImageProvider(name, providers);
  assertApplicationImageCoordinateNameSeparation(
    providers,
    options.protectedEnvironmentNames,
  );
  const coordinates = resolveApplicationImageCoordinates(
    name,
    selected.definition!,
    options.hostEnv ?? {},
  );
  const protectedCredentials =
    collectApplicationImageCredentialNames(providers);
  const deployDefinitions = await Promise.all(
    packageTargets.map(async ({ target }) => ({
      definition: await loadDeployTargetDefinition(repo, target),
      target,
    })),
  );
  const projectionIssues = [
    ...packageTargets.flatMap(({ definition, target }) =>
      collectPackageBuildCredentialProjectionIssues(
        target,
        definition.build,
        protectedCredentials,
      ),
    ),
    ...deployDefinitions.flatMap(({ definition, target }) =>
      collectDeployRuntimeCredentialProjectionIssues(
        target,
        definition.runtime,
        protectedCredentials,
      ),
    ),
    ...(options.npmReleaseDefinition === undefined
      ? []
      : collectNpmReleaseCredentialProjectionIssues(
          options.npmReleaseDefinition,
          protectedCredentials,
        )),
  ];

  assertNoApplicationImageCredentialProjections(projectionIssues);

  return {
    coordinates,
    name,
    protectedCredentials,
    providers,
  };
}

function deploySelectionUsesNamedApplicationImageProvider(
  packageManifest: PackageManifest,
  selectedTargets: string[],
): boolean {
  return selectedTargets.some((target) => {
    const artifact = getOwnPackageManifestArtifact(packageManifest, target);

    return (
      artifact?.kind === "oci_image" &&
      (artifact.status === "published" || artifact.repository !== undefined)
    );
  });
}

export async function activateApplicationImageCredentialBoundaryForDeploy(
  repo: Directory,
  packageManifest: PackageManifest,
  selectedTargets: string[],
): Promise<ProtectedApplicationImageCredential[]> {
  if (
    !deploySelectionUsesNamedApplicationImageProvider(
      packageManifest,
      selectedTargets,
    )
  ) {
    return [];
  }

  const frozenCredentials =
    await loadOptionalApplicationImageCredentialCapability(repo);
  const protectedCredentials =
    frozenCredentials ??
    collectApplicationImageCredentialNames(
      await loadApplicationImageProviders(repo),
    );
  const definitions = await Promise.all(
    selectedTargets.map(async (target) => ({
      definition: await loadDeployTargetDefinition(repo, target),
      target,
    })),
  );

  assertNoApplicationImageCredentialProjections(
    definitions.flatMap(({ definition, target }) =>
      collectDeployRuntimeCredentialProjectionIssues(
        target,
        definition.runtime,
        protectedCredentials,
      ),
    ),
  );

  return protectedCredentials;
}
