import type { Container, Directory } from "@dagger.io/dagger";

import type { ApplicationImageProviderActivation } from "../../application-images/activation.ts";
import { formatApplicationImageCredentialCapability } from "../../application-images/credential-capability.ts";
import { preflightApplicationImageProvider } from "../../application-images/cosign.ts";
import { collectApplicationImageCredentialNames } from "../../application-images/environment-boundary.ts";
import { loadApplicationImageProviders } from "../../application-images/load-providers.ts";
import { parseApplicationImageProvider } from "../../application-images/options.ts";
import {
  finalizeApplicationImage,
  planApplicationImage,
  prepareApplicationImage,
  type PackageApplicationImageResult,
  type PreparedApplicationImage,
} from "../../application-images/package-image.ts";
import type { ResolvedApplicationImageProvider } from "../../application-images/resolve-provider.ts";
import { resolveApplicationImageProvider } from "../../application-images/resolve-provider.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import { logSubsection } from "../../logging/sections.ts";
import { canonicalizeFrameworkRuntime } from "../../runtime/framework-runtime.ts";
import { RUSH_WORKDIR } from "../../rush/container.ts";
import type { PackageActionPlan } from "./package-action-plan.ts";
import { assertPackageValidation } from "./package-validation.ts";
import { writePackageRuntimeMetadata } from "./package-runtime-metadata.ts";
import {
  executeOciPackageBatch,
  OCI_PUBLICATION_BOUNDARY_MESSAGE,
} from "./oci-package-results.ts";

export type NamedPackageActionPlan = {
  plan: PackageActionPlan;
  target: string;
};

export type ExecutePackagePlansOptions = {
  applicationImageProviderActivation?: ApplicationImageProviderActivation;
  applicationImageProvider?: string;
  dryRun?: boolean;
  gitSha?: string;
  hostEnv?: Record<string, string>;
  sourceRepositoryUrl?: string;
};

export type ExecutePackagePlansResult = {
  container: Container;
  repo: Directory;
};

function packagePlanKind(plan: PackageActionPlan): string {
  return "oci" in plan ? "oci_image" : plan.artifact.kind;
}

export async function executePackagePlans(
  sourceRepo: Directory,
  container: Container,
  packagePlans: NamedPackageActionPlan[],
  options: ExecutePackagePlansOptions = {},
): Promise<ExecutePackagePlansResult> {
  const ociPlans = packagePlans.filter(
    (
      entry,
    ): entry is NamedPackageActionPlan & {
      plan: Extract<PackageActionPlan, { oci: unknown }>;
    } => "oci" in entry.plan,
  );
  const dryRun = options.dryRun ?? false;
  let provider: ResolvedApplicationImageProvider | undefined;
  let credentialCapability: string | undefined;

  if (ociPlans.length > 0) {
    const providerName =
      options.applicationImageProviderActivation?.name ??
      parseApplicationImageProvider(options.applicationImageProvider ?? "off");
    const providers =
      options.applicationImageProviderActivation?.providers ??
      (providerName === "off"
        ? undefined
        : await loadApplicationImageProviders(sourceRepo));
    const protectedCredentials =
      options.applicationImageProviderActivation?.protectedCredentials ??
      (providers === undefined
        ? []
        : collectApplicationImageCredentialNames(providers));

    if (providerName !== "off") {
      credentialCapability =
        formatApplicationImageCredentialCapability(protectedCredentials);
    }
    provider = resolveApplicationImageProvider(
      providerName,
      providers,
      options.hostEnv ?? {},
      dryRun,
    );
  }

  if (provider !== undefined && !dryRun && provider.name === "off") {
    throw new Error(
      "Live OCI image packaging requires applicationImageProvider to select a configured provider.",
    );
  }

  let nextContainer = container;

  for (const { plan, target } of packagePlans) {
    logSubsection(`Package target: ${target}`);
    console.log(`[package] ${target}: ${packagePlanKind(plan)}`);

    for (const validation of plan.validations) {
      await assertPackageValidation(
        nextContainer.directory(RUSH_WORKDIR),
        validation,
        target,
      );
    }

    for (const { command, args } of plan.commands) {
      nextContainer = nextContainer.withExec([command, ...args], {
        expand: false,
      });
    }
  }

  if (ociPlans.length > 0 && !dryRun) {
    nextContainer = await nextContainer.sync();
  }

  let packagedRepo = await canonicalizeFrameworkRuntime(
    sourceRepo,
    nextContainer.directory(RUSH_WORKDIR),
  );
  const artifacts = new Map<string, PackageManifestArtifact>();

  for (const { plan, target } of packagePlans) {
    if (!("oci" in plan)) {
      artifacts.set(target, plan.artifact);
    }
  }

  if (provider === undefined) {
    return {
      container: nextContainer,
      repo: writePackageRuntimeMetadata(
        packagedRepo,
        packagePlans,
        artifacts,
        credentialCapability,
      ),
    };
  }

  const ociResults = dryRun
    ? ociPlans.map(({ plan, target }) => ({
        result: planApplicationImage(target, plan.oci, {
          dryRun,
          gitSha: options.gitSha ?? "",
          provider,
          sourceRepositoryUrl: options.sourceRepositoryUrl,
        }),
        target,
      }))
    : await executeOciPackageBatch<
        PreparedApplicationImage,
        PackageApplicationImageResult
      >(
        ociPlans.map(({ plan, target }) => ({
          finalize: (prepared: PreparedApplicationImage) =>
            finalizeApplicationImage(prepared, provider),
          prepare: () =>
            prepareApplicationImage(packagedRepo, target, plan.oci, {
              gitSha: options.gitSha ?? "",
              sourceRepositoryUrl: options.sourceRepositoryUrl,
            }),
          target,
        })),
        () => preflightApplicationImageProvider(provider),
        () => console.log(OCI_PUBLICATION_BOUNDARY_MESSAGE),
      );

  for (const { result, target } of ociResults) {
    artifacts.set(target, result.artifact);
    for (const evidenceFile of result.evidenceFiles) {
      packagedRepo = packagedRepo.withFile(
        evidenceFile.path,
        evidenceFile.file,
      );
    }
  }

  return {
    container: nextContainer,
    repo: writePackageRuntimeMetadata(
      packagedRepo,
      packagePlans,
      artifacts,
      credentialCapability,
    ),
  };
}
