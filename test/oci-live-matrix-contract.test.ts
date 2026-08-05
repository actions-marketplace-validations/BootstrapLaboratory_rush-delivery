import * as assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const runnerPath = path.join(
  repoRoot,
  "test/scripts/run-oci-v081-acceptance-matrix.sh",
);
const libraryPath = path.join(
  repoRoot,
  "test/scripts/lib/oci-v081-acceptance-matrix.sh",
);
const fixtureBuilderPath = path.join(
  repoRoot,
  "test/scripts/build-oci-v081-matrix-fixture.mjs",
);
const verifierPath = path.join(
  repoRoot,
  "test/scripts/verify-oci-v081-acceptance-matrix.mjs",
);
const daggerStubPath = path.join(
  repoRoot,
  "test/scripts/stub-oci-v081-matrix-dagger.mjs",
);
const gitSha = "0123456789abcdef0123456789abcdef01234567";

async function runBash(source: string, args: string[] = []) {
  return execFileAsync("bash", ["-c", source, "matrix-test", ...args], {
    encoding: "utf8",
  });
}

async function buildFixture(
  mode: string,
  destination: string,
  sourceSha: string = gitSha,
  digestSeed: string = "a",
) {
  await runBash(
    'source "$1"; oci_v081_matrix_build_fixture "$2" "$3" "$4" "$5"',
    [libraryPath, mode, destination, sourceSha, digestSeed],
  );
}

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

test("v0.8.1 deterministic matrix names every executable scenario and passes shell syntax", async () => {
  await Promise.all([
    execFileAsync("bash", ["-n", runnerPath]),
    execFileAsync("bash", ["-n", libraryPath]),
  ]);
  const { stdout } = await execFileAsync(runnerPath, ["--list"], {
    encoding: "utf8",
  });
  assert.deepEqual(stdout.trim().split("\n"), [
    "named-provider-dry-run-without-env-file",
    "filesystem-workflow",
    "filesystem-package-deploy-targets",
    "filesystem-build-and-package-deploy-targets",
    "filesystem-deploy-release",
    "archive-checksum-restore-separate-deploy",
    "rollback-second-restore-without-manifest-mutation",
    "reserved-env-attack-rejection",
    "full-partial-mixed-evidence-isolation",
  ]);
  const { stdout: liveStdout } = await execFileAsync(
    runnerPath,
    ["--list-live-scenarios"],
    { encoding: "utf8" },
  );
  assert.deepEqual(liveStdout.trim().split("\n"), [
    "malformed-private-pem",
    "malformed-public-pem",
    "wrong-signing-password",
    "invalid-key",
    "mismatched-key",
    "multi-target-success",
    "multi-target-preparation-failure",
    "multi-target-finalization-failure",
  ]);

  const runner = await readFile(runnerPath, "utf8");
  const namedDryFunction =
    /run_named_provider_dry_run\(\) \{([\s\S]+?)\n\}/u.exec(runner)?.[1];
  assert.ok(namedDryFunction);
  assert.match(namedDryFunction, /--application-image-provider=ghcr/u);
  assert.doesNotMatch(namedDryFunction, /deploy-env-file/u);
  for (const entrypoint of [
    "workflow",
    "package-deploy-targets",
    "build-and-package-deploy-targets",
    "deploy-release",
  ]) {
    assert.match(runner, new RegExp(`\\b${entrypoint}\\b`, "u"));
  }
  assert.match(runner, /--application-image-provider=off/u);
  assert.equal(
    (runner.match(/oci_v081_matrix_restore_archive/g) ?? []).length,
    2,
  );
  assert.equal((runner.match(/run_restored_deploy/g) ?? []).length, 3);
});

