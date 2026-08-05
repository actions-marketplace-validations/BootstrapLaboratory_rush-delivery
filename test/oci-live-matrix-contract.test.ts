import * as assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
const realFaultHookPath = path.join(
  repoRoot,
  "test/scripts/configure-oci-v081-finalization-fault.sh",
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

function registryInventoryVersion(
  digest: string,
  registryVersionId: number,
  tags: string[] = [`sha-${gitSha}`],
) {
  return {
    created_at: "2026-08-05T00:00:00.000Z",
    digest,
    registry_version_id: registryVersionId,
    subject: tags.includes(`sha-${gitSha}`),
    tags,
  };
}

function cosignInventoryVersions(
  _subjectDigest: string,
  firstRegistryVersionId: number,
) {
  return ["a", "b", "c"].map((digestCharacter, index) =>
    registryInventoryVersion(
      `sha256:${digestCharacter.repeat(64)}`,
      firstRegistryVersionId + index,
      [],
    ),
  );
}

function registryInventoryEvent(
  target: string,
  version: ReturnType<typeof registryInventoryVersion>,
  sequence: number,
) {
  return {
    ...version,
    operation: version.subject
      ? "subject-published"
      : "package-version-present",
    sequence,
    target,
  };
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
    const fixtureProjects: Array<[string, string[]]> = [
      [success, ["control-plane-api", "matrix-worker"]],
      [
        finalizationFailure,
        ["control-plane-api", "matrix-worker", "matrix-later"],
      ],
    ];
    for (const [fixture, expectedProjects] of fixtureProjects) {
      const rush = JSON.parse(
        await readFile(path.join(fixture, "rush.json"), "utf8"),
      );
      assert.deepEqual(
        new Set(
          rush.projects.map(
            ({ packageName }: { packageName: string }) => packageName,
          ),
        ),
        new Set(expectedProjects),
      );
      const lockfile = await readFile(
        path.join(fixture, "common/config/rush/pnpm-lock.yaml"),
        "utf8",
      );
      for (const project of expectedProjects) {
        assert.match(lockfile, new RegExp(`@rush-temp/${project}`, "u"));
      }
      for (const project of expectedProjects.slice(1)) {
        const packageDefinition = JSON.parse(
          await readFile(
            path.join(fixture, "apps", project, "package.json"),
            "utf8",
          ),
        );
        assert.deepEqual(Object.keys(packageDefinition.scripts).sort(), [
          "build",
          "lint",
          "test",
          "verify",
        ]);
      }
    }
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

test("successful live mutation remains completed after crossing the publication boundary", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-successful-mutation-"),
  );
  const capturedLog = path.join(temporaryRoot, "package.log");

  try {
    await writeFile(
      capturedLog,
      "[package] OCI publication boundary crossed; ordered finalization is starting.\n",
    );
    const { stdout } = await runBash(
      'source "$1"; oci_v081_matrix_classify_mutation_state "$2" none 0',
      [libraryPath, capturedLog],
    );
    assert.equal(stdout.trim(), "completed");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("prepublication acceptance rejects a crossed boundary despite a zero-inventory hook", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-prepublication-boundary-"),
  );
  const executableDirectory = path.join(temporaryRoot, "bin");
  const daggerPath = path.join(executableDirectory, "dagger");
  const inventoryHook = path.join(temporaryRoot, "inventory-hook.mjs");
  const fixture = path.join(temporaryRoot, "fixture");
  const deployEnvFile = path.join(temporaryRoot, "deploy.env");
  const dockerConfigFile = path.join(temporaryRoot, "docker-config.json");
  const packageOutput = path.join(temporaryRoot, "package-output");
  const capturedLog = path.join(temporaryRoot, "package.log");
  const stateDirectory = path.join(temporaryRoot, "state");
  const inventoryEvidence = path.join(temporaryRoot, "inventory.json");
  const inventoryLog = path.join(temporaryRoot, "inventory.log");

  try {
    await Promise.all([
      mkdir(executableDirectory, { recursive: true }),
      mkdir(fixture, { recursive: true }),
    ]);
    await writeFile(
      daggerPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' '[package] OCI publication boundary crossed; ordered finalization is starting.' >&2",
        "printf '%s\\n' 'OCI application image preparation failed: Grype scan/policy.' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    await writeFile(
      inventoryHook,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "const [assertion, registry, repositoryPrefix, targetsCsv, outputPath] = process.argv.slice(2);",
        'const targets = targetsCsv.split(",");',
        "const repositories = Object.fromEntries(targets.map((target) => [target, { inspected: true, package_version_count: 0, publication_count: 0, versions: [] }]));",
        'writeFileSync(outputPath, JSON.stringify({ assertion, event_order: "target-list-then-registry-version-id", events: [], registry, repositories, repository_prefix: repositoryPrefix, targets }) + "\\n");',
        "",
      ].join("\n"),
    );
    await Promise.all([chmod(daggerPath, 0o755), chmod(inventoryHook, 0o755)]);
    await writeFile(
      deployEnvFile,
      [
        "OCI_MATRIX_USERNAME=boundary-user",
        "OCI_MATRIX_TOKEN=BOUNDARY_TOKEN_SENTINEL_112233",
        "OCI_MATRIX_SIGNING_KEY=BOUNDARY_PRIVATE_SENTINEL_223344",
        "OCI_MATRIX_SIGNING_PASSWORD=BOUNDARY_PASSWORD_SENTINEL_334455",
        "OCI_MATRIX_VERIFICATION_KEY=BOUNDARY_PUBLIC_SENTINEL_445566",
        "",
      ].join("\n"),
    );
    await writeFile(
      dockerConfigFile,
      `${JSON.stringify({ auths: { "registry.example": { auth: "BOUNDARY_AUTH_SENTINEL_556677" } } })}\n`,
    );

    await assert.rejects(
      runBash(
        [
          'source "$1"',
          'export PATH="$2:$PATH"',
          'oci_v081_matrix_expect_prepublication_failure_once multi-target-preparation-failure "$3" "$4" "$5" "$6" "$7" "$8" registry.example matrix/adversarial "$9" "${10}" "${11}"',
        ].join("; "),
        [
          libraryPath,
          executableDirectory,
          fixture,
          deployEnvFile,
          packageOutput,
          capturedLog,
          stateDirectory,
          inventoryHook,
          inventoryEvidence,
          inventoryLog,
          dockerConfigFile,
        ],
      ),
      /prepublication scenario crossed the publication boundary/u,
    );
    await assert.rejects(readFile(inventoryEvidence), /ENOENT/u);
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
  assert.match(runner, /OCI_V081_MATRIX_CANDIDATE_SHA/u);
  assert.doesNotMatch(runner, /git .*rev-parse HEAD/u);
  assert.match(runner, /randomBytes\(16\)/u);
  assert.match(runner, /trap cleanup_live_scenario EXIT/u);
  assert.match(runner, /pre-mutation-inventory\.json/u);
  assert.match(runner, /cleanup-inventory\.json/u);
  assert.match(runner, /fault-teardown\.log/u);
  assert.match(runner, /registry-inventory\.json/u);
  assert.match(runner, /package\.log/u);
  assert.match(runner, /rush-delivery-v081-live-work\.\$\{scenario\}\.XXXXXX/u);
  assert.match(runner, /oci_v081_matrix_publish_sanitized_output/u);
  assert.match(runner, /oci_v081_matrix_write_namespace_record/u);
  assert.match(
    runner,
    /OCI_V081_MATRIX_FAULT_WORK_ROOT="\$\{OCI_V081_MATRIX_LIVE_WORK_ROOT\}"/u,
  );
  assert.doesNotMatch(runner, /fixture="\$\{output_root\}\/fixture"/u);
  assert.doesNotMatch(
    runner,
    /namespace cleanup or inspection failed[\s\S]{0,160}OCI_V081_MATRIX_LIVE_OBSERVED_STAGE=/u,
  );

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
  assert.match(library, /\[\[ -f \$\{source\} && ! -L \$\{source\}/u);
  assert.match(
    library,
    /oci_v081_matrix_assert_protected_capture[\s\S]*?"\$\{staging_root\}"[\s\S]*?false/u,
  );
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
        'if (assertion !== "zero" && process.env.OCI_V081_MATRIX_INVENTORY_LEAK_VALUE) process.stdout.write(process.env.OCI_V081_MATRIX_INVENTORY_LEAK_VALUE + "\\n");',
        "const repositories = {};",
        "const events = [];",
        'const subjectVersion = (digest, id) => ({ created_at: "2026-08-05T00:00:00.000Z", digest, registry_version_id: id, subject: true, tags: ["sha-0123456789abcdef0123456789abcdef01234567"] });',
        'const cosignVersions = (_digest, index) => [{ created_at: "2026-08-05T00:00:01.000Z", digest: "sha256:" + String(index + 7).repeat(64), registry_version_id: 100 + index * 3, subject: false, tags: [] }, { created_at: "2026-08-05T00:00:02.000Z", digest: "sha256:" + String(index + 8).repeat(64), registry_version_id: 101 + index * 3, subject: false, tags: [] }, { created_at: "2026-08-05T00:00:03.000Z", digest: "sha256:" + (index + 9).toString(16).repeat(64), registry_version_id: 102 + index * 3, subject: false, tags: [] }];',
        'const appendEvents = (target, versions) => { for (const version of versions) events.push({ ...version, operation: version.subject ? "subject-published" : "package-version-present", sequence: events.length + 1, target }); };',
        'if (assertion === "success") {',
        "  for (const [index, target] of targets.entries()) {",
        '    const digest = "sha256:" + String(index + 1).repeat(64);',
        '    const reference = registry + "/" + repositoryPrefix + "/" + target + "@" + digest;',
        "    const version = subjectVersion(digest, index + 1);",
        "    const versions = [version, ...cosignVersions(digest, index)];",
        "    repositories[target] = { inspected: true, package_version_count: versions.length, publication_count: 1, subject_digest: digest, reference, signature_verified: true, spdx_attestation_verified: true, provenance_attestation_verified: true, versions };",
        "    appendEvents(target, versions);",
        "  }",
        '} else if (assertion === "ordered-partial") {',
        '  const firstDigest = "sha256:" + "1".repeat(64);',
        '  const failedDigest = "sha256:" + "2".repeat(64);',
        '  const firstReference = registry + "/" + repositoryPrefix + "/" + targets[0] + "@" + firstDigest;',
        '  const failedReference = registry + "/" + repositoryPrefix + "/" + targets[1] + "@" + failedDigest;',
        "  const firstVersion = subjectVersion(firstDigest, 1);",
        "  const failedVersion = subjectVersion(failedDigest, 2);",
        "  const firstVersions = [firstVersion, ...cosignVersions(firstDigest, 0)];",
        "  repositories[targets[0]] = { inspected: true, package_version_count: firstVersions.length, publication_count: 1, reference: firstReference, subject_digest: firstDigest, signature_verified: true, spdx_attestation_verified: true, provenance_attestation_verified: true, versions: firstVersions };",
        '  repositories[targets[1]] = { inspected: true, package_version_count: 1, publication_count: 1, reference: failedReference, subject_digest: failedDigest, status: "published-then-failed", versions: [failedVersion] };',
        "  repositories[targets[2]] = { inspected: true, package_version_count: 0, publication_count: 0, versions: [] };",
        "  appendEvents(targets[0], firstVersions);",
        "  appendEvents(targets[1], [failedVersion]);",
        '} else if (assertion === "zero") {',
        "  for (const target of targets) repositories[target] = { inspected: true, package_version_count: 0, publication_count: 0, versions: [] };",
        "} else {",
        '  throw new Error("unsupported synthetic inventory assertion");',
        "}",
        'writeFileSync(outputPath, JSON.stringify({ assertion, event_order: "target-list-then-registry-version-id", events, registry, repositories, repository_prefix: repositoryPrefix, targets }) + "\\n", { mode: 0o600 });',
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
        'if (process.env.OCI_V081_MATRIX_CLEANUP_LEAK_VALUE) process.stdout.write(process.env.OCI_V081_MATRIX_CLEANUP_LEAK_VALUE + "\\n");',
        'const targets = targetsCsv.split(",");',
        "const repositories = Object.fromEntries(targets.map((target) => [target, { inspected: true, package_absent: true, remaining_publication_count: 0 }]));",
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
        'if (action === "teardown-finalization-failure" && process.env.OCI_V081_MATRIX_FAULT_TEARDOWN_LEAK_VALUE) process.stdout.write(process.env.OCI_V081_MATRIX_FAULT_TEARDOWN_LEAK_VALUE + "\\n");',
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
            OCI_V081_MATRIX_CANDIDATE_SHA: gitSha,
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
      const cleanupEvidence = JSON.parse(
        await readFile(path.join(outputRoot, "cleanup-inventory.json"), "utf8"),
      );
      const namespace = cleanupEvidence.repository_prefix;
      assert.match(
        namespace ?? "",
        new RegExp(`^matrix/synthetic/v081-${scenario}-[a-f0-9]{32}$`, "u"),
      );
      observedNamespaces.add(namespace ?? "");
      assert.equal(cleanupEvidence.cleanup_completed, true);
      assert.equal(cleanupEvidence.repository_prefix, namespace);
      const expectedStage =
        scenario === "multi-target-success"
          ? "none"
          : scenario === "multi-target-preparation-failure"
            ? "image-preparation"
            : scenario === "multi-target-finalization-failure"
              ? "registry-publication"
              : scenario === "malformed-private-pem" ||
                  scenario === "malformed-public-pem"
                ? "credential-shape-preflight"
                : "cosign-preflight";
      const expectedMutation =
        scenario === "multi-target-success"
          ? "completed"
          : scenario === "multi-target-finalization-failure"
            ? "started"
            : "not-started";
      const expectedFaultState =
        scenario === "multi-target-finalization-failure"
          ? "succeeded"
          : "not-required";
      assert.equal(
        await readFile(
          path.join(outputRoot, "scenario-diagnostic.txt"),
          "utf8",
        ),
        [
          "schema=rush-delivery-v081-live-scenario-diagnostic/v2",
          `scenario=${scenario}`,
          "outcome=passed",
          `observed_stage=${expectedStage}`,
          `mutation_state=${expectedMutation}`,
          `fault_teardown_state=${expectedFaultState}`,
          "cleanup_state=succeeded",
          "evidence_state=sanitized",
          "registry=registry.example",
          `repository_prefix=${namespace}`,
          `targets=${cleanupEvidence ? Object.keys(cleanupEvidence.repositories).join(",") : ""}`,
          "source_revision=0123456789abcdef0123456789abcdef01234567",
          "",
        ].join("\n"),
      );
      const retainedEntries = [
        ".rush-delivery-v081-live-owned",
        "cleanup-inventory.json",
        "pre-mutation-inventory.json",
        "registry-inventory.json",
        "scenario-diagnostic.txt",
        ...(scenario === "multi-target-success" ? ["package-output"] : []),
      ].sort();
      assert.deepEqual((await readdir(outputRoot)).sort(), retainedEntries);
      await execFileAsync(process.execPath, [
        verifierPath,
        "protected-capture",
        outputRoot,
        deployEnvFile,
        dockerConfigFile,
        "false",
      ]);
      if (scenario === "multi-target-success") {
        await execFileAsync(process.execPath, [
          verifierPath,
          "live-success",
          path.join(outputRoot, "package-output"),
          path.join(outputRoot, "registry-inventory.json"),
          "control-plane-api,matrix-worker",
          "registry.example",
          namespace ?? "",
        ]);
      }
    }
    assert.equal(observedNamespaces.size, scenarios.length);
    const namespaceRecordNames = (
      await readdir(path.join(temporaryRoot, "namespace-records"))
    ).sort();
    assert.equal(namespaceRecordNames.length, scenarios.length);
    for (const scenario of scenarios) {
      const recordName = namespaceRecordNames.find((name) =>
        new RegExp(`^${scenario}-[a-f0-9]{32}\\.txt$`, "u").test(name),
      );
      assert.ok(recordName);
      const namespaceRecord = await readFile(
        path.join(temporaryRoot, "namespace-records", recordName),
        "utf8",
      );
      assert.match(
        namespaceRecord,
        new RegExp(
          [
            "^schema=rush-delivery-v081-live-namespace/v1",
            `scenario=${scenario}`,
            "candidate_commit=[a-f0-9]{40}",
            "registry=registry.example",
            `repository_prefix=matrix/synthetic/v081-${scenario}-[a-f0-9]{32}`,
            "targets=control-plane-api(?:,matrix-worker(?:,matrix-later)?)?",
            "$",
          ].join("\\n"),
          "u",
        ),
      );
    }

    const unexpectedOutputRoot = path.join(
      temporaryRoot,
      "output-unexpected-failure",
    );
    const unexpectedFailure = spawnSync(
      runnerPath,
      ["--run-live-scenario", "multi-target-success", unexpectedOutputRoot],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
          OCI_V081_MATRIX_CANDIDATE_SHA: gitSha,
          OCI_V081_MATRIX_DEPLOY_ENV_FILE: path.join(
            temporaryRoot,
            "multi-target-success.env",
          ),
          OCI_V081_MATRIX_DOCKER_CONFIG_FILE: dockerConfigFile,
          OCI_V081_MATRIX_FAULT_HOOK: faultHook,
          OCI_V081_MATRIX_INVENTORY_HOOK: inventoryHook,
          OCI_V081_MATRIX_REGISTRY: "registry.example",
          OCI_V081_MATRIX_REPOSITORY_PREFIX: "matrix/synthetic",
          OCI_V081_MATRIX_STUB_UNEXPECTED_FAILURE: "true",
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
        timeout: 120_000,
      },
    );
    assert.notEqual(unexpectedFailure.status, 0);
    assert.deepEqual((await readdir(unexpectedOutputRoot)).sort(), [
      ".rush-delivery-v081-live-owned",
      "cleanup-inventory.json",
      "pre-mutation-inventory.json",
      "scenario-diagnostic.txt",
    ]);
    const unexpectedDiagnostic = (
      await readFile(
        path.join(unexpectedOutputRoot, "scenario-diagnostic.txt"),
        "utf8",
      )
    )
      .trimEnd()
      .split("\n");
    assert.deepEqual(unexpectedDiagnostic.slice(0, 9), [
      "schema=rush-delivery-v081-live-scenario-diagnostic/v2",
      "scenario=multi-target-success",
      "outcome=failed",
      "observed_stage=package-contract",
      "mutation_state=unknown",
      "fault_teardown_state=not-required",
      "cleanup_state=succeeded",
      "evidence_state=sanitized",
      "registry=registry.example",
    ]);
    assert.match(
      unexpectedDiagnostic[9],
      /^repository_prefix=matrix\/synthetic\/v081-multi-target-success-[a-f0-9]{32}$/u,
    );
    assert.deepEqual(unexpectedDiagnostic.slice(10), [
      "targets=control-plane-api,matrix-worker",
      "source_revision=0123456789abcdef0123456789abcdef01234567",
    ]);
    await execFileAsync(process.execPath, [
      verifierPath,
      "protected-capture",
      unexpectedOutputRoot,
      path.join(temporaryRoot, "multi-target-success.env"),
      dockerConfigFile,
      "false",
    ]);

    const leakedOutputRoot = path.join(temporaryRoot, "output-secret-leak");
    const rejectedLeak = spawnSync(
      runnerPath,
      ["--run-live-scenario", "multi-target-success", leakedOutputRoot],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
          OCI_V081_MATRIX_CANDIDATE_SHA: gitSha,
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
    assert.deepEqual((await readdir(leakedOutputRoot)).sort(), [
      ".rush-delivery-v081-live-owned",
      "scenario-diagnostic.txt",
    ]);
    assert.match(
      await readFile(
        path.join(leakedOutputRoot, "scenario-diagnostic.txt"),
        "utf8",
      ),
      /observed_stage=protected-output[\s\S]*evidence_state=quarantined/u,
    );

    for (const leakCase of [
      {
        envName: "OCI_V081_MATRIX_INVENTORY_LEAK_VALUE",
        name: "inventory",
        scenario: "multi-target-success",
      },
      {
        envName: "OCI_V081_MATRIX_CLEANUP_LEAK_VALUE",
        name: "cleanup",
        scenario: "multi-target-success",
      },
      {
        envName: "OCI_V081_MATRIX_FAULT_TEARDOWN_LEAK_VALUE",
        name: "fault-teardown",
        scenario: "multi-target-finalization-failure",
      },
    ]) {
      const outputRoot = path.join(
        temporaryRoot,
        `output-${leakCase.name}-leak`,
      );
      const rejected = spawnSync(
        runnerPath,
        ["--run-live-scenario", leakCase.scenario, outputRoot],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            [leakCase.envName]: token,
            OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
            OCI_V081_MATRIX_CANDIDATE_SHA: gitSha,
            OCI_V081_MATRIX_DEPLOY_ENV_FILE: path.join(
              temporaryRoot,
              `${leakCase.scenario}.env`,
            ),
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
      const combined = `${rejected.stdout}${rejected.stderr}`;
      assert.notEqual(rejected.status, 0);
      assert.equal(combined.includes(token), false);
      assert.deepEqual((await readdir(outputRoot)).sort(), [
        ".rush-delivery-v081-live-owned",
        "scenario-diagnostic.txt",
      ]);
      assert.match(
        await readFile(
          path.join(outputRoot, "scenario-diagnostic.txt"),
          "utf8",
        ),
        /outcome=failed[\s\S]*observed_stage=protected-output[\s\S]*evidence_state=quarantined/u,
      );
    }

    let repositoryHasHead = false;
    try {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      repositoryHasHead = true;
    } catch {
      // Dagger self-check deliberately excludes Git metadata from module source.
    }
    if (repositoryHasHead) {
      const realFaultOutputRoot = path.join(
        temporaryRoot,
        "output-real-finalization-fault",
      );
      const { stdout } = await execFileAsync(
        runnerPath,
        [
          "--run-live-scenario",
          "multi-target-finalization-failure",
          realFaultOutputRoot,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OCI_V081_MATRIX_CANDIDATE_SHA: gitSha,
            OCI_V081_MATRIX_CLEANUP_HOOK: cleanupHook,
            OCI_V081_MATRIX_DEPLOY_ENV_FILE: path.join(
              temporaryRoot,
              "multi-target-finalization-failure.env",
            ),
            OCI_V081_MATRIX_DOCKER_CONFIG_FILE: dockerConfigFile,
            OCI_V081_MATRIX_FAULT_HOOK: realFaultHookPath,
            OCI_V081_MATRIX_INVENTORY_HOOK: inventoryHook,
            OCI_V081_MATRIX_REGISTRY: "ghcr.io",
            OCI_V081_MATRIX_REPOSITORY_PREFIX:
              "bootstraplaboratory/rush-delivery-v081-acceptance",
            PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
            RUNNER_TEMP: temporaryRoot,
          },
          timeout: 120_000,
        },
      );
      assert.match(stdout, /checks passed; cleanup is armed/u);
      assert.match(
        await readFile(
          path.join(realFaultOutputRoot, "scenario-diagnostic.txt"),
          "utf8",
        ),
        /outcome=passed[\s\S]*observed_stage=registry-publication[\s\S]*mutation_state=started[\s\S]*fault_teardown_state=succeeded[\s\S]*cleanup_state=succeeded/u,
      );
    }
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

test("live zero verifier rejects referrer versions and incomplete event ledgers", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-zero-ledger-"),
  );
  const evidencePath = path.join(temporaryRoot, "inventory.json");
  const registry = "registry.example";
  const repositoryPrefix = "matrix/v081-zero-ledger";
  const target = "control-plane-api";
  const emptyInventory = {
    assertion: "zero",
    event_order: "target-list-then-registry-version-id",
    events: [],
    registry,
    repositories: {
      [target]: {
        inspected: true,
        package_version_count: 0,
        publication_count: 0,
        versions: [],
      },
    },
    repository_prefix: repositoryPrefix,
    targets: [target],
  };

  try {
    await writeFile(evidencePath, `${JSON.stringify(emptyInventory)}\n`);
    const verifierArguments = [
      verifierPath,
      "live-zero-inventory",
      evidencePath,
      target,
      registry,
      repositoryPrefix,
    ];
    await execFileAsync(process.execPath, verifierArguments);

    const referrerVersion = registryInventoryVersion(
      `sha256:${"9".repeat(64)}`,
      9,
      [`sha256-${"9".repeat(64)}.att`],
    );
    const completeMutation = JSON.parse(JSON.stringify(emptyInventory));
    completeMutation.repositories[target] = {
      inspected: true,
      package_version_count: 1,
      publication_count: 0,
      versions: [referrerVersion],
    };
    completeMutation.events.push(
      registryInventoryEvent(target, referrerVersion, 1),
    );
    await writeFile(evidencePath, `${JSON.stringify(completeMutation)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, verifierArguments),
      /found package versions/u,
    );

    completeMutation.events = [];
    await writeFile(evidencePath, `${JSON.stringify(completeMutation)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, verifierArguments),
      /event ledger does not exactly match package versions/u,
    );
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
  const registry = "registry.example";
  const repositoryPrefix = "matrix/v081-live-verifier";

  try {
    await writeFile(
      zeroInventory,
      `${JSON.stringify({
        assertion: "zero",
        event_order: "target-list-then-registry-version-id",
        events: [],
        registry,
        repositories: {
          "control-plane-api": {
            inspected: true,
            package_version_count: 0,
            publication_count: 0,
            versions: [],
          },
        },
        repository_prefix: repositoryPrefix,
        targets: ["control-plane-api"],
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
        registry,
        repositoryPrefix,
      ]);
    }
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-failure",
      "invalid-key",
      invalidLog,
      zeroInventory,
      "control-plane-api",
      registry,
      repositoryPrefix,
    ]);
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-failure",
      "mismatched-key",
      mismatchLog,
      zeroInventory,
      "control-plane-api",
      registry,
      repositoryPrefix,
    ]);

    const firstDigest = `sha256:${"1".repeat(64)}`;
    const failedDigest = `sha256:${"2".repeat(64)}`;
    const firstVersion = registryInventoryVersion(firstDigest, 1);
    const failedVersion = registryInventoryVersion(failedDigest, 2);
    const firstVersions = [
      firstVersion,
      ...cosignInventoryVersions(firstDigest, 10),
    ];
    const validPartialInventory = {
      assertion: "ordered-partial",
      event_order: "target-list-then-registry-version-id",
      events: [
        ...firstVersions.map((version, index) =>
          registryInventoryEvent("control-plane-api", version, index + 1),
        ),
        registryInventoryEvent(
          "matrix-worker",
          failedVersion,
          firstVersions.length + 1,
        ),
      ],
      registry,
      repositories: {
        "control-plane-api": {
          inspected: true,
          package_version_count: firstVersions.length,
          provenance_attestation_verified: true,
          publication_count: 1,
          reference: `${registry}/${repositoryPrefix}/control-plane-api@${firstDigest}`,
          signature_verified: true,
          spdx_attestation_verified: true,
          subject_digest: firstDigest,
          versions: firstVersions,
        },
        "matrix-worker": {
          inspected: true,
          package_version_count: 1,
          publication_count: 1,
          reference: `${registry}/${repositoryPrefix}/matrix-worker@${failedDigest}`,
          status: "published-then-failed",
          subject_digest: failedDigest,
          versions: [failedVersion],
        },
        "matrix-later": {
          inspected: true,
          package_version_count: 0,
          publication_count: 0,
          versions: [],
        },
      },
      repository_prefix: repositoryPrefix,
      targets: ["control-plane-api", "matrix-worker", "matrix-later"],
    };
    await writeFile(
      partialInventory,
      `${JSON.stringify(validPartialInventory)}\n`,
    );
    await writeFile(
      partialLog,
      [
        'OCI package target "matrix-worker" failed during registry publish.',
        'Earlier published target "control-plane-api": registry.example/control-plane-api@sha256:abc.',
        `Failed target "matrix-worker" published reference: ${registry}/${repositoryPrefix}/matrix-worker@${failedDigest}`,
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
      registry,
      repositoryPrefix,
    ]);
    const lateFailedVersion = registryInventoryVersion(
      `sha256:${"4".repeat(64)}`,
      40,
      [],
    );
    const lateFinalizationInventory = JSON.parse(
      JSON.stringify(validPartialInventory),
    );
    lateFinalizationInventory.repositories[
      "matrix-worker"
    ].package_version_count = 2;
    lateFinalizationInventory.repositories["matrix-worker"].versions.push(
      lateFailedVersion,
    );
    lateFinalizationInventory.events.push(
      registryInventoryEvent(
        "matrix-worker",
        lateFailedVersion,
        lateFinalizationInventory.events.length + 1,
      ),
    );
    await writeFile(
      partialInventory,
      `${JSON.stringify(lateFinalizationInventory)}\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-failure",
        "ordered-finalization",
        partialLog,
        partialInventory,
        "control-plane-api,matrix-worker,matrix-later",
        registry,
        repositoryPrefix,
      ]),
      /Failed target is not independently proven published before failure/u,
    );
    const skippedVersion = registryInventoryVersion(
      `sha256:${"3".repeat(64)}`,
      3,
      [`sha256-${"3".repeat(64)}.sig`],
    );
    const mutatedSkippedInventory = JSON.parse(
      JSON.stringify(validPartialInventory),
    );
    mutatedSkippedInventory.repositories["matrix-later"] = {
      inspected: true,
      package_version_count: 1,
      publication_count: 0,
      versions: [skippedVersion],
    };
    mutatedSkippedInventory.events.push(
      registryInventoryEvent(
        "matrix-later",
        skippedVersion,
        mutatedSkippedInventory.events.length + 1,
      ),
    );
    await writeFile(
      partialInventory,
      `${JSON.stringify(mutatedSkippedInventory)}\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-failure",
        "ordered-finalization",
        partialLog,
        partialInventory,
        "control-plane-api,matrix-worker,matrix-later",
        registry,
        repositoryPrefix,
      ]),
      /Later skipped target was mutated/u,
    );
    await writeFile(
      partialInventory,
      `${JSON.stringify(validPartialInventory)}\n`,
    );
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
        registry,
        repositoryPrefix,
      ]),
      /incomplete package-version inventory/u,
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
        registry,
        repositoryPrefix,
      ]),
      /incomplete package-version inventory/u,
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
  const events: Array<ReturnType<typeof registryInventoryEvent>> = [];
  const registry = "registry.example";
  const repositoryPrefix = "matrix";

  try {
    for (const [index, target] of targets.entries()) {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      const repository = `${registry}/${repositoryPrefix}/${target}`;
      const reference = `${repository}@${digest}`;
      const version = registryInventoryVersion(digest, index + 1);
      const versions = [
        version,
        ...cosignInventoryVersions(digest, 100 + index * 3),
      ];
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
        inspected: true,
        package_version_count: versions.length,
        provenance_attestation_verified: true,
        publication_count: 1,
        reference,
        signature_verified: true,
        spdx_attestation_verified: true,
        subject_digest: digest,
        versions,
      };
      for (const inventoryVersion of versions) {
        events.push(
          registryInventoryEvent(target, inventoryVersion, events.length + 1),
        );
      }
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
        event_order: "target-list-then-registry-version-id",
        events,
        registry,
        repositories,
        repository_prefix: repositoryPrefix,
        targets,
      })}\n`,
    );
    await execFileAsync(process.execPath, [
      verifierPath,
      "live-success",
      outputDirectory,
      inventoryPath,
      targets.join(","),
      registry,
      repositoryPrefix,
    ]);

    const validInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    const nonCanonicalInventory = JSON.parse(JSON.stringify(validInventory));
    [nonCanonicalInventory.events[0], nonCanonicalInventory.events[1]] = [
      nonCanonicalInventory.events[1],
      nonCanonicalInventory.events[0],
    ];
    nonCanonicalInventory.events.forEach(
      (event: { sequence: number }, index: number) => {
        event.sequence = index + 1;
      },
    );
    await writeFile(
      inventoryPath,
      `${JSON.stringify(nonCanonicalInventory)}\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-success",
        outputDirectory,
        inventoryPath,
        targets.join(","),
        registry,
        repositoryPrefix,
      ]),
      /event ledger does not exactly match package versions/u,
    );

    const overPublished = JSON.parse(JSON.stringify(validInventory));
    overPublished.repositories[targets[0]].publication_count = 2;
    await writeFile(inventoryPath, `${JSON.stringify(overPublished)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-success",
        outputDirectory,
        inventoryPath,
        targets.join(","),
        registry,
        repositoryPrefix,
      ]),
      /incomplete package-version inventory/u,
    );

    overPublished.repositories[targets[0]].publication_count = 1;
    overPublished.events.push({
      ...overPublished.events[0],
      sequence: overPublished.events.length + 1,
    });
    await writeFile(inventoryPath, `${JSON.stringify(overPublished)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierPath,
        "live-success",
        outputDirectory,
        inventoryPath,
        targets.join(","),
        registry,
        repositoryPrefix,
      ]),
      /event ledger does not exactly match package versions/u,
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
            {
              inspected: true,
              package_absent: true,
              remaining_publication_count: 0,
            },
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
    delete evidence.repositories["matrix-worker"].package_absent;
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

    evidence.repositories["matrix-worker"].package_absent = true;
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

test("live matrix retains allowlisted registry publication failure stages", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-registry-stages-"),
  );
  const cases = [
    [
      'OCI package target "api" failed during registry publication authentication.',
      "registry-publication-authentication",
    ],
    [
      'OCI package target "api" failed during registry publication authorization.',
      "registry-publication-authorization",
    ],
    [
      'OCI package target "api" failed during registry publication transport.',
      "registry-publication-transport",
    ],
    [
      'OCI package target "api" failed during registry publication.',
      "registry-publication",
    ],
  ] as const;

  try {
    for (const [message, expected] of cases) {
      const log = path.join(temporaryRoot, `${expected}.log`);
      await writeFile(log, `${message}\n`);
      const { stdout } = await runBash(
        'source "$1"; oci_v081_matrix_classify_failure_stage "$2"',
        [libraryPath, log],
      );
      assert.equal(stdout.trim(), expected);
      const { stdout: mutationState } = await runBash(
        'source "$1"; oci_v081_matrix_classify_mutation_state "$2" "$3" 1',
        [libraryPath, log, expected],
      );
      assert.equal(mutationState.trim(), "started");
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
