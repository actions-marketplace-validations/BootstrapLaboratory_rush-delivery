import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(
  testDirectory,
  "../.github/workflows/release-smoke.yml",
);

test("release smoke takes an exact ref/commit and covers v0.9.0 consumer paths", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = parseYaml(source) as {
    env: Record<string, string>;
    jobs: {
      "released-consumer-smoke": {
        strategy: {
          matrix: { scenario: string[]; surface: string[] };
        };
      };
    };
    permissions: Record<string, string>;
  };

  assert.deepEqual(
    workflow.jobs["released-consumer-smoke"].strategy.matrix.surface,
    [
      "github-action-bounded",
      "github-action-legacy",
      "remote-module-legacy",
      "release-launcher-bounded",
    ],
  );
  assert.deepEqual(
    workflow.jobs["released-consumer-smoke"].strategy.matrix.scenario,
    ["filesystem-only", "oci-provider-off"],
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.env, {
    RELEASE_SMOKE_EXPECTED_SHA: "${{ inputs.expected_commit }}",
    RELEASE_SMOKE_REF: "${{ inputs.target_ref }}",
  });

  assert.match(source, /target_ref:[\s\S]+default: v0\.9\.0/u);
  assert.match(source, /expected_commit:[\s\S]+required: true/u);
  assert.match(source, /ref: \$\{\{ env\.RELEASE_SMOKE_REF \}\}/u);
  assert.match(source, /uses: \.\/release-source/u);
  assert.match(source, /source-import-policy:/u);
  assert.match(source, /github-action-legacy/u);
  assert.match(source, /--source-import-policy=bounded/u);
  assert.match(source, /gh release download "\$\{RELEASE_SMOKE_REF\}"/u);
  assert.match(source, /cmp[\s\S]+github-action\/rush-delivery-local/u);
  assert.match(
    source,
    /github\.com\/BootstrapLaboratory\/rush-delivery@\$\{RELEASE_SMOKE_REF\}/u,
  );
  assert.match(source, /--source-mode=local_copy/u);
  assert.match(
    source,
    /actual_release_sha="\$\(git -C "\$\{RELEASE_SMOKE_SOURCE\}" rev-parse HEAD\)"/u,
  );
  assert.ok(
    source.includes(
      'if [[ ${actual_release_sha} != "${RELEASE_SMOKE_EXPECTED_SHA}" ]]; then',
    ),
  );
  assert.match(source, /application-image-provider: off/u);
  assert.match(source, /--application-image-provider=off/u);
  assert.match(source, /docker-socket: ""/u);
  assert.match(source, /target\.artifactReference !== undefined/u);

  assert.match(
    source,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/u,
  );
  assert.match(
    source,
    /dagger\/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8\.4\.1/u,
  );
  assert.doesNotMatch(source, /packages:\s+write/u);
  assert.doesNotMatch(source, /secrets\./u);
});
