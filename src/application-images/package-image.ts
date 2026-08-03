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
import type { OciImagePackagePlan } from "../stages/package-stage/package-action-plan.ts";
import {
  buildApplicationImageRepository,
  buildApplicationImageTagReference,
  normalizePublishedImageReference,
} from "./reference.ts";
import type { ResolvedApplicationImageProvider } from "./resolve-provider.ts";
import {
  createPlannedApplicationImageArtifact,
  normalizeApplicationImageGitSha,
  normalizeApplicationImageSourceUrl,
} from "./planned-artifact.ts";
import { rejectedVulnerabilities, type GrypeReport } from "./scan-policy.ts";

export const SYFT_IMAGE =
  "anchore/syft@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026";
export const SYFT_VERSION = "1.50.0";
export const GRYPE_IMAGE =
  "anchore/grype@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db";
export const GRYPE_VERSION = "0.116.1";
export const COSIGN_IMAGE =
  "ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849";
export const COSIGN_VERSION = "3.1.2";

const TARGET_NAME_PATTERN = /^[A-Za-z0-9@._-]+$/;

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

type SpdxReport = {
  SPDXID?: string;
  creationInfo?: unknown;
  dataLicense?: string;
  documentNamespace?: string;
  name?: string;
  spdxVersion?: string;
};

