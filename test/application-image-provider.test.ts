import * as assert from "node:assert/strict";
import { test } from "node:test";

import { parseApplicationImageProvider } from "../src/application-images/options.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
import { resolveApplicationImageCoordinates } from "../src/application-images/coordinates.ts";
import {
  resolveApplicationImageCredentialValues,
  selectApplicationImageProvider,
} from "../src/application-images/provider-selection.ts";

const providersYaml = `
providers:
  release:
    kind: oci_registry
    registry: registry.example.test:5000
    repository_prefix: example/platform
    username_env: OCI_USERNAME
    token_env: OCI_TOKEN
    signing_key_env: OCI_SIGNING_KEY
    signing_password_env: OCI_SIGNING_PASSWORD
    verification_key_env: OCI_SIGNING_PUBLIC_KEY
`;

test("parses generic application image provider metadata", () => {
  assert.deepStrictEqual(parseApplicationImageProviders(providersYaml), {
    providers: {
      release: {
        kind: "oci_registry",
        registry: "registry.example.test:5000",
        repository_prefix: "example/platform",
        signing_key_env: "OCI_SIGNING_KEY",
        signing_password_env: "OCI_SIGNING_PASSWORD",
        token_env: "OCI_TOKEN",
        username_env: "OCI_USERNAME",
        verification_key_env: "OCI_SIGNING_PUBLIC_KEY",
      },
    },
  });
});

test("accepts off and normalized named provider options", () => {
  assert.equal(parseApplicationImageProvider("off"), "off");
  assert.equal(parseApplicationImageProvider("release-eu"), "release-eu");
});

