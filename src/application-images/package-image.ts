import { createHash } from "node:crypto";

import {
  dag,
  type Container,
  type Directory,
  type File,
  type Platform,
} from "@dagger.io/dagger";

import type {
  PlannedOciImagePackageManifestArtifact,
  PublishedOciImagePackageManifestArtifact,
} from "../model/package-manifest.ts";
import type { VulnerabilitySeverity } from "../model/package-target.ts";
import { withFreshExecutionCache } from "../execution/cache-buster.ts";
import { dockerfilePathInsideBuildContext } from "./docker-build-context.ts";
import type { OciImagePackagePlan } from "../stages/package-stage/package-action-plan.ts";
import {
  OciPackageOperationError,
  type OciPackageFinalization,
} from "../stages/package-stage/oci-package-results.ts";
import {
  CosignPublicationError,
  COSIGN_IMAGE,
  COSIGN_VERSION,
  preflightApplicationImageProvider,
  signAttestAndVerifyApplicationImage,
} from "./cosign.ts";
import {
  createPlannedApplicationImageArtifact,
  normalizeApplicationImageGitSha,
  normalizeApplicationImageSourceUrl,
} from "./planned-artifact.ts";
import { assertSafeApplicationImageTarget } from "./evidence-target.ts";
import {
  buildApplicationImageRepository,
  buildApplicationImageTagReference,
  normalizePublishedImageReference,
} from "./reference.ts";
import { sanitizeRegistryPublicationFailure } from "./publication-failure.ts";
import { isolateApplicationImagePreparationCoordinates } from "./preparation-boundary.ts";
import type { ResolvedApplicationImageProvider } from "./resolve-provider.ts";
import { rejectedVulnerabilities, type GrypeReport } from "./scan-policy.ts";

export { COSIGN_IMAGE, COSIGN_VERSION };

export const SYFT_IMAGE =
  "anchore/syft@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026";
export const SYFT_VERSION = "1.50.0";
export const GRYPE_IMAGE =
  "anchore/grype@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db";
export const GRYPE_VERSION = "0.116.1";

export type ApplicationImageEvidenceFile = {
  file: File;
  path: string;
};

export type PackageApplicationImageResult = {
  artifact:
    | PlannedOciImagePackageManifestArtifact
    | PublishedOciImagePackageManifestArtifact;
  evidenceFiles: ApplicationImageEvidenceFile[];
};

export type PackageApplicationImageOptions = {
  dryRun: boolean;
  gitSha: string;
  provider: ResolvedApplicationImageProvider;
  sourceRepositoryUrl?: string;
};

export type PrepareApplicationImageOptions = {
  gitSha: string;
  sourceRepositoryUrl?: string;
};

export type PreparedApplicationImage = {
  context: string;
  dockerfile: string;
  gitSha: string;
  image: string;
  platform: string;
  preparedSubject: Container;
  sbom: File;
  scan: File;
  scanPolicy: VulnerabilitySeverity[];
  sourceRepositoryUrl: string;
  target: string;
};

type SpdxReport = {
  SPDXID?: string;
  creationInfo?: unknown;
  dataLicense?: string;
  documentNamespace?: string;
  name?: string;
  spdxVersion?: string;
};