test("v0.8.1 deterministic runner executes every local control-flow gate", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-runner-contract-"),
  );
  const executableDirectory = path.join(temporaryRoot, "bin");

  try {
    await mkdir(executableDirectory, { recursive: true });
    await symlink(daggerStubPath, path.join(executableDirectory, "dagger"));
    const { stdout } = await execFileAsync(runnerPath, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
      },
      timeout: 120_000,
    });
    assert.match(
      stdout,
      /v0\.8\.1 deterministic OCI acceptance matrix passed\./u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("filesystem fixture has no OCI provider metadata and keeps the legacy package contract", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-filesystem-fixture-"),
  );
  const fixture = path.join(temporaryRoot, "fixture");

  try {
    await buildFixture("filesystem", fixture);
    await assert.rejects(
      readFile(path.join(fixture, ".dagger/application-images/providers.yaml")),
      /ENOENT/u,
    );
    assert.equal(
      await readFile(
        path.join(fixture, ".dagger/package/targets/control-plane-api.yaml"),
        "utf8",
      ),
      [
        "name: control-plane-api",
        "artifact:",
        "  kind: directory",
        "  path: apps/control-plane-api/dist",
        "",
      ].join("\n"),
    );
    assert.equal(
      (await stat(path.join(fixture, "matrix/deploy-filesystem.sh"))).mode &
        0o777,
      0o755,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("isolation fixture binds full, partial, and mixed workspaces to local evidence hashes", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-isolation-fixture-"),
  );
  const fixture = path.join(temporaryRoot, "fixture");

  try {
    await buildFixture("oci-isolation", fixture, gitSha, "d");
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture, ".dagger/runtime/package-manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(manifest.artifacts), [
      "image-a",
      "image-b",
      "filesystem",
    ]);
    assert.equal(manifest.artifacts["image-a"].source_revision, gitSha);
    assert.equal(
      manifest.artifacts["image-a"].digest,
      `sha256:${"d".repeat(64)}`,
    );

    for (const target of ["image-a", "image-b"]) {
      for (const evidenceName of ["provenance", "sbom", "scan"]) {
        const evidence = manifest.artifacts[target].evidence[evidenceName];
        const contents = await readFile(path.join(fixture, evidence.path));
        assert.equal(evidence.digest, sha256(contents));
      }
    }

    assert.match(
      await readFile(
        path.join(fixture, ".dagger/deploy/targets/image-a.yaml"),
        "utf8",
      ),
      /workspace:\n    mode: full/u,
    );
    assert.match(
      await readFile(
        path.join(fixture, ".dagger/deploy/targets/image-b.yaml"),
        "utf8",
      ),
      /dirs:\n      - \.dagger\n      - matrix/u,
    );
    assert.equal(
      (await lstat(path.join(fixture, "matrix/current"))).isSymbolicLink(),
      true,
    );
    assert.equal(
      await readlink(path.join(fixture, "matrix/current")),
      "deploy-image-a.sh",
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("archive helpers verify external checksum and preserve bytes, modes, and symlinks", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-archive-contract-"),
  );
  const fixture = path.join(temporaryRoot, "fixture");
  const archive = path.join(temporaryRoot, "protected", "bundle.tar.gz");
  const checksum = path.join(temporaryRoot, "protected", "bundle.sha256");
  const sourceRecord = path.join(temporaryRoot, "protected", "bundle.git-sha");
  const restored = path.join(temporaryRoot, "restored", "bundle");

  try {
    await buildFixture("oci-isolation", fixture);
    const manifestBefore = await readFile(
      path.join(fixture, ".dagger/runtime/package-manifest.json"),
    );
    await runBash(
      [
        'source "$1"',
        'oci_v081_matrix_create_archive "$2" "$3" "$4" "$5" "$6"',
        'oci_v081_matrix_restore_archive "$3" "$4" "$7"',
      ].join("; "),
      [libraryPath, fixture, archive, checksum, sourceRecord, gitSha, restored],
    );
    assert.deepEqual(
      await readFile(
        path.join(restored, ".dagger/runtime/package-manifest.json"),
      ),
      manifestBefore,
    );
    assert.equal(
      (await stat(path.join(restored, "matrix/deploy-image-a.sh"))).mode &
        0o777,
      0o751,
    );
    assert.equal(
      (await lstat(path.join(restored, "matrix/current"))).isSymbolicLink(),
      true,
    );
    assert.equal(await readFile(sourceRecord, "utf8"), `${gitSha}\n`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("deferred live fixtures cover multi-target preparation and key-preflight derivation without credentials", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-live-fixtures-"),
  );
  const single = path.join(temporaryRoot, "single");
  const success = path.join(temporaryRoot, "success");
  const failure = path.join(temporaryRoot, "failure");
  const finalizationFailure = path.join(temporaryRoot, "finalization-failure");

  try {
    for (const [mode, destination, suffix] of [
      ["live-single-target", single, "key"],
      ["live-multi-target-success", success, "success"],
      ["live-multi-target-preparation-failure", failure, "failure"],
      [
        "live-multi-target-finalization-failure",
        finalizationFailure,
        "finalization",
      ],
    ]) {
      await runBash(
        [
          'source "$1"',
          'oci_v081_matrix_build_live_fixture "$2" "$3" registry.example "matrix/run-$4"',
        ].join("; "),
        [libraryPath, mode, destination, suffix],
      );
    }

    assert.match(
      await readFile(
        path.join(single, ".dagger/application-images/providers.yaml"),
        "utf8",
      ),
      /repository_prefix: matrix\/run-key/u,
    );
    const successPlan = JSON.parse(
      await readFile(path.join(success, "ci/oci-plan.json"), "utf8"),
    );
    assert.deepEqual(successPlan.deploy_targets, [
      "control-plane-api",
      "matrix-worker",
    ]);
    assert.match(
      await readFile(
        path.join(failure, ".dagger/package/targets/matrix-worker.yaml"),
        "utf8",
      ),
      /grype-invalid\.yaml/u,
    );
    assert.equal(
      await readFile(
        path.join(failure, ".dagger/application-images/grype-invalid.yaml"),
        "utf8",
      ),
      "ignore: [\n",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(finalizationFailure, "ci/oci-plan.json"),
          "utf8",
        ),
      ).deploy_targets,
      ["control-plane-api", "matrix-worker", "matrix-later"],
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("deferred live runner is one-shot, hard-bounded, and requires independent zero-publication inventory", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-live-guard-"),
  );
  const stateDirectory = path.join(temporaryRoot, "state");
  const hookPath = path.join(temporaryRoot, "inventory-hook.sh");
  const hookOutput = path.join(temporaryRoot, "inventory-args.txt");

  try {
    await writeFile(
      hookPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$@" > "${OCI_MATRIX_HOOK_OUTPUT}"\n',
    );
    await chmod(hookPath, 0o755);
    await runBash(
      [
        'source "$1"',
        'oci_v081_matrix_claim_mutation_slot "$2"',
        'if oci_v081_matrix_claim_mutation_slot "$2"; then exit 91; fi',
        "if oci_v081_matrix_run_bounded 2001 true; then exit 92; fi",
        'OCI_MATRIX_HOOK_OUTPUT="$4" oci_v081_matrix_assert_zero_publications "$3" registry.example matrix/run "api,worker"',
      ].join("; "),
      [libraryPath, stateDirectory, hookPath, hookOutput],
    );
    assert.equal(
      await readFile(hookOutput, "utf8"),
      "registry.example\nmatrix/run\napi,worker\n",
    );

    const library = await readFile(libraryPath, "utf8");
    assert.match(
      library,
      /OCI_V081_MATRIX_LIVE_MUTATION_TIMEOUT_SECONDS=1200/u,
    );
    assert.equal(
      (library.match(/build-and-package-deploy-targets/g) ?? []).length,
      1,
    );
    assert.match(library, /invalid-key\)\s*[\s\S]*?expected_pattern=/u);
    assert.match(library, /mismatched-key\)\s*[\s\S]*?expected_pattern=/u);
    assert.match(
      library,
      /malformed-private-pem\)\s*[\s\S]*?expected_pattern=/u,
    );
    assert.match(
      library,
      /malformed-public-pem\)\s*[\s\S]*?expected_pattern=/u,
    );
    assert.match(
      library,
      /wrong-signing-password\)\s*[\s\S]*?expected_pattern=/u,
    );
    assert.match(library, /multi-target-preparation-failure/u);
    assert.match(library, /ordered-partial/u);
    assert.match(library, /oci_v081_matrix_assert_zero_publications/u);
    assert.doesNotMatch(
      library,
      /while .*run_live_package|until .*run_live_package/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("live runner exposes credential-gated execution for every deferred release scenario", async () => {
  const runner = await readFile(runnerPath, "utf8");
  for (const scenario of [
    "malformed-private-pem",
    "malformed-public-pem",
    "wrong-signing-password",
    "invalid-key",
    "mismatched-key",
    "multi-target-success",
    "multi-target-preparation-failure",
    "multi-target-finalization-failure",
  ]) {
    assert.match(runner, new RegExp(scenario, "u"));
  }
  assert.match(runner, /--run-live-scenario/u);
  assert.match(runner, /OCI_V081_MATRIX_DEPLOY_ENV_FILE/u);
  assert.match(runner, /OCI_V081_MATRIX_DOCKER_CONFIG_FILE/u);
  assert.match(runner, /OCI_V081_MATRIX_INVENTORY_HOOK/u);
  assert.match(runner, /OCI_V081_MATRIX_CLEANUP_HOOK/u);
  assert.match(runner, /OCI_V081_MATRIX_FAULT_HOOK/u);
  assert.match(runner, /randomBytes\(16\)/u);
  assert.match(runner, /trap cleanup_live_scenario EXIT/u);
  assert.match(runner, /pre-mutation-inventory\.json/u);
  assert.match(runner, /cleanup-inventory\.json/u);
  assert.match(runner, /fault-teardown\.log/u);
  assert.match(runner, /registry-inventory\.json/u);
  assert.match(runner, /package\.log/u);

  const library = await readFile(libraryPath, "utf8");
  assert.match(
    library,
    /export --path="\$\{output_directory\}" >"\$\{captured_log\}" 2>&1/u,
  );
  for (const inspectedPath of [
    "captured_log",
    "output_directory",
    "inventory_log",
    "inventory_evidence",
  ]) {
    assert.match(
      library,
      new RegExp(
        `oci_v081_matrix_assert_protected_capture[\\s\\S]*?"\\$\\{${inspectedPath}\\}"`,
        "u",
      ),
    );
  }
});

test("credential-gated runner executes every deferred scenario with unique cleanup-bound namespaces", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-live-runner-"),
  );
  const executableDirectory = path.join(temporaryRoot, "bin");
  const inventoryHook = path.join(temporaryRoot, "inventory-hook.mjs");
  const cleanupHook = path.join(temporaryRoot, "cleanup-hook.mjs");
  const faultHook = path.join(temporaryRoot, "fault-hook.mjs");
  const dockerConfigFile = path.join(temporaryRoot, "docker-config.json");
  const username = "SENTINEL_LIVE_USERNAME_92ab";
  const token = "SENTINEL_LIVE_TOKEN_45f10c";
  const basicAuth = Buffer.from(`${username}:${token}`, "utf8").toString(
    "base64",
  );
  const validPrivate =
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\\nVALID_PRIVATE_BODY_5a91ce\\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----";
  const validPublic =
    "-----BEGIN PUBLIC KEY-----\\nVALID_PUBLIC_BODY_629cae\\n-----END PUBLIC KEY-----";
  const scenarios = [
    "malformed-private-pem",
    "malformed-public-pem",
    "wrong-signing-password",
    "invalid-key",
    "mismatched-key",
    "multi-target-success",
    "multi-target-preparation-failure",
    "multi-target-finalization-failure",
  ];
  const observedNamespaces = new Set<string>();

  try {
    await mkdir(executableDirectory, { recursive: true });
    await symlink(daggerStubPath, path.join(executableDirectory, "dagger"));
    await writeFile(
      inventoryHook,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "const [assertion, registry, repositoryPrefix, targetsCsv, outputPath] = process.argv.slice(2);",
        'const targets = targetsCsv.split(",");',
        "const repositories = {};",
        "const events = [];",
        'if (assertion === "success") {',
        "  for (const [index, target] of targets.entries()) {",
        '    const digest = "sha256:" + String(index + 1).repeat(64);',
        '    const reference = registry + "/" + repositoryPrefix + "/" + target + "@" + digest;',
        "    repositories[target] = { publication_count: 1, subject_digest: digest, reference, signature_verified: true, spdx_attestation_verified: true, provenance_attestation_verified: true };",
        '    events.push({ operation: "subject-published", sequence: index + 1, target });',
        "  }",
        '} else if (assertion === "ordered-partial") {',
        '  const firstDigest = "sha256:" + "1".repeat(64);',
        '  const failedDigest = "sha256:" + "2".repeat(64);',
        '  const firstReference = registry + "/" + repositoryPrefix + "/" + targets[0] + "@" + firstDigest;',
        '  const failedReference = registry + "/" + repositoryPrefix + "/" + targets[1] + "@" + failedDigest;',
        "  repositories[targets[0]] = { publication_count: 1, reference: firstReference, subject_digest: firstDigest, signature_verified: true, spdx_attestation_verified: true, provenance_attestation_verified: true };",
        '  repositories[targets[1]] = { inspected: true, publication_count: 1, reference: failedReference, subject_digest: failedDigest, status: "published-then-failed" };',
        "  repositories[targets[2]] = { publication_count: 0 };",
        '  events.push({ operation: "subject-published", sequence: 1, target: targets[0] });',
        '  events.push({ operation: "subject-published", sequence: 2, target: targets[1] });',
        '} else if (assertion === "zero") {',
        "  for (const target of targets) repositories[target] = { publication_count: 0 };",
        "} else {",
        '  throw new Error("unsupported synthetic inventory assertion");',
        "}",
        'writeFileSync(outputPath, JSON.stringify({ assertion, events, repositories }) + "\\n", { mode: 0o600 });',
        "",
      ].join("\n"),
    );
    await writeFile(
      cleanupHook,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "const [action, registry, repositoryPrefix, targetsCsv, outputPath] = process.argv.slice(2);",
        'if (action !== "inspect-and-clean") throw new Error("unsupported cleanup action");',
        'const targets = targetsCsv.split(",");',
        "const repositories = Object.fromEntries(targets.map((target) => [target, { inspected: true, remaining_publication_count: 0 }]));",
        'writeFileSync(outputPath, JSON.stringify({ assertion: "cleanup", cleanup_completed: true, registry, repositories, repository_prefix: repositoryPrefix }) + "\\n", { mode: 0o600 });',
        'process.stdout.write("safe cleanup hook output\\n");',
        "",
      ].join("\n"),
    );
    await writeFile(
      faultHook,
      [
        "#!/usr/bin/env node",
        "const [action] = process.argv.slice(2);",
        'if (action !== "configure-finalization-failure" && action !== "teardown-finalization-failure") throw new Error("unsupported fault action");',
        'process.stdout.write("safe fault hook " + action + "\\n");',
        "",
      ].join("\n"),
    );
    await Promise.all([
      chmod(inventoryHook, 0o755),
      chmod(cleanupHook, 0o755),
      chmod(faultHook, 0o755),
    ]);
    await writeFile(
      dockerConfigFile,
      `${JSON.stringify({
        auths: { "registry.example": { auth: basicAuth } },
      })}\n`,
    );

    for (const scenario of scenarios) {
      let privateKey = validPrivate;
      let publicKey = validPublic;
      let password = "VALID_PASSWORD_SENTINEL_c725";
      if (scenario === "malformed-private-pem") {
        privateKey = "MALFORMED_PRIVATE_SENTINEL_6d2c";
      } else if (scenario === "malformed-public-pem") {
        publicKey = "MALFORMED_PUBLIC_SENTINEL_e092";
      } else if (scenario === "wrong-signing-password") {
        password = "WRONG_PASSWORD_SENTINEL_85f1";
      } else if (scenario === "invalid-key") {
        privateKey = validPrivate.replace(
          "VALID_PRIVATE_BODY_5a91ce",
          "INVALID_PRIVATE_BODY_73c45f",
        );
      } else if (scenario === "mismatched-key") {
        publicKey = validPublic.replace(
          "VALID_PUBLIC_BODY_629cae",
          "MISMATCH_PUBLIC_BODY_d926b0",
        );
      }
      const deployEnvFile = path.join(temporaryRoot, `${scenario}.env`);
      const outputRoot = path.join(temporaryRoot, `output-${scenario}`);
      await writeFile(
        deployEnvFile,
        [
          `OCI_MATRIX_USERNAME=${username}`,
          `OCI_MATRIX_TOKEN=${token}`,
          `OCI_MATRIX_SIGNING_KEY=${privateKey}`,
          `OCI_MATRIX_SIGNING_PASSWORD=${password}`,
          `OCI_MATRIX_VERIFICATION_KEY=${publicKey}`,
          "",
        ].join("\n"),
      );
      const { stdout } = await execFileAsync(
        runnerPath,
        ["--run-live-scenario", scenario, outputRoot],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
            OCI_V081_MATRIX_DEPLOY_ENV_FILE: deployEnvFile,
            OCI_V081_MATRIX_DOCKER_CONFIG_FILE: dockerConfigFile,
            OCI_V081_MATRIX_FAULT_HOOK: faultHook,
            OCI_V081_MATRIX_INVENTORY_HOOK: inventoryHook,
            OCI_V081_MATRIX_REGISTRY: "registry.example",
            OCI_V081_MATRIX_REPOSITORY_PREFIX: "matrix/synthetic",
            PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
          },
          timeout: 120_000,
        },
      );
      assert.match(stdout, /checks passed; cleanup is armed/u);
      const packageLog = await readFile(
        path.join(outputRoot, "package.log"),
        "utf8",
      );
      assert.match(packageLog, /safe package stdout/u);
      assert.match(packageLog, /safe package stderr/u);
      const providerSource = await readFile(
        path.join(
          outputRoot,
          "fixture/.dagger/application-images/providers.yaml",
        ),
        "utf8",
      );
      const namespace = /repository_prefix:\s*(\S+)/u.exec(providerSource)?.[1];
      assert.match(
        namespace ?? "",
        new RegExp(`^matrix/synthetic/v081-${scenario}-[a-f0-9]{32}$`, "u"),
      );
      observedNamespaces.add(namespace ?? "");
      const cleanupEvidence = JSON.parse(
        await readFile(path.join(outputRoot, "cleanup-inventory.json"), "utf8"),
      );
      assert.equal(cleanupEvidence.cleanup_completed, true);
      assert.equal(cleanupEvidence.repository_prefix, namespace);
      assert.equal(
        (
          await stat(
            path.join(outputRoot, "state/mutating-package-call.started"),
          )
        ).isFile(),
        true,
      );
      if (scenario === "multi-target-finalization-failure") {
        assert.match(
          await readFile(path.join(outputRoot, "fault-teardown.log"), "utf8"),
          /safe fault hook teardown-finalization-failure/u,
        );
      }
    }
    assert.equal(observedNamespaces.size, scenarios.length);

    const leakedOutputRoot = path.join(temporaryRoot, "output-secret-leak");
    const rejectedLeak = spawnSync(
      runnerPath,
      ["--run-live-scenario", "multi-target-success", leakedOutputRoot],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
          OCI_V081_MATRIX_DEPLOY_ENV_FILE: path.join(
            temporaryRoot,
            "multi-target-success.env",
          ),
          OCI_V081_MATRIX_DOCKER_CONFIG_FILE: dockerConfigFile,
          OCI_V081_MATRIX_FAULT_HOOK: faultHook,
          OCI_V081_MATRIX_INVENTORY_HOOK: inventoryHook,
          OCI_V081_MATRIX_REGISTRY: "registry.example",
          OCI_V081_MATRIX_REPOSITORY_PREFIX: "matrix/synthetic",
          OCI_V081_MATRIX_STUB_LEAK_VALUE: token,
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
        timeout: 120_000,
      },
    );
    const rejectedLeakOutput = `${rejectedLeak.stdout}${rejectedLeak.stderr}`;
    assert.notEqual(rejectedLeak.status, 0);
    assert.equal(rejectedLeakOutput.includes(token), false);
    assert.match(rejectedLeakOutput, /contains a credential sentinel/u);
    await assert.rejects(lstat(leakedOutputRoot), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("live retained-output scanner rejects raw and derived credential canaries without echoing them", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-protected-capture-"),
  );
  const protectedValuesFile = path.join(temporaryRoot, "deploy.env");
  const dockerConfigFile = path.join(temporaryRoot, "docker-config.json");
  const inspectedFile = path.join(temporaryRoot, "captured.log");
  const username = "SENTINEL_MATRIX_USERNAME_9f82";
  const token = "SENTINEL_MATRIX_TOKEN_d7a2b1c9";
  const password = "SENTINEL_MATRIX_PASSWORD_38e51ac4";
  const privateKeyBody = "PRIVKEYBODY4FF84B0D7E96A1C3";
  const publicKeyBody = "PUBKEYBODY0AB731C8F59D426E";
  const privateKey = [
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    privateKeyBody,
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
  ].join("\\n");
  const publicKey = [
    "-----BEGIN PUBLIC KEY-----",
    publicKeyBody,
    "-----END PUBLIC KEY-----",
  ].join("\\n");
  const basicAuth = Buffer.from(`${username}:${token}`, "utf8").toString(
    "base64",
  );
  const dockerConfig = `${JSON.stringify({
    auths: { "registry.example": { auth: basicAuth } },
  })}\n`;

  try {
    await writeFile(
      protectedValuesFile,
      [
        `OCI_MATRIX_USERNAME=${username}`,
        `OCI_MATRIX_TOKEN=${token}`,
        `OCI_MATRIX_SIGNING_KEY=${privateKey}`,
        `OCI_MATRIX_SIGNING_PASSWORD=${password}`,
        `OCI_MATRIX_VERIFICATION_KEY=${publicKey}`,
        "",
      ].join("\n"),
    );
    await writeFile(dockerConfigFile, dockerConfig);
    await writeFile(inspectedFile, `safe progress for ${username}\n`);
    await execFileAsync(process.execPath, [
      verifierPath,
      "protected-capture",
      inspectedFile,
      protectedValuesFile,
      dockerConfigFile,
      "true",
    ]);

    const encodedDockerConfig = Buffer.from(dockerConfig, "utf8").toString(
      "base64",
    );
    for (const protectedValue of [
      username,
      token,
      password,
      privateKey.replaceAll("\\n", "\n"),
      publicKey.replaceAll("\\n", "\n"),
      Buffer.from(privateKey.replaceAll("\\n", "\n"), "utf8").toString(
        "base64",
      ),
      privateKeyBody,
      Buffer.from(publicKeyBody, "utf8").toString("base64"),
      privateKeyBody.slice(7, 23),
      Buffer.from(publicKeyBody.slice(4, 20), "utf8").toString("base64"),
      basicAuth,
      `Basic ${basicAuth}`,
      encodedDockerConfig,
    ]) {
      await writeFile(inspectedFile, `prefix\n${protectedValue}\nsuffix\n`);
      const rejected = spawnSync(
        process.execPath,
        [
          verifierPath,
          "protected-capture",
          inspectedFile,
          protectedValuesFile,
          dockerConfigFile,
          "false",
        ],
        { encoding: "utf8" },
      );
      const combined = `${rejected.stdout}${rejected.stderr}`;
      assert.notEqual(rejected.status, 0);
      assert.equal(combined.includes(protectedValue), false);
      assert.match(combined, /contains a credential sentinel/u);
    }

    await writeFile(inspectedFile, `${token}\n`);
    const rejectedProgressLeak = spawnSync(
      process.execPath,
      [
        verifierPath,
        "protected-capture",
        inspectedFile,
        protectedValuesFile,
        dockerConfigFile,
        "true",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(rejectedProgressLeak.status, 0);
    assert.equal(
      `${rejectedProgressLeak.stdout}${rejectedProgressLeak.stderr}`.includes(
        token,
      ),
      false,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("key-failure profiles are independently constrained before live mutation", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-key-profiles-"),
  );
  const validPrivate =
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\\nPRIVATE_SENTINEL\\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----";
  const validPublic =
    "-----BEGIN PUBLIC KEY-----\\nPUBLIC_SENTINEL\\n-----END PUBLIC KEY-----";

  try {
    for (const [scenario, privateKey, publicKey] of [
      ["malformed-private-pem", "MALFORMED_PRIVATE_SENTINEL", validPublic],
      ["malformed-public-pem", validPrivate, "MALFORMED_PUBLIC_SENTINEL"],
      ["wrong-signing-password", validPrivate, validPublic],
      ["invalid-key", validPrivate, validPublic],
      ["mismatched-key", validPrivate, validPublic],
    ]) {
      const envFile = path.join(temporaryRoot, `${scenario}.env`);
      await writeFile(
        envFile,
        [
          "OCI_MATRIX_USERNAME=MATRIX_PROFILE_USERNAME",
          "OCI_MATRIX_TOKEN=MATRIX_PROFILE_TOKEN",
          `OCI_MATRIX_SIGNING_KEY=${privateKey}`,
          "OCI_MATRIX_SIGNING_PASSWORD=MATRIX_PROFILE_PASSWORD",
          `OCI_MATRIX_VERIFICATION_KEY=${publicKey}`,
          "",
        ].join("\n"),
      );
      await execFileAsync(process.execPath, [
        verifierPath,
        "credential-failure-profile",
        scenario,
        envFile,
      ]);
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("live failure verifier requires zero inventory and stable published-then-failed evidence", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-live-verifier-"),
  );
  const zeroInventory = path.join(temporaryRoot, "zero.json");
  const malformedPrivateLog = path.join(temporaryRoot, "malformed-private.log");
  const malformedPublicLog = path.join(temporaryRoot, "malformed-public.log");
  const wrongPasswordLog = path.join(temporaryRoot, "wrong-password.log");
  const invalidLog = path.join(temporaryRoot, "invalid.log");
  const mismatchLog = path.join(temporaryRoot, "mismatch.log");
  const partialInventory = path.join(temporaryRoot, "partial.json");
  const partialLog = path.join(temporaryRoot, "partial.log");

  try {
    await writeFile(
      zeroInventory,
      `${JSON.stringify({
        assertion: "zero",
        events: [],
        repositories: {
          "control-plane-api": { publication_count: 0 },
        },
      })}\n`,
    );
    await writeFile(
      malformedPrivateLog,
      "Application image signing env OCI_MATRIX_SIGNING_KEY must contain the expected PEM key.\n",
    );
    await writeFile(
      malformedPublicLog,
      "Application image signing env OCI_MATRIX_VERIFICATION_KEY must contain the expected PEM key.\n",
    );
    await writeFile(
      wrongPasswordLog,
      'Application image provider "matrix" Cosign preflight failed for signing password.\n',
    );
    await writeFile(
      invalidLog,
      'Application image provider "matrix" Cosign preflight failed for signing private key.\n',
    );
    await writeFile(
      mismatchLog,
      'Application image provider "matrix" Cosign preflight failed for signing/verification key pair.\n',
    );
    for (const [scenario, logFile] of [
      ["malformed-private-pem", malformedPrivateLog],
      ["malformed-public-pem", malformedPublicLog],
      ["wrong-signing-password", wrongPasswordLog],
    ]) {
      await execFileAsync(process.execPath, [
        verifierPath,
        "live-failure",
        scenario,
        logFile,
        zeroInventory,
        "control-plane-api",
      ]);
    }
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-failure",
      "invalid-key",
      invalidLog,
      zeroInventory,
      "control-plane-api",
    ]);
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-failure",
      "mismatched-key",
      mismatchLog,
      zeroInventory,
      "control-plane-api",
    ]);

    await writeFile(
      partialInventory,
      `${JSON.stringify({
        assertion: "ordered-partial",
        events: [
          {
            operation: "subject-published",
            sequence: 1,
            target: "control-plane-api",
          },
          {
            operation: "subject-published",
            sequence: 2,
            target: "matrix-worker",
          },
        ],
        repositories: {
          "control-plane-api": {
            provenance_attestation_verified: true,
            publication_count: 1,
            signature_verified: true,
            spdx_attestation_verified: true,
          },
          "matrix-worker": {
            inspected: true,
            publication_count: 1,
            reference: `registry.example/matrix-worker@sha256:${"2".repeat(64)}`,
            status: "published-then-failed",
            subject_digest: `sha256:${"2".repeat(64)}`,
          },
          "matrix-later": { publication_count: 0 },
        },
      })}\n`,
    );
    await writeFile(
      partialLog,
      [
        'OCI package target "matrix-worker" failed during registry publish.',
        'Earlier published target "control-plane-api": registry.example/control-plane-api@sha256:abc.',
        `Failed target "matrix-worker" published reference: registry.example/matrix-worker@sha256:${"2".repeat(64)}`,
        'Later target "matrix-later" was not started.',
        "OCI publication is nontransactional.",
        "",
      ].join("\n"),
    );
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-failure",
      "ordered-finalization",
      partialLog,
      partialInventory,
      "control-plane-api,matrix-worker,matrix-later",
    ]);
    const missingFailedPublication = JSON.parse(
      await readFile(partialInventory, "utf8"),
    );
    missingFailedPublication.repositories["matrix-worker"].publication_count =
      0;
    await writeFile(
      partialInventory,
      `${JSON.stringify(missingFailedPublication)}\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-failure",
        "ordered-finalization",
        partialLog,
        partialInventory,
        "control-plane-api,matrix-worker,matrix-later",
      ]),
      /Failed target is not independently proven published before failure/u,
    );
    missingFailedPublication.repositories["matrix-worker"].publication_count =
      1;
    await writeFile(
      partialInventory,
      `${JSON.stringify(missingFailedPublication)}\n`,
    );
    const duplicatedEarlierPublication = JSON.parse(
      await readFile(partialInventory, "utf8"),
    );
    duplicatedEarlierPublication.repositories[
      "control-plane-api"
    ].publication_count = 2;
    await writeFile(
      partialInventory,
      `${JSON.stringify(duplicatedEarlierPublication)}\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-failure",
        "ordered-finalization",
        partialLog,
        partialInventory,
        "control-plane-api,matrix-worker,matrix-later",
      ]),
      /Earlier target is not independently proven complete/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("live success verifier cross-checks manifest order, local evidence, and registry attestations", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-live-success-verifier-"),
  );
  const outputDirectory = path.join(temporaryRoot, "output");
  const inventoryPath = path.join(temporaryRoot, "inventory.json");
  const targets = ["control-plane-api", "matrix-worker"];
  const artifacts: Record<string, unknown> = {};
  const repositories: Record<string, unknown> = {};

  try {
    for (const [index, target] of targets.entries()) {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      const repository = `registry.example/matrix/${target}`;
      const reference = `${repository}@${digest}`;
      const evidenceRoot = `.dagger/runtime/evidence/${target}`;
      const evidenceContents = {
        provenance: `${JSON.stringify({ target, type: "provenance" })}\n`,
        sbom: `${JSON.stringify({ spdxVersion: "SPDX-2.3", target })}\n`,
        scan: `${JSON.stringify({ matches: [], target })}\n`,
      };
      await mkdir(path.join(outputDirectory, evidenceRoot), {
        recursive: true,
      });
      await Promise.all([
        writeFile(
          path.join(outputDirectory, evidenceRoot, "provenance.json"),
          evidenceContents.provenance,
        ),
        writeFile(
          path.join(outputDirectory, evidenceRoot, "sbom.spdx.json"),
          evidenceContents.sbom,
        ),
        writeFile(
          path.join(outputDirectory, evidenceRoot, "scan.json"),
          evidenceContents.scan,
        ),
      ]);
      artifacts[target] = {
        digest,
        evidence: {
          provenance: {
            digest: sha256(evidenceContents.provenance),
            path: `${evidenceRoot}/provenance.json`,
          },
          sbom: {
            digest: sha256(evidenceContents.sbom),
            path: `${evidenceRoot}/sbom.spdx.json`,
          },
          scan: {
            digest: sha256(evidenceContents.scan),
            path: `${evidenceRoot}/scan.json`,
          },
          signature: { reference, verified: true },
        },
        kind: "oci_image",
        reference,
        repository,
        status: "published",
      };
      repositories[target] = {
        provenance_attestation_verified: true,
        publication_count: 1,
        reference,
        signature_verified: true,
        spdx_attestation_verified: true,
        subject_digest: digest,
      };
    }
    await mkdir(path.join(outputDirectory, ".dagger/runtime"), {
      recursive: true,
    });
    await writeFile(
      path.join(outputDirectory, ".dagger/runtime/package-manifest.json"),
      `${JSON.stringify({ artifacts }, null, 2)}\n`,
    );
    await writeFile(
      inventoryPath,
      `${JSON.stringify({
        assertion: "success",
        events: targets.map((target, index) => ({
          operation: "subject-published",
          sequence: index + 1,
          target,
        })),
        repositories,
      })}\n`,
    );
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-success",
      outputDirectory,
      inventoryPath,
      targets.join(","),
    ]);

    const overPublished = JSON.parse(await readFile(inventoryPath, "utf8"));
    overPublished.repositories[targets[0]].publication_count = 2;
    await writeFile(inventoryPath, `${JSON.stringify(overPublished)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-success",
        outputDirectory,
        inventoryPath,
        targets.join(","),
      ]),
      /Independent registry evidence is incomplete/u,
    );

    overPublished.repositories[targets[0]].publication_count = 1;
    overPublished.events.push({
      operation: "subject-published",
      sequence: 99,
      target: targets[0],
    });
    await writeFile(inventoryPath, `${JSON.stringify(overPublished)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-success",
        outputDirectory,
        inventoryPath,
        targets.join(","),
      ]),
      /must contain one subject publication/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("live cleanup evidence proves every disposable repository absent", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-cleanup-proof-"),
  );
  const evidencePath = path.join(temporaryRoot, "cleanup.json");
  const targets = ["control-plane-api", "matrix-worker"];

  try {
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        assertion: "cleanup",
        cleanup_completed: true,
        registry: "registry.example",
        repositories: Object.fromEntries(
          targets.map((target) => [
            target,
            { inspected: true, remaining_publication_count: 0 },
          ]),
        ),
        repository_prefix: "matrix/v081-run-0123456789abcdef",
      })}\n`,
    );
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-cleanup",
      evidencePath,
      "registry.example",
      "matrix/v081-run-0123456789abcdef",
      targets.join(","),
    ]);

    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.repositories["matrix-worker"].remaining_publication_count = 1;
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-cleanup",
        evidencePath,
        "registry.example",
        "matrix/v081-run-0123456789abcdef",
        targets.join(","),
      ]),
      /did not prove matrix-worker absent/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("matrix JavaScript helpers parse before any Dagger acceptance is attempted", async () => {
  await Promise.all([
    execFileAsync(process.execPath, ["--check", fixtureBuilderPath]),
    execFileAsync(process.execPath, ["--check", verifierPath]),
    execFileAsync(process.execPath, ["--check", daggerStubPath]),
  ]);
});
