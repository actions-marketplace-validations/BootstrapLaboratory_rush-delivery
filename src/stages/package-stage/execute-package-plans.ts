import type { Container, Directory } from "@dagger.io/dagger";

import { loadApplicationImageProviders } from "../../application-images/load-providers.ts";
import { parseApplicationImageProvider } from "../../application-images/options.ts";
import { packageApplicationImage } from "../../application-images/package-image.ts";
import { resolveApplicationImageProvider } from "../../application-images/resolve-provider.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import { logSubsection } from "../../logging/sections.ts";
import { RUSH_WORKDIR } from "../../rush/container.ts";
import type { PackageActionPlan } from "./package-action-plan.ts";
import {
  createPackageManifest,
  formatPackageManifest,
} from "./package-manifest.ts";
import { assertPackageValidation } from "./package-validation.ts";

const PACKAGE_MANIFEST_PATH = ".dagger/runtime/package-manifest.json";

export type NamedPackageActionPlan = {
  plan: PackageActionPlan;
  target: string;
};

export type ExecutePackagePlansOptions = {
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
    (entry): entry is NamedPackageActionPlan & {
      plan: Extract<PackageActionPlan, { oci: unknown }>;
    } => "oci" in entry.plan,
  );
  const dryRun = options.dryRun ?? false;
  const providerName = parseApplicationImageProvider(
    options.applicationImageProvider ?? "off",
  );
  const providers =
    ociPlans.length > 0 && providerName !== "off"
      ? await loadApplicationImageProviders(sourceRepo)
      : undefined;
  const provider = resolveApplicationImageProvider(
    providerName,
    providers,
    options.hostEnv ?? {},
    dryRun,
  );

  if (ociPlans.length > 0 && !dryRun && provider.name === "off") {
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

  let packagedRepo = nextContainer.directory(RUSH_WORKDIR);
  const artifacts: Record<string, PackageManifestArtifact> = {};

  for (const { plan, target } of packagePlans) {
    if (!("oci" in plan)) {
      artifacts[target] = plan.artifact;
    }
  }

  const settledOciResults = await Promise.allSettled(
    ociPlans.map(async ({ plan, target }) => ({
      result: await packageApplicationImage(packagedRepo, target, plan.oci, {
        dryRun,
        gitSha: options.gitSha ?? "",
        provider,
        sourceRepositoryUrl: options.sourceRepositoryUrl,
      }),
      target,
    })),
  );
  const failures: string[] = [];

  for (const [index, settled] of settledOciResults.entries()) {
    const target = ociPlans[index].target;

    if (settled.status === "rejected") {
      failures.push(
        `OCI package target "${target}" failed: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
      );
      continue;
    }

    artifacts[target] = settled.value.result.artifact;
    for (const evidenceFile of settled.value.result.evidenceFiles) {
      packagedRepo = packagedRepo.withFile(
        evidenceFile.path,
        evidenceFile.file,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      ["OCI application image packaging failed:", ...failures].join("\n"),
    );
  }

  const orderedArtifacts = Object.fromEntries(
    packagePlans.map(({ target }) => [target, artifacts[target]]),
  );

  return {
    container: nextContainer,
    repo: packagedRepo.withNewFile(
      PACKAGE_MANIFEST_PATH,
      formatPackageManifest(createPackageManifest(orderedArtifacts)),
    ),
  };
}
