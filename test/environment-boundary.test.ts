import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPLICATION_IMAGE_CREDENTIAL_FIELDS,
  CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES,
  assertNoApplicationImageCredentialProjections,
  collectApplicationImageCredentialNames,
  collectDeployRuntimeCredentialProjectionIssues,
  collectFrameworkOwnedDeployEnvironmentIssues,
  collectNpmReleaseCredentialProjectionIssues,
  collectPackageBuildCredentialProjectionIssues,
} from "../src/application-images/environment-boundary.ts";
import type { ApplicationImageProvidersDefinition } from "../src/model/application-image.ts";
import type { DeployRuntimeSpec } from "../src/model/deploy-target.ts";
import type { NpmReleaseDefinition } from "../src/model/npm-release.ts";
import type { PackageBuildSpec } from "../src/model/package-target.ts";
import { resolvePackageBuildEnvironmentFromDefinitions } from "../src/stages/build-stage/build-env.ts";
import {
  mergeProjectAndFrameworkDeployEnvironment,
  resolveSpecEnvironment,
} from "../src/stages/deploy/runtime-env.ts";

const providers: ApplicationImageProvidersDefinition = {
  providers: {
    release: {
      kind: "oci_registry",
      registry: "registry.example",
      repository_prefix: "example/release",
      signing_key_env: "RELEASE_SIGNING_KEY",
      signing_password_env: "RELEASE_SIGNING_PASSWORD",
      token_env: "RELEASE_TOKEN",
      username_env: "RELEASE_USERNAME",
      verification_key_env: "RELEASE_VERIFICATION_KEY",
    },
    staging: {
      kind: "oci_registry",
      registry: "registry.example",
      repository_prefix: "example/staging",
      signing_key_env: "STAGING_SIGNING_KEY",
      signing_password_env: "STAGING_SIGNING_PASSWORD",
      token_env: "STAGING_TOKEN",
      username_env: "STAGING_USERNAME",
      verification_key_env: "STAGING_VERIFICATION_KEY",
    },
  },
};

const credentials = collectApplicationImageCredentialNames(providers);

function emptyBuild(): PackageBuildSpec {
  return {
    dry_run_defaults: {},
    map_env: {},
    pass_env: [],
  };
}

function emptyRuntime(): DeployRuntimeSpec {
  return {
    dry_run_defaults: {},
    env: {},
    file_mounts: [],
    image: "node:24-bookworm-slim",
    install: [],
    map_env: {},
    pass_env: [],
    required_host_env: [],
    workspace: { dirs: [], files: [] },
  };
}

function npmRelease(tokenEnv: string): NpmReleaseDefinition {
  return {
    auth: { kind: "token", token_env: tokenEnv },
    kind: "npm",
    publish: { provenance: false, registry: "", tag: "latest" },
    versioning: { strategy: "rush-change-files", target_branch: "main" },
  };
}

test("collects all five protected credential names from every provider in stable order", () => {
  assert.deepEqual(
    credentials.map(({ field, name, provider }) => ({ field, name, provider })),
    [
      ...APPLICATION_IMAGE_CREDENTIAL_FIELDS.map((field) => ({
        field,
        name: providers.providers.release[field],
        provider: "release",
      })),
      ...APPLICATION_IMAGE_CREDENTIAL_FIELDS.map((field) => ({
        field,
        name: providers.providers.staging[field],
        provider: "staging",
      })),
    ],
  );
});

test("rejects every package Build credential projection channel", () => {
  const cases: Array<{ field: string; spec: PackageBuildSpec }> = [
    {
      field: "build.pass_env",
      spec: { ...emptyBuild(), pass_env: ["RELEASE_TOKEN"] },
    },
    {
      field: "build.map_env output",
      spec: {
        ...emptyBuild(),
        map_env: { RELEASE_TOKEN: "SAFE_SOURCE" },
      },
    },
    {
      field: "build.map_env source",
      spec: {
        ...emptyBuild(),
        map_env: { SAFE_OUTPUT: "RELEASE_TOKEN" },
      },
    },
    {
      field: "build.dry_run_defaults",
      spec: {
        ...emptyBuild(),
        dry_run_defaults: { RELEASE_TOKEN: "not-a-secret" },
      },
    },
  ];

  for (const { field, spec } of cases) {
    const issues = collectPackageBuildCredentialProjectionIssues(
      "api",
      spec,
      credentials,
    );

    assert.equal(issues.length, 1, field);
    assert.equal(issues[0].metadataField, field);
    assert.equal(issues[0].provider, "release");
    assert.equal(issues[0].target, "api");
    assert.throws(
      () => assertNoApplicationImageCredentialProjections(issues),
      /provider "release".+RELEASE_TOKEN.+package target "api"/s,
    );
  }
});

