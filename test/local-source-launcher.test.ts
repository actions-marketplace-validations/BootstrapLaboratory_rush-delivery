import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const launcherPath = path.join(repoRoot, "github-action/rush-delivery-local");

function createRepository(prefix = "rush-delivery-local-"): string {
  const repository = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(repository, ".dagger"));
  mkdirSync(path.join(repository, ".git"));
  writeFileSync(path.join(repository, "rush.json"), "{}\n");
  return repository;
}

function runLauncher(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [launcherPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
  });
}

test("bounded launcher emits ordered caller-side filters and preserves inclusions", () => {
  const repository = createRepository("rush-delivery-local-'quote-");
  const ignorePath = path.join(repository, ".dagger/source-import.ignore");
  writeFileSync(
    ignorePath,
    [
      "# repository source boundary",
      "apps/worker/.venv",
      "!apps/worker/.venv/bin/uv",
      "generated output",
    ].join("\r\n"),
  );

  const result = runLauncher([
    "--emit-shell",
    `--repo=${repository}`,
    "--",
    "workflow",
    "--git-sha=1234567890abcdef1234567890abcdef12345678",
    '--force-targets-json=["api"]',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^repo=\$\(host \| directory /u);
  assert.match(result.stdout, /rush-delivery-local-'\\''quote-/u);
  const ordered = [
    "**/node_modules",
    "**/.venv",
    "**/__pycache__",
    "**/.rush",
    "**/rush-logs",
    ".trunk/out",
    ".trunk/logs",
    "apps/worker/.venv",
    "!apps/worker/.venv/bin/uv",
    "generated output",
  ];
  let previousIndex = -1;
  for (const pattern of ordered) {
    const index = result.stdout.indexOf(`--exclude='${pattern}'`);
    assert.ok(
      index > previousIndex,
      `${pattern} must retain ordered precedence`,
    );
    previousIndex = index;
  }
  assert.match(result.stdout, /local-source --repo=\$repo \| workflow/u);
  assert.match(result.stdout, /'--force-targets-json=\["api"\]'/u);
  assert.doesNotMatch(result.stdout, /--source-mode/u);

  rmSync(repository, { force: true, recursive: true });
});

test("bounded launcher passes host paths as typed Dagger Shell objects", () => {
  const repository = createRepository();
  const workflowEnv = path.join(repository, "workflow env");
  const deployEnv = path.join(repository, "deploy.env");
  const releaseEnv = path.join(repository, "release.env");
  const runtimeFiles = path.join(repository, "runtime files");
  const dockerSocket = path.join(repository, "docker.sock");
  const result = runLauncher([
    "--emit-shell",
    `--repo=${repository}`,
    "--",
    "workflow",
    `--workflow-env-file=${workflowEnv}`,
    "--deploy-env-file",
    deployEnv,
    `--release-env-file=${releaseEnv}`,
    "--runtime-files",
    runtimeFiles,
    `--docker-socket=${dockerSocket}`,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `rush_delivery_input_0=\\$\\(host \\| file '${workflowEnv}'\\)`,
      "u",
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `rush_delivery_input_1=\\$\\(host \\| file '${deployEnv}'\\)`,
      "u",
    ),
  );
  assert.match(result.stdout, /rush_delivery_input_2=\$\(host \| file /u);
  assert.match(result.stdout, /rush_delivery_input_3=\$\(host \| directory /u);
  assert.match(
    result.stdout,
    /rush_delivery_input_4=\$\(host \| unix-socket /u,
  );
  for (const [name, index] of [
    ["workflow-env-file", 0],
    ["deploy-env-file", 1],
    ["release-env-file", 2],
    ["runtime-files", 3],
    ["docker-socket", 4],
  ] as const) {
    assert.match(
      result.stdout,
      new RegExp(`--${name}=\\$rush_delivery_input_${index}`, "u"),
    );
  }
  assert.doesNotMatch(result.stdout, /'--workflow-env-file=\//u);

  rmSync(repository, { force: true, recursive: true });
});

test("bounded launcher rejects unsafe patterns and mandatory path removal", () => {
  const invalidPatterns = [
    "../outside",
    "/absolute",
    "!!double",
    "!",
    "**/.git",
    ".dagger/runtime",
    "rush.json",
    "cache\\escape",
    "cache$(id)",
    "cache;id",
  ];

  for (const pattern of invalidPatterns) {
    const repository = createRepository();
    writeFileSync(
      path.join(repository, ".dagger/source-import.ignore"),
      pattern,
    );
    const result = runLauncher([
      "--emit-shell",
      `--repo=${repository}`,
      "--",
      "validate",
    ]);
    assert.notEqual(result.status, 0, pattern);
    assert.match(result.stderr, /source import pattern/u);
    assert.doesNotMatch(result.stderr, /\$\(uid=/u);
    rmSync(repository, { force: true, recursive: true });
  }
});

test("bounded launcher confines and validates the optional ignore file", () => {
  const repository = createRepository();
  let result = runLauncher([
    "--emit-shell",
    `--repo=${repository}`,
    "--source-import-ignore-file=.dagger/missing.ignore",
    "--",
    "release-packages",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ignore file does not exist/u);

  const outside = path.join(repository, "outside.ignore");
  writeFileSync(outside, "cache\n");
  symlinkSync(outside, path.join(repository, ".dagger/source-import.ignore"));
  result = runLauncher([
    "--emit-shell",
    `--repo=${repository}`,
    "--",
    "release-packages",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symlink/u);

  rmSync(repository, { force: true, recursive: true });
});

test("legacy launcher preserves the top-level call path without reading ignores", () => {
  const repository = createRepository();
  const binDirectory = path.join(repository, "bin");
  const capturePath = path.join(repository, "dagger-args.txt");
  mkdirSync(binDirectory);
  writeFileSync(
    path.join(binDirectory, "dagger"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" >"$RUSH_DELIVERY_TEST_CAPTURE"\n',
  );
  chmodSync(path.join(binDirectory, "dagger"), 0o755);
  writeFileSync(
    path.join(repository, ".dagger/source-import.ignore"),
    "../invalid-but-unread\n",
  );

  const result = runLauncher(
    [
      "--source-import-policy=legacy",
      `--repo=${repository}`,
      "--module=github.com/example/rush-delivery@v0.9.1",
      "--",
      "validate",
      "--event-name=pull_request",
    ],
    {
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      RUSH_DELIVERY_TEST_CAPTURE: capturePath,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(capturePath, "utf8").trim().split("\n"), [
    "call",
    "-m",
    "github.com/example/rush-delivery@v0.9.1",
    "validate",
    "--event-name=pull_request",
    "--source-mode=local_copy",
    `--repo=${repository}`,
  ]);

  rmSync(repository, { force: true, recursive: true });
});

test("launcher rejects adapter-owned arguments and contradictory legacy flags", () => {
  const repository = createRepository();
  for (const args of [
    [
      "--emit-shell",
      `--repo=${repository}`,
      "--",
      "workflow",
      "--repo=elsewhere",
    ],
    [
      "--emit-shell",
      `--repo=${repository}`,
      "--",
      "workflow",
      "--source-mode=git",
    ],
    [
      "--source-import-policy=legacy",
      "--source-import-ignore-file=.dagger/source-import.ignore",
      `--repo=${repository}`,
      "--",
      "validate",
    ],
  ]) {
    const result = runLauncher(args);
    assert.notEqual(result.status, 0);
  }

  rmSync(repository, { force: true, recursive: true });
});
