#!/usr/bin/env node

import * as assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { connect } from "../../sdk/core.js";
import {
  buildCosignPreflightScript,
  COSIGN_PREFLIGHT_BUSYBOX_IMAGE,
  COSIGN_PREFLIGHT_BUSYBOX_PATH,
} from "../../src/application-images/cosign-plan.ts";

const COSIGN_IMAGE =
  "ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849";
const PREFLIGHT_TEMP_PATH = "/tmp/rush-delivery-cosign-preflight";

function execExitCode(error) {
  return typeof error === "object" &&
    error !== null &&
    error.name === "ExecError" &&
    Number.isInteger(error.exitCode)
    ? error.exitCode
    : undefined;
}

async function generateKeyPair(client, name, password) {
  const prefix = `/keys/${name}`;
  const generated = client
    .container()
    .from(COSIGN_IMAGE)
    .withNewFile(
      `/tmp/rush-delivery-engine-regression/key-generation-${name}`,
      `${randomBytes(16).toString("hex")}\n`,
    )
    .withDirectory("/keys", client.directory(), { owner: "65532:65532" })
    .withSecretVariable(
      "COSIGN_PASSWORD",
      client.setSecret(`${name}-generation-password`, password),
    )
    .withExec([
      "/ko-app/cosign",
      "generate-key-pair",
      "--output-key-prefix",
      prefix,
    ]);

  await generated.sync();

  return {
    privateKey: await generated.file(`${prefix}.key`).contents(),
    publicKey: await generated.file(`${prefix}.pub`).contents(),
  };
}

async function runPreflight(
  client,
  toolContainer,
  name,
  privateKey,
  password,
  publicKey,
) {
  const preflight = toolContainer
    .withNewFile(
      `/tmp/rush-delivery-engine-regression/${name}`,
      `${randomBytes(16).toString("hex")}\n`,
    )
    .withMountedTemp(PREFLIGHT_TEMP_PATH)
    .withSecretVariable(
      "COSIGN_PRIVATE_KEY",
      client.setSecret(`${name}-private-key`, privateKey),
    )
    .withSecretVariable(
      "COSIGN_PASSWORD",
      client.setSecret(`${name}-password`, password),
    )
    .withSecretVariable(
      "COSIGN_PUBLIC_KEY",
      client.setSecret(`${name}-public-key`, publicKey),
    )
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
    return 0;
  } catch (error) {
    const exitCode = execExitCode(error);

    if (exitCode === undefined) {
      throw new Error(
        "Cosign engine regression failed outside a classified exec.",
      );
    }

    if (![41, 42, 43, 44, 45].includes(exitCode)) {
      throw new Error(
        `Cosign engine regression returned an unexpected exit code ${exitCode}.`,
      );
    }

    return exitCode;
  }
}

async function canDerivePublicKey(client, toolContainer, privateKey, password) {
  try {
    await toolContainer
      .withSecretVariable(
        "COSIGN_PRIVATE_KEY",
        client.setSecret("direct-private-key", privateKey),
      )
      .withSecretVariable(
        "COSIGN_PASSWORD",
        client.setSecret("direct-password", password),
      )
      .withExec([
        "/ko-app/cosign",
        "public-key",
        "--key",
        "env://COSIGN_PRIVATE_KEY",
        "--outfile",
        "/tmp/derived-public-key.pem",
      ])
      .sync();
    return true;
  } catch {
    return false;
  }
}

async function assertRegistryBundleFlagSupport(toolContainer) {
  await Promise.all(
    ["sign", "attest", "verify", "verify-attestation"].map((command) =>
      toolContainer
        .withExec([
          "/ko-app/cosign",
          command,
          "--new-bundle-format=false",
          "--help",
        ])
        .sync(),
    ),
  );
}

await connect(async (client) => {
  const [cosignContainer, busyboxContainer] = await Promise.all([
    client.container().from(COSIGN_IMAGE).sync(),
    client.container().from(COSIGN_PREFLIGHT_BUSYBOX_IMAGE).sync(),
  ]);
  const toolContainer = await cosignContainer
    .withFile(
      COSIGN_PREFLIGHT_BUSYBOX_PATH,
      busyboxContainer.file("/bin/busybox"),
      { permissions: 0o555 },
    )
    .sync();
  await assertRegistryBundleFlagSupport(toolContainer);
  const password = `engine-preflight-${randomBytes(16).toString("hex")}`;
  const otherPassword = `engine-preflight-${randomBytes(16).toString("hex")}`;
  const [primary, other] = await Promise.all([
    generateKeyPair(client, "primary", password),
    generateKeyPair(client, "other", otherPassword),
  ]);
  const malformedPrivateKey = [
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "not-a-valid-key",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "",
  ].join("\n");
  const malformedPublicKey = [
    "-----BEGIN PUBLIC KEY-----",
    "not-a-valid-key",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");

  assert.equal(
    primary.privateKey.startsWith(
      "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    ),
    true,
  );
  assert.equal(
    primary.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"),
    true,
  );

  assert.equal(
    await canDerivePublicKey(
      client,
      toolContainer,
      primary.privateKey,
      password,
    ),
    true,
  );

  assert.equal(
    await runPreflight(
      client,
      toolContainer,
      "valid",
      primary.privateKey,
      password,
      primary.publicKey,
    ),
    0,
  );
  assert.equal(
    await runPreflight(
      client,
      toolContainer,
      "wrong-password",
      primary.privateKey,
      `${password}-wrong`,
      primary.publicKey,
    ),
    41,
  );
  assert.equal(
    await runPreflight(
      client,
      toolContainer,
      "malformed-private",
      malformedPrivateKey,
      password,
      primary.publicKey,
    ),
    42,
  );
  assert.equal(
    await runPreflight(
      client,
      toolContainer,
      "malformed-public",
      primary.privateKey,
      password,
      malformedPublicKey,
    ),
    44,
  );
  assert.equal(
    await runPreflight(
      client,
      toolContainer,
      "mismatched-public",
      primary.privateKey,
      password,
      other.publicKey,
    ),
    45,
  );
});

process.stdout.write("Cosign preflight engine regression passed.\n");
