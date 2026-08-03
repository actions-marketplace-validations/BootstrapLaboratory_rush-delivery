import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildApplicationImageRepository,
  buildApplicationImageTagReference,
  normalizePublishedImageReference,
} from "../src/application-images/reference.ts";

const gitSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const repository = "registry.example.test/example/platform/services/server";

test("builds generic application image repository and navigation tag", () => {
  const builtRepository = buildApplicationImageRepository(
    {
      kind: "oci_registry",
      registry: "registry.example.test",
      repository_prefix: "example/platform",
      signing_key_env: "SIGNING_KEY",
      signing_password_env: "SIGNING_PASSWORD",
      token_env: "TOKEN",
      username_env: "USERNAME",
      verification_key_env: "VERIFICATION_KEY",
    },
    "services/server",
  );

  assert.equal(builtRepository, repository);
  assert.equal(
    buildApplicationImageTagReference(builtRepository, gitSha),
    `${repository}:sha-${gitSha}`,
  );
});

test("normalizes a Dagger publish result to repository@digest", () => {
  const tagReference = `${repository}:sha-${gitSha}`;

  assert.deepStrictEqual(
    normalizePublishedImageReference(
      repository,
      tagReference,
      `${tagReference}@${digest}`,
    ),
    {
      digest,
      reference: `${repository}@${digest}`,
      repository,
      tagReference,
    },
  );
});

test("rejects mutable publication results", () => {
  const tagReference = `${repository}:sha-${gitSha}`;

  assert.throws(
    () =>
      normalizePublishedImageReference(
        repository,
        tagReference,
        tagReference,
      ),
    /without a digest/,
  );
});

test("rejects publication results for another repository", () => {
  const tagReference = `${repository}:sha-${gitSha}`;

  assert.throws(
    () =>
      normalizePublishedImageReference(
        repository,
        tagReference,
        `registry.example.test/other/image@${digest}`,
      ),
    /unexpected repository/,
  );
});
