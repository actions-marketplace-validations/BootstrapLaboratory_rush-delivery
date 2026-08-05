import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
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
const scriptsDirectory = path.join(repoRoot, "test/scripts");
const inventoryHook = path.join(
  scriptsDirectory,
  "inventory-ghcr-v081-acceptance.sh",
);
const cleanupHook = path.join(
  scriptsDirectory,
  "cleanup-ghcr-v081-acceptance.sh",
);
const profileScript = path.join(
  scriptsDirectory,
  "prepare-oci-v081-live-profiles.sh",
);
const faultHook = path.join(
  scriptsDirectory,
  "configure-oci-v081-finalization-fault.sh",
);
const faultInjector = path.join(
  scriptsDirectory,
  "inject-oci-v081-finalization-fault.mjs",
);
const evidenceTool = path.join(
  scriptsDirectory,
  "ghcr-v081-acceptance-evidence.mjs",
);
const ghcrLibrary = path.join(
  scriptsDirectory,
  "lib/oci-v081-ghcr-acceptance.sh",
);
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/oci-acceptance.yml",
);
const namespace =
  "bootstraplaboratory/rush-delivery-v081-acceptance/v081-multi-target-success-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gitSha = "0123456789abcdef0123456789abcdef01234567";
const subjectTag = `sha-${gitSha}`;

async function assertAbsent(filePath: string) {
  await assert.rejects(lstat(filePath), /ENOENT/u);
}

