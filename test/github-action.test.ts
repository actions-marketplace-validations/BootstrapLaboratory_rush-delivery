import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const scriptPath = path.join(repoRoot, "github-action", "prepare-workflow.sh");

function parseGithubOutput(contents: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredocMatch = /^([^<]+)<<(.+)$/.exec(line);

    if (heredocMatch === null) {
      continue;
    }

    const [, name, delimiter] = heredocMatch;
    const valueLines: string[] = [];
    index += 1;

    while (index < lines.length && lines[index] !== delimiter) {
      valueLines.push(lines[index]);
      index += 1;
    }

    outputs[name] = valueLines.join("\n");
  }

  return outputs;
}

function runPrepare(env: Record<string, string>) {
  const result = spawnSync("bash", [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
  });

  return result;
}

test("action metadata defines a composite action over dagger-for-github", () => {
  const metadata = parseYaml(
    readFileSync(path.join(repoRoot, "action.yml"), "utf8"),
  ) as {
    inputs: Record<string, { default?: string }>;
    runs: {
      steps: Array<{ uses?: string }>;
      using: string;
    };
  };

  assert.equal(metadata.inputs.entrypoint.default, "workflow");
  assert.equal(metadata.inputs.repo.default, "");
  assert.equal(metadata.inputs["workflow-env"].default, "");
  assert.equal(metadata.inputs["workflow-env-file"].default, "");
  assert.equal(metadata.inputs["release-env"].default, "");
  assert.equal(metadata.inputs["release-env-file"].default, "");
  assert.equal(metadata.inputs["release-targets-json"].default, "[]");
  assert.equal(metadata.inputs["validate-targets-json"].default, "[]");
  assert.equal(metadata.inputs["application-image-provider"].default, "off");
  assert.equal(metadata.inputs["dagger-version"].default, "v0.20.7");
  assert.equal(metadata.runs.using, "composite");
  assert.ok(
    metadata.runs.steps.some(
      (step) =>
        step.uses ===
        "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77",
    ),
  );
});

