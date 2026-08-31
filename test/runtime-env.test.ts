import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { DeployRuntimeSpec } from "../src/model/deploy-target.ts";
import {
  getRequiredMountSource,
  getRequiredRepoRelativeHostPathSource,
  parseDeployEnvFile,
  resolveSpecEnvironment,
  validateRuntimeFilesProvided,
  validateRequiredHostEnv,
} from "../src/stages/deploy/runtime-env.ts";

const webappLikeSpec: DeployRuntimeSpec = {
  dry_run_defaults: {
    CLOUDFLARE_PAGES_PROJECT_NAME: "webapp",
    WEBAPP_URL: "https://webapp.pages.dev",
  },
  env: {
    STATIC_ENV: "always",
  },
  file_mounts: [],
  image: "node:24-bookworm-slim",
  install: [],
  map_env: {},
  pass_env: ["CLOUDFLARE_PAGES_PROJECT_NAME", "WEBAPP_URL"],
  required_host_env: ["REQUIRED_ONLY_IN_LIVE_RUN"],
  workspace: {
    dirs: [],
    files: [],
  },
};

test("parses a flat deploy env file into a host env map", () => {
  const parsedEnv = parseDeployEnvFile(`
    # comment
    CLOUDFLARE_PAGES_PROJECT_NAME=beltapp
    WEBAPP_URL=https://beltapp.pages.dev
  `);

  assert.deepEqual(parsedEnv, {
    CLOUDFLARE_PAGES_PROJECT_NAME: "beltapp",
    WEBAPP_URL: "https://beltapp.pages.dev",
  });
});

test("flat env diagnostics redact malformed values and actual-newline PEM input", () => {
  const sentinel = "SENTINEL_FLAT_ENV_SECRET_d280e4";

  for (const contents of [
    `OCI_TOKEN=${sentinel}\n${sentinel}`,
    `OCI_SIGNING_KEY=-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\n${sentinel}\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----`,
    `${sentinel.toLowerCase()}=value`,
  ]) {
    let message = "";

    assert.throws(
      () => parseDeployEnvFile(contents),
      (error) => {
        message = error instanceof Error ? error.message : String(error);
        return true;
      },
    );
    assert.match(message, /line contents were redacted/);
    assert.equal(message.includes(sentinel), false);
  }
});

test("resolves pass-through env from host env and static env values", () => {
  const resolvedEnv = resolveSpecEnvironment(
    webappLikeSpec,
    {
      CLOUDFLARE_PAGES_PROJECT_NAME: "beltapp",
      WEBAPP_URL: "https://beltapp.pages.dev",
    },
    false,
    "webapp",
  );

  assert.deepEqual(resolvedEnv, {
    CLOUDFLARE_PAGES_PROJECT_NAME: "beltapp",
    STATIC_ENV: "always",
    WEBAPP_URL: "https://beltapp.pages.dev",
  });
});

test("resolves mapped pass-through env from host env", () => {
  const resolvedEnv = resolveSpecEnvironment(
    {
      ...webappLikeSpec,
      dry_run_defaults: {
        WEBAPP_VITE_GRAPHQL_HTTP: "https://dry-run.example.test/graphql",
      },
      map_env: {
        VITE_GRAPHQL_HTTP: "WEBAPP_VITE_GRAPHQL_HTTP",
      },
      pass_env: [],
    },
    {
      WEBAPP_VITE_GRAPHQL_HTTP: "https://api.example.test/graphql",
    },
    false,
    "webapp",
  );

  assert.deepEqual(resolvedEnv, {
    STATIC_ENV: "always",
    VITE_GRAPHQL_HTTP: "https://api.example.test/graphql",
  });
});