test("tracked GHCR matrix infrastructure is executable, pinned, and wired for all scenarios", async () => {
  const shellScripts = [
    inventoryHook,
    cleanupHook,
    profileScript,
    faultHook,
    ghcrLibrary,
    path.join(scriptsDirectory, "run-oci-v081-acceptance-matrix.sh"),
  ];
  await Promise.all(
    shellScripts.map((script) => execFileAsync("bash", ["-n", script])),
  );
  await Promise.all(
    [evidenceTool, faultInjector].map((script) =>
      execFileAsync("node", ["--check", script]),
    ),
  );
  for (const script of [
    inventoryHook,
    cleanupHook,
    profileScript,
    faultHook,
    evidenceTool,
    faultInjector,
  ]) {
    assert.notEqual((await stat(script)).mode & 0o111, 0);
  }

  const workflow = await readFile(workflowPath, "utf8");
  const matrixLibrary = await readFile(
    path.join(scriptsDirectory, "lib/oci-v081-acceptance-matrix.sh"),
    "utf8",
  );
  assert.match(workflow, /v081-live-matrix:/u);
  assert.match(
    workflow,
    /v081-live-matrix:\s+runs-on: ubuntu-latest\s+timeout-minutes: 360/u,
  );
  assert.match(workflow, /--list-live-scenarios/u);
  assert.match(workflow, /inventory-ghcr-v081-acceptance\.sh/u);
  assert.match(workflow, /cleanup-ghcr-v081-acceptance\.sh/u);
  assert.match(workflow, /configure-oci-v081-finalization-fault\.sh/u);
  assert.match(workflow, /prepare-oci-v081-live-profiles\.sh/u);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /rush-delivery-v081-live-matrix-evidence/u);
  assert.match(
    workflow,
    /Recover every registered v0\.8\.1 GHCR matrix namespace\s+if: \$\{\{ always\(\) \}\}[\s\S]+--namespace-record/u,
  );
  assert.match(workflow, /include-hidden-files: true/u);
  assert.match(workflow, /bootstraplaboratory\/rush-delivery-v081-acceptance/u);
  assert.match(
    workflow,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/u,
  );
  assert.match(
    workflow,
    /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6/u,
  );
  assert.match(
    workflow,
    /dagger\/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8\.4\.1/u,
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4/u,
  );
  const actionReferences = [
    ...workflow.matchAll(/^\s*uses: \S+@([^\s#]+)(?:\s+#.*)?$/gmu),
  ];
  assert.equal(actionReferences.length, 8);
  for (const reference of actionReferences) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u);
  }
  assert.match(
    matrixLibrary,
    /dagger -m "\$\{module_root\}" --progress=logs call/u,
  );
  assert.match(matrixLibrary, /source_commit=\[a-f0-9\]\{40\}/u);
  assert.match(matrixLibrary, /failed_target=matrix-worker/u);

  const cosignSource = await readFile(
    path.join(repoRoot, "src/application-images/cosign.ts"),
    "utf8",
  );
  const pinnedCosign = /export const COSIGN_IMAGE =\s*\n\s*"([^"]+)"/u.exec(
    cosignSource,
  )?.[1];
  assert.ok(pinnedCosign);
  assert.match(
    await readFile(inventoryHook, "utf8"),
    new RegExp(pinnedCosign.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assert.match(
    await readFile(profileScript, "utf8"),
    new RegExp(pinnedCosign.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
});

test("GHCR evidence planner binds subject tags, API order, verification, and cleanup", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-ghcr-evidence-"),
  );
  const snapshots = path.join(temporaryRoot, "snapshots");
  const statuses = path.join(temporaryRoot, "statuses");
  const inventory = path.join(temporaryRoot, "inventory.json");
  const verification = path.join(temporaryRoot, "verification.json");
  const cleanup = path.join(temporaryRoot, "cleanup.json");
  const orderedInventory = path.join(temporaryRoot, "ordered-inventory.json");
  const orderedVerification = path.join(
    temporaryRoot,
    "ordered-verification.json",
  );

  try {
    await Promise.all([
      mkdir(snapshots, { mode: 0o700 }),
      mkdir(statuses, { mode: 0o700 }),
    ]);
    for (const [index, target] of [
      "control-plane-api",
      "matrix-worker",
    ].entries()) {
      await writeFile(
        path.join(snapshots, `${index}.json`),
        `${JSON.stringify([
          [
            {
              created_at: `2026-08-05T00:00:0${index}Z`,
              id: 100 + index,
              metadata: { container: { tags: [subjectTag] } },
              name: `sha256:${String(index + 1).repeat(64)}`,
              target,
            },
          ],
          [
            {
              created_at: `2026-08-05T00:00:1${index}Z`,
              id: 200 + index,
              metadata: { container: { tags: [] } },
              name: `sha256:${String(index + 7).repeat(64)}`,
            },
            {
              created_at: `2026-08-05T00:00:2${index}Z`,
              id: 300 + index,
              metadata: { container: { tags: [] } },
              name: `sha256:${String(index + 8).repeat(64)}`,
            },
            {
              created_at: `2026-08-05T00:00:3${index}Z`,
              id: 400 + index,
              metadata: { container: { tags: [] } },
              name: `sha256:${(index + 9).toString(16).repeat(64)}`,
            },
          ],
        ])}\n`,
      );
      await writeFile(path.join(statuses, `${index}.status`), "absent\n", {
        mode: 0o600,
      });
    }
    await execFileAsync("node", [
      evidenceTool,
      "inventory-plan",
      "success",
      "ghcr.io",
      namespace,
      "control-plane-api,matrix-worker",
      snapshots,
      inventory,
      verification,
    ]);
    const evidence = JSON.parse(await readFile(inventory, "utf8"));
    assert.equal(evidence.registry, "ghcr.io");
    assert.equal(evidence.event_order, "target-list-then-registry-version-id");
    assert.equal(evidence.repository_prefix, namespace);
    assert.deepEqual(evidence.targets, ["control-plane-api", "matrix-worker"]);
    assert.deepEqual(Object.keys(evidence.repositories), [
      "control-plane-api",
      "matrix-worker",
    ]);
    assert.deepEqual(
      evidence.events.map(({ target }: { target: string }) => target),
      [
        "control-plane-api",
        "control-plane-api",
        "control-plane-api",
        "control-plane-api",
        "matrix-worker",
        "matrix-worker",
        "matrix-worker",
        "matrix-worker",
      ],
    );
    assert.deepEqual(
      evidence.events.map(({ operation }: { operation: string }) => operation),
      [
        "subject-published",
        "package-version-present",
        "package-version-present",
        "package-version-present",
        "subject-published",
        "package-version-present",
        "package-version-present",
        "package-version-present",
      ],
    );
    for (const repository of Object.values(evidence.repositories) as Array<
      Record<string, unknown>
    >) {
      assert.equal(repository.publication_count, 1);
      assert.equal(repository.package_version_count, 4);
      assert.equal(
        (repository.versions as Array<Record<string, unknown>>).length,
        4,
      );
      assert.equal(repository.signature_verified, true);
      assert.equal(repository.spdx_attestation_verified, true);
      assert.equal(repository.provenance_attestation_verified, true);
    }
    const { stdout: references } = await execFileAsync("node", [
      evidenceTool,
      "print-verification-references",
      verification,
    ]);
    assert.equal(references.trim().split("\n").length, 2);
    assert.equal(references.includes("@sha256:"), true);

    await writeFile(
      path.join(snapshots, "1.json"),
      `${JSON.stringify([
        [
          {
            created_at: "2026-08-05T00:00:01Z",
            id: 101,
            metadata: { container: { tags: [subjectTag] } },
            name: `sha256:${"2".repeat(64)}`,
          },
        ],
      ])}\n`,
    );
    await writeFile(path.join(snapshots, "2.json"), "[]\n");
    await execFileAsync("node", [
      evidenceTool,
      "inventory-plan",
      "ordered-partial",
      "ghcr.io",
      namespace,
      "control-plane-api,matrix-worker,matrix-later",
      snapshots,
      orderedInventory,
      orderedVerification,
    ]);
    const orderedEvidence = JSON.parse(
      await readFile(orderedInventory, "utf8"),
    );
    assert.equal(
      orderedEvidence.repositories["matrix-worker"].publication_count,
      1,
    );
    assert.equal(
      orderedEvidence.repositories["matrix-worker"].status,
      "published-then-failed",
    );
    assert.deepEqual(
      orderedEvidence.events.map(({ target }: { target: string }) => target),
      [
        "control-plane-api",
        "control-plane-api",
        "control-plane-api",
        "control-plane-api",
        "matrix-worker",
      ],
    );

    await writeFile(path.join(snapshots, "1.json"), "[]\n");
    await assert.rejects(
      execFileAsync("node", [
        evidenceTool,
        "inventory-plan",
        "ordered-partial",
        "ghcr.io",
        namespace,
        "control-plane-api,matrix-worker,matrix-later",
        snapshots,
        path.join(temporaryRoot, "missing-failed-inventory.json"),
        path.join(temporaryRoot, "missing-failed-verification.json"),
      ]),
      /exactly one published subject for the failed target/u,
    );

    await execFileAsync("node", [
      evidenceTool,
      "cleanup-evidence",
      "ghcr.io",
      namespace,
      "control-plane-api,matrix-worker",
      statuses,
      cleanup,
    ]);
    const cleanupEvidence = JSON.parse(await readFile(cleanup, "utf8"));
    assert.equal(cleanupEvidence.cleanup_completed, true);
    assert.equal(
      cleanupEvidence.repositories["control-plane-api"].package_absent,
      true,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("GHCR zero and skipped assertions reject every untagged or referrer package version", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-ghcr-adversarial-inventory-"),
  );
  const snapshots = path.join(temporaryRoot, "snapshots");
  const untaggedVersion = {
    created_at: "2026-08-05T00:00:01Z",
    id: 301,
    metadata: { container: { tags: [] } },
    name: `sha256:${"a".repeat(64)}`,
  };
  const referrerVersion = {
    created_at: "2026-08-05T00:00:02Z",
    id: 302,
    metadata: {
      container: { tags: [`sha256-${"b".repeat(64)}.sig`] },
    },
    name: `sha256:${"b".repeat(64)}`,
  };
  const subjectVersion = (id: number, digestCharacter: string) => ({
    created_at: `2026-08-05T00:00:${String(id - 300 + 2).padStart(2, "0")}Z`,
    id,
    metadata: { container: { tags: [subjectTag] } },
    name: `sha256:${digestCharacter.repeat(64)}`,
  });
  const completedVersions = (subject: ReturnType<typeof subjectVersion>) => [
    subject,
    {
      created_at: "2026-08-05T00:00:07Z",
      id: subject.id + 100,
      metadata: {
        container: { tags: [`${subject.name.replace(":", "-")}.sig`] },
      },
      name: `sha256:${"e".repeat(64)}`,
    },
    {
      created_at: "2026-08-05T00:00:08Z",
      id: subject.id + 200,
      metadata: {
        container: { tags: [`${subject.name.replace(":", "-")}.att`] },
      },
      name: `sha256:${"f".repeat(64)}`,
    },
    {
      created_at: "2026-08-05T00:00:09Z",
      id: subject.id + 300,
      metadata: { container: { tags: [] } },
      name: `sha256:${"1".repeat(64)}`,
    },
  ];

  try {
    await mkdir(snapshots, { mode: 0o700 });
    for (const [name, version] of [
      ["untagged", untaggedVersion],
      ["referrer", referrerVersion],
    ] as const) {
      await writeFile(
        path.join(snapshots, "0.json"),
        `${JSON.stringify([[version]])}\n`,
      );
      await assert.rejects(
        execFileAsync("node", [
          evidenceTool,
          "inventory-plan",
          "zero",
          "ghcr.io",
          namespace,
          "control-plane-api",
          snapshots,
          path.join(temporaryRoot, `${name}-zero-inventory.json`),
          path.join(temporaryRoot, `${name}-zero-verification.json`),
        ]),
        /unexpectedly contains a package version/u,
      );
    }

    await Promise.all([
      writeFile(
        path.join(snapshots, "0.json"),
        `${JSON.stringify([completedVersions(subjectVersion(303, "c"))])}\n`,
      ),
      writeFile(
        path.join(snapshots, "1.json"),
        `${JSON.stringify([[subjectVersion(304, "d"), untaggedVersion]])}\n`,
      ),
      writeFile(path.join(snapshots, "2.json"), "[]\n"),
    ]);
    await assert.rejects(
      execFileAsync("node", [
        evidenceTool,
        "inventory-plan",
        "ordered-partial",
        "ghcr.io",
        namespace,
        "control-plane-api,matrix-worker,matrix-later",
        snapshots,
        path.join(temporaryRoot, "late-failed-inventory.json"),
        path.join(temporaryRoot, "late-failed-verification.json"),
      ]),
      /failed target contains non-subject package versions/u,
    );

    await Promise.all([
      writeFile(
        path.join(snapshots, "1.json"),
        `${JSON.stringify([[subjectVersion(304, "d")]])}\n`,
      ),
      writeFile(
        path.join(snapshots, "2.json"),
        `${JSON.stringify([[untaggedVersion], [referrerVersion]])}\n`,
      ),
    ]);
    await assert.rejects(
      execFileAsync("node", [
        evidenceTool,
        "inventory-plan",
        "ordered-partial",
        "ghcr.io",
        namespace,
        "control-plane-api,matrix-worker,matrix-later",
        snapshots,
        path.join(temporaryRoot, "skipped-inventory.json"),
        path.join(temporaryRoot, "skipped-verification.json"),
      ]),
      /package version for a skipped target/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("protected profile builder creates all distinct key-failure profiles with owner-only modes", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-profile-builder-"),
  );
  const output = path.join(temporaryRoot, "profiles");
  const material = path.join(output, "material");
  const token = "TOKEN_SENTINEL_0123456789abcdef0123456789abcdef";

  try {
    await mkdir(output, { mode: 0o700 });
    await execFileAsync("node", [
      evidenceTool,
      "initialize-profile-material",
      material,
    ]);
    for (const [name, body] of [
      ["primary", "PRIMARY_BODY"],
      ["secondary", "SECONDARY_BODY"],
    ]) {
      const keyDirectory = path.join(material, name);
      await mkdir(keyDirectory, { mode: 0o700 });
      await writeFile(
        path.join(keyDirectory, "cosign.key"),
        [
          "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
          body,
          "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(keyDirectory, "cosign.pub"),
        [
          "-----BEGIN PUBLIC KEY-----",
          body,
          "-----END PUBLIC KEY-----",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    }
    await execFileAsync(
      "node",
      [evidenceTool, "build-profiles", output, material, "ghcr.io"],
      {
        env: {
          ...process.env,
          GITHUB_ACTOR: "matrix-operator",
          GITHUB_TOKEN: token,
        },
      },
    );
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
    const contents = new Map<string, string>();
    for (const scenario of scenarios) {
      const profilePath = path.join(output, "scenarios", `${scenario}.env`);
      contents.set(scenario, await readFile(profilePath, "utf8"));
      assert.equal((await stat(profilePath)).mode & 0o777, 0o600);
    }
    assert.equal(
      (await stat(path.join(output, "scenarios"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      contents.get("malformed-private-pem")?.includes("BEGIN ENCRYPTED"),
      false,
    );
    assert.equal(
      contents.get("malformed-public-pem")?.includes("BEGIN PUBLIC KEY"),
      false,
    );
    assert.equal(
      contents
        .get("invalid-key")
        ?.includes("not-a-valid-encrypted-private-key"),
      true,
    );
    assert.notEqual(
      contents.get("mismatched-key"),
      contents.get("multi-target-success"),
    );
    const dockerConfig = await readFile(
      path.join(output, "registry-auth.json"),
      "utf8",
    );
    assert.equal(dockerConfig.includes(token), false);
    assert.equal(
      (await stat(path.join(output, "registry-auth.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("project GHCR hooks independently inspect, verify, delete, and re-inspect a namespace", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-ghcr-hooks-"),
  );
  const executableDirectory = path.join(temporaryRoot, "bin");
  const registryState = path.join(temporaryRoot, "registry-state");
  const daggerCalls = path.join(temporaryRoot, "dagger-calls.txt");
  const deployEnvironment = path.join(temporaryRoot, "deploy.env");
  const dockerConfig = path.join(temporaryRoot, "docker-config.json");
  const inventory = path.join(temporaryRoot, "inventory.json");
  const cleanup = path.join(temporaryRoot, "cleanup.json");
  const verificationComplete = path.join(
    temporaryRoot,
    "verification-complete",
  );
  const recoveryCleanup = path.join(temporaryRoot, "recovery-cleanup.json");
  const namespaceRecordRoot = path.join(temporaryRoot, "namespace-records");
  const namespaceRecord = path.join(
    namespaceRecordRoot,
    "multi-target-success-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt",
  );
  const token = "TOKEN_SENTINEL_abcdef0123456789abcdef0123456789";

  try {
    await Promise.all([
      mkdir(executableDirectory, { mode: 0o700 }),
      mkdir(registryState, { mode: 0o700 }),
    ]);
    await writeFile(
      path.join(executableDirectory, "gh"),
      [
        "#!/usr/bin/env node",
        'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "const args = process.argv.slice(2);",
        'const endpoint = args.find((value) => value.startsWith("/orgs/"));',
        'const method = args[args.indexOf("--method") + 1];',
        "if (!endpoint) process.exit(91);",
        'if (method === "GET" && !args.includes("--include") && (!args.includes("--paginate") || !args.includes("--slurp"))) process.exit(92);',
        "const encoded = /packages\\/container\\/([^/?]+)/u.exec(endpoint)?.[1];",
        'const packageName = decodeURIComponent(encoded ?? "");',
        'const marker = path.join(process.env.OCI_V081_TEST_REGISTRY_STATE, Buffer.from(packageName).toString("hex"));',
        'if (process.env.OCI_V081_TEST_FALSE_404 === "true") { if (args.includes("--include")) process.stdout.write("HTTP/2.0 500 Internal Server Error\\n\\n"); else process.stderr.write("transient route mentioned 404 while failing\\n"); process.exit(1); }',
        'if (method === "DELETE") { mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, "deleted\\n"); process.exit(0); }',
        'if (existsSync(marker)) { if (args.includes("--include")) process.stdout.write("HTTP/2.0 404 Not Found\\n\\n"); else process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }',
        'const target = packageName.split("/").at(-1);',
        'const index = target === "control-plane-api" ? 1 : 2;',
        'const pollMarker = marker + ".polls";',
        'const pollCount = (existsSync(pollMarker) ? Number(readFileSync(pollMarker, "utf8")) : 0) + 1;',
        "writeFileSync(pollMarker, String(pollCount));",
        'const subjectDigest = "sha256:" + String(index).repeat(64);',
        `const versions = [{ id: 100 + index, name: subjectDigest, created_at: "2026-08-05T00:00:0" + index + "Z", metadata: { container: { tags: ["${subjectTag}"] } } }];`,
        'if (pollCount >= 2) versions.push({ id: 200 + index, name: "sha256:" + String(index + 2).repeat(64), created_at: "2026-08-05T00:00:1" + index + "Z", metadata: { container: { tags: [] } } }, { id: 300 + index, name: "sha256:" + String(index + 3).repeat(64), created_at: "2026-08-05T00:00:2" + index + "Z", metadata: { container: { tags: [] } } }, { id: 350 + index, name: "sha256:" + String(index + 5).repeat(64), created_at: "2026-08-05T00:00:25Z", metadata: { container: { tags: [] } } });',
        'if (existsSync(process.env.OCI_V081_TEST_VERIFICATION_COMPLETE ?? "")) versions.push({ id: 400 + index, name: "sha256:" + String(index + 4).repeat(64), created_at: "2026-08-05T00:00:3" + index + "Z", metadata: { container: { tags: [] } } });',
        'process.stdout.write(JSON.stringify([versions]) + "\\n");',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(executableDirectory, "dagger"),
      [
        "#!/usr/bin/env node",
        'import { appendFileSync, writeFileSync } from "node:fs";',
        'appendFileSync(process.env.OCI_V081_TEST_DAGGER_CALLS, process.argv.slice(2).join(" ") + "\\n");',
        'writeFileSync(process.env.OCI_V081_TEST_VERIFICATION_COMPLETE, "verified\\n");',
        "",
      ].join("\n"),
    );
    await Promise.all([
      chmod(path.join(executableDirectory, "gh"), 0o755),
      chmod(path.join(executableDirectory, "dagger"), 0o755),
    ]);
    await writeFile(
      deployEnvironment,
      [
        "OCI_MATRIX_USERNAME=matrix-operator",
        `OCI_MATRIX_TOKEN=${token}`,
        "OCI_MATRIX_SIGNING_KEY=unused",
        "OCI_MATRIX_SIGNING_PASSWORD=unused-password",
        "OCI_MATRIX_VERIFICATION_KEY=-----BEGIN PUBLIC KEY-----\\nPUBLIC_BODY\\n-----END PUBLIC KEY-----",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      dockerConfig,
      `${JSON.stringify({ auths: { "ghcr.io": { auth: "protected-auth" } } })}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      GITHUB_TOKEN: token,
      OCI_V081_MATRIX_DEPLOY_ENV_FILE: deployEnvironment,
      OCI_V081_MATRIX_DOCKER_CONFIG_FILE: dockerConfig,
      OCI_V081_TEST_DAGGER_CALLS: daggerCalls,
      OCI_V081_TEST_REGISTRY_STATE: registryState,
      OCI_V081_TEST_VERIFICATION_COMPLETE: verificationComplete,
      PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: temporaryRoot,
    };
    await execFileAsync(
      inventoryHook,
      [
        "success",
        "ghcr.io",
        namespace,
        "control-plane-api,matrix-worker",
        inventory,
      ],
      { env: environment },
    );
    const inventoryEvidence = JSON.parse(await readFile(inventory, "utf8"));
    assert.equal(
      inventoryEvidence.repositories["matrix-worker"].publication_count,
      1,
    );
    assert.equal(
      inventoryEvidence.repositories["matrix-worker"].package_version_count,
      5,
    );
    assert.equal(
      inventoryEvidence.events.filter(
        ({ operation }: { operation: string }) =>
          operation === "package-version-present",
      ).length,
      8,
    );
    assert.equal(
      (await readFile(daggerCalls, "utf8")).split("sync").length - 1,
      2,
    );

    await execFileAsync(
      cleanupHook,
      [
        "inspect-and-clean",
        "ghcr.io",
        namespace,
        "control-plane-api,matrix-worker",
        cleanup,
      ],
      { env: environment },
    );
    const cleanupEvidence = JSON.parse(await readFile(cleanup, "utf8"));
    assert.equal(cleanupEvidence.cleanup_completed, true);
    assert.equal(
      cleanupEvidence.repositories["matrix-worker"].remaining_publication_count,
      0,
    );

    await mkdir(namespaceRecordRoot, { mode: 0o700 });
    await writeFile(
      namespaceRecord,
      [
        "schema=rush-delivery-v081-live-namespace/v1",
        "scenario=multi-target-success",
        `candidate_commit=${gitSha}`,
        "registry=ghcr.io",
        `repository_prefix=${namespace}`,
        "targets=control-plane-api,matrix-worker",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await execFileAsync(
      cleanupHook,
      ["--namespace-record", namespaceRecord, recoveryCleanup],
      { env: environment },
    );
    const recoveryEvidence = JSON.parse(
      await readFile(recoveryCleanup, "utf8"),
    );
    assert.equal(recoveryEvidence.cleanup_completed, true);
    assert.equal(
      recoveryEvidence.repositories["control-plane-api"].package_absent,
      true,
    );
    assert.equal(
      recoveryEvidence.repositories["matrix-worker"].package_absent,
      true,
    );

    const invalidRecord = path.join(
      namespaceRecordRoot,
      "multi-target-success-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.txt",
    );
    const rejectedEvidence = path.join(temporaryRoot, "rejected-cleanup.json");
    await writeFile(
      invalidRecord,
      (await readFile(namespaceRecord, "utf8")).replace(
        "targets=control-plane-api,matrix-worker",
        "targets=control-plane-api,matrix-later",
      ),
      { mode: 0o600 },
    );
    await assert.rejects(
      execFileAsync(
        cleanupHook,
        ["--namespace-record", invalidRecord, rejectedEvidence],
        { env: environment },
      ),
    );
    await assertAbsent(rejectedEvidence);

    const falseAbsenceEvidence = path.join(
      temporaryRoot,
      "false-absence-cleanup.json",
    );
    await assert.rejects(
      execFileAsync(
        cleanupHook,
        [
          "inspect-and-clean",
          "ghcr.io",
          namespace,
          "control-plane-api,matrix-worker",
          falseAbsenceEvidence,
        ],
        {
          env: { ...environment, OCI_V081_TEST_FALSE_404: "true" },
        },
      ),
    );
    await assertAbsent(falseAbsenceEvidence);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("finalization fault injector is post-publication and the hook owns an exact HEAD copy", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-v081-finalization-fault-"),
  );
  const outputRoot = path.join(temporaryRoot, "live-output");
  const sourceCopy = path.join(temporaryRoot, "package-image.ts");
  const stateFile = path.join(outputRoot, "state/finalization-fault-module");
  const faultNamespace =
    "bootstraplaboratory/rush-delivery-v081-acceptance/v081-multi-target-finalization-failure-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const environment = {
    ...process.env,
    OCI_V081_MATRIX_FAULT_STATE_FILE: stateFile,
    OCI_V081_MATRIX_FAULT_WORK_ROOT: outputRoot,
    RUNNER_TEMP: temporaryRoot,
  };
  const currentSource = await readFile(
    path.join(repoRoot, "src/application-images/package-image.ts"),
    "utf8",
  );

  try {
    await mkdir(outputRoot, { mode: 0o700 });
    await writeFile(
      path.join(outputRoot, ".rush-delivery-v081-live-owned"),
      "rush-delivery-v081-live-owned\n",
      { mode: 0o600 },
    );
    await writeFile(sourceCopy, currentSource);
    await execFileAsync("node", [faultInjector, sourceCopy, "matrix-worker"]);
    const patchedSource = await readFile(sourceCopy, "utf8");
    const normalization = patchedSource.indexOf(
      "published = normalizePublishedImageReference",
    );
    const injected = patchedSource.indexOf(
      "injected post-publication acceptance failure",
    );
    const provenance = patchedSource.indexOf("let provenance: File");
    assert.equal(
      normalization >= 0 && normalization < injected && injected < provenance,
      true,
    );
    assert.equal(
      patchedSource.match(/Private v0\.8\.1 live-acceptance fault/gu)?.length,
      1,
    );

    const hookSource = await readFile(faultHook, "utf8");
    assert.match(
      hookSource,
      /git -C "\$\{OCI_V081_FAULT_REPO_ROOT\}" archive --format=tar HEAD/u,
    );
    assert.match(hookSource, /\.rush-delivery-v081-finalization-fault-owned/u);
    let headSource: string | undefined;
    try {
      ({ stdout: headSource } = await execFileAsync("git", [
        "-C",
        repoRoot,
        "show",
        "HEAD:src/application-images/package-image.ts",
      ]));
    } catch {
      // Dagger self-check deliberately excludes Git metadata from module source.
    }
    if (
      headSource === currentSource &&
      currentSource.includes("export async function finalizeApplicationImage")
    ) {
      await execFileAsync(
        faultHook,
        [
          "configure-finalization-failure",
          "ghcr.io",
          faultNamespace,
          "matrix-worker",
        ],
        { env: environment, timeout: 120_000 },
      );
      const moduleRoot = (await readFile(stateFile, "utf8")).trimEnd();
      assert.equal(
        moduleRoot.startsWith(
          `${temporaryRoot}/rush-delivery-v081-finalization-fault.`,
        ),
        true,
      );
      await assertAbsent(path.join(moduleRoot, ".git"));
      await assertAbsent(path.join(moduleRoot, "sdk"));
      await assertAbsent(path.join(moduleRoot, "node_modules"));
      assert.match(
        await readFile(
          path.join(moduleRoot, "src/application-images/package-image.ts"),
          "utf8",
        ),
        /injected post-publication acceptance failure/u,
      );
      await execFileAsync(
        faultHook,
        [
          "teardown-finalization-failure",
          "ghcr.io",
          faultNamespace,
          "matrix-worker",
        ],
        { env: environment },
      );
      await assertAbsent(moduleRoot);
      await assertAbsent(stateFile);
    } else {
      const { stdout } = await execFileAsync(
        faultHook,
        [
          "teardown-finalization-failure",
          "ghcr.io",
          faultNamespace,
          "matrix-worker",
        ],
        { env: environment },
      );
      assert.match(stdout, /No disposable v0\.8\.1 finalization-fault module/u);
      await assertAbsent(stateFile);
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
