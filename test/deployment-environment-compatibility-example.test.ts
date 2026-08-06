import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { resolveApplicationImageCoordinates } from "../src/application-images/coordinates.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
import { parseEnvFileContents } from "../src/env/env-file.ts";
import { parseRushToolchain } from "../src/rush-toolchain/parse.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const exampleRoot = path.join(
  repoRoot,
  "examples/deployment-environment-compatibility",
);

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

test("v0.9.0 compatibility fragments satisfy current and immutable schemas", async () => {
  const ajv = new Ajv2020({ allErrors: true });
  for (const [exampleName, schemaName] of [
    [
      "application-image-providers.yaml",
      "application-image-providers.schema.json",
    ],
    ["rush-toolchain.yaml", "rush-toolchain.schema.json"],
  ] as const) {
    const value = parseYaml(
      await readFile(path.join(exampleRoot, exampleName), "utf8"),
    );
    for (const schemaPath of [
      `schemas/${schemaName}`,
      `schemas/v0.9.0/${schemaName}`,
    ]) {
      const validate = ajv.compile((await readJson(schemaPath)) as AnySchema);
      assert.equal(
        validate(value),
        true,
        `${exampleName} failed ${schemaPath}: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
});

test("one provider resolves two coordinate-only deployment profiles", async () => {
  const providers = parseApplicationImageProviders(
    await readFile(
      path.join(exampleRoot, "application-image-providers.yaml"),
      "utf8",
    ),
  );
  const provider = providers.providers.release;
  const stagingEnv = parseEnvFileContents(
    await readFile(path.join(exampleRoot, "staging.plan.env"), "utf8"),
    "staging plan env",
  );
  const productionEnv = parseEnvFileContents(
    await readFile(path.join(exampleRoot, "production.plan.env"), "utf8"),
    "production plan env",
  );

  assert.deepEqual(
    resolveApplicationImageCoordinates("release", provider, stagingEnv),
    { registry: "ghcr.io", repositoryPrefix: "example-inc/staging" },
  );
  assert.deepEqual(
    resolveApplicationImageCoordinates("release", provider, productionEnv),
    { registry: "ghcr.io", repositoryPrefix: "example-inc/production" },
  );
  for (const credentialName of [
    provider.username_env,
    provider.token_env,
    provider.signing_key_env,
    provider.signing_password_env,
    provider.verification_key_env,
  ]) {
    assert.equal(credentialName in stagingEnv, false);
    assert.equal(credentialName in productionEnv, false);
  }
});

test("mixed-language example parses to the documented pinned toolchain", async () => {
  const definition = parseRushToolchain(
    await readFile(path.join(exampleRoot, "rush-toolchain.yaml"), "utf8"),
  );

  assert.equal(definition.platform, "linux/amd64");
  assert.match(definition.base_image, /@sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(
    definition.downloads.map(({ destination, format, mode }) => ({
      destination,
      format,
      mode,
    })),
    [{ destination: "/usr/local/bin/uv", format: "tar_gz", mode: "0755" }],
  );
});

test("documented launcher digest matches the executable bundled by the Action", async () => {
  const launcher = await readFile(
    path.join(repoRoot, "github-action/rush-delivery-local"),
  );
  const digest = createHash("sha256").update(launcher).digest("hex");
  const localCopyGuide = await readFile(
    path.join(repoRoot, "docs/local-copy-source-imports.md"),
    "utf8",
  );
  const tutorial = await readFile(
    path.join(repoRoot, "docs/tutorial/oci-application-images/README.md"),
    "utf8",
  );

  assert.equal(
    digest,
    "802ed18dc3bce89974d64884fe3c7ca64f3e206faa4c8c8eef237757101bd391",
  );
  assert.match(localCopyGuide, new RegExp(digest, "u"));
  assert.match(tutorial, new RegExp(digest, "u"));
  assert.match(
    localCopyGuide,
    /byte-for-byte file bundled in the\s+GitHub Action/u,
  );
});
