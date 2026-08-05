import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Container, Directory, File } from "@dagger.io/dagger";

import { canonicalizeFrameworkRuntime } from "../src/runtime/framework-runtime.ts";
import {
  applyRuntimeWorkspace,
  assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence,
  buildRuntimeWorkspacePlan,
  FRAMEWORK_EVIDENCE_PATH,
  mountTargetEvidence,
  withoutFrameworkEvidence,
} from "../src/stages/deploy/runtime-workspace.ts";

type WorkspaceCall = {
  operation: string;
  path: string;
  source?: string;
};

function fakeDirectory(name: string, calls: WorkspaceCall[]): Directory {
  return {
    __testName: name,
    directory(path: string) {
      calls.push({ operation: "directory", path, source: name });
      return fakeDirectory(`${name}/${path}`, calls);
    },
    file(path: string) {
      calls.push({ operation: "file", path, source: name });
      return { __testName: `${name}/${path}` } as unknown as File;
    },
    async exists(
      path: string,
      options?: { expectedType?: string },
    ): Promise<boolean> {
      if (options?.expectedType === "SYMLINK_TYPE") {
        return false;
      }

      return (
        options?.expectedType === "DIRECTORY_TYPE" &&
        [".dagger", "runtime", "evidence"].includes(path)
      );
    },
    withDirectory(path: string, source: unknown) {
      calls.push({
        operation: "withDirectory",
        path,
        source: (source as { __testName?: string }).__testName,
      });
      return fakeDirectory(`${name}-with-${path}`, calls);
    },
    withoutDirectory(path: string) {
      calls.push({ operation: "withoutDirectory", path, source: name });
      return fakeDirectory(`${name}-without-${path}`, calls);
    },
    withoutFile(path: string) {
      calls.push({ operation: "withoutFile", path, source: name });
      return fakeDirectory(`${name}-without-${path}`, calls);
    },
  } as unknown as Directory;
}

function evidenceSanitizationCalls(name: string): WorkspaceCall[] {
  return [
    { operation: "directory", path: ".dagger", source: name },
    {
      operation: "directory",
      path: "runtime",
      source: `${name}/.dagger`,
    },
    {
      operation: "withoutDirectory",
      path: "runtime",
      source: `${name}/.dagger`,
    },
    { operation: "withoutDirectory", path: ".dagger", source: name },
    {
      operation: "withoutDirectory",
      path: "evidence",
      source: `${name}/.dagger/runtime`,
    },
    {
      operation: "withDirectory",
      path: "runtime",
      source: `${name}/.dagger/runtime-without-evidence`,
    },
    {
      operation: "withDirectory",
      path: ".dagger",
      source: `${name}/.dagger-without-runtime-with-runtime`,
    },
  ];
}

function fakeContainer(calls: WorkspaceCall[]): Container {
  const container = {
    withDirectory(path: string, source: unknown) {
      calls.push({
        operation: "withDirectory",
        path,
        source: (source as { __testName?: string }).__testName,
      });
      return container;
    },
    withFile(path: string, source: unknown) {
      calls.push({
        operation: "withFile",
        path,
        source: (source as { __testName?: string }).__testName,
      });
      return container;
    },
  };

  return container as unknown as Container;
}

test("Package materializes post-Build metadata and clears only framework runtime", async () => {
  const calls: WorkspaceCall[] = [];

  await canonicalizeFrameworkRuntime(
    fakeDirectory("pre-build-source", calls),
    fakeDirectory("post-build-output", calls),
  );

  assert.deepStrictEqual(calls, [
    {
      operation: "directory",
      path: ".dagger",
      source: "post-build-output",
    },
    {
      operation: "withoutDirectory",
      path: "runtime",
      source: "post-build-output/.dagger",
    },
    {
      operation: "withoutDirectory",
      path: ".dagger",
      source: "post-build-output",
    },
    {
      operation: "withDirectory",
      path: ".dagger",
      source: "post-build-output/.dagger-without-runtime",
    },
  ]);
});

test("builds a partial runtime workspace plan when mode is omitted", () => {
  assert.deepStrictEqual(
    buildRuntimeWorkspacePlan({
      dirs: ["common/deploy/server", "deploy/cloudrun/scripts"],
      files: ["apps/server/Dockerfile"],
    }),
    {
      dirs: ["common/deploy/server", "deploy/cloudrun/scripts"],
      files: ["apps/server/Dockerfile"],
      mode: "partial",
    },
  );
});

test("builds a full runtime workspace plan when mode is full", () => {
  assert.deepStrictEqual(
    buildRuntimeWorkspacePlan({
      dirs: ["ignored"],
      files: ["ignored.txt"],
      mode: "full",
    }),
    {
      mode: "full",
    },
  );
});

