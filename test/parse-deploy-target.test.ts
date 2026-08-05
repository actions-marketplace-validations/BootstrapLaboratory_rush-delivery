import * as assert from "node:assert/strict";
import { test } from "node:test";

import { parseDeployTarget } from "../src/stages/deploy/parse-deploy-target.ts";
import { CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES } from "../src/application-images/environment-boundary.ts";

test("parses deploy target runtime metadata", () => {
  const definition = parseDeployTarget(`
name: webapp
deploy_script: deploy/cloudflare-pages/scripts/deploy-webapp.sh

runtime:
  image: node:24-bookworm-slim
  pass_env:
    - WEBAPP_URL
    - WEBAPP_VITE_GRAPHQL_HTTP
    - WEBAPP_VITE_GRAPHQL_HTTP
  map_env:
    VITE_GRAPHQL_WS: WEBAPP_VITE_GRAPHQL_WS
  env:
    STATIC_ENV: always
  workspace:
    dirs:
      - apps/webapp/dist
      - ./deploy/cloudflare-pages/scripts/
      - apps/webapp/dist
    files:
      - apps/webapp/package.json
`);

  assert.deepStrictEqual(definition, {
    deploy_script: "deploy/cloudflare-pages/scripts/deploy-webapp.sh",
    name: "webapp",
    runtime: {
      dry_run_defaults: {},
      env: {
        STATIC_ENV: "always",
      },
      file_mounts: [],
      image: "node:24-bookworm-slim",
      install: [],
      map_env: {
        VITE_GRAPHQL_WS: "WEBAPP_VITE_GRAPHQL_WS",
      },
      pass_env: ["WEBAPP_URL", "WEBAPP_VITE_GRAPHQL_HTTP"],
      required_host_env: [],
      workspace: {
        dirs: ["apps/webapp/dist", "deploy/cloudflare-pages/scripts"],
        files: ["apps/webapp/package.json"],
      },
    },
  });
});

test("fails when runtime map_env source is invalid", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: webapp
deploy_script: deploy/cloudflare-pages/scripts/deploy-webapp.sh

runtime:
  image: node:24-bookworm-slim
  map_env:
    VITE_GRAPHQL_HTTP: webapp_vite_graphql_http
`),
    /Deploy target runtime map_env value for "VITE_GRAPHQL_HTTP" "webapp_vite_graphql_http" must match/,
  );
});

test("preserves ordered duplicate install commands", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  install:
    - apt-get update
    - echo added repo
    - apt-get update
`);

  assert.deepStrictEqual(definition.runtime.install, [
    "apt-get update",
    "echo added repo",
    "apt-get update",
  ]);
});

test("fails when target runtime image is missing", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: webapp
deploy_script: deploy/cloudflare-pages/scripts/deploy-webapp.sh

runtime: {}
`),
    /Deploy target runtime image must be a non-empty string\./,
  );
});

test("parses full runtime workspace mode", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  workspace:
    mode: full
`);

  assert.deepStrictEqual(definition.runtime.workspace, {
    dirs: [],
    files: [],
    mode: "full",
  });
});

test("fails when runtime workspace mode is unsupported", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  workspace:
    mode: minimal
`),
    /Deploy target runtime workspace mode must be "full"\./,
  );
});

test("fails when runtime workspace path escapes the repository", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  workspace:
    dirs:
      - ../server
`),
    /Deploy target runtime workspace dirs entry must stay inside the repository\./,
  );
});

test("fails when runtime workspace explicitly selects framework evidence", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  workspace:
    dirs:
      - .dagger/runtime/evidence/server
`),
    /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/,
  );
});

test("allows ordinary .dagger metadata in a partial workspace", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  workspace:
    dirs:
      - .dagger
`);

  assert.deepStrictEqual(definition.runtime.workspace, {
    dirs: [".dagger"],
    files: [],
  });
});

