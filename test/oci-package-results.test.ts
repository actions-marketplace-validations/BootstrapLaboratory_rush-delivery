import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectOciPackageResults,
  executeOciPackageBatch,
  finalizeOciPackageResults,
  OCI_PUBLICATION_BOUNDARY_MESSAGE,
  OciPackageOperationError,
} from "../src/stages/package-stage/oci-package-results.ts";

test("collects multiple OCI preparations in metadata order", async () => {
  const results = await collectOciPackageResults([
    { run: async () => "api-subject", target: "api" },
    { run: async () => "worker-subject", target: "worker" },
  ]);

  assert.deepEqual(results, [
    { result: "api-subject", target: "api" },
    { result: "worker-subject", target: "worker" },
  ]);
});

test("awaits every started preparation and reports failures deterministically", async () => {
  const completed: string[] = [];
  let releaseSlowTarget: (() => void) | undefined;
  const slowTarget = new Promise<void>((resolve) => {
    releaseSlowTarget = resolve;
  });
  const operation = collectOciPackageResults([
    {
      run: async () => {
        throw new OciPackageOperationError("Docker image build");
      },
      target: "api",
    },
    {
      run: async () => {
        await slowTarget;
        completed.push("worker");
        throw new OciPackageOperationError("Grype scan/policy");
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
        "OCI application image preparation failed:",
        'OCI package target "api" failed during Docker image build.',
        'OCI package target "worker" failed during Grype scan/policy.',
      ].join("\n"),
    );
    return true;
  });
});

test("sanitizes untyped preparation failures", async () => {
  const secretSentinel = "credential-that-must-not-escape";

  await assert.rejects(
    collectOciPackageResults([
      {
        run: async () => {
          throw new Error(`tool output contained ${secretSentinel}`);
        },
        target: "api",
      },
    ]),
    (error: Error) => {
      assert.match(error.message, /failed during preparation/);
      assert.doesNotMatch(error.message, new RegExp(secretSentinel));
      return true;
    },
  );
});

test("runs one preflight, prepares in parallel, and finalizes in target order", async () => {
  const events: string[] = [];
  let releasePreparations: (() => void) | undefined;
  const preparationBarrier = new Promise<void>((resolve) => {
    releasePreparations = resolve;
  });
  const operation = executeOciPackageBatch(
    ["api", "worker"].map((target) => ({
      finalize: async (prepared: string) => {
        events.push(`finalize:${target}:${prepared}`);
        return {
          publishedReference: `registry.example/platform/${target}@sha256:${"a".repeat(64)}`,
          result: `${target}-published`,
        };
      },
      prepare: async () => {
        events.push(`prepare:${target}`);
        await preparationBarrier;
        return `${target}-prepared`;
      },
      target,
    })),
    async () => {
      events.push("preflight");
    },
    () => {
      events.push(OCI_PUBLICATION_BOUNDARY_MESSAGE);
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["preflight", "prepare:api", "prepare:worker"]);
  releasePreparations?.();

  assert.deepEqual(await operation, [
    { result: "api-published", target: "api" },
    { result: "worker-published", target: "worker" },
  ]);
  assert.deepEqual(events, [
    "preflight",
    "prepare:api",
    "prepare:worker",
    OCI_PUBLICATION_BOUNDARY_MESSAGE,
    "finalize:api:api-prepared",
    "finalize:worker:worker-prepared",
  ]);
});

test("a provider preflight failure starts no preparation or finalization", async () => {
  let prepareCalls = 0;
  let finalizeCalls = 0;

  await assert.rejects(
    executeOciPackageBatch(
      [
        {
          finalize: async () => {
            finalizeCalls += 1;
            return { publishedReference: "unused", result: "unused" };
          },
          prepare: async () => {
            prepareCalls += 1;
            return "unused";
          },
          target: "api",
        },
      ],
      async () => {
        throw new Error("provider preflight failed");
      },
    ),
    /provider preflight failed/,
  );
  assert.equal(prepareCalls, 0);
  assert.equal(finalizeCalls, 0);
});

test("any preparation failure prevents every publication", async () => {
  const finalized: string[] = [];

  await assert.rejects(
    executeOciPackageBatch(
      [
        {
          finalize: async () => {
            finalized.push("api");
            return { publishedReference: "unused", result: "unused" };
          },
          prepare: async () => {
            throw new OciPackageOperationError(
              "SPDX SBOM generation/validation",
            );
          },
          target: "api",
        },
        {
          finalize: async () => {
            finalized.push("worker");
            return { publishedReference: "unused", result: "unused" };
          },
          prepare: async () => "worker-prepared",
          target: "worker",
        },
      ],
      async () => undefined,
    ),
    /OCI application image preparation failed/,
  );
  assert.deepEqual(finalized, []);
});

test("finalization failure reports completed, failed, and skipped targets", async () => {
  const digestA = `registry.example/platform/api@sha256:${"a".repeat(64)}`;
  const digestB = `registry.example/platform/worker@sha256:${"b".repeat(64)}`;
  const calls: string[] = [];

  await assert.rejects(
    finalizeOciPackageResults([
      {
        run: async () => {
          calls.push("api");
          return { publishedReference: digestA, result: "api-result" };
        },
        target: "api",
      },
      {
        run: async () => {
          calls.push("worker");
          throw new OciPackageOperationError(
            "Cosign verify-signature",
            digestB,
          );
        },
        target: "worker",
      },
      {
        run: async () => {
          calls.push("web");
          return { publishedReference: "unused", result: "unused" };
        },
        target: "web",
      },
    ]),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          "OCI application image finalization failed:",
          'OCI package target "worker" failed during Cosign verify-signature.',
          `Earlier published target "api": ${digestA}`,
          `Failed target "worker" published reference: ${digestB}`,
          'Later target "web" was not started.',
          "OCI publication is nontransactional. Inspect the registry and clean up any published digest, signature, and attestation artifacts before retrying.",
        ].join("\n"),
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["api", "worker"]);
});
