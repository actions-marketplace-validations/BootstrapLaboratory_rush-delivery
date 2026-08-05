import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCosignPreflightCommandPlan,
  buildCosignPreflightScript,
  buildCosignPublicationCommandPlan,
  classifyCosignPreflightFailure,
  classifyCosignPreflightExitCode,
  CosignPreflightError,
  CosignToolAvailabilityError,
  COSIGN_PREFLIGHT_BUSYBOX_IMAGE,
  COSIGN_PREFLIGHT_BUSYBOX_PATH,
  materializeCosignTool,
} from "../src/application-images/cosign-plan.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
import { resolveApplicationImageCredentialValues } from "../src/application-images/provider-selection.ts";

test("pins the offline Cosign key-preflight command plan", () => {
  assert.deepEqual(buildCosignPreflightCommandPlan(), [
    {
      args: [
        "/ko-app/cosign",
        "public-key",
        "--key",
        "env://COSIGN_PRIVATE_KEY",
        "--outfile",
        "/tmp/rush-delivery-cosign-preflight/derived-public-key.pem",
      ],
      stage: "derive-private-public-key",
    },
    {
      args: [
        "/ko-app/cosign",
        "sign-blob",
        "--yes",
        "--use-signing-config=false",
        "--tlog-upload=false",
        "--key",
        "env://COSIGN_PRIVATE_KEY",
        "--bundle",
        "/tmp/rush-delivery-cosign-preflight/signature.sigstore.json",
        "/tmp/rush-delivery-cosign-preflight/challenge",
      ],
      redirectStdout: "/tmp/rush-delivery-cosign-preflight/signature-output",
      stage: "sign-challenge",
    },
    {
      args: [
        "/ko-app/cosign",
        "verify-blob",
        "--bundle",
        "/tmp/rush-delivery-cosign-preflight/signature.sigstore.json",
        "--insecure-ignore-tlog",
        "--key",
        "/tmp/rush-delivery-cosign-preflight/derived-public-key.pem",
        "/tmp/rush-delivery-cosign-preflight/challenge",
      ],
      stage: "verify-derived-key",
    },
    {
      args: [
        "/ko-app/cosign",
        "verify-blob",
        "--bundle",
        "/tmp/rush-delivery-cosign-preflight/signature.sigstore.json",
        "--insecure-ignore-tlog",
        "--key",
        "env://COSIGN_PUBLIC_KEY",
        "/tmp/rush-delivery-cosign-preflight/challenge",
      ],
      stage: "verify-configured-key",
    },
  ]);
});