test("prepare workflow writes deploy env, runtime files, and Dagger args", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rush-delivery-action-"));
  const outputPath = path.join(tempDir, "github-output");
  const sourceCredential = path.join(tempDir, "gha-creds.json");
  const sourceExecutable = path.join(tempDir, "deploy-helper.sh");
  const deployEnvFile = path.join(tempDir, "base.env");

  writeFileSync(sourceCredential, '{"ok":true}\n');
  writeFileSync(sourceExecutable, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(sourceExecutable, 0o755);
  writeFileSync(deployEnvFile, "BASE_VALUE=from-file\n");

  const result = runPrepare({
    GITHUB_ACTION_PATH: repoRoot,
    GITHUB_ACTOR: "octocat",
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    GITHUB_WORKSPACE: "/home/runner/work/repo/repo",
    INPUT_ARTIFACT_PREFIX: "artifact",
    INPUT_APPLICATION_IMAGE_PROVIDER: "release",
    INPUT_DEPLOY_ENV:
      "GCP_PROJECT_ID=test-project\nCLOUD_RUN_REGION=us-central1",
    INPUT_DEPLOY_ENV_FILE: deployEnvFile,
    INPUT_DEPLOY_TAG_PREFIX: "deploy/prod",
    INPUT_DOCKER_SOCKET: "",
    INPUT_DRY_RUN: "false",
    INPUT_ENVIRONMENT: "prod",
    INPUT_EVENT_NAME: "workflow_call",
    INPUT_FORCE_TARGETS_JSON: '["server"]',
    INPUT_INCLUDE_GITHUB_ENV: "true",
    INPUT_MODULE: "",
    INPUT_PR_BASE_SHA: "",
    INPUT_RUNTIME_FILE_MAP: `${sourceCredential}=>gcp-credentials.json\n${sourceExecutable}=>bin/deploy-helper.sh\n=>ignored.json`,
    INPUT_RUNTIME_FILES: "",
    INPUT_RUSH_CACHE_POLICY: "lazy",
    INPUT_RUSH_CACHE_PROVIDER: "github",
    INPUT_SOURCE_AUTH_TOKEN_ENV: "GITHUB_TOKEN",
    INPUT_SOURCE_AUTH_USERNAME: "",
    INPUT_SOURCE_MODE: "git",
    INPUT_SOURCE_REF: "",
    INPUT_SOURCE_REPOSITORY_URL: "",
    INPUT_TOOLCHAIN_IMAGE_POLICY: "lazy",
    INPUT_TOOLCHAIN_IMAGE_PROVIDER: "github",
    RD_GITHUB_API_URL: "https://api.github.example",
    RD_GITHUB_TOKEN: "token-value",
    RUNNER_TEMP: tempDir,
  });

  assert.equal(result.status, 0, result.stderr);

  const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
  assert.equal(outputs.module, repoRoot);
  assert.match(outputs.args, /^workflow /);
  assert.match(
    outputs.args,
    /--git-sha=1234567890abcdef1234567890abcdef12345678/,
  );
  assert.match(outputs.args, /--dry-run=false/);
  assert.match(outputs.args, /--release-targets-json=/);
  assert.match(outputs.args, /--application-image-provider=release/);
  assert.match(outputs.args, /--workflow-env-file=/);
  assert.match(outputs.args, /--source-mode=git/);
  assert.match(
    outputs.args,
    /--source-repository-url=https:\/\/github\.example\/owner\/repo\.git/,
  );
  assert.match(outputs.args, /--source-auth-token-env=GITHUB_TOKEN/);
  assert.doesNotMatch(outputs.args, /--docker-socket=/);

  const deployEnv = await readFile(outputs["deploy-env-file"], "utf8");
  assert.match(deployEnv, /BASE_VALUE=from-file/);
  assert.match(deployEnv, /GCP_PROJECT_ID=test-project/);

  const workflowEnv = await readFile(outputs["workflow-env-file"], "utf8");
  assert.match(workflowEnv, /GITHUB_ACTOR=octocat/);
  assert.match(workflowEnv, /GITHUB_REPOSITORY=owner\/repo/);
  assert.match(workflowEnv, /GITHUB_API_URL=https:\/\/api\.github\.example/);
  assert.match(workflowEnv, /GITHUB_TOKEN=token-value/);

  const releaseEnv = await readFile(outputs["release-env-file"], "utf8");
  assert.equal(releaseEnv, "");

  for (const envFile of [
    outputs["workflow-env-file"],
    outputs["deploy-env-file"],
    outputs["release-env-file"],
  ]) {
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  }

  const copiedRuntimeCredential = path.join(
    outputs["runtime-files"],
    "gcp-credentials.json",
  );
  assert.equal(
    await readFile(copiedRuntimeCredential, "utf8"),
    '{"ok":true}\n',
  );
  assert.equal((await stat(copiedRuntimeCredential)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(path.join(outputs["runtime-files"], "bin/deploy-helper.sh")))
      .mode & 0o777,
    0o700,
  );
  assert.equal((await stat(outputs["runtime-files"])).mode & 0o777, 0o700);

  await assert.rejects(
    stat(path.join(outputs["runtime-files"], "ignored.json")),
  );

  await rm(tempDir, { force: true, recursive: true });
});

