import * as assert from "node:assert/strict";
import { test } from "node:test";

import { collectOciPackageResults } from "../src/stages/package-stage/oci-package-results.ts";

test("collects multiple OCI targets in metadata order", async () => {
  const results = await collectOciPackageResults([
    { run: async () => "api-digest", target: "api" },
    { run: async () => "worker-digest", target: "worker" },
  ]);

  assert.deepEqual(results, [
    { result: "api-digest", target: "api" },
    { result: "worker-digest", target: "worker" },
  ]);
});

test("awaits every started OCI target and reports failures deterministically", async () => {
  const completed: string[] = [];
  let releaseSlowTarget: (() => void) | undefined;
  const slowTarget = new Promise<void>((resolve) => {
    releaseSlowTarget = resolve;
  });
  const operation = collectOciPackageResults([
    {
      run: async () => {
        throw new Error("registry authentication rejected");
      },
      target: "api",
    },
    {
      run: async () => {
        await slowTarget;
        completed.push("worker");
        throw new Error("scanner policy rejected critical finding");
      },
      target: "worker",
    },
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, []);
  releaseSlowTarget?.();

  await assert.rejects(operation, (error: Error) => {
    assert.deepEqual(completed, ["worker"]);
    assert.equal(
      error.message,
      [
        "OCI application image packaging failed:",
        'OCI package target "api" failed: registry authentication rejected',
        'OCI package target "worker" failed: scanner policy rejected critical finding',
      ].join("\n"),
    );
    return true;
  });
});
