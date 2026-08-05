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

test("release smoke covers both v0.8.1 consumer surfaces and compatibility paths", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = parseYaml(source) as {
    env: { RELEASE_SMOKE_EXPECTED_SHA: string };
    jobs: {
      "v081-consumer-smoke": {
        strategy: {
          matrix: { scenario: string[]; surface: string[] };
        };
      };
    };
    permissions: Record<string, string>;
  };

  assert.deepEqual(
    workflow.jobs["v081-consumer-smoke"].strategy.matrix.surface,
    ["github-action", "remote-module"],
  );
  assert.deepEqual(
    workflow.jobs["v081-consumer-smoke"].strategy.matrix.scenario,
    ["filesystem-only", "oci-provider-off"],
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.env, {
    RELEASE_SMOKE_EXPECTED_SHA: "b90f4d7894254c58df35a39f69fe20bbf1004553",
  });

  assert.match(source, /ref: v0\.8\.1/u);
  assert.match(source, /uses: BootstrapLaboratory\/rush-delivery@v0\.8\.1/u);
  assert.match(
    source,
    /-m github\.com\/BootstrapLaboratory\/rush-delivery@v0\.8\.1/u,
  );
  assert.match(source, /source-mode: local_copy/u);
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
  assert.match(
    source,
    /const encodedResult = JSON\.parse\(process\.env\.RELEASE_SMOKE_OUTPUT\);/u,
  );
  assert.match(source, /typeof encodedResult !== "string"/u);
  assert.match(source, /const result = JSON\.parse\(encodedResult\);/u);
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
  assert.doesNotMatch(source, /(?:TOKEN|PASSWORD|PRIVATE_KEY|SIGNING_KEY):/u);
});
