import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { Directory } from "@dagger.io/dagger";

import {
  APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
  formatApplicationImageCredentialCapability,
  loadOptionalApplicationImageCredentialCapability,
  parseApplicationImageCredentialCapability,
} from "../src/application-images/credential-capability.ts";
import { collectApplicationImageCredentialNames } from "../src/application-images/environment-boundary.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
import { parsePackageManifest } from "../src/stages/package-stage/package-manifest.ts";
import { writePackageRuntimeMetadata } from "../src/stages/package-stage/package-runtime-metadata.ts";

const providerYaml = [
  "providers:",
  "  release:",
  "    kind: oci_registry",
  "    registry: registry.example",
  "    repository_prefix: example/release",
  "    username_env: RELEASE_USERNAME",
  "    token_env: RELEASE_TOKEN",
  "    signing_key_env: RELEASE_SIGNING_KEY",
  "    signing_password_env: RELEASE_SIGNING_PASSWORD",
  "    verification_key_env: RELEASE_VERIFICATION_KEY",
  "",
].join("\n");

const providers = parseApplicationImageProviders(providerYaml);
const credentials = collectApplicationImageCredentialNames(providers);

test("credential capability round-trips a complete canonical names-only boundary", () => {
  const formatted = formatApplicationImageCredentialCapability(
    [...credentials].reverse(),
  );
  const parsed = parseApplicationImageCredentialCapability(formatted);

  assert.deepEqual(parsed, credentials);
  assert.doesNotMatch(formatted, /registry\.example|example\/release/u);
  assert.doesNotMatch(formatted, /token-value|password-value|PRIVATE KEY/u);
});

test("credential capability rejects weakening, duplication, and unknown data", () => {
  const valid = JSON.parse(
    formatApplicationImageCredentialCapability(credentials),
  ) as {
    credentials: Array<Record<string, string>>;
    schema_version: string;
    unexpected?: boolean;
  };

  const invalidCases: Array<{ expected: RegExp; value: unknown }> = [
    {
      expected: /must protect at least one provider/u,
      value: { ...valid, credentials: [] },
    },
    {
      expected: /is missing field/u,
      value: { ...valid, credentials: valid.credentials.slice(0, -1) },
    },
    {
      expected: /must be globally unique/u,
      value: {
        ...valid,
        credentials: valid.credentials.map((credential, index) =>
          index === 1
            ? { ...credential, name: valid.credentials[0].name }
            : credential,
        ),
      },
    },
    {
      expected: /has unsupported field: unexpected/u,
      value: { ...valid, unexpected: true },
    },
  ];

  for (const { expected, value } of invalidCases) {
    assert.throws(
      () => parseApplicationImageCredentialCapability(JSON.stringify(value)),
      expected,
    );
  }
});

test("optional capability loading fails closed when an existing handoff is unreadable", async () => {
  const absentRepo = {
    async exists(): Promise<boolean> {
      return false;
    },
  } as unknown as Directory;
  assert.equal(
    await loadOptionalApplicationImageCredentialCapability(absentRepo),
    undefined,
  );

  const directoryRepo = {
    async exists(
      _path: string,
      options?: { expectedType?: string },
    ): Promise<boolean> {
      return options?.expectedType === undefined;
    },
  } as unknown as Directory;
  await assert.rejects(
    () => loadOptionalApplicationImageCredentialCapability(directoryRepo),
    /must be a regular file/u,
  );
});

test("Package writes the frozen capability before its generated manifest", () => {
  const writes: Array<{ contents: string; path: string }> = [];
  const packagedRepo = {
    withNewFile(filePath: string, contents: string): Directory {
      writes.push({ contents, path: filePath });
      return packagedRepo as unknown as Directory;
    },
  };
  writePackageRuntimeMetadata(
    packagedRepo as unknown as Directory,
    [
      {
        target: "api",
      },
    ],
    new Map([
      [
        "api",
        {
          image: "api",
          kind: "oci_image",
          platforms: ["linux/amd64"],
          repository: "registry.example/example/release/api",
          source_revision: "0123456789abcdef0123456789abcdef01234567",
          status: "planned",
        },
      ],
    ]),
    formatApplicationImageCredentialCapability(credentials),
  );

  assert.deepEqual(
    writes.map(({ path }) => path),
    [
      APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
      ".dagger/runtime/package-manifest.json",
    ],
  );
  assert.deepEqual(
    parseApplicationImageCredentialCapability(writes[0].contents),
    credentials,
  );
  assert.equal(
    parsePackageManifest(writes[1].contents).artifacts.api.kind,
    "oci_image",
  );
});

test("Package preserves a __proto__ target as an own manifest artifact", () => {
  const writes: Array<{ contents: string; path: string }> = [];
  const packagedRepo = {
    withNewFile(filePath: string, contents: string): Directory {
      writes.push({ contents, path: filePath });
      return packagedRepo as unknown as Directory;
    },
  };
  const artifact = {
    image: "prototype",
    kind: "oci_image" as const,
    platforms: ["linux/amd64"] as [string],
    source_revision: "0123456789abcdef0123456789abcdef01234567",
    status: "planned" as const,
  };

  writePackageRuntimeMetadata(
    packagedRepo as unknown as Directory,
    [{ target: "__proto__" }],
    new Map([["__proto__", artifact]]),
    undefined,
  );

  const manifest = parsePackageManifest(writes[0].contents);
  assert.equal(Object.hasOwn(manifest.artifacts, "__proto__"), true);
  assert.deepEqual(manifest.artifacts.__proto__, artifact);
  assert.equal(Object.getPrototypeOf(manifest.artifacts), Object.prototype);
});