test("uses dry-run defaults for mapped pass-through env values", () => {
  const resolvedEnv = resolveSpecEnvironment(
    {
      ...webappLikeSpec,
      dry_run_defaults: {
        WEBAPP_VITE_GRAPHQL_HTTP: "https://dry-run.example.test/graphql",
      },
      map_env: {
        VITE_GRAPHQL_HTTP: "WEBAPP_VITE_GRAPHQL_HTTP",
      },
      pass_env: [],
    },
    {},
    true,
    "webapp",
  );

  assert.deepEqual(resolvedEnv, {
    STATIC_ENV: "always",
    VITE_GRAPHQL_HTTP: "https://dry-run.example.test/graphql",
  });
});

test("allows static env to repeat a pass-through env with the same value", () => {
  const resolvedEnv = resolveSpecEnvironment(
    {
      ...webappLikeSpec,
      env: {
        WEBAPP_URL: "https://beltapp.pages.dev",
      },
      pass_env: ["WEBAPP_URL"],
    },
    {
      WEBAPP_URL: "https://beltapp.pages.dev",
    },
    false,
    "webapp",
  );

  assert.deepEqual(resolvedEnv, {
    WEBAPP_URL: "https://beltapp.pages.dev",
  });
});

test("fails when static env collides with pass-through env", () => {
  assert.throws(
    () =>
      resolveSpecEnvironment(
        {
          ...webappLikeSpec,
          env: {
            WEBAPP_URL: "https://static.example.test",
          },
          pass_env: ["WEBAPP_URL"],
        },
        {
          WEBAPP_URL: "https://beltapp.pages.dev",
        },
        false,
        "webapp",
      ),
    /Environment variable "WEBAPP_URL" for target "webapp" is defined by both runtime env passthrough and static env with different values\./,
  );
});

test("fails when static env collides with mapped env", () => {
  assert.throws(
    () =>
      resolveSpecEnvironment(
        {
          ...webappLikeSpec,
          dry_run_defaults: {},
          env: {
            VITE_GRAPHQL_HTTP: "https://static.example.test/graphql",
          },
          map_env: {
            VITE_GRAPHQL_HTTP: "WEBAPP_VITE_GRAPHQL_HTTP",
          },
          pass_env: [],
        },
        {
          WEBAPP_VITE_GRAPHQL_HTTP: "https://api.example.test/graphql",
        },
        false,
        "webapp",
      ),
    /Environment variable "VITE_GRAPHQL_HTTP" for target "webapp" is defined by both runtime env passthrough and static env with different values\./,
  );
});

test("uses dry-run defaults for missing pass-through env values", () => {
  const resolvedEnv = resolveSpecEnvironment(
    webappLikeSpec,
    {},
    true,
    "webapp",
  );

  assert.deepEqual(resolvedEnv, {
    CLOUDFLARE_PAGES_PROJECT_NAME: "webapp",
    STATIC_ENV: "always",
    WEBAPP_URL: "https://webapp.pages.dev",
  });
});

test("fails in a live runtime when a required pass-through env value is missing", () => {
  assert.throws(
    () =>
      resolveSpecEnvironment(
        webappLikeSpec,
        {
          CLOUDFLARE_PAGES_PROJECT_NAME: "beltapp",
        },
        false,
        "webapp",
      ),
    /WEBAPP_URL/,
  );
});

test("required host env validation only applies to live runs", () => {
  assert.doesNotThrow(() =>
    validateRequiredHostEnv(webappLikeSpec, {}, true, "webapp"),
  );
  assert.throws(
    () => validateRequiredHostEnv(webappLikeSpec, {}, false, "webapp"),
    /REQUIRED_ONLY_IN_LIVE_RUN/,
  );
});

test("fails in a live runtime when a required mount source env value is missing", () => {
  assert.throws(
    () => getRequiredMountSource({}, "GOOGLE_GHA_CREDS_PATH", "server"),
    /GOOGLE_GHA_CREDS_PATH/,
  );
});