function validateTarget(target: string): void {
  if (!TARGET_NAME_PATTERN.test(target)) {
    throw new Error(
      `OCI image package target "${target}" cannot be used as an evidence directory name.`,
    );
  }
}

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
  let image = context
    .dockerBuild({
      dockerfile: plan.dockerfile,
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

function formatProvenance(
  target: string,
  plan: OciImagePackagePlan,
  gitSha: string,
  sourceRepositoryUrl: string,
  imageDigest: string,
): string {
  return `${JSON.stringify(
    {
      buildDefinition: {
        buildType:
          "https://bootstraplaboratory.github.io/rush-delivery/build-types/oci-image/v0.8.0",
        externalParameters: {
          context: plan.context,
          dockerfile: plan.dockerfile,
          image: plan.image,
          package_target: target,
          platform: plan.platform,
        },
        internalParameters: {
          package_manifest_contract: "rush-delivery-package-manifest/v2",
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: gitSha },
            uri: sourceRepositoryUrl || "urn:rush-delivery:local-source",
          },
        ],
      },
      runDetails: {
        builder: {
          id: "https://github.com/BootstrapLaboratory/rush-delivery@v0.8.0",
        },
        metadata: {
          invocationId: `${target}:${gitSha}:${imageDigest}`,
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

async function signAndVerify(
  provider: ResolvedApplicationImageProvider,
  imageReference: string,
  sbom: File,
  provenance: File,
): Promise<void> {
  requireLiveProvider(provider);

  const commonAuthArgs = ["--key", "env://COSIGN_PRIVATE_KEY"];
  const commonVerifyArgs = [
    "--key",
    "env://COSIGN_PUBLIC_KEY",
    "--insecure-ignore-tlog",
  ];
  const container = dag
    .container()
    .from(COSIGN_IMAGE)
    .withEnvVariable("DOCKER_CONFIG", "/home/nonroot/.docker")
    .withMountedSecret(
      "/home/nonroot/.docker/config.json",
      provider.dockerConfig,
      { mode: 0o400, owner: "65532:65532" },
    )
    .withSecretVariable("COSIGN_PRIVATE_KEY", provider.signingKey)
    .withSecretVariable("COSIGN_PASSWORD", provider.signingPassword)
    .withSecretVariable("COSIGN_PUBLIC_KEY", provider.verificationKey)
    .withFile("/evidence/sbom.spdx.json", sbom)
    .withFile("/evidence/provenance.json", provenance)
    .withExec([
      "/ko-app/cosign",
      "sign",
      "--yes",
      "--use-signing-config=false",
      "--tlog-upload=false",
      ...commonAuthArgs,
      imageReference,
    ])
    .withExec([
      "/ko-app/cosign",
      "attest",
      "--yes",
      "--use-signing-config=false",
      "--tlog-upload=false",
      "--predicate",
      "/evidence/sbom.spdx.json",
      "--type",
      "spdxjson",
      ...commonAuthArgs,
      imageReference,
    ])
    .withExec([
      "/ko-app/cosign",
      "attest",
      "--yes",
      "--use-signing-config=false",
      "--tlog-upload=false",
      "--predicate",
      "/evidence/provenance.json",
      "--type",
      "slsaprovenance1",
      ...commonAuthArgs,
      imageReference,
    ])
    .withExec(["/ko-app/cosign", "verify", ...commonVerifyArgs, imageReference])
    .withExec([
      "/ko-app/cosign",
      "verify-attestation",
      ...commonVerifyArgs,
      "--type",
      "spdxjson",
      imageReference,
    ])
    .withExec([
      "/ko-app/cosign",
      "verify-attestation",
      ...commonVerifyArgs,
      "--type",
      "slsaprovenance1",
      imageReference,
    ]);

  await container.sync();
}

export async function packageApplicationImage(
  repo: Directory,
  target: string,
  plan: OciImagePackagePlan,
  options: PackageApplicationImageOptions,
): Promise<PackageApplicationImageResult> {
  validateTarget(target);
  const gitSha = normalizeApplicationImageGitSha(options.gitSha);
  const sourceRepositoryUrl = normalizeApplicationImageSourceUrl(
    options.sourceRepositoryUrl,
  );
  if (options.dryRun) {
    return {
      artifact: createPlannedApplicationImageArtifact(
        plan,
        gitSha,
        options.provider.definition,
      ),
      evidenceFiles: [],
    };
  }

  requireLiveProvider(options.provider);
  const liveRepository = buildApplicationImageRepository(
    options.provider.definition,
    plan.image,
  );
  const tagReference = buildApplicationImageTagReference(
    liveRepository,
    gitSha,
  );
  const image = buildImageContainer(repo, plan, gitSha, sourceRepositoryUrl);
  const imageTarball = image.asTarball();
  const [sbom, scan] = await Promise.all([
    generateSbom(imageTarball),
    scanImage(repo, imageTarball, plan.scan.fail_on, plan.scan.ignore_file),
  ]);
  const publishedReference = await image
    .withRegistryAuth(
      options.provider.definition.registry,
      options.provider.username,
      options.provider.registryToken,
    )
    .publish(tagReference);
  const published = normalizePublishedImageReference(
    liveRepository,
    tagReference,
    publishedReference,
  );
  const provenanceContents = formatProvenance(
    target,
    plan,
    gitSha,
    sourceRepositoryUrl,
    published.digest,
  );
  const provenance = dag
    .directory()
    .withNewFile("provenance.json", provenanceContents)
    .file("provenance.json");

  try {
    await signAndVerify(
      options.provider,
      published.reference,
      sbom,
      provenance,
    );
  } catch (error) {
    throw new Error(
      `OCI image was published at ${published.reference}, but signing or verification failed; the registry may retain the image and navigation tag: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const evidenceDirectory = `.dagger/runtime/evidence/${target}`;
  const sbomPath = `${evidenceDirectory}/sbom.spdx.json`;
  const scanPath = `${evidenceDirectory}/scan.json`;
  const provenancePath = `${evidenceDirectory}/provenance.json`;

  return {
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
          digest: await sha256File(sbom),
          format: "spdx-json",
          path: sbomPath,
          subject_digest: published.digest,
        },
        scan: {
          digest: await sha256File(scan),
          path: scanPath,
          policy: plan.scan.fail_on,
          result: "passed",
          scanner: `grype-${GRYPE_VERSION}`,
        },
        signature: {
          kind: "sigstore",
          reference: published.reference,
          verified: true,
        },
      },
      image: plan.image,
      kind: "oci_image",
      platforms: [plan.platform],
      reference: published.reference,
      repository: published.repository,
      source_revision: gitSha,
      status: "published",
    },
    evidenceFiles: [
      { file: provenance, path: provenancePath },
      { file: sbom, path: sbomPath },
      { file: scan, path: scanPath },
    ],
  };
}
