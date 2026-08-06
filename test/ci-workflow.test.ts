import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(testDirectory, "../.github/workflows/ci.yml");

test("direct CI runs the unconfigured non-root project test path", async () => {
  const source = await readFile(workflowPath, "utf8");
  const workflow = parseYaml(source) as {
    concurrency: { "cancel-in-progress": boolean; group: string };
    jobs: {
      test: {
        "runs-on": string;
        steps: Array<{
          name: string;
          run?: string;
          uses?: string;
          with?: Record<string, unknown>;
        }>;
        "timeout-minutes": number;
      };
    };
    on: { pull_request: unknown; push: { branches: string[] } };
    permissions: Record<string, string>;
  };

  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    "cancel-in-progress": true,
    group: "ci-${{ github.workflow }}-${{ github.ref }}",
  });
  assert.equal(workflow.jobs.test["runs-on"], "ubuntu-latest");
  assert.equal(workflow.jobs.test["timeout-minutes"], 30);

  const steps = workflow.jobs.test.steps;
  assert.ok(
    steps.some(
      (step) =>
        step.uses ===
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    ),
  );
  assert.ok(
    steps.some(
      (step) =>
        step.uses ===
          "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38" &&
        step.with?.["node-version"] === "24.15.0" &&
        step.with.cache === "yarn" &&
        step.with["cache-dependency-path"] === "yarn.lock",
    ),
  );

  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  assert.ok(commands.includes("yarn install --frozen-lockfile"));
  assert.ok(commands.includes("git diff --exit-code"));
  assert.ok(
    commands.some(
      (command) =>
        command.includes("[[ $(id -u) == 0 ]]") &&
        command.includes("env -u OCI_V081_MATRIX_TEMP_ROOT npm test"),
    ),
  );

  assert.doesNotMatch(source, /OCI_V081_MATRIX_TEMP_ROOT:\s*\S+/u);
  assert.doesNotMatch(source, /packages:\s+write/u);
  assert.doesNotMatch(source, /secrets\./u);

  const actionReferences = [
    ...source.matchAll(/^\s*uses:\s+\S+@([^\s#]+)(?:\s+#.*)?$/gmu),
  ];
  assert.equal(actionReferences.length, 2);
  for (const reference of actionReferences) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u);
  }
});