async function sha256File(file: File): Promise<string> {
  const contents = await file.contents();
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function buildImageContainer(
  repo: Directory,
  plan: OciImagePackagePlan,
  gitSha: string,
  sourceRepositoryUrl: string,
): Container {
  const context = plan.context === "." ? repo : repo.directory(plan.context);
  const dockerfile = dockerfilePathInsideBuildContext(
    plan.context,
    plan.dockerfile,
  );
  let image = context
    .dockerBuild({
      dockerfile,
      platform: plan.platform as Platform,
    })
    .withLabel("org.opencontainers.image.revision", gitSha);

  if (sourceRepositoryUrl.length > 0) {
    image = image.withLabel(
      "org.opencontainers.image.source",
      sourceRepositoryUrl,
    );
  }

  return image;
}

async function generateSbom(imageTarball: File): Promise<File> {
  const outputPath = "/output/sbom.spdx.json";
  const container = dag
    .container()
    .from(SYFT_IMAGE)
    .withFile("/input/image.tar", imageTarball)
    .withDirectory("/output", dag.directory())
    .withExec([
      "/syft",
      "scan",
      "oci-archive:/input/image.tar",
      "--quiet",
      "--output",
      `spdx-json=${outputPath}`,
    ]);

  await container.sync();
  const reportFile = container.file(outputPath);
  const report = JSON.parse(await reportFile.contents()) as SpdxReport;

  if (
    report.spdxVersion !== "SPDX-2.3" ||
    report.SPDXID !== "SPDXRef-DOCUMENT" ||
    report.dataLicense !== "CC0-1.0" ||
    typeof report.name !== "string" ||
    report.name.length === 0 ||
    typeof report.documentNamespace !== "string" ||
    report.documentNamespace.length === 0 ||
    typeof report.creationInfo !== "object" ||
    report.creationInfo === null
  ) {
    throw new Error("Syft did not produce a valid SPDX 2.3 JSON document.");
  }

  return reportFile;
}

async function scanImage(
  repo: Directory,
  imageTarball: File,
  policy: VulnerabilitySeverity[],
  ignoreFile?: string,
): Promise<File> {
  const outputPath = "/output/scan.json";
  const args = [
    "/grype",
    "oci-archive:/input/image.tar",
    "--quiet",
    "--output",
    "json",
    "--file",
    outputPath,
  ];
  let container = dag
    .container()
    .from(GRYPE_IMAGE)
    .withFile("/input/image.tar", imageTarball)
    .withDirectory("/output", dag.directory())
    .withMountedCache(
      "/root/.cache/grype",
      dag.cacheVolume(`rush-delivery-grype-${GRYPE_VERSION}`),
    );

  container = withFreshExecutionCache(container, "grype-scan");

  if (ignoreFile !== undefined) {
    container = container.withFile("/config/grype.yaml", repo.file(ignoreFile));
    args.push("--config", "/config/grype.yaml");
  }

  container = container.withExec(args);
  await container.sync();
  const reportFile = container.file(outputPath);
  const report = JSON.parse(await reportFile.contents()) as GrypeReport;
  const rejected = rejectedVulnerabilities(report, policy);

  if (rejected.count > 0) {
    throw new Error(
      `OCI image vulnerability policy rejected ${rejected.count} finding(s) at severities ${policy.join(", ")}${rejected.ids.length > 0 ? `: ${rejected.ids.join(", ")}` : "."}`,
    );
  }

  return reportFile;
}

function evidenceFailureStage(index: number, error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (index === 0) {
    return message.startsWith("Syft did not produce")
      ? "SPDX SBOM validation"
      : "Syft SBOM generation";
  }

  if (message.startsWith("Grype produced invalid scanner output")) {
    return "Grype scanner output validation";
  }

  if (message.startsWith("OCI image vulnerability policy rejected")) {
    return "Grype vulnerability policy";
  }

  return "Grype scan execution";
}

function formatProvenance(
  prepared: PreparedApplicationImage,
  imageDigest: string,
): string {
  return `${JSON.stringify(
    {
      buildDefinition: {
        buildType:
          "https://bootstraplaboratory.github.io/rush-delivery/build-types/oci-image/v0.8.1",
        externalParameters: {
          context: prepared.context,
          dockerfile: prepared.dockerfile,
          image: prepared.image,
          package_target: prepared.target,
          platform: prepared.platform,
        },
        internalParameters: {
          package_manifest_contract: "rush-delivery-package-manifest/v2",
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: prepared.gitSha },
            uri:
              prepared.sourceRepositoryUrl || "urn:rush-delivery:local-source",
          },
        ],
      },
      runDetails: {
        builder: {
          id: "https://github.com/BootstrapLaboratory/rush-delivery@v0.8.1",
        },
        metadata: {
          invocationId: `${prepared.target}:${prepared.gitSha}:${imageDigest}`,
        },
      },
    },
    null,
    2,
  )}\n`;
}

function requireLiveProvider(
  provider: ResolvedApplicationImageProvider,
): asserts provider is ResolvedApplicationImageProvider & {
  definition: NonNullable<ResolvedApplicationImageProvider["definition"]>;
  coordinates: NonNullable<ResolvedApplicationImageProvider["coordinates"]>;
  dockerConfig: NonNullable<ResolvedApplicationImageProvider["dockerConfig"]>;
  registryToken: NonNullable<ResolvedApplicationImageProvider["registryToken"]>;
  signingKey: NonNullable<ResolvedApplicationImageProvider["signingKey"]>;
  signingPassword: NonNullable<
    ResolvedApplicationImageProvider["signingPassword"]
  >;
  username: string;
  verificationKey: NonNullable<
    ResolvedApplicationImageProvider["verificationKey"]
  >;
} {
  if (
    provider.name === "off" ||
    provider.coordinates === undefined ||
    provider.definition === undefined ||
    provider.dockerConfig === undefined ||
    provider.registryToken === undefined ||
    provider.signingKey === undefined ||
    provider.signingPassword === undefined ||
    provider.username === undefined ||
    provider.verificationKey === undefined
  ) {
    throw new Error(
      "Live OCI image packaging requires a fully resolved application image provider.",
    );
  }
}

export function planApplicationImage(
  target: string,
  plan: OciImagePackagePlan,
  options: PackageApplicationImageOptions,
): PackageApplicationImageResult {
  assertSafeApplicationImageTarget(target);
  const gitSha = normalizeApplicationImageGitSha(options.gitSha);
  normalizeApplicationImageSourceUrl(options.sourceRepositoryUrl);

  return {
    artifact: createPlannedApplicationImageArtifact(
      plan,
      gitSha,
      options.provider.coordinates,
    ),
    evidenceFiles: [],
  };
}

export async function prepareApplicationImage(
  repo: Directory,
  target: string,
  plan: OciImagePackagePlan,
  options: PrepareApplicationImageOptions,
): Promise<PreparedApplicationImage> {
  assertSafeApplicationImageTarget(target);
  const gitSha = normalizeApplicationImageGitSha(options.gitSha);
  const sourceRepositoryUrl = normalizeApplicationImageSourceUrl(
    options.sourceRepositoryUrl,
  );
  const preparedSubject = buildImageContainer(
    repo,
    plan,
    gitSha,
    sourceRepositoryUrl,
  );
  let imageTarball: File;

  try {
    imageTarball = await preparedSubject.asTarball().sync();
  } catch {
    throw new OciPackageOperationError("Docker image build");
  }

  const evidence = await Promise.allSettled([
    generateSbom(imageTarball),
    scanImage(repo, imageTarball, plan.scan.fail_on, plan.scan.ignore_file),
  ]);
  const failedStages = evidence.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [evidenceFailureStage(index, outcome.reason)]
      : [],
  );

  if (failedStages.length > 0) {
    throw new OciPackageOperationError(failedStages.join(" and "));
  }

  const [sbomResult, scanResult] = evidence;

  if (sbomResult.status !== "fulfilled" || scanResult.status !== "fulfilled") {
    throw new OciPackageOperationError("evidence preparation");
  }

  return {
    context: plan.context,
    dockerfile: plan.dockerfile,
    gitSha,
    image: plan.image,
    platform: plan.platform,
    preparedSubject,
    sbom: sbomResult.value,
    scan: scanResult.value,
    scanPolicy: plan.scan.fail_on,
    sourceRepositoryUrl,
    target,
  };
}