test("rejects explicit framework evidence workspace selections", () => {
  for (const workspace of [
    {
      dirs: [FRAMEWORK_EVIDENCE_PATH],
      files: [],
    },
    {
      dirs: [],
      files: [`${FRAMEWORK_EVIDENCE_PATH}/other/sbom.spdx.json`],
    },
    {
      dirs: [`.dagger/runtime/cache/../evidence/other`],
      files: [],
    },
  ]) {
    assert.throws(
      () => buildRuntimeWorkspacePlan(workspace),
      /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/,
    );
  }
});

test("allows ordinary .dagger metadata as a sanitized partial workspace", () => {
  assert.deepStrictEqual(
    buildRuntimeWorkspacePlan({ dirs: [".dagger"], files: [] }),
    {
      dirs: [".dagger"],
      files: [],
      mode: "partial",
    },
  );
});

test("runtime bypass rejects file-mount destinations that can replace verified evidence", () => {
  const unsafeTargets = [
    "/",
    "/workspace",
    "/workspace/.dagger",
    "/workspace/.dagger/runtime",
    "/workspace/.dagger/runtime/evidence",
    "/workspace/.dagger/runtime/evidence/image/scan.json",
    ".dagger/runtime/evidence/image/sbom.spdx.json",
    "/tmp/../workspace/.dagger/runtime/evidence/image/provenance.json",
    "\\workspace\\.dagger\\runtime\\evidence\\image\\scan.json",
  ];

  for (const [index, target] of unsafeTargets.entries()) {
    assert.throws(
      () =>
        assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence([
          index % 2 === 0
            ? { kind: "runtime_file", source: "value", target }
            : { kind: "host_path", source_var: "VALUE_PATH", target },
        ]),
      /collides with Rush Delivery evidence/,
    );
  }

  assert.doesNotThrow(() =>
    assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence([
      {
        kind: "runtime_file",
        source: "value",
        target: "/workspace/.dagger/project-config.json",
      },
      {
        kind: "host_path",
        source_var: "VALUE_PATH",
        target: "/tmp/../run//credential.json",
      },
    ]),
  );
});

test("removes all framework evidence before applying a full workspace", async () => {
  const calls: WorkspaceCall[] = [];

  await applyRuntimeWorkspace(
    fakeContainer(calls),
    fakeDirectory("packaged", calls),
    { dirs: [], files: [], mode: "full" },
  );

  assert.deepStrictEqual(calls, [
    ...evidenceSanitizationCalls("packaged"),
    {
      operation: "withDirectory",
      path: "/workspace",
      source: "packaged-without-.dagger-with-.dagger",
    },
  ]);
});

test("a partial .dagger parent uses the evidence-free repository view", async () => {
  const calls: WorkspaceCall[] = [];

  await applyRuntimeWorkspace(
    fakeContainer(calls),
    fakeDirectory("packaged", calls),
    { dirs: [".dagger"], files: ["package.json"] },
  );

  assert.deepStrictEqual(calls, [
    ...evidenceSanitizationCalls("packaged"),
    {
      operation: "directory",
      path: ".dagger",
      source: "packaged-without-.dagger-with-.dagger",
    },
    {
      operation: "withDirectory",
      path: "/workspace/.dagger",
      source: "packaged-without-.dagger-with-.dagger/.dagger",
    },
    {
      operation: "file",
      path: "package.json",
      source: "packaged-without-.dagger-with-.dagger",
    },
    {
      operation: "withFile",
      path: "/workspace/package.json",
      source: "packaged-without-.dagger-with-.dagger/package.json",
    },
  ]);
});

test("mounts only the selected target evidence from the original bundle", () => {
  const calls: WorkspaceCall[] = [];

  mountTargetEvidence(
    fakeContainer(calls),
    fakeDirectory("original-packaged", calls),
    "image-a",
  );

  assert.deepStrictEqual(calls, [
    {
      operation: "directory",
      path: `${FRAMEWORK_EVIDENCE_PATH}/image-a`,
      source: "original-packaged",
    },
    {
      operation: "withDirectory",
      path: `/workspace/${FRAMEWORK_EVIDENCE_PATH}/image-a`,
      source: `original-packaged/${FRAMEWORK_EVIDENCE_PATH}/image-a`,
    },
  ]);
});

test("host-path mount sources use an evidence-free repository view", async () => {
  const calls: WorkspaceCall[] = [];

  const sanitized = await withoutFrameworkEvidence(
    fakeDirectory("runtime-mount-source", calls),
  );
  sanitized.file("safe/provider-key.pem");

  assert.deepStrictEqual(calls, [
    ...evidenceSanitizationCalls("runtime-mount-source"),
    {
      operation: "file",
      path: "safe/provider-key.pem",
      source: "runtime-mount-source-without-.dagger-with-.dagger",
    },
  ]);
});

test("rejects unsafe target names before mounting evidence", () => {
  const calls: WorkspaceCall[] = [];

  assert.throws(
    () =>
      mountTargetEvidence(
        fakeContainer(calls),
        fakeDirectory("original-packaged", calls),
        "..",
      ),
    /cannot be used as a framework evidence path/,
  );
  assert.deepStrictEqual(calls, []);
});