test("fails when file mount source_var is invalid", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source_var: not-valid
      target: /tmp/gcp-credentials.json
`),
    /file mount source_var "not-valid" must match/,
  );
});

test("parses runtime file mounts with default targets", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source: gcp-credentials.json
    - source: nested/kubeconfig
      target: /tmp/kubeconfig
`);

  assert.deepStrictEqual(definition.runtime.file_mounts, [
    {
      kind: "runtime_file",
      source: "gcp-credentials.json",
      target: "/runtime-files/gcp-credentials.json",
    },
    {
      kind: "runtime_file",
      source: "nested/kubeconfig",
      target: "/tmp/kubeconfig",
    },
  ]);
});

test("preserves host path file mounts for compatibility", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source_var: GOOGLE_GHA_CREDS_PATH
      target: /tmp/gcp-credentials.json
`);

  assert.deepStrictEqual(definition.runtime.file_mounts, [
    {
      kind: "host_path",
      source_var: "GOOGLE_GHA_CREDS_PATH",
      target: "/tmp/gcp-credentials.json",
    },
  ]);
});

test("rejects both file-mount kinds at framework evidence destinations", () => {
  const entries = [
    [
      "source: credential.json",
      "target: /workspace/.dagger/runtime/evidence/server/scan.json",
    ],
    [
      "source_var: CREDENTIAL_PATH",
      "target: .dagger/runtime/evidence/server/sbom.spdx.json",
    ],
    ["source: credential.json", "target: /workspace/.dagger"],
  ];

  for (const entry of entries) {
    assert.throws(
      () =>
        parseDeployTarget(`
name: server
deploy_script: deploy/server.sh
runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - ${entry[0]}
      ${entry[1]}
`),
      /collides with Rush Delivery evidence/,
    );
  }
});

test("preserves non-colliding legacy non-normalized file-mount targets", () => {
  for (const target of [
    "/tmp\\credential.json",
    "/tmp//credential.json",
    "/tmp/../credential.json",
  ]) {
    const definition = parseDeployTarget(`
name: server
deploy_script: deploy/server.sh
runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source: credential.json
      target: ${JSON.stringify(target)}
`);
    assert.equal(definition.runtime.file_mounts[0].target, target);
  }
});

test("fails when runtime file mount source escapes the bundle", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source: ../gcp-credentials.json
`),
    /file mount source must stay inside the runtime files bundle/,
  );
});

test("fails when file mount defines both source forms", () => {
  assert.throws(
    () =>
      parseDeployTarget(`
name: server
deploy_script: deploy/cloudrun/scripts/deploy-server.sh

runtime:
  image: node:24-bookworm-slim
  file_mounts:
    - source: gcp-credentials.json
      source_var: GOOGLE_GHA_CREDS_PATH
      target: /tmp/gcp-credentials.json
`),
    /must define exactly one of source or source_var/,
  );
});

test("rejects framework-owned names from every Deploy output channel", () => {
  const names = [
    ...CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES,
    "ARTIFACT_FUTURE_NAME",
  ];

  for (const name of names) {
    const runtimeFragments = [
      `pass_env: [${name}]`,
      ["map_env:", `  ${name}: SAFE_SOURCE`].join("\n"),
      ["env:", `  ${name}: value`].join("\n"),
      ["dry_run_defaults:", `  ${name}: value`].join("\n"),
      `required_host_env: [${name}]`,
      [
        "file_mounts:",
        `  - source_var: ${name}`,
        "    target: /run/value",
      ].join("\n"),
    ];

    for (const fragment of runtimeFragments) {
      assert.throws(
        () =>
          parseDeployTarget(`
name: server
deploy_script: deploy/server.sh
runtime:
  image: node:24-bookworm-slim
${fragment
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`),
        new RegExp(`${name}.+reserved for Rush Delivery`),
      );
    }
  }
});

test("allows a framework-owned name only as a map_env source", () => {
  const definition = parseDeployTarget(`
name: server
deploy_script: deploy/server.sh
runtime:
  image: node:24-bookworm-slim
  map_env:
    PROJECT_GIT_SHA: GIT_SHA
`);

  assert.deepEqual(definition.runtime.map_env, {
    PROJECT_GIT_SHA: "GIT_SHA",
  });
});