test("runs the complete key preflight in one ephemeral BusyBox shell", () => {
  const plan = buildCosignPreflightCommandPlan();
  const script = buildCosignPreflightScript();

  assert.match(
    COSIGN_PREFLIGHT_BUSYBOX_IMAGE,
    /^busybox:1\.37\.0-musl@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(COSIGN_PREFLIGHT_BUSYBOX_PATH, "/usr/local/bin/busybox");
  assert.match(script, /^set -eu\numask 077\n/u);
  assert.match(script, /key preflight v1/u);

  for (const step of plan) {
    for (const argument of step.args) {
      assert.ok(
        script.includes(`'${argument}'`),
        `preflight script must retain ${step.stage} argument`,
      );
    }
  }

  assert.match(
    script,
    /2> '\/tmp\/rush-delivery-cosign-preflight\/cosign-error'/u,
  );
  assert.doesNotMatch(script, /cat .*cosign-error|printf .*cosign-error/u);
});

test("classifies only stable single-exec preflight exit codes", () => {
  assert.equal(classifyCosignPreflightExitCode(41), "signing password");
  assert.equal(classifyCosignPreflightExitCode(42), "signing private key");
  assert.equal(classifyCosignPreflightExitCode(43), "signing private key");
  assert.equal(classifyCosignPreflightExitCode(44), "verification key");
  assert.equal(
    classifyCosignPreflightExitCode(45),
    "signing/verification key pair",
  );
  assert.equal(classifyCosignPreflightExitCode(1), undefined);
});

test("pins all offline Cosign publication and verification flags", () => {
  const reference = `registry.example/platform/api@sha256:${"a".repeat(64)}`;
  const plan = buildCosignPublicationCommandPlan(reference);

  assert.deepEqual(
    plan.map(({ stage }) => stage),
    [
      "sign",
      "attest-spdx",
      "attest-provenance",
      "verify-signature",
      "verify-spdx-attestation",
      "verify-provenance-attestation",
    ],
  );

  for (const step of plan.slice(0, 3)) {
    assert.ok(step.args.includes("--tlog-upload=false"));
    assert.ok(step.args.includes("--use-signing-config=false"));
    assert.ok(step.args.includes("env://COSIGN_PRIVATE_KEY"));
    assert.equal(step.args.at(-1), reference);
    assert.equal(step.redirectStdout, "/dev/null");
  }

  for (const step of plan.slice(3)) {
    assert.ok(step.args.includes("--insecure-ignore-tlog"));
    assert.ok(step.args.includes("env://COSIGN_PUBLIC_KEY"));
    assert.equal(step.args.at(-1), reference);
    assert.equal(step.redirectStdout, "/dev/null");
  }

  for (const step of plan) {
    assert.equal(
      step.args.filter((argument) => argument === "--new-bundle-format=false")
        .length,
      1,
      `${step.stage} must pin the registry-compatible Cosign bundle format`,
    );
    assert.equal(
      step.args.some((argument) =>
        argument.startsWith("--registry-referrers-mode"),
      ),
      false,
      `${step.stage} must not opt into OCI referrers mode`,
    );
  }

  assert.deepEqual(
    plan
      .filter(({ args }) => args.includes("attest"))
      .map(({ args }) => args[args.indexOf("--type") + 1]),
    ["spdxjson", "slsaprovenance1"],
  );
  assert.deepEqual(
    plan
      .filter(({ args }) => args.includes("verify-attestation"))
      .map(({ args }) => args[args.indexOf("--type") + 1]),
    ["spdxjson", "slsaprovenance1"],
  );
});

test("classifies pinned Cosign failures without retaining tool diagnostics", () => {
  assert.equal(
    classifyCosignPreflightFailure(
      "derive-private-public-key",
      new Error("decrypt: incorrect password secret-sentinel"),
    ),
    "signing password",
  );
  assert.equal(
    classifyCosignPreflightFailure(
      "derive-private-public-key",
      new Error("PEM decoding failed secret-sentinel"),
    ),
    "signing private key",
  );
  assert.equal(
    classifyCosignPreflightFailure(
      "verify-configured-key",
      new Error("PEM decoding failed secret-sentinel"),
    ),
    "verification key",
  );
  assert.equal(
    classifyCosignPreflightFailure(
      "verify-configured-key",
      new Error("invalid signature secret-sentinel"),
    ),
    "signing/verification key pair",
  );
  assert.doesNotMatch(
    new CosignPreflightError("release", "verification key").message,
    /secret-sentinel/,
  );
});

test("classifies Cosign tool availability before credential roles", async () => {
  const sentinel = "SENTINEL_COSIGN_TOOL_FAILURE_7f51";
  let message = "";

  await assert.rejects(
    () =>
      materializeCosignTool("release", async () => {
        throw new Error(sentinel);
      }),
    (error) => {
      assert.ok(error instanceof CosignToolAvailabilityError);
      message = error.message;
      return true;
    },
  );
  assert.match(
    message,
    /Cosign preflight toolchain is unavailable before key preflight/,
  );
  assert.equal(message.includes(sentinel), false);
  assert.doesNotMatch(
    message,
    /signing private key|signing password|verification key/,
  );
});

test("credential normalization preserves raw multiline PEM input", () => {
  const providers = parseApplicationImageProviders(`
providers:
  release:
    kind: oci_registry
    registry: registry.example
    repository_prefix: example/platform
    username_env: OCI_USERNAME
    token_env: OCI_TOKEN
    signing_key_env: OCI_SIGNING_KEY
    signing_password_env: OCI_SIGNING_PASSWORD
    verification_key_env: OCI_SIGNING_PUBLIC_KEY
`);
  const privateKey = [
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "private",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
  ].join("\n");
  const publicKey = [
    "-----BEGIN PUBLIC KEY-----",
    "public",
    "-----END PUBLIC KEY-----",
  ].join("\n");
  const credentials = resolveApplicationImageCredentialValues(
    { definition: providers.providers.release, name: "release" },
    {
      OCI_SIGNING_KEY: privateKey,
      OCI_SIGNING_PASSWORD: "password",
      OCI_SIGNING_PUBLIC_KEY: publicKey,
      OCI_TOKEN: "token",
      OCI_USERNAME: "username",
    },
  );

  assert.equal(credentials.signingKey, privateKey);
  assert.equal(credentials.verificationKey, publicKey);
});