test("prepare workflow passes release targets and release env for composed workflow", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rush-delivery-action-"));
  const outputPath = path.join(tempDir, "github-output");

  const result = runPrepare({
    GITHUB_ACTION_PATH: repoRoot,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    INPUT_DRY_RUN: "false",
    INPUT_INCLUDE_GITHUB_ENV: "true",
    INPUT_RELEASE_ENV: "NPM_TOKEN=npm-token",
    INPUT_RELEASE_TARGETS_JSON: '["npm"]',
    INPUT_SOURCE_AUTH_TOKEN_ENV: "GITHUB_TOKEN",
    INPUT_SOURCE_MODE: "git",
    INPUT_WORKFLOW_ENV: "SHARED_VALUE=yes",
    RD_GITHUB_API_URL: "https://api.github.example",
    RD_GITHUB_TOKEN: "token-value",
    RUNNER_TEMP: tempDir,
  });

  assert.equal(result.status, 0, result.stderr);

  const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
  assert.match(outputs.args, /^workflow /);
  assert.match(outputs.args, /--release-targets-json=/);
  assert.match(outputs.args, /npm/);
  assert.match(outputs.args, /--workflow-env-file=/);
  assert.match(outputs.args, /--release-env-file=/);

  const workflowEnv = await readFile(outputs["workflow-env-file"], "utf8");
  assert.match(workflowEnv, /SHARED_VALUE=yes/);
  assert.match(workflowEnv, /GITHUB_TOKEN=token-value/);

  const releaseEnv = await readFile(outputs["release-env-file"], "utf8");
  assert.match(releaseEnv, /NPM_TOKEN=npm-token/);
  assert.doesNotMatch(releaseEnv, /GITHUB_TOKEN=token-value/);

  await rm(tempDir, { force: true, recursive: true });
});

test("prepare release-packages entrypoint writes release env and Dagger args", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rush-delivery-action-"));
  const outputPath = path.join(tempDir, "github-output");
  const releaseEnvFile = path.join(tempDir, "release.env");

  writeFileSync(releaseEnvFile, "NPM_TOKEN=from-file\n");

  const result = runPrepare({
    GITHUB_ACTION_PATH: repoRoot,
    GITHUB_ACTOR: "octocat",
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    GITHUB_WORKSPACE: "/home/runner/work/repo/repo",
    INPUT_DRY_RUN: "false",
    INPUT_ENTRYPOINT: "release-packages",
    INPUT_INCLUDE_GITHUB_ENV: "true",
    INPUT_RELEASE_ENV: "EXTRA_RELEASE_VALUE=yes",
    INPUT_RELEASE_ENV_FILE: releaseEnvFile,
    INPUT_RUSH_CACHE_PROVIDER: "github",
    INPUT_SOURCE_AUTH_TOKEN_ENV: "GITHUB_TOKEN",
    INPUT_SOURCE_MODE: "git",
    INPUT_TOOLCHAIN_IMAGE_PROVIDER: "github",
    RD_GITHUB_API_URL: "https://api.github.example",
    RD_GITHUB_TOKEN: "token-value",
    RUNNER_TEMP: tempDir,
  });

  assert.equal(result.status, 0, result.stderr);

  const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
  assert.match(outputs.args, /^release-packages /);
  assert.match(
    outputs.args,
    /--git-sha=1234567890abcdef1234567890abcdef12345678/,
  );
  assert.match(outputs.args, /--dry-run=false/);
  assert.match(outputs.args, /--release-env-file=/);
  assert.match(outputs.args, /--toolchain-image-provider=github/);
  assert.match(outputs.args, /--toolchain-image-policy=lazy/);
  assert.match(outputs.args, /--rush-cache-provider=github/);
  assert.match(outputs.args, /--rush-cache-policy=lazy/);
  assert.match(outputs.args, /--source-mode=git/);
  assert.match(
    outputs.args,
    /--source-repository-url=https:\/\/github\.example\/owner\/repo\.git/,
  );
  assert.match(outputs.args, /--source-ref=refs\/heads\/main/);
  assert.match(outputs.args, /--source-auth-token-env=GITHUB_TOKEN/);
  assert.doesNotMatch(outputs.args, /--deploy-env-file=/);
  assert.doesNotMatch(outputs.args, /--runtime-files=/);

  const releaseEnv = await readFile(outputs["release-env-file"], "utf8");
  assert.match(releaseEnv, /NPM_TOKEN=from-file/);
  assert.match(releaseEnv, /EXTRA_RELEASE_VALUE=yes/);
  assert.match(releaseEnv, /GITHUB_TOKEN=token-value/);

  await rm(tempDir, { force: true, recursive: true });
});