test("parses every static and environment-backed coordinate combination", () => {
  for (const [registryField, repositoryField] of [
    ["registry: registry.example", "repository_prefix: example/platform"],
    ["registry: registry.example", "repository_prefix_env: OCI_REPOSITORY"],
    ["registry_env: OCI_REGISTRY", "repository_prefix: example/platform"],
    ["registry_env: OCI_REGISTRY", "repository_prefix_env: OCI_REPOSITORY"],
  ]) {
    const parsed = parseApplicationImageProviders(`
providers:
  release:
    kind: oci_registry
    ${registryField}
    ${repositoryField}
    username_env: OCI_USERNAME
    token_env: OCI_TOKEN
    signing_key_env: OCI_SIGNING_KEY
    signing_password_env: OCI_SIGNING_PASSWORD
    verification_key_env: OCI_SIGNING_PUBLIC_KEY
`);
    const reads: string[] = [];
    const hostEnv = new Proxy(
      {
        OCI_REGISTRY: "registry.example",
        OCI_REPOSITORY: "example/platform",
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    assert.deepEqual(
      resolveApplicationImageCoordinates(
        "release",
        parsed.providers.release,
        hostEnv,
      ),
      {
        registry: "registry.example",
        repositoryPrefix: "example/platform",
      },
    );
    assert.deepEqual(
      reads,
      [
        ...(registryField.includes("_env") ? ["OCI_REGISTRY"] : []),
        ...(repositoryField.includes("_env") ? ["OCI_REPOSITORY"] : []),
      ],
    );
  }
});

test("rejects missing and conflicting coordinate XOR fields", () => {
  for (const replacement of [
    "registry: registry.example.test:5000\n    registry_env: OCI_REGISTRY",
    "",
    "repository_prefix: example/platform\n    repository_prefix_env: OCI_REPOSITORY",
  ]) {
    const source = replacement.includes("repository_prefix")
      ? providersYaml.replace(
          "repository_prefix: example/platform",
          replacement,
        )
      : providersYaml.replace("registry: registry.example.test:5000", replacement);

    assert.throws(
      () => parseApplicationImageProviders(source),
      /must define exactly one of/,
    );
  }
});

test("redacts invalid dynamic coordinate values", () => {
  const providers = parseApplicationImageProviders(
    providersYaml
      .replace("registry: registry.example.test:5000", "registry_env: OCI_REGISTRY")
      .replace(
        "repository_prefix: example/platform",
        "repository_prefix_env: OCI_REPOSITORY",
      ),
  );
  const sentinel = "https://SENTINEL_COORDINATE.invalid/Upper";
  let message = "";

  assert.throws(
    () =>
      resolveApplicationImageCoordinates(
        "release",
        providers.providers.release,
        {
          OCI_REGISTRY: sentinel,
          OCI_REPOSITORY: "example/platform",
        },
      ),
    (error) => {
      message = error instanceof Error ? error.message : String(error);
      return true;
    },
  );
  assert.equal(message.includes(sentinel), false);
  assert.match(message, /registry from environment OCI_REGISTRY/);
});

test("rejects coordinate names that alias credentials, each other, or framework names", () => {
  for (const coordinateName of ["OCI_TOKEN", "GIT_SHA", "ARTIFACT_PATH"]) {
    assert.throws(
      () =>
        parseApplicationImageProviders(
          providersYaml.replace(
            "registry: registry.example.test:5000",
            `registry_env: ${coordinateName}`,
          ),
        ),
      /coordinate environment names must be public and distinct/,
    );
  }

  assert.throws(
    () =>
      parseApplicationImageProviders(
        providersYaml
          .replace(
            "registry: registry.example.test:5000",
            "registry_env: OCI_COORDINATE",
          )
          .replace(
            "repository_prefix: example/platform",
            "repository_prefix_env: OCI_COORDINATE",
          ),
      ),
    /aliases provider "release" field/,
  );
});

test("rejects reserved off provider metadata", () => {
  assert.throws(
    () =>
      parseApplicationImageProviders(`
providers:
  off:
    kind: oci_registry
`),
    /name "off" is invalid or reserved/,
  );
});

test("rejects provider registry URLs", () => {
  assert.throws(
    () =>
      parseApplicationImageProviders(
        providersYaml.replace(
          "registry.example.test:5000",
          "https://registry.example.test",
        ),
      ),
    /registry must be an OCI registry authority/,
  );
});

test("rejects invalid provider credential env names", () => {
  assert.throws(
    () =>
      parseApplicationImageProviders(
        providersYaml.replace("OCI_TOKEN", "oci-token"),
      ),
    /token_env "oci-token" must match/,
  );
});

test("rejects credential env aliases within one provider before value lookup", () => {
  assert.throws(
    () =>
      parseApplicationImageProviders(
        providersYaml.replace(
          "token_env: OCI_TOKEN",
          "token_env: OCI_USERNAME",
        ),
      ),
    /environment names must be globally unique:[\s\S]+OCI_USERNAME[\s\S]+username_env[\s\S]+token_env/,
  );
});

test("rejects credential env aliases across providers deterministically", () => {
  assert.throws(
    () =>
      parseApplicationImageProviders(`${providersYaml}
  staging:
    kind: oci_registry
    registry: registry.example.test
    repository_prefix: example/staging
    username_env: STAGING_USERNAME
    token_env: OCI_TOKEN
    signing_key_env: STAGING_SIGNING_KEY
    signing_password_env: STAGING_SIGNING_PASSWORD
    verification_key_env: STAGING_VERIFICATION_KEY
`),
    /environment names must be globally unique:[\s\S]+OCI_TOKEN[\s\S]+provider "release" field "token_env"[\s\S]+provider "staging" field "token_env"/,
  );
});

test("direct provider models reject aliases before reading credential values", () => {
  const providers = {
    providers: {
      release: {
        kind: "oci_registry" as const,
        registry: "registry.example",
        repository_prefix: "example/release",
        signing_key_env: "RELEASE_SIGNING_KEY",
        signing_password_env: "RELEASE_SIGNING_PASSWORD",
        token_env: "RELEASE_USERNAME",
        username_env: "RELEASE_USERNAME",
        verification_key_env: "RELEASE_VERIFICATION_KEY",
      },
    },
  };
  const hostEnv = new Proxy<Record<string, string>>(
    {},
    {
      get(): never {
        throw new Error("credential values must not be read");
      },
    },
  );

  assert.throws(() => {
    const selected = selectApplicationImageProvider("release", providers);
    resolveApplicationImageCredentialValues(
      {
        definition: selected.definition!,
        name: selected.name,
      },
      hostEnv,
    );
  }, /environment names must be globally unique/);
});

test("dry-run provider resolution validates metadata without reading credentials", () => {
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

  assert.deepEqual(selectApplicationImageProvider("release", providers), {
    definition: providers.providers.release,
    name: "release",
  });
});

test("provider selection rejects inherited object keys that are not declared", () => {
  assert.throws(
    () => selectApplicationImageProvider("constructor", { providers: {} }),
    /does not define selected provider "constructor"/,
  );
});

test("live provider credential selection reports missing env names without values", () => {
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

  assert.throws(
    () =>
      resolveApplicationImageCredentialValues(
        {
          definition: providers.providers.release,
          name: "release",
        },
        {},
      ),
    /requires host env OCI_USERNAME/,
  );
});

test("provider credential selection decodes single-line PEM values", () => {
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
  const credentials = resolveApplicationImageCredentialValues(
    {
      definition: providers.providers.release,
      name: "release",
    },
    {
      OCI_SIGNING_KEY:
        "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\\nprivate\\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
      OCI_SIGNING_PASSWORD: "password",
      OCI_SIGNING_PUBLIC_KEY:
        "-----BEGIN PUBLIC KEY-----\\npublic\\n-----END PUBLIC KEY-----",
      OCI_TOKEN: "token",
      OCI_USERNAME: "username",
    },
  );

  assert.match(credentials.signingKey, /KEY-----\nprivate\n-----END/);
  assert.match(credentials.verificationKey, /KEY-----\npublic\n-----END/);
});

test("live provider selection reads exactly the selected provider credential names", () => {
  const providers = parseApplicationImageProviders(`
providers:
  release:
    kind: oci_registry
    registry: registry.example
    repository_prefix: example/platform
    username_env: RELEASE_USERNAME
    token_env: RELEASE_TOKEN
    signing_key_env: RELEASE_SIGNING_KEY
    signing_password_env: RELEASE_SIGNING_PASSWORD
    verification_key_env: RELEASE_VERIFICATION_KEY
  staging:
    kind: oci_registry
    registry: registry.example
    repository_prefix: example/staging
    username_env: STAGING_USERNAME
    token_env: STAGING_TOKEN
    signing_key_env: STAGING_SIGNING_KEY
    signing_password_env: STAGING_SIGNING_PASSWORD
    verification_key_env: STAGING_VERIFICATION_KEY
`);
  const reads: string[] = [];
  const values: Record<string, string> = {
    RELEASE_SIGNING_KEY:
      "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\\nprivate\\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
    RELEASE_SIGNING_PASSWORD: "password",
    RELEASE_TOKEN: "token",
    RELEASE_USERNAME: "username",
    RELEASE_VERIFICATION_KEY:
      "-----BEGIN PUBLIC KEY-----\\npublic\\n-----END PUBLIC KEY-----",
    STAGING_SIGNING_KEY: "must-not-read",
    STAGING_SIGNING_PASSWORD: "must-not-read",
    STAGING_TOKEN: "must-not-read",
    STAGING_USERNAME: "must-not-read",
    STAGING_VERIFICATION_KEY: "must-not-read",
  };
  const hostEnv = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        reads.push(property);
      }

      return Reflect.get(target, property, receiver);
    },
  });

  resolveApplicationImageCredentialValues(
    {
      definition: providers.providers.release,
      name: "release",
    },
    hostEnv,
  );

  assert.deepEqual(reads.sort(), [
    "RELEASE_SIGNING_KEY",
    "RELEASE_SIGNING_PASSWORD",
    "RELEASE_TOKEN",
    "RELEASE_USERNAME",
    "RELEASE_VERIFICATION_KEY",
  ]);
});