export async function finalizeApplicationImage(
  prepared: PreparedApplicationImage,
  provider: ResolvedApplicationImageProvider,
): Promise<OciPackageFinalization<PackageApplicationImageResult>> {
  requireLiveProvider(provider);
  const liveRepository = buildApplicationImageRepository(
    provider.coordinates,
    prepared.image,
  );
  const tagReference = buildApplicationImageTagReference(
    liveRepository,
    prepared.gitSha,
  );
  let returnedReference: string;

  try {
    returnedReference = await prepared.preparedSubject
      .withRegistryAuth(
        provider.coordinates.registry,
        provider.username,
        provider.registryToken,
      )
      .publish(tagReference);
  } catch (error) {
    throw sanitizeRegistryPublicationFailure(error);
  }

  let published: ReturnType<typeof normalizePublishedImageReference>;

  try {
    published = normalizePublishedImageReference(
      liveRepository,
      tagReference,
      returnedReference,
    );
  } catch {
    throw new OciPackageOperationError(
      "returned publication reference validation",
    );
  }

  let provenance: File;

  try {
    provenance = dag
      .directory()
      .withNewFile(
        "provenance.json",
        formatProvenance(prepared, published.digest),
      )
      .file("provenance.json");
  } catch {
    throw new OciPackageOperationError(
      "provenance construction",
      published.reference,
    );
  }

  try {
    await signAttestAndVerifyApplicationImage(
      provider,
      published.reference,
      prepared.sbom,
      provenance,
    );
  } catch (error) {
    throw new OciPackageOperationError(
      error instanceof CosignPublicationError
        ? `Cosign ${error.stage}`
        : "Cosign signing/attestation/verification",
      published.reference,
    );
  }

  const evidenceDirectory = `.dagger/runtime/evidence/${prepared.target}`;
  const sbomPath = `${evidenceDirectory}/sbom.spdx.json`;
  const scanPath = `${evidenceDirectory}/scan.json`;
  const provenancePath = `${evidenceDirectory}/provenance.json`;
  let result: PackageApplicationImageResult;

  try {
    result = {
      artifact: {
        digest: published.digest,
        evidence: {
          provenance: {
            digest: await sha256File(provenance),
            format: "slsa-provenance-v1",
            path: provenancePath,
            subject_digest: published.digest,
          },
          sbom: {
            digest: await sha256File(prepared.sbom),
            format: "spdx-json",
            path: sbomPath,
            subject_digest: published.digest,
          },
          scan: {
            digest: await sha256File(prepared.scan),
            path: scanPath,
            policy: prepared.scanPolicy,
            result: "passed",
            scanner: `grype-${GRYPE_VERSION}`,
          },
          signature: {
            kind: "sigstore",
            reference: published.reference,
            verified: true,
          },
        },
        image: prepared.image,
        kind: "oci_image",
        platforms: [prepared.platform],
        reference: published.reference,
        repository: published.repository,
        source_revision: prepared.gitSha,
        status: "published",
      },
      evidenceFiles: [
        { file: provenance, path: provenancePath },
        { file: prepared.sbom, path: sbomPath },
        { file: prepared.scan, path: scanPath },
      ],
    };
  } catch {
    throw new OciPackageOperationError(
      "evidence finalization",
      published.reference,
    );
  }

  return { publishedReference: published.reference, result };
}

export async function packageApplicationImage(
  repo: Directory,
  target: string,
  plan: OciImagePackagePlan,
  options: PackageApplicationImageOptions,
): Promise<PackageApplicationImageResult> {
  if (options.dryRun) {
    return planApplicationImage(target, plan, options);
  }

  requireLiveProvider(options.provider);
  await preflightApplicationImageProvider(options.provider);
  const prepared = await prepareApplicationImage(
    repo,
    target,
    plan,
    isolateApplicationImagePreparationCoordinates(options),
  );
  return (await finalizeApplicationImage(prepared, options.provider)).result;
}
