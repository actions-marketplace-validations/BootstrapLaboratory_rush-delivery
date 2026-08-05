const COSIGN_BINARY = "/ko-app/cosign";
export const COSIGN_PREFLIGHT_BUSYBOX_VERSION = "1.37.0-musl";
export const COSIGN_PREFLIGHT_BUSYBOX_IMAGE =
  "busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
export const COSIGN_PREFLIGHT_BUSYBOX_PATH = "/usr/local/bin/busybox";
const PRIVATE_KEY_REFERENCE = "env://COSIGN_PRIVATE_KEY";
const PUBLIC_KEY_REFERENCE = "env://COSIGN_PUBLIC_KEY";
export const COSIGN_PREFLIGHT_CHALLENGE_PATH =
  "/tmp/rush-delivery-cosign-preflight/challenge";
const PREFLIGHT_DERIVED_PUBLIC_KEY_PATH =
  "/tmp/rush-delivery-cosign-preflight/derived-public-key.pem";
const PREFLIGHT_BUNDLE_PATH =
  "/tmp/rush-delivery-cosign-preflight/signature.sigstore.json";
const PREFLIGHT_ERROR_PATH = "/tmp/rush-delivery-cosign-preflight/cosign-error";

const COSIGN_PREFLIGHT_EXIT_CODES = {
  signingPassword: 41,
  signingPrivateKey: 42,
  derivedKeyVerification: 43,
  verificationKey: 44,
  keyPairMismatch: 45,
} as const;

export type CosignPreflightStage =
  | "derive-private-public-key"
  | "sign-challenge"
  | "verify-configured-key"
  | "verify-derived-key";

export type CosignPublicationStage =
  | "attest-provenance"
  | "attest-spdx"
  | "sign"
  | "verify-provenance-attestation"
  | "verify-signature"
  | "verify-spdx-attestation";

export type CosignCommandStep<TStage extends string> = {
  args: string[];
  redirectStdout?: string;
  stage: TStage;
};

export class CosignPreflightError extends Error {
  readonly credentialRole:
    | "signing password"
    | "signing private key"
    | "signing/verification key pair"
    | "verification key";
  readonly providerName: string;

  constructor(
    providerName: string,
    credentialRole: CosignPreflightError["credentialRole"],
  ) {
    super(
      `Application image provider "${providerName}" Cosign preflight failed for ${credentialRole}.`,
    );
    this.name = "CosignPreflightError";
    this.credentialRole = credentialRole;
    this.providerName = providerName;
  }
}

export class CosignToolAvailabilityError extends Error {
  readonly providerName: string;

  constructor(providerName: string) {
    super(
      `Application image provider "${providerName}" Cosign preflight toolchain is unavailable before key preflight.`,
    );
    this.name = "CosignToolAvailabilityError";
    this.providerName = providerName;
  }
}

export class CosignPreflightExecutionError extends Error {
  readonly providerName: string;

  constructor(providerName: string) {
    super(
      `Application image provider "${providerName}" Cosign key preflight could not complete.`,
    );
    this.name = "CosignPreflightExecutionError";
    this.providerName = providerName;
  }
}

export async function materializeCosignTool<T>(
  providerName: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch {
    throw new CosignToolAvailabilityError(providerName);
  }
}

export class CosignPublicationError extends Error {
  readonly stage: CosignPublicationStage;

  constructor(stage: CosignPublicationStage) {
    super(`Cosign ${stage} failed.`);
    this.name = "CosignPublicationError";
    this.stage = stage;
  }
}