test("prepare validate entrypoint writes source-aware Dagger args", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rush-delivery-action-"));
  const outputPath = path.join(tempDir, "github-output");

  const result = runPrepare({
    GITHUB_ACTION_PATH: repoRoot,
    GITHUB_ACTOR: "octocat",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    GITHUB_WORKSPACE: "/home/runner/work/repo/repo",
    INPUT_ENTRYPOINT: "validate",
    INPUT_EVENT_NAME: "",
    INPUT_INCLUDE_GITHUB_ENV: "true",
    INPUT_PR_BASE_SHA: "",
    INPUT_SOURCE_AUTH_TOKEN_ENV: "GITHUB_TOKEN",
    INPUT_SOURCE_MODE: "git",
    INPUT_SOURCE_REF: "",
    INPUT_SOURCE_REPOSITORY_URL: "",
    INPUT_TOOLCHAIN_IMAGE_PROVIDER: "github",
    INPUT_RUSH_CACHE_PROVIDER: "github",
    INPUT_VALIDATE_TARGETS_JSON: '["api-contract"]',
    RD_GITHUB_API_URL: "https://api.github.example",
    RD_GITHUB_TOKEN: "token-value",
    RD_PR_BASE_SHA: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    RUNNER_TEMP: tempDir,
  });

  assert.equal(result.status, 0, result.stderr);

  const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
  assert.match(outputs.args, /^validate /);
  assert.match(
    outputs.args,
    /--git-sha=1234567890abcdef1234567890abcdef12345678/,
  );
  assert.match(outputs.args, /--event-name=pull_request/);
  assert.match(
    outputs.args,
    /--pr-base-sha=abcdefabcdefabcdefabcdefabcdefabcdefabcd/,
  );
  assert.match(outputs.args, /--validate-targets-json=/);
  assert.match(outputs.args, /api-contract/);
  assert.match(outputs.args, /--deploy-env-file=/);
  assert.match(outputs.args, /--toolchain-image-provider=github/);
  assert.match(outputs.args, /--toolchain-image-policy=pull-or-build/);
  assert.match(outputs.args, /--rush-cache-provider=github/);
  assert.match(outputs.args, /--rush-cache-policy=pull-or-build/);
  assert.match(outputs.args, /--source-mode=git/);
  assert.match(
    outputs.args,
    /--source-repository-url=https:\/\/github\.example\/owner\/repo\.git/,
  );
  assert.match(outputs.args, /--source-ref=refs\/pull\/7\/merge/);
  assert.match(outputs.args, /--source-auth-token-env=GITHUB_TOKEN/);
  assert.doesNotMatch(outputs.args, /--dry-run=/);
  assert.doesNotMatch(outputs.args, /--runtime-files=/);

  const deployEnv = await readFile(outputs["deploy-env-file"], "utf8");
  assert.match(deployEnv, /GITHUB_TOKEN=token-value/);

  await rm(tempDir, { force: true, recursive: true });
});

test("prepare workflow rejects runtime file destinations that escape the bundle", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rush-delivery-action-"));
  const outputPath = path.join(tempDir, "github-output");
  const sourceCredential = path.join(tempDir, "gha-creds.json");
  await mkdir(tempDir, { recursive: true });
  writeFileSync(sourceCredential, "{}\n");

  const result = runPrepare({
    GITHUB_ACTION_PATH: repoRoot,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678",
    INPUT_RUNTIME_FILE_MAP: `${sourceCredential}=>../gcp-credentials.json`,
    RD_GITHUB_TOKEN: "token-value",
    RUNNER_TEMP: tempDir,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must stay inside runtime-files/);

  await rm(tempDir, { force: true, recursive: true });
});
