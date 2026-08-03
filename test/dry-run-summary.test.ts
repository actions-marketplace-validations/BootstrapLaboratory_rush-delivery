import * as assert from "node:assert/strict";
import { test } from "node:test";

import { formatDryRunSummary } from "../src/stages/deploy/dry-run-summary.ts";

test("dry-run output lists runtime file bundle mounts", () => {
  const output = formatDryRunSummary({
    artifact: {
      deploy_path: "deploy/server",
      kind: "directory",
      path: "deploy/server",
    },
    artifactPath: "/workspace/deploy/server",
    definition: {
      deploy_script: "deploy/server.sh",
      name: "server",
      runtime: {
        dry_run_defaults: {},
        env: {},
        file_mounts: [
          {
            kind: "runtime_file",
            source: "gcp-credentials.json",
            target: "/runtime-files/gcp-credentials.json",
          },
        ],
        image: "node:24-bookworm-slim",
        install: [],
        map_env: {},
        pass_env: [],
        required_host_env: [],
        workspace: {
          dirs: [],
          files: [],
        },
      },
    },
    deployTag: "deploy/prod/server",
    dockerSocketEnabled: false,
    environment: "prod",
    envVars: {},
    gitSha: "abc123",
    wave: 1,
  });

  assert.match(
    output,
    /source=gcp-credentials\.json target=\/runtime-files\/gcp-credentials\.json/,
  );
});

test("dry-run output describes planned OCI intent without a fake digest", () => {
  const output = formatDryRunSummary({
    artifact: {
      image: "control-plane-api",
      kind: "oci_image",
      platforms: ["linux/amd64"],
      repository: "registry.example/example/control-plane-api",
      source_revision: "0123456789abcdef0123456789abcdef01234567",
      status: "planned",
    },
    definition: {
      deploy_script: "deploy/image.sh",
      name: "image",
      runtime: {
        dry_run_defaults: {},
        env: {},
        file_mounts: [],
        image: "node:24-bookworm-slim",
        install: [],
        map_env: {},
        pass_env: [],
        required_host_env: [],
        workspace: { dirs: [], files: [] },
      },
    },
    deployTag: "deploy/prod/image",
    dockerSocketEnabled: false,
    environment: "prod",
    envVars: {
      ARTIFACT_IMAGE_NAME: "control-plane-api",
      ARTIFACT_KIND: "oci_image",
    },
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    wave: 1,
  });

  assert.match(output, /package_artifact_image=control-plane-api/);
  assert.match(output, /package_artifact_platforms=\["linux\/amd64"\]/);
  assert.match(output, /no-image-or-digest-produced-dry-run/);
  assert.doesNotMatch(output, /ARTIFACT_PATH/);
  assert.doesNotMatch(output, /sha256:/);
});
