import { dag, type Container, type File } from "@dagger.io/dagger";

import {
  buildCosignPreflightCommandPlan,
  buildCosignPreflightScript,
  buildCosignPublicationCommandPlan,
  classifyCosignPreflightFailure,
  classifyCosignPreflightExitCode,
  CosignPreflightError,
  CosignPreflightExecutionError,
  COSIGN_PREFLIGHT_BUSYBOX_IMAGE,
  COSIGN_PREFLIGHT_BUSYBOX_PATH,
  CosignPublicationError,
  materializeCosignTool,
} from "./cosign-plan.ts";
import { withFreshExecutionCache } from "../execution/cache-buster.ts";
import type { ResolvedApplicationImageProvider } from "./resolve-provider.ts";

export {
  buildCosignPreflightCommandPlan,
  buildCosignPreflightScript,
  buildCosignPublicationCommandPlan,
  classifyCosignPreflightFailure,
  classifyCosignPreflightExitCode,
  CosignPreflightError,
  CosignPreflightExecutionError,
  CosignPublicationError,
  CosignToolAvailabilityError,
  COSIGN_PREFLIGHT_BUSYBOX_IMAGE,
  materializeCosignTool,
} from "./cosign-plan.ts";

export const COSIGN_IMAGE =
  "ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849";
export const COSIGN_VERSION = "3.1.2";

function daggerExecExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { exitCode?: unknown; name?: unknown };

  return candidate.name === "ExecError" &&
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode)
    ? candidate.exitCode
    : undefined;
}

function requireSigningProvider(
  provider: ResolvedApplicationImageProvider,
): asserts provider is ResolvedApplicationImageProvider & {
  dockerConfig: NonNullable<ResolvedApplicationImageProvider["dockerConfig"]>;
  signingKey: NonNullable<ResolvedApplicationImageProvider["signingKey"]>;
  signingPassword: NonNullable<
    ResolvedApplicationImageProvider["signingPassword"]
  >;
  verificationKey: NonNullable<
    ResolvedApplicationImageProvider["verificationKey"]
  >;
} {
  if (
    provider.name === "off" ||
    provider.dockerConfig === undefined ||
    provider.signingKey === undefined ||
    provider.signingPassword === undefined ||
    provider.verificationKey === undefined
  ) {
    throw new Error(
      "Live OCI image signing requires a fully resolved application image provider.",
    );
  }
}

export async function preflightApplicationImageProvider(
  provider: ResolvedApplicationImageProvider,
): Promise<void> {
  requireSigningProvider(provider);

  const container = await materializeCosignTool(provider.name, async () => {
    const [cosignContainer, busyboxContainer] = await Promise.all([
      dag.container().from(COSIGN_IMAGE).sync(),
      dag.container().from(COSIGN_PREFLIGHT_BUSYBOX_IMAGE).sync(),
    ]);

    return cosignContainer
      .withFile(
        COSIGN_PREFLIGHT_BUSYBOX_PATH,
        busyboxContainer.file("/bin/busybox"),
        { permissions: 0o555 },
      )
      .sync();
  });
  const preflight = withFreshExecutionCache(container, "cosign-key-preflight")
    .withMountedTemp("/tmp/rush-delivery-cosign-preflight")
    .withSecretVariable("COSIGN_PRIVATE_KEY", provider.signingKey)
    .withSecretVariable("COSIGN_PASSWORD", provider.signingPassword)
    .withSecretVariable("COSIGN_PUBLIC_KEY", provider.verificationKey)
    .withExec(
      [
        COSIGN_PREFLIGHT_BUSYBOX_PATH,
        "sh",
        "-eu",
        "-c",
        buildCosignPreflightScript(),
      ],
      { expand: false },
    );

  try {
    await preflight.sync();
  } catch (error) {
    const exitCode = daggerExecExitCode(error);

    if (exitCode !== undefined) {
      const credentialRole = classifyCosignPreflightExitCode(exitCode);

      if (credentialRole !== undefined) {
        throw new CosignPreflightError(provider.name, credentialRole);
      }
    }

    throw new CosignPreflightExecutionError(provider.name);
  }
}

export async function signAttestAndVerifyApplicationImage(
  provider: ResolvedApplicationImageProvider,
  imageReference: string,
  sbom: File,
  provenance: File,
): Promise<void> {
  requireSigningProvider(provider);

  let container: Container = dag
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
    .withFile("/evidence/provenance.json", provenance);
  container = withFreshExecutionCache(container, "cosign-publication");

  for (const step of buildCosignPublicationCommandPlan(imageReference)) {
    try {
      container = container.withExec(step.args, {
        redirectStdout: step.redirectStdout,
      });
      await container.sync();
    } catch {
      throw new CosignPublicationError(step.stage);
    }
  }
}