test("Build boundary fails before resolving a protected host value", () => {
  assert.throws(
    () =>
      resolvePackageBuildEnvironmentFromDefinitions(
        [
          {
            definition: {
              artifact: { kind: "directory", path: "dist" },
              build: { ...emptyBuild(), pass_env: ["RELEASE_TOKEN"] },
              name: "api",
            },
            target: "api",
          },
        ],
        {},
        {
          dryRun: false,
          protectedApplicationImageCredentials: credentials,
          requirePackageTargets: true,
          stage: "build",
        },
      ),
    /credential projection validation failed/,
  );
});

test("rejects every Deploy credential projection channel", () => {
  const cases: Array<{ field: string; spec: DeployRuntimeSpec }> = [
    {
      field: "runtime.pass_env",
      spec: { ...emptyRuntime(), pass_env: ["STAGING_TOKEN"] },
    },
    {
      field: "runtime.map_env output",
      spec: {
        ...emptyRuntime(),
        map_env: { STAGING_TOKEN: "SAFE_SOURCE" },
      },
    },
    {
      field: "runtime.map_env source",
      spec: {
        ...emptyRuntime(),
        map_env: { SAFE_OUTPUT: "STAGING_TOKEN" },
      },
    },
    {
      field: "runtime.env",
      spec: { ...emptyRuntime(), env: { STAGING_TOKEN: "value" } },
    },
    {
      field: "runtime.dry_run_defaults",
      spec: {
        ...emptyRuntime(),
        dry_run_defaults: { STAGING_TOKEN: "value" },
      },
    },
    {
      field: "runtime.required_host_env",
      spec: {
        ...emptyRuntime(),
        required_host_env: ["STAGING_TOKEN"],
      },
    },
    {
      field: "runtime.file_mounts[].source_var",
      spec: {
        ...emptyRuntime(),
        file_mounts: [
          {
            kind: "host_path",
            source_var: "STAGING_TOKEN",
            target: "/run/token",
          },
        ],
      },
    },
  ];

  for (const { field, spec } of cases) {
    const issues = collectDeployRuntimeCredentialProjectionIssues(
      "api",
      spec,
      credentials,
    );

    assert.equal(issues.length, 1, field);
    assert.equal(issues[0].metadataField, field);
    assert.equal(issues[0].provider, "staging");
  }
});

test("rejects composed NPM auth that aliases any declared provider credential", () => {
  const issues = collectNpmReleaseCredentialProjectionIssues(
    npmRelease("STAGING_SIGNING_PASSWORD"),
    credentials,
  );

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    field: "signing_password_env",
    metadataField: "auth.token_env",
    name: "STAGING_SIGNING_PASSWORD",
    provider: "staging",
    target: "npm",
    targetKind: "npm release",
  });
});

test("rejects every framework-owned Deploy name and the future ARTIFACT_ namespace", () => {
  const reservedNames = [
    ...CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES,
    "ARTIFACT_FUTURE_NAME",
  ];

  for (const name of reservedNames) {
    const channels: DeployRuntimeSpec[] = [
      { ...emptyRuntime(), pass_env: [name] },
      { ...emptyRuntime(), map_env: { [name]: "SAFE_SOURCE" } },
      { ...emptyRuntime(), env: { [name]: "value" } },
      { ...emptyRuntime(), dry_run_defaults: { [name]: "value" } },
      { ...emptyRuntime(), required_host_env: [name] },
      {
        ...emptyRuntime(),
        file_mounts: [
          { kind: "host_path", source_var: name, target: "/run/value" },
        ],
      },
    ];

    for (const runtime of channels) {
      assert.equal(
        collectFrameworkOwnedDeployEnvironmentIssues("api", runtime).length,
        1,
        name,
      );
      assert.throws(
        () => resolveSpecEnvironment(runtime, { [name]: "same" }, true, "api"),
        new RegExp(name),
      );
    }
  }
});

test("framework environment owns collisions even when values are equal", () => {
  assert.throws(
    () =>
      mergeProjectAndFrameworkDeployEnvironment(
        { GIT_SHA: "same" },
        { GIT_SHA: "same" },
        "api",
      ),
    /cannot overwrite framework-owned environment[\s\S]+GIT_SHA/,
  );

  assert.deepEqual(
    mergeProjectAndFrameworkDeployEnvironment(
      { PROJECT_REGION: "eu-west-1" },
      { DRY_RUN: "1", GIT_SHA: "abc" },
      "api",
    ),
    {
      DRY_RUN: "1",
      GIT_SHA: "abc",
      PROJECT_REGION: "eu-west-1",
    },
  );
});