export function buildCosignPreflightCommandPlan(): CosignCommandStep<CosignPreflightStage>[] {
  const verifyArgs = [
    COSIGN_BINARY,
    "verify-blob",
    "--bundle",
    PREFLIGHT_BUNDLE_PATH,
    "--insecure-ignore-tlog",
  ];

  return [
    {
      args: [
        COSIGN_BINARY,
        "public-key",
        "--key",
        PRIVATE_KEY_REFERENCE,
        "--outfile",
        PREFLIGHT_DERIVED_PUBLIC_KEY_PATH,
      ],
      stage: "derive-private-public-key",
    },
    {
      args: [
        COSIGN_BINARY,
        "sign-blob",
        "--yes",
        "--use-signing-config=false",
        "--tlog-upload=false",
        "--key",
        PRIVATE_KEY_REFERENCE,
        "--bundle",
        PREFLIGHT_BUNDLE_PATH,
        COSIGN_PREFLIGHT_CHALLENGE_PATH,
      ],
      redirectStdout: "/tmp/rush-delivery-cosign-preflight/signature-output",
      stage: "sign-challenge",
    },
    {
      args: [
        ...verifyArgs,
        "--key",
        PREFLIGHT_DERIVED_PUBLIC_KEY_PATH,
        COSIGN_PREFLIGHT_CHALLENGE_PATH,
      ],
      stage: "verify-derived-key",
    },
    {
      args: [
        ...verifyArgs,
        "--key",
        PUBLIC_KEY_REFERENCE,
        COSIGN_PREFLIGHT_CHALLENGE_PATH,
      ],
      stage: "verify-configured-key",
    },
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(step: CosignCommandStep<CosignPreflightStage>): string {
  return step.args.map(shellQuote).join(" ");
}

export function buildCosignPreflightScript(): string {
  const [deriveKey, signChallenge, verifyDerivedKey, verifyConfiguredKey] =
    buildCosignPreflightCommandPlan();
  const busybox = shellQuote(COSIGN_PREFLIGHT_BUSYBOX_PATH);
  const errorPath = shellQuote(PREFLIGHT_ERROR_PATH);

  return [
    "set -eu",
    "umask 077",
    `${busybox} printf '%s\\n' 'rush-delivery application-image provider key preflight v1' > ${shellQuote(COSIGN_PREFLIGHT_CHALLENGE_PATH)}`,
    `if ! ${shellCommand(deriveKey)} > /dev/null 2> ${errorPath}; then`,
    `  if ${busybox} grep -Eiq 'decrypt|password' ${errorPath}; then exit ${COSIGN_PREFLIGHT_EXIT_CODES.signingPassword}; fi`,
    `  exit ${COSIGN_PREFLIGHT_EXIT_CODES.signingPrivateKey}`,
    "fi",
    `if ! ${shellCommand(signChallenge)} > ${shellQuote(signChallenge.redirectStdout!)} 2> ${errorPath}; then`,
    `  if ${busybox} grep -Eiq 'decrypt|password' ${errorPath}; then exit ${COSIGN_PREFLIGHT_EXIT_CODES.signingPassword}; fi`,
    `  exit ${COSIGN_PREFLIGHT_EXIT_CODES.signingPrivateKey}`,
    "fi",
    `if ! ${shellCommand(verifyDerivedKey)} > /dev/null 2> ${errorPath}; then`,
    `  exit ${COSIGN_PREFLIGHT_EXIT_CODES.derivedKeyVerification}`,
    "fi",
    `if ! ${shellCommand(verifyConfiguredKey)} > /dev/null 2> ${errorPath}; then`,
    `  if ${busybox} grep -Eiq 'invalid signature' ${errorPath}; then exit ${COSIGN_PREFLIGHT_EXIT_CODES.keyPairMismatch}; fi`,
    `  exit ${COSIGN_PREFLIGHT_EXIT_CODES.verificationKey}`,
    "fi",
  ].join("\n");
}

export function classifyCosignPreflightExitCode(
  exitCode: number,
): CosignPreflightError["credentialRole"] | undefined {
  switch (exitCode) {
    case COSIGN_PREFLIGHT_EXIT_CODES.signingPassword:
      return "signing password";
    case COSIGN_PREFLIGHT_EXIT_CODES.signingPrivateKey:
    case COSIGN_PREFLIGHT_EXIT_CODES.derivedKeyVerification:
      return "signing private key";
    case COSIGN_PREFLIGHT_EXIT_CODES.verificationKey:
      return "verification key";
    case COSIGN_PREFLIGHT_EXIT_CODES.keyPairMismatch:
      return "signing/verification key pair";
    default:
      return undefined;
  }
}

export function buildCosignPublicationCommandPlan(
  imageReference: string,
): CosignCommandStep<CosignPublicationStage>[] {
  const signingArgs = [
    "--new-bundle-format=false",
    "--key",
    PRIVATE_KEY_REFERENCE,
  ];
  const verificationArgs = [
    "--new-bundle-format=false",
    "--key",
    PUBLIC_KEY_REFERENCE,
    "--insecure-ignore-tlog",
  ];

  return [
    {
      args: [
        COSIGN_BINARY,
        "sign",
        "--yes",
        "--use-signing-config=false",
        "--tlog-upload=false",
        ...signingArgs,
        imageReference,
      ],
      redirectStdout: "/dev/null",
      stage: "sign",
    },
    {
      args: [
        COSIGN_BINARY,
        "attest",
        "--yes",
        "--use-signing-config=false",
        "--tlog-upload=false",
        "--predicate",
        "/evidence/sbom.spdx.json",
        "--type",
        "spdxjson",
        ...signingArgs,
        imageReference,
      ],
      redirectStdout: "/dev/null",
      stage: "attest-spdx",
    },
    {
      args: [
        COSIGN_BINARY,
        "attest",
        "--yes",
        "--use-signing-config=false",
        "--tlog-upload=false",
        "--predicate",
        "/evidence/provenance.json",
        "--type",
        "slsaprovenance1",
        ...signingArgs,
        imageReference,
      ],
      redirectStdout: "/dev/null",
      stage: "attest-provenance",
    },
    {
      args: [COSIGN_BINARY, "verify", ...verificationArgs, imageReference],
      redirectStdout: "/dev/null",
      stage: "verify-signature",
    },
    {
      args: [
        COSIGN_BINARY,
        "verify-attestation",
        ...verificationArgs,
        "--type",
        "spdxjson",
        imageReference,
      ],
      redirectStdout: "/dev/null",
      stage: "verify-spdx-attestation",
    },
    {
      args: [
        COSIGN_BINARY,
        "verify-attestation",
        ...verificationArgs,
        "--type",
        "slsaprovenance1",
        imageReference,
      ],
      redirectStdout: "/dev/null",
      stage: "verify-provenance-attestation",
    },
  ];
}

export function classifyCosignPreflightFailure(
  stage: CosignPreflightStage,
  error: unknown,
): CosignPreflightError["credentialRole"] {
  const message = error instanceof Error ? error.message : String(error);

  if (stage === "derive-private-public-key" || stage === "sign-challenge") {
    return /decrypt|password/i.test(message)
      ? "signing password"
      : "signing private key";
  }

  if (stage === "verify-configured-key") {
    return /invalid signature/i.test(message)
      ? "signing/verification key pair"
      : "verification key";
  }

  return "signing private key";
}
