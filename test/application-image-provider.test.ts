import * as assert from "node:assert/strict";
import { test } from "node:test";

import { parseApplicationImageProvider } from "../src/application-images/options.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
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

  assert.deepEqual(
    selectApplicationImageProvider("release", providers),
    {
      definition: providers.providers.release,
      name: "release",
    },
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