test("normalizes a workspace-backed mount source under hostWorkspaceDir to a repo-relative path", () => {
  assert.equal(
    getRequiredRepoRelativeHostPathSource(
      {
        GOOGLE_GHA_CREDS_PATH:
          "/home/runner/work/beltapp/beltapp/gha-creds.json",
      },
      "GOOGLE_GHA_CREDS_PATH",
      "server",
      "/home/runner/work/beltapp/beltapp",
    ),
    "gha-creds.json",
  );
});

test("keeps an already repo-relative file mount source unchanged", () => {
  assert.equal(
    getRequiredRepoRelativeHostPathSource(
      {
        GOOGLE_GHA_CREDS_PATH: "./secrets/gha-creds.json",
      },
      "GOOGLE_GHA_CREDS_PATH",
      "server",
      "/home/runner/work/beltapp/beltapp",
    ),
    "secrets/gha-creds.json",
  );
});

test("rejects host-path mounts that bypass target-scoped evidence isolation", () => {
  for (const sourcePath of [
    ".dagger/runtime/evidence",
    ".dagger/runtime/evidence/other/scan.json",
    ".dagger/./runtime/evidence/other/scan.json",
    ".dagger/runtime/./evidence/other/scan.json",
  ]) {
    assert.throws(
      () =>
        getRequiredRepoRelativeHostPathSource(
          { EVIDENCE_SOURCE: sourcePath },
          "EVIDENCE_SOURCE",
          "current",
        ),
      /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/,
    );
  }

  assert.throws(
    () =>
      getRequiredRepoRelativeHostPathSource(
        {
          EVIDENCE_SOURCE:
            "/runner/work/repo/.dagger/runtime/evidence/other/scan.json",
        },
        "EVIDENCE_SOURCE",
        "current",
        "/runner/work/repo",
      ),
    /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/,
  );

  assert.throws(
    () =>
      getRequiredRepoRelativeHostPathSource(
        {
          EVIDENCE_SOURCE:
            "/runner/work/repo/.dagger/./runtime/evidence/other/scan.json",
        },
        "EVIDENCE_SOURCE",
        "current",
        "/runner/work/repo",
      ),
    /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/,
  );
});

test("fails when an absolute workspace-backed mount source is outside hostWorkspaceDir", () => {
  assert.throws(
    () =>
      getRequiredRepoRelativeHostPathSource(
        {
          GOOGLE_GHA_CREDS_PATH: "/tmp/gha-creds.json",
        },
        "GOOGLE_GHA_CREDS_PATH",
        "server",
        "/home/runner/work/beltapp/beltapp",
      ),
    /hostWorkspaceDir/,
  );
});

test("fails when an absolute workspace-backed mount source is provided without hostWorkspaceDir", () => {
  assert.throws(
    () =>
      getRequiredRepoRelativeHostPathSource(
        {
          GOOGLE_GHA_CREDS_PATH:
            "/home/runner/work/beltapp/beltapp/gha-creds.json",
        },
        "GOOGLE_GHA_CREDS_PATH",
        "server",
      ),
    /hostWorkspaceDir/,
  );
});

test("requires runtime files only for live runtime file mounts", () => {
  assert.doesNotThrow(() =>
    validateRuntimeFilesProvided(
      [
        {
          kind: "runtime_file",
          source: "gcp-credentials.json",
          target: "/runtime-files/gcp-credentials.json",
        },
      ],
      undefined,
      true,
      "server",
    ),
  );

  assert.throws(
    () =>
      validateRuntimeFilesProvided(
        [
          {
            kind: "runtime_file",
            source: "gcp-credentials.json",
            target: "/runtime-files/gcp-credentials.json",
          },
        ],
        undefined,
        false,
        "server",
      ),
    /Runtime files directory is required for target "server"/,
  );

  assert.doesNotThrow(() =>
    validateRuntimeFilesProvided(
      [
        {
          kind: "host_path",
          source_var: "GOOGLE_GHA_CREDS_PATH",
          target: "/tmp/gcp-credentials.json",
        },
      ],
      undefined,
      false,
      "server",
    ),
  );
});
