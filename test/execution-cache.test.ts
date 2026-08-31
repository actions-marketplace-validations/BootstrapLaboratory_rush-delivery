import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Container } from "@dagger.io/dagger";

import { withFreshExecutionCache } from "../src/execution/cache-buster.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("public state-sensitive functions opt out of Dagger function caching", async () => {
  const source = await readFile(path.join(repoRoot, "src/index.ts"), "utf8");

  for (const method of [
    "selfCheck",
    "detect",
    "buildDeployTargets",
    "packageDeployTargets",
    "buildAndPackageDeployTargets",
    "deployRelease",
    "workflow",
    "validate",
    "releasePackages",
  ]) {
    assert.match(
      source,
      new RegExp(`@func\\(\\{ cache: "never" \\}\\)\\s+async ${method}\\(`),
      `${method} must execute on every public call`,
    );
  }

  for (const method of [
    "ping",
    "describeReleaseTargets",
    "validateMetadataContract",
  ]) {
    assert.match(
      source,
      new RegExp(
        `@func\\(\\{ cache: "session" \\}\\)\\s+(?:async )?${method}\\(`,
      ),
      `${method} must use an explicit bounded cache policy`,
    );
  }
});

test("fresh execution cache inputs are non-secret and unique", () => {
  const calls: Array<{ contents: string; path: string }> = [];
  const fakeContainer = {
    withNewFile(filePath: string, contents: string) {
      calls.push({ contents, path: filePath });
      return fakeContainer;
    },
  } as unknown as Container;

  assert.equal(
    withFreshExecutionCache(fakeContainer, "cosign-publication"),
    fakeContainer,
  );
  withFreshExecutionCache(fakeContainer, "cosign-publication");

  assert.deepEqual(
    calls.map(({ path: filePath }) => filePath),
    [
      "/tmp/rush-delivery-execution/cosign-publication",
      "/tmp/rush-delivery-execution/cosign-publication",
    ],
  );
  assert.notEqual(calls[0].contents, calls[1].contents);
  assert.match(
    calls[0].contents,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\n$/,
  );
  assert.throws(
    () => withFreshExecutionCache(fakeContainer, "../unsafe"),
    /operation name is invalid/,
  );
});

test("mutable and security-sensitive execution graphs use fresh cache inputs", async () => {
  const files = [
    "src/application-images/cosign.ts",
    "src/application-images/package-image.ts",
    "src/stages/deploy/execute-target.ts",
    "src/stages/release/release-packages.ts",
  ];

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    assert.match(
      source,
      /withFreshExecutionCache\(/,
      `${file} must invalidate state-sensitive execution layers`,
    );
  }

  const cosignSource = await readFile(
    path.join(repoRoot, "src/application-images/cosign.ts"),
    "utf8",
  );
  assert.match(
    cosignSource,
    /withMountedTemp\("\/tmp\/rush-delivery-cosign-preflight"\)/,
    "Cosign preflight key-derived files must stay on an ephemeral mount",
  );
  assert.doesNotMatch(
    cosignSource,
    /withNewFile\(\s*COSIGN_PREFLIGHT_CHALLENGE_PATH/u,
    "Cosign preflight must create its challenge inside the single tmpfs exec",
  );
  assert.match(
    cosignSource,
    /withMountedTemp\("\/tmp\/rush-delivery-cosign-preflight"\)[\s\S]+withExec\([\s\S]+buildCosignPreflightScript\(\)/u,
    "Cosign preflight must run its complete plan in one tmpfs-backed exec",
  );
});
