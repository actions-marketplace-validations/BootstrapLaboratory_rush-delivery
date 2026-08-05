import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync, zstdCompressSync } from "node:zlib";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const libraryPath = path.join(testDirectory, "scripts/lib/oci-acceptance.sh");
const acceptanceScriptPath = path.join(
  testDirectory,
  "scripts/run-oci-acceptance.sh",
);
const verifierPath = path.join(
  testDirectory,
  "scripts/verify-oci-acceptance.mjs",
);
const cleanupScriptPath = path.join(
  testDirectory,
  "scripts/cleanup-ghcr-acceptance.sh",
);
const workflowPath = path.join(
  testDirectory,
  "../.github/workflows/oci-acceptance.yml",
);
const daggerSecurityScriptPath = path.join(
  testDirectory,
  "scripts/run-dagger-security-engine.sh",
);
const canonicalBuildScriptPath = path.join(
  testDirectory,
  "../examples/oci-application-image-rush-repo/apps/control-plane-api/scripts/build.mjs",
);
const canonicalDeployScriptPath = path.join(
  testDirectory,
  "../examples/oci-application-image-rush-repo/deploy/consume-image.sh",
);
const canonicalProviderPath = path.join(
  testDirectory,
  "../examples/oci-application-image-rush-repo/.dagger/application-images/providers.yaml",
);

function sha256(contents: string | Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function writeTarOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
}

function createTar(
  entries: readonly { contents: Buffer; name: string }[],
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    assert.ok(name.length > 0 && name.length <= 100);

    const header = Buffer.alloc(512);
    name.copy(header, 0);
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, entry.contents.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );

    blocks.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function createOciImageArchive(
  layerPayload: string,
  compression: "gzip" | "zstd",
  historyCommand = "deterministic acceptance fixture",
): { archive: Buffer; manifestDigest: string } {
  const uncompressedLayer = createTar([
    { contents: Buffer.from(layerPayload, "utf8"), name: "payload.txt" },
  ]);
  const layer =
    compression === "gzip"
      ? gzipSync(uncompressedLayer)
      : zstdCompressSync(uncompressedLayer);
  const layerDigest = sha256(layer);
  const config = Buffer.from(
    `${JSON.stringify({
      architecture: "amd64",
      config: {},
      history: [{ created_by: historyCommand }],
      os: "linux",
      rootfs: {
        diff_ids: [sha256(uncompressedLayer)],
        type: "layers",
      },
    })}\n`,
    "utf8",
  );
  const configDigest = sha256(config);
  const manifest = Buffer.from(
    JSON.stringify({
      config: {
        digest: configDigest,
        mediaType: "application/vnd.oci.image.config.v1+json",
        size: config.length,
      },
      layers: [
        {
          digest: layerDigest,
          mediaType: `application/vnd.oci.image.layer.v1.tar+${compression}`,
          size: layer.length,
        },
      ],
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      schemaVersion: 2,
    }),
    "utf8",
  );
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      manifests: [
        {
          digest: manifestDigest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          platform: { architecture: "amd64", os: "linux" },
          size: manifest.length,
        },
      ],
      mediaType: "application/vnd.oci.image.index.v1+json",
      schemaVersion: 2,
    }),
    "utf8",
  );

  return {
    archive: createTar([
      {
        contents: Buffer.from('{"imageLayoutVersion":"1.0.0"}\n'),
        name: "oci-layout",
      },
      { contents: index, name: "index.json" },
      {
        contents: config,
        name: `blobs/sha256/${configDigest.slice("sha256:".length)}`,
      },
      {
        contents: manifest,
        name: `blobs/sha256/${manifestDigest.slice("sha256:".length)}`,
      },
      {
        contents: layer,
        name: `blobs/sha256/${layerDigest.slice("sha256:".length)}`,
      },
    ]),
    manifestDigest,
  };
}

function runLibrary(
  script: string,
  args: readonly string[] = [],
): SpawnSyncReturns<string> {
  return spawnSync(
    "bash",
    ["-c", `source "$1"; shift; ${script}`, "bash", libraryPath, ...args],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

test("OCI acceptance readiness retry succeeds within its fixed bound", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-retry-"),
  );
  const counterPath = path.join(tempDirectory, "counter");
  writeFileSync(counterPath, "0\n", "utf8");

  try {
    const result = runLibrary(
      'probe() { count="$(<"$1")"; count=$((count + 1)); printf "%s\\n" "$count" >"$1"; ((count >= 3)); }; oci_acceptance_retry_read 3 0 probe "$1"',
      [counterPath],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(counterPath, "utf8"), "3\n");
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("explicit registry configuration never inherits GitHub credentials", () => {
  const missingExplicit = runLibrary(
    'GITHUB_ACTOR=github-user GITHUB_TOKEN=github-token; unset OCI_ACCEPTANCE_USERNAME OCI_ACCEPTANCE_TOKEN; username=""; token=""; oci_acceptance_resolve_registry_credentials registry.example false run-id',
  );
  const explicit = runLibrary(
    'GITHUB_ACTOR=github-user GITHUB_TOKEN=github-token OCI_ACCEPTANCE_USERNAME=registry-user OCI_ACCEPTANCE_TOKEN=registry-token; export GITHUB_ACTOR GITHUB_TOKEN OCI_ACCEPTANCE_USERNAME OCI_ACCEPTANCE_TOKEN; username=""; token=""; oci_acceptance_resolve_registry_credentials registry.example false run-id; [[ $username == registry-user && $token == registry-token ]]',
  );
  const ttl = runLibrary(
    'GITHUB_ACTOR=github-user GITHUB_TOKEN=github-token; export GITHUB_ACTOR GITHUB_TOKEN; unset OCI_ACCEPTANCE_USERNAME OCI_ACCEPTANCE_TOKEN; username=""; token=""; oci_acceptance_resolve_registry_credentials ttl.sh false run-id; [[ $username == SENTINEL_OCI_USERNAME_run-id && $token == SENTINEL_OCI_TOKEN_run-id ]]',
  );

  assert.notEqual(missingExplicit.status, 0);
  assert.equal(
    `${missingExplicit.stdout}${missingExplicit.stderr}`.includes(
      "github-token",
    ),
    false,
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(ttl.status, 0, ttl.stderr);
});

test("OCI acceptance readiness retry exhausts without exceeding its bound", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-exhaustion-"),
  );
  const counterPath = path.join(tempDirectory, "counter");
  writeFileSync(counterPath, "0\n", "utf8");

  try {
    const result = runLibrary(
      'probe() { count="$(<"$1")"; count=$((count + 1)); printf "%s\\n" "$count" >"$1"; return 1; }; oci_acceptance_retry_read 2 0 probe "$1"',
      [counterPath],
    );

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(counterPath, "utf8"), "2\n");
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance failure classification separates product and transport outcomes", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-classification-"),
  );
  const productLog = path.join(tempDirectory, "product.log");
  const transportLog = path.join(tempDirectory, "transport.log");
  writeFileSync(productLog, "application image scan policy rejected target\n");
  writeFileSync(transportLog, "registry request: TLS handshake timeout\n");

  try {
    const product = runLibrary(
      'oci_acceptance_classify_failure "$1" not-started',
      [productLog],
    );
    const preMutationTransport = runLibrary(
      'oci_acceptance_classify_failure "$1" not-started',
      [transportLog],
    );
    const postMutationTransport = runLibrary(
      'oci_acceptance_classify_failure "$1" started',
      [transportLog],
    );
    const preMutationTimeout = runLibrary(
      'oci_acceptance_classify_failure "$1" not-started 124',
      [productLog],
    );
    const postMutationTimeout = runLibrary(
      'oci_acceptance_classify_failure "$1" unknown 124',
      [productLog],
    );

    assert.equal(product.status, 0, product.stderr);
    assert.equal(product.stdout, "product-contract\n");
    assert.equal(preMutationTransport.stdout, "registry-transport\n");
    assert.equal(
      postMutationTransport.stdout,
      "registry-transport-ambiguous\n",
    );
    assert.equal(preMutationTimeout.stdout, "operation-timeout\n");
    assert.equal(postMutationTimeout.stdout, "mutation-timeout-ambiguous\n");
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance derives only allowlisted stages and conservative mutation states", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-stage-"),
  );
  const preflightLog = path.join(tempDirectory, "preflight.log");
  const publicationLog = path.join(tempDirectory, "publication.log");
  const finalizationLog = path.join(tempDirectory, "finalization.log");
  const authenticationLog = path.join(tempDirectory, "authentication.log");
  const authorizationLog = path.join(tempDirectory, "authorization.log");
  const publicationTransportLog = path.join(
    tempDirectory,
    "publication-transport.log",
  );
  const cosignStages = [
    "sign",
    "attest-spdx",
    "attest-provenance",
    "verify-signature",
    "verify-spdx-attestation",
    "verify-provenance-attestation",
  ] as const;
  const cosignLogs = cosignStages.map((stage) => ({
    expected: `cosign-${stage}`,
    log: path.join(tempDirectory, `cosign-${stage}.log`),
    stage,
  }));
  const unknownLog = path.join(tempDirectory, "unknown.log");
  writeFileSync(
    preflightLog,
    'Application image provider "ghcr" Cosign preflight failed for signing password.\n',
  );
  writeFileSync(
    publicationLog,
    [
      "[package] OCI publication boundary crossed; ordered finalization is starting.",
      'OCI package target "api" failed during registry publication.',
      "",
    ].join("\n"),
  );
  writeFileSync(
    finalizationLog,
    [
      "[package] OCI publication boundary crossed; ordered finalization is starting.",
      "OCI application image finalization failed:",
      'Later target "worker" was not started.',
      "",
    ].join("\n"),
  );
  writeFileSync(
    authenticationLog,
    'OCI package target "api" failed during registry publication authentication.\n',
  );
  writeFileSync(
    authorizationLog,
    'OCI package target "api" failed during registry publication authorization.\n',
  );
  writeFileSync(
    publicationTransportLog,
    'OCI package target "api" failed during registry publication transport.\n',
  );
  for (const { log, stage } of cosignLogs) {
    writeFileSync(
      log,
      `OCI package target "api" failed during Cosign ${stage}.\n`,
    );
  }
  writeFileSync(unknownLog, "unmapped package failure\n");

  try {
    const preflightStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [preflightLog],
    );
    const preflightState = runLibrary(
      'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
      [preflightLog],
    );
    const publicationStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [publicationLog],
    );
    const publicationState = runLibrary(
      'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
      [publicationLog],
    );
    const unknownState = runLibrary(
      'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
      [unknownLog],
    );
    const finalizationStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [finalizationLog],
    );
    const finalizationState = runLibrary(
      'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
      [finalizationLog],
    );
    const timeoutState = runLibrary(
      'oci_acceptance_detect_mutation_state "$1" 124 package-contract',
      [unknownLog],
    );
    const successfulState = runLibrary(
      'oci_acceptance_detect_mutation_state "$1" 0 package-contract',
      [unknownLog],
    );
    const authenticationStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [authenticationLog],
    );
    const authorizationStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [authorizationLog],
    );
    const publicationTransportStage = runLibrary(
      'oci_acceptance_classify_failure_stage "$1"',
      [publicationTransportLog],
    );
    const publicationTransportState = runLibrary(
      'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
      [publicationTransportLog],
    );
    const publicationTransportClass = runLibrary(
      'oci_acceptance_classify_failure "$1" started',
      [publicationTransportLog],
    );

    assert.equal(preflightStage.stdout, "cosign-preflight\n");
    assert.equal(preflightState.stdout, "not-started\n");
    assert.equal(publicationStage.stdout, "registry-publication\n");
    assert.equal(publicationState.stdout, "started\n");
    assert.equal(finalizationStage.stdout, "image-finalization\n");
    assert.equal(finalizationState.stdout, "started\n");
    assert.equal(
      authenticationStage.stdout,
      "registry-publication-authentication\n",
    );
    assert.equal(
      authorizationStage.stdout,
      "registry-publication-authorization\n",
    );
    assert.equal(
      publicationTransportStage.stdout,
      "registry-publication-transport\n",
    );
    assert.equal(publicationTransportState.stdout, "started\n");
    assert.equal(
      publicationTransportClass.stdout,
      "registry-transport-ambiguous\n",
    );
    for (const { expected, log } of cosignLogs) {
      const stage = runLibrary('oci_acceptance_classify_failure_stage "$1"', [
        log,
      ]);
      const mutationState = runLibrary(
        'stage="$(oci_acceptance_classify_failure_stage "$1")"; oci_acceptance_detect_mutation_state "$1" 1 "$stage"',
        [log],
      );
      assert.equal(stage.stdout.trim(), expected);
      assert.equal(mutationState.stdout, "started\n");
    }
    assert.equal(unknownState.stdout, "unknown\n");
    assert.equal(timeoutState.stdout, "unknown\n");
    assert.equal(successfulState.stdout, "completed\n");
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance cleanup is bounded to its registered temp namespace", async () => {
  const tempRoot = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-cleanup-root-"),
  );
  const registered = path.join(
    tempRoot,
    "rush-delivery-oci-acceptance.registered",
  );
  const unrelated = path.join(tempRoot, "unrelated");
  writeFileSync(unrelated, "keep\n", "utf8");
  writeFileSync(registered, "not-a-directory\n", "utf8");

  try {
    await rm(registered, { force: true });
    const makeRegistered = spawnSync("mkdir", ["-p", registered]);
    assert.equal(makeRegistered.status, 0);
    writeFileSync(path.join(registered, "marker"), "remove\n", "utf8");

    const cleanup = runLibrary('oci_acceptance_cleanup_tree "$1" "$2"', [
      tempRoot,
      registered,
    ]);
    const refused = runLibrary('oci_acceptance_cleanup_tree "$1" "$2"', [
      tempRoot,
      tempRoot,
    ]);

    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(registered), false);
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(unrelated), true);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("OCI acceptance executes its registered registry cleanup hook", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-hook-"),
  );
  const hookPath = path.join(tempDirectory, "cleanup-hook.sh");
  const markerPath = path.join(tempDirectory, "cleanup-marker");
  writeFileSync(
    hookPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
      ': "${OCI_ACCEPTANCE_CLEANUP_REGISTRY:?}"',
      ': "${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX:?}"',
      ': "${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES:?}"',
      ': "${OCI_ACCEPTANCE_CLEANUP_USERNAME:?}"',
      ': "${OCI_ACCEPTANCE_CLEANUP_TOKEN:?}"',
      ': "${GITHUB_TOKEN:?}"',
      'printf "%s/%s:%s\\n" "${OCI_ACCEPTANCE_CLEANUP_REGISTRY}" "${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX}" "${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES}" >"${HOOK_DIR}/cleanup-marker"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(hookPath, 0o700);

  try {
    const result = runLibrary(
      'oci_acceptance_run_cleanup_hook "$1" registry.example example/run "control-plane-api" cleanup-token cleanup-user cleanup-registry-token; test -f "$2"',
      [hookPath, markerPath],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(markerPath, "utf8"),
      "registry.example/example/run:control-plane-api\n",
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance diagnostics never echo a protected sentinel", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-redaction-"),
  );
  const logPath = path.join(tempDirectory, "captured.log");
  const sentinel = `sentinel-${process.pid}-${Date.now()}`;
  writeFileSync(logPath, `prefix ${sentinel} suffix\n`, "utf8");

  try {
    const result = runLibrary('oci_acceptance_assert_absent "$1" "$2"', [
      logPath,
      sentinel,
    ]);
    const combined = `${result.stdout}${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.equal(combined.includes(sentinel), false);
    assert.match(combined, /contains protected material/);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance mutation timeout wrapper preserves command status and captures output", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-timeout-"),
  );
  const logPath = path.join(tempDirectory, "mutation.log");

  try {
    const result = runLibrary(
      "oci_acceptance_run_with_timeout 5 \"$1\" bash -c 'printf controlled-output; exit 7'; status=$?; [[ $status == 7 ]]",
      [logPath],
    );
    const invalid = runLibrary('oci_acceptance_run_with_timeout 0 "$1" true', [
      logPath,
    ]);
    const unbounded = runLibrary(
      'oci_acceptance_require_bounded_integer "attempt count" 6 1 5',
    );
    const compatibleNode = runLibrary("oci_acceptance_node_runtime_ready");
    const incompatibleNode = runLibrary(
      "node() { return 1; }; oci_acceptance_node_runtime_ready",
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(logPath, "utf8"), "controlled-output");
    assert.notEqual(invalid.status, 0);
    assert.notEqual(unbounded.status, 0);
    assert.match(
      unbounded.stderr,
      /attempt count must be an integer from 1 through 5/,
    );
    assert.equal(compatibleNode.status, 0, compatibleNode.stderr);
    assert.notEqual(incompatibleNode.status, 0);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance diagnostic artifact contains only its fixed redacted schema", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-diagnostic-"),
  );
  const diagnosticPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-diagnostic.txt",
  );
  const sentinel = `diagnostic-secret-${process.pid}-${Date.now()}`;

  try {
    const written = runLibrary(
      'oci_acceptance_write_diagnostic "$1" failed verification-contract bundle-verification started succeeded',
      [diagnosticPath],
    );
    const rejected = runLibrary(
      'oci_acceptance_write_diagnostic "$1" failed "$2" bundle-verification started succeeded',
      [diagnosticPath, sentinel],
    );
    const diagnostic = readFileSync(diagnosticPath, "utf8");

    assert.equal(written.status, 0, written.stderr);
    assert.notEqual(rejected.status, 0);
    assert.equal(
      diagnostic,
      [
        "schema=rush-delivery-oci-acceptance-diagnostic/v2",
        "outcome=failed",
        "failure_class=verification-contract",
        "failure_stage=bundle-verification",
        "mutation_state=started",
        "cleanup_state=succeeded",
        "",
      ].join("\n"),
    );
    assert.equal(diagnostic.includes(sentinel), false);
    assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance namespace record is fixed, non-secret, and deletion-scoped", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-namespace-record-"),
  );
  const recordPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-namespace.txt",
  );
  const namespace = `bootstraplaboratory/rush-delivery-acceptance-${"a".repeat(32)}`;
  const sentinel = `namespace-secret-${process.pid}-${Date.now()}`;

  try {
    const written = runLibrary(
      'oci_acceptance_write_namespace_record "$1" ghcr.io "$2" control-plane-api',
      [recordPath, namespace],
    );
    const rejectedPrefix = runLibrary(
      'oci_acceptance_write_namespace_record "$1" ghcr.io "$2" control-plane-api',
      [recordPath, `bootstraplaboratory/${sentinel}`],
    );
    const rejectedSuffix = runLibrary(
      'oci_acceptance_write_namespace_record "$1" ghcr.io "$2" second-image',
      [recordPath, namespace],
    );
    const record = readFileSync(recordPath, "utf8");

    assert.equal(written.status, 0, written.stderr);
    assert.notEqual(rejectedPrefix.status, 0);
    assert.notEqual(rejectedSuffix.status, 0);
    assert.equal(
      record,
      [
        "schema=rush-delivery-oci-acceptance-namespace/v1",
        "registry=ghcr.io",
        `repository_prefix=${namespace}`,
        "package_suffix=control-plane-api",
        "",
      ].join("\n"),
    );
    assert.equal(
      `${rejectedPrefix.stdout}${rejectedPrefix.stderr}${rejectedSuffix.stdout}${rejectedSuffix.stderr}${record}`.includes(
        sentinel,
      ),
      false,
    );
    assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance runner preserves a controlled diagnostic on early failure", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-runner-diagnostic-"),
  );
  const fakeBin = path.join(tempDirectory, "bin");
  const fakeCurl = path.join(fakeBin, "curl");
  const fakeDagger = path.join(fakeBin, "dagger");
  const fakeNode = path.join(fakeBin, "node");
  const diagnosticPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-diagnostic.txt",
  );
  const sentinel = `runner-secret-${process.pid}-${Date.now()}`;
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(fakeCurl, "#!/usr/bin/env bash\nexit 99\n");
  writeFileSync(fakeDagger, "#!/usr/bin/env bash\nexit 99\n");
  chmodSync(fakeCurl, 0o700);
  chmodSync(fakeDagger, 0o700);

  try {
    const result = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: sentinel,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "6",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const diagnostic = readFileSync(diagnosticPath, "utf8");
    const combined = `${result.stdout}${result.stderr}${diagnostic}`;

    assert.notEqual(result.status, 0);
    assert.match(diagnostic, /outcome=failed/);
    assert.match(diagnostic, /failure_class=configuration/);
    assert.match(diagnostic, /mutation_state=not-started/);
    assert.match(diagnostic, /cleanup_state=not-required/);
    assert.equal(combined.includes(sentinel), false);

    writeFileSync(fakeNode, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(fakeNode, 0o700);
    const incompatibleRuntime = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: sentinel,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const runtimeDiagnostic = readFileSync(diagnosticPath, "utf8");
    const runtimeOutput = `${incompatibleRuntime.stdout}${incompatibleRuntime.stderr}${runtimeDiagnostic}`;

    assert.notEqual(incompatibleRuntime.status, 0);
    assert.match(runtimeDiagnostic, /failure_class=node-runtime/);
    assert.match(
      incompatibleRuntime.stderr,
      /^OCI acceptance infrastructure \[node-runtime\]: pinned Node\.js 24 with built-in zstd support is required\n$/,
    );
    assert.equal(runtimeOutput.includes(sentinel), false);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance reports temp cleanup failure and cannot turn it into success", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-temp-cleanup-"),
  );
  const fakeBin = path.join(tempDirectory, "bin");
  const fakeFind = path.join(fakeBin, "find");
  const diagnosticPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-diagnostic.txt",
  );
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(fakeFind, "#!/usr/bin/env bash\nexit 23\n");
  chmodSync(fakeFind, 0o700);

  try {
    const result = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "temp-cleanup-sentinel",
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "6",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: tempDirectory,
      },
    });
    const diagnostic = readFileSync(diagnosticPath, "utf8");
    const source = readFileSync(acceptanceScriptPath, "utf8");

    assert.notEqual(result.status, 0);
    assert.match(diagnostic, /cleanup_state=failed/);
    assert.match(
      source,
      /if \(\(original_status == 0\)\) && \[\[ \$\{cleanup_failed\} == true \]\]; then\s+original_status=1/,
    );
    assert.equal(
      `${result.stdout}${result.stderr}${diagnostic}`.includes(
        "temp-cleanup-sentinel",
      ),
      false,
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance resets setup diagnostics after successful key generation", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-setup-stage-"),
  );
  const fakeBin = path.join(tempDirectory, "bin");
  const fakeCurl = path.join(fakeBin, "curl");
  const fakeDagger = path.join(fakeBin, "dagger");
  const fakeTar = path.join(fakeBin, "tar");
  const diagnosticPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-diagnostic.txt",
  );
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(fakeCurl, "#!/usr/bin/env bash\nprintf '200'\n");
  writeFileSync(
    fakeDagger,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'command_text="${*: -1}"',
      'key_dir="${command_text##* export }"',
      'mkdir -p "${key_dir}"',
      'printf "%s\\n" "-----BEGIN ENCRYPTED COSIGN PRIVATE KEY-----" test "-----END ENCRYPTED COSIGN PRIVATE KEY-----" >"${key_dir}/cosign.key"',
      'printf "%s\\n" "-----BEGIN PUBLIC KEY-----" test "-----END PUBLIC KEY-----" >"${key_dir}/cosign.pub"',
      "",
    ].join("\n"),
  );
  writeFileSync(fakeTar, "#!/usr/bin/env bash\nexit 41\n");
  for (const executable of [fakeCurl, fakeDagger, fakeTar]) {
    chmodSync(executable, 0o700);
  }

  try {
    const result = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "1",
        OCI_ACCEPTANCE_REGISTRY: "registry.example",
        OCI_ACCEPTANCE_REPOSITORY_PREFIX: "acceptance/setup-stage",
        OCI_ACCEPTANCE_RETENTION_POLICY: "delete-on-exit",
        OCI_ACCEPTANCE_SIGNING_PASSWORD: "setup-signing-password",
        OCI_ACCEPTANCE_TOKEN: "setup-registry-token",
        OCI_ACCEPTANCE_USERNAME: "setup-registry-user",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: tempDirectory,
      },
    });
    const diagnostic = readFileSync(diagnosticPath, "utf8");

    assert.notEqual(result.status, 0);
    assert.match(diagnostic, /failure_class=configuration/);
    assert.match(diagnostic, /failure_stage=configuration/);
    assert.doesNotMatch(diagnostic, /failure_stage=key-generation/);
    assert.equal(
      `${result.stdout}${result.stderr}${diagnostic}`.includes(
        "setup-registry-token",
      ),
      false,
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("explicit-registry runner never forwards an ambient GitHub token to cleanup", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-explicit-cleanup-"),
  );
  const fakeBin = path.join(tempDirectory, "bin");
  const fakeCurl = path.join(fakeBin, "curl");
  const fakeDagger = path.join(fakeBin, "dagger");
  const cleanupHook = path.join(tempDirectory, "cleanup-hook.sh");
  const cleanupRecord = path.join(tempDirectory, "cleanup-record");
  const diagnosticPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-diagnostic.txt",
  );
  const ambientGitHubToken = `ambient-github-${process.pid}-${Date.now()}`;
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(fakeCurl, "#!/usr/bin/env bash\nprintf '200'\n", "utf8");
  writeFileSync(
    fakeDagger,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ $* == *generate-key-pair* ]]; then",
      '  command_text="${*: -1}"',
      '  key_dir="${command_text##* export }"',
      '  mkdir -p "${key_dir}"',
      '  printf "%s\\n" "-----BEGIN ENCRYPTED COSIGN PRIVATE KEY-----" test "-----END ENCRYPTED COSIGN PRIVATE KEY-----" >"${key_dir}/cosign.key"',
      '  printf "%s\\n" "-----BEGIN PUBLIC KEY-----" test "-----END PUBLIC KEY-----" >"${key_dir}/cosign.pub"',
      "  exit 0",
      "fi",
      "if [[ -n ${FAKE_PROTECTED_OUTPUT:-} ]]; then",
      "  printf '%s\\n' '[package] OCI publication boundary crossed; ordered finalization is starting.'",
      "  printf '%s\\n' 'OCI application image finalization failed:'",
      "  printf '%s\\n' \"${FAKE_PROTECTED_OUTPUT}\"",
      "elif [[ ${FAKE_IMAGE_FINALIZATION:-false} == true ]]; then",
      "  printf '%s\\n' '[package] OCI publication boundary crossed; ordered finalization is starting.'",
      "  printf '%s\\n' 'OCI application image finalization failed:'",
      "  printf '%s\\n' 'Later target \"worker\" was not started.'",
      "elif [[ ${FAKE_PUBLICATION_BOUNDARY:-false} == true ]]; then",
      "  printf '%s\\n' '[package] OCI publication boundary crossed; ordered finalization is starting.'",
      "  printf '%s\\n' 'OCI package target \"control-plane-api\" failed during registry publication.'",
      "else",
      "  printf '%s\\n' 'OCI application image preparation failed:'",
      "fi",
      "printf '%s\\n' 'connection reset by peer'",
      "exit 19",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    cleanupHook,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': "${CLEANUP_RECORD:?}"',
      'printf "%s:%s\\n" "${GITHUB_TOKEN+x}" "${GITHUB_TOKEN:-}" >"${CLEANUP_RECORD}"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCurl, 0o700);
  chmodSync(fakeDagger, 0o700);
  chmodSync(cleanupHook, 0o700);

  try {
    const result = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        CLEANUP_RECORD: cleanupRecord,
        GITHUB_TOKEN: ambientGitHubToken,
        OCI_ACCEPTANCE_CLEANUP_HOOK: cleanupHook,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "1",
        OCI_ACCEPTANCE_REGISTRY: "registry.example",
        OCI_ACCEPTANCE_REPOSITORY_PREFIX: "acceptance/explicit",
        OCI_ACCEPTANCE_RETENTION_POLICY: "delete-on-exit",
        OCI_ACCEPTANCE_SIGNING_PASSWORD: "explicit-signing-password",
        OCI_ACCEPTANCE_TOKEN: "explicit-registry-token",
        OCI_ACCEPTANCE_USERNAME: "explicit-registry-user",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const record = readFileSync(cleanupRecord, "utf8");
    const combined = `${result.stdout}${result.stderr}${record}`;

    assert.equal(result.status, 19, result.stderr);
    assert.equal(record, "x:\n");
    assert.equal(combined.includes(ambientGitHubToken), false);
    assert.match(
      readFileSync(diagnosticPath, "utf8"),
      /cleanup_state=succeeded/,
    );
    assert.match(
      readFileSync(diagnosticPath, "utf8"),
      /mutation_state=not-started/,
    );
    assert.match(
      readFileSync(diagnosticPath, "utf8"),
      /failure_stage=image-preparation/,
    );
    assert.match(result.stderr, /\[registry-transport\/image-preparation\]/);
    assert.doesNotMatch(result.stderr, /registry-transport-ambiguous/);

    const afterBoundary = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        CLEANUP_RECORD: cleanupRecord,
        FAKE_PUBLICATION_BOUNDARY: "true",
        GITHUB_TOKEN: ambientGitHubToken,
        OCI_ACCEPTANCE_CLEANUP_HOOK: cleanupHook,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "1",
        OCI_ACCEPTANCE_REGISTRY: "registry.example",
        OCI_ACCEPTANCE_REPOSITORY_PREFIX: "acceptance/explicit",
        OCI_ACCEPTANCE_RETENTION_POLICY: "delete-on-exit",
        OCI_ACCEPTANCE_SIGNING_PASSWORD: "explicit-signing-password",
        OCI_ACCEPTANCE_TOKEN: "explicit-registry-token",
        OCI_ACCEPTANCE_USERNAME: "explicit-registry-user",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const afterBoundaryDiagnostic = readFileSync(diagnosticPath, "utf8");

    assert.equal(afterBoundary.status, 19, afterBoundary.stderr);
    assert.match(afterBoundaryDiagnostic, /mutation_state=started/);
    assert.match(afterBoundaryDiagnostic, /failure_stage=registry-publication/);
    assert.match(afterBoundary.stderr, /registry-transport-ambiguous/);
    assert.equal(
      `${afterBoundary.stdout}${afterBoundary.stderr}${afterBoundaryDiagnostic}`.includes(
        ambientGitHubToken,
      ),
      false,
    );

    const imageFinalization = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        CLEANUP_RECORD: cleanupRecord,
        FAKE_IMAGE_FINALIZATION: "true",
        GITHUB_TOKEN: ambientGitHubToken,
        OCI_ACCEPTANCE_CLEANUP_HOOK: cleanupHook,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "1",
        OCI_ACCEPTANCE_REGISTRY: "registry.example",
        OCI_ACCEPTANCE_REPOSITORY_PREFIX: "acceptance/explicit",
        OCI_ACCEPTANCE_RETENTION_POLICY: "delete-on-exit",
        OCI_ACCEPTANCE_SIGNING_PASSWORD: "explicit-signing-password",
        OCI_ACCEPTANCE_TOKEN: "explicit-registry-token",
        OCI_ACCEPTANCE_USERNAME: "explicit-registry-user",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const imageFinalizationDiagnostic = readFileSync(diagnosticPath, "utf8");

    assert.equal(imageFinalization.status, 19, imageFinalization.stderr);
    assert.match(imageFinalizationDiagnostic, /mutation_state=started/);
    assert.match(
      imageFinalizationDiagnostic,
      /failure_stage=image-finalization/,
    );

    const protectedOutput = spawnSync("bash", [acceptanceScriptPath], {
      encoding: "utf8",
      env: {
        CLEANUP_RECORD: cleanupRecord,
        FAKE_PROTECTED_OUTPUT: "explicit-registry-token",
        GITHUB_TOKEN: ambientGitHubToken,
        OCI_ACCEPTANCE_CLEANUP_HOOK: cleanupHook,
        OCI_ACCEPTANCE_DIAGNOSTIC_PATH: diagnosticPath,
        OCI_ACCEPTANCE_PROBE_ATTEMPTS: "1",
        OCI_ACCEPTANCE_REGISTRY: "registry.example",
        OCI_ACCEPTANCE_REPOSITORY_PREFIX: "acceptance/explicit",
        OCI_ACCEPTANCE_RETENTION_POLICY: "delete-on-exit",
        OCI_ACCEPTANCE_SIGNING_PASSWORD: "explicit-signing-password",
        OCI_ACCEPTANCE_TOKEN: "explicit-registry-token",
        OCI_ACCEPTANCE_USERNAME: "explicit-registry-user",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const protectedOutputDiagnostic = readFileSync(diagnosticPath, "utf8");
    const protectedOutputCombined = `${protectedOutput.stdout}${protectedOutput.stderr}${protectedOutputDiagnostic}`;

    assert.notEqual(protectedOutput.status, 0);
    assert.match(protectedOutputDiagnostic, /mutation_state=started/);
    assert.match(protectedOutputDiagnostic, /failure_stage=protected-output/);
    assert.equal(
      protectedOutputCombined.includes("explicit-registry-token"),
      false,
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("canonical OCI project scripts reject every provider credential name", () => {
  const providerEnvironmentNames = [
    "RD_OCI_GHCR_USERNAME",
    "RD_OCI_GHCR_TOKEN",
    "RD_OCI_COSIGN_PRIVATE_KEY",
    "RD_OCI_COSIGN_PASSWORD",
    "RD_OCI_COSIGN_PUBLIC_KEY",
  ];
  const buildSource = readFileSync(canonicalBuildScriptPath, "utf8");
  const deploySource = readFileSync(canonicalDeployScriptPath, "utf8");

  for (const environmentName of providerEnvironmentNames) {
    assert.match(buildSource, new RegExp(`\\b${environmentName}\\b`));
    assert.match(deploySource, new RegExp(`\\b${environmentName}\\b`));
  }

  const sentinel = `provider-secret-${process.pid}-${Date.now()}`;
  const leakedBuild = spawnSync(process.execPath, [canonicalBuildScriptPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      RD_OCI_GHCR_TOKEN: sentinel,
    },
  });
  const leakedDeploy = spawnSync("bash", [canonicalDeployScriptPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      RD_OCI_GHCR_TOKEN: sentinel,
    },
  });

  assert.notEqual(leakedBuild.status, 0);
  assert.notEqual(leakedDeploy.status, 0);
  assert.equal(
    `${leakedBuild.stdout}${leakedBuild.stderr}${leakedDeploy.stdout}${leakedDeploy.stderr}`.includes(
      sentinel,
    ),
    false,
  );
});

test("OCI acceptance changes only registry coordinates in the canonical provider", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-provider-"),
  );
  const providerPath = path.join(tempDirectory, "providers.yaml");
  const canonicalSource = readFileSync(canonicalProviderPath, "utf8");
  writeFileSync(providerPath, canonicalSource);

  try {
    const rewritten = runLibrary(
      'oci_acceptance_rewrite_provider_coordinates "$1" registry.example acceptance/run',
      [providerPath],
    );
    const expected = canonicalSource
      .replace("    registry: ghcr.io\n", "    registry: registry.example\n")
      .replace(
        "    repository_prefix: example/rush-delivery-tutorial\n",
        "    repository_prefix: acceptance/run\n",
      );

    assert.equal(rewritten.status, 0, rewritten.stderr);
    assert.equal(readFileSync(providerPath, "utf8"), expected);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("GHCR acceptance cleanup is hard-bound, pinned, and readback-verified", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-ghcr-cleanup-"),
  );
  const fakeBin = path.join(tempDirectory, "bin");
  const fakeGh = path.join(fakeBin, "gh");
  const fakeSleep = path.join(fakeBin, "sleep");
  const ghRecordPath = path.join(tempDirectory, "gh-record");
  const ghStatePath = path.join(tempDirectory, "gh-state");
  const namespaceRecordPath = path.join(
    tempDirectory,
    "rush-delivery-oci-acceptance-namespace.txt",
  );
  const namespace = `bootstraplaboratory/rush-delivery-acceptance-${"b".repeat(32)}`;
  const packageEndpoint = `/orgs/bootstraplaboratory/packages/container/rush-delivery-acceptance-${"b".repeat(32)}%2Fcontrol-plane-api`;
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeGh,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >>"${GH_RECORD}"',
      'method="GET"',
      "for ((index = 1; index <= $#; index += 1)); do",
      "  if [[ ${!index} == --method ]]; then",
      "    method_index=$((index + 1))",
      '    method="${!method_index}"',
      "  fi",
      "done",
      'endpoint="${*: -1}"',
      "if [[ ${method} == DELETE ]]; then",
      "  printf 'HTTP/2 204 No Content\\n'",
      "  exit 0",
      "fi",
      'count="$(<"${GH_STATE}")"',
      "count=$((count + 1))",
      'printf "%s\\n" "${count}" >"${GH_STATE}"',
      "if ((count <= ${GH_READBACK_PRESENT_COUNT:-0})); then",
      "  printf 'HTTP/2 200 OK\\n'",
      "  exit 0",
      "fi",
      "[[ ${endpoint} == *control-plane-api ]] || exit 97",
      "printf 'HTTP/2 404 Not Found\\n'",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGh, 0o700);
  writeFileSync(fakeSleep, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeSleep, 0o700);

  try {
    writeFileSync(ghStatePath, "0\n");
    const stillPresent = spawnSync("bash", [cleanupScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "sentinel-github-token",
        GH_READBACK_PRESENT_COUNT: "5",
        GH_RECORD: ghRecordPath,
        GH_STATE: ghStatePath,
        OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES: "control-plane-api",
        OCI_ACCEPTANCE_CLEANUP_REGISTRY: "ghcr.io",
        OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX: namespace,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const stillPresentCalls = readFileSync(ghRecordPath, "utf8")
      .trim()
      .split("\n");

    assert.notEqual(stillPresent.status, 0);
    assert.equal(stillPresentCalls.length, 6);
    assert.equal(
      stillPresentCalls.filter((call) => call.includes("--method DELETE"))
        .length,
      1,
    );
    assert.equal(
      stillPresentCalls.filter((call) => call.includes("--method GET")).length,
      5,
    );
    for (const call of stillPresentCalls) {
      assert.match(call, /--hostname github\.com/);
      assert.match(call, /--header Accept: application\/vnd\.github\+json/);
      assert.match(call, /--header X-GitHub-Api-Version: 2022-11-28/);
      assert.ok(call.endsWith(packageEndpoint));
    }
    assert.equal(
      `${stillPresent.stdout}${stillPresent.stderr}`.includes(
        "sentinel-github-token",
      ),
      false,
    );
    assert.match(stillPresent.stderr, /could not prove.*absent/);

    writeFileSync(ghRecordPath, "");
    writeFileSync(ghStatePath, "0\n");
    const eventuallyAbsent = spawnSync("bash", [cleanupScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "sentinel-github-token",
        GH_READBACK_PRESENT_COUNT: "2",
        GH_RECORD: ghRecordPath,
        GH_STATE: ghStatePath,
        OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES: "control-plane-api",
        OCI_ACCEPTANCE_CLEANUP_REGISTRY: "ghcr.io",
        OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX: namespace,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(eventuallyAbsent.status, 0, eventuallyAbsent.stderr);
    assert.equal(
      readFileSync(ghRecordPath, "utf8").trim().split("\n").length,
      4,
    );

    const callsBeforeRejectedCoordinates = readFileSync(ghRecordPath, "utf8");
    const rejectedPrefix = spawnSync("bash", [cleanupScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "sentinel-github-token",
        GH_RECORD: ghRecordPath,
        GH_STATE: ghStatePath,
        OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES: "control-plane-api",
        OCI_ACCEPTANCE_CLEANUP_REGISTRY: "ghcr.io",
        OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX:
          "bootstraplaboratory/rush-delivery-acceptance",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const rejectedSuffix = spawnSync("bash", [cleanupScriptPath], {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "sentinel-github-token",
        GH_RECORD: ghRecordPath,
        GH_STATE: ghStatePath,
        OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES: "second-image",
        OCI_ACCEPTANCE_CLEANUP_REGISTRY: "ghcr.io",
        OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX: namespace,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(rejectedPrefix.status, 0);
    assert.notEqual(rejectedSuffix.status, 0);
    assert.equal(
      readFileSync(ghRecordPath, "utf8"),
      callsBeforeRejectedCoordinates,
    );

    writeFileSync(
      namespaceRecordPath,
      [
        "schema=rush-delivery-oci-acceptance-namespace/v1",
        "registry=ghcr.io",
        `repository_prefix=${namespace}`,
        "package_suffix=control-plane-api",
        "",
      ].join("\n"),
    );
    writeFileSync(ghRecordPath, "");
    writeFileSync(ghStatePath, "0\n");
    const recovery = spawnSync(
      "bash",
      [cleanupScriptPath, "--namespace-record", namespaceRecordPath],
      {
        encoding: "utf8",
        env: {
          GITHUB_TOKEN: "sentinel-github-token",
          GH_RECORD: ghRecordPath,
          GH_STATE: ghStatePath,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(
      readFileSync(ghRecordPath, "utf8").trim().split("\n").length,
      2,
    );

    writeFileSync(
      namespaceRecordPath,
      readFileSync(namespaceRecordPath, "utf8").replace(
        namespace,
        "bootstraplaboratory/rush-delivery",
      ),
    );
    writeFileSync(ghRecordPath, "");
    const rejectedRecord = spawnSync(
      "bash",
      [cleanupScriptPath, "--namespace-record", namespaceRecordPath],
      {
        encoding: "utf8",
        env: {
          GITHUB_TOKEN: "sentinel-github-token",
          GH_RECORD: ghRecordPath,
          GH_STATE: ghStatePath,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.notEqual(rejectedRecord.status, 0);
    assert.equal(readFileSync(ghRecordPath, "utf8"), "");

    const cleanupSource = readFileSync(cleanupScriptPath, "utf8");
    assert.match(cleanupSource, /GHCR_ACCEPTANCE_API_HOST=github\.com/);
    assert.match(cleanupSource, /GHCR_ACCEPTANCE_API_TIMEOUT_SECONDS=30/);
    assert.match(cleanupSource, /--kill-after=/);
    assert.match(cleanupSource, /--method DELETE/);
    assert.match(cleanupSource, /--method GET/);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance never retries mutating calls and independently verifies signed evidence", () => {
  const source = readFileSync(acceptanceScriptPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  const daggerSecuritySource = readFileSync(daggerSecurityScriptPath, "utf8");

  assert.equal(
    source.match(
      /dagger --progress=logs call build-and-package-deploy-targets/g,
    )?.length,
    1,
  );
  assert.equal(
    source.match(/dagger --silent call --json deploy-release/g)?.length,
    1,
  );
  assert.match(
    source,
    /oci_acceptance_run_with_timeout[\s\S]{0,500}dagger --progress=logs call build-and-package-deploy-targets/,
  );
  assert.doesNotMatch(
    source,
    /dagger --silent call build-and-package-deploy-targets/,
  );
  assert.match(daggerSecuritySource, /dagger --progress=logs -c/);
  assert.match(daggerSecuritySource, /dagger --silent -c/);
  assert.match(
    daggerSecuritySource,
    /with-secret-variable RUSH_DELIVERY_PROGRESS_SECRET/,
  );
  assert.match(
    daggerSecuritySource,
    /grep -Fq "\$\{DAGGER_PROGRESS_SECRET_SENTINEL\}"/,
  );
  assert.match(
    source,
    /oci_acceptance_run_with_timeout[\s\S]{0,500}dagger --silent call --json deploy-release/,
  );
  assert.match(source, /with-registry-auth.+from.+as-tarball/);
  assert.doesNotMatch(
    source,
    /oci_acceptance_retry_read[\s\S]{0,300}build-and-package-deploy-targets/,
  );
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:env [^\n]+ )?docker\s/m);
  assert.doesNotMatch(source, /\/var\/run\/docker\.sock/);
  assert.match(
    source,
    /if \[\[ \$\{github_project_mode\} == true \]\]; then\s+cleanup_github_token="\$\{GITHUB_TOKEN-\}"\s+fi\s+unset GITHUB_TOKEN/,
  );
  assert.match(source, /unset OCI_ACCEPTANCE_USERNAME OCI_ACCEPTANCE_TOKEN/);
  assert.match(
    source,
    /with-mounted-secret \/home\/nonroot\/\.docker\/config\.json.+secret file:/,
  );
  assert.match(
    source,
    /ghcr\.io\/sigstore\/cosign\/cosign@sha256:[a-f0-9]{64}/,
  );
  assert.match(
    source,
    /with-new-file \/tmp\/rush-delivery-key-generation-cache \$\{random_suffix\}/,
  );
  assert.equal(source.match(/--mode=256 --owner=65532:65532/g)?.length, 2);
  assert.match(source, /with-mounted-secret \/keys\/cosign\.pub.+secret file:/);
  assert.match(
    source,
    /cosign,verify,--key,\/keys\/cosign\.pub,--insecure-ignore-tlog/,
  );
  assert.match(source, /cosign,verify-attestation.+--type,spdxjson/);
  assert.match(source, /cosign,verify-attestation.+--type,slsaprovenance1/);
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4[\s\S]+rush-delivery-oci-acceptance-diagnostic\.txt/,
  );
  assert.match(
    workflow,
    /live-oci:\s+runs-on: ubuntu-latest\s+timeout-minutes: 120/,
  );
  assert.match(
    workflow,
    /OCI_ACCEPTANCE_NAMESPACE_RECORD_PATH: \$\{\{ runner\.temp \}\}\/rush-delivery-oci-acceptance-namespace\.txt/,
  );
  assert.match(
    workflow,
    /Recover project-controlled GHCR acceptance namespace\s+if: \$\{\{ always\(\) \}\}[\s\S]+cleanup-ghcr-acceptance\.sh[\s\S]+--namespace-record/,
  );
  assert.match(
    workflow,
    /Recover every registered v0\.8\.1 GHCR matrix namespace\s+if: \$\{\{ always\(\) \}\}[\s\S]+timeout --signal=TERM --kill-after=10s 300s[\s\S]+cleanup-ghcr-v081-acceptance\.sh[\s\S]+--namespace-record/,
  );
  assert.match(
    workflow,
    /name: rush-delivery-v081-live-matrix-evidence[\s\S]+include-hidden-files: true/,
  );
  assert.match(
    workflow,
    /path: \|[\s\S]+rush-delivery-oci-acceptance-diagnostic\.txt[\s\S]+rush-delivery-oci-acceptance-namespace\.txt/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6[\s\S]{0,100}node-version: 24\.15\.0/,
  );
  assert.ok(
    workflow.indexOf(
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    ) < workflow.indexOf("Run project-controlled GHCR acceptance"),
  );
  assert.match(workflow, /npm run test:dagger-security-engine/);
  assert.match(workflow, /yarn install --frozen-lockfile/);
  assert.match(
    source,
    /oci_acceptance_node_runtime_ready[\s\S]{0,180}pinned Node\.js 24 with built-in zstd support is required/,
  );
  assert.match(source, /oci_acceptance_write_namespace_record/);
  assert.ok(
    source.indexOf(
      'oci_acceptance_classify_failure_stage "${acceptance_log}"',
    ) < source.indexOf('assert_protected_capture \\\n\t"${acceptance_log}"'),
  );
  assert.doesNotMatch(workflow, /acceptance\.log|deploy\.log|docker-config/);
});

test("OCI acceptance verifier enforces the bundle, image, and Deploy contracts without echoing sentinels", async () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "rush-delivery-acceptance-verifier-"),
  );
  const outputDirectory = path.join(tempDirectory, "output");
  const evidenceDirectory = path.join(
    outputDirectory,
    ".dagger/runtime/evidence/control-plane-api",
  );
  const manifestDirectory = path.join(outputDirectory, ".dagger/runtime");
  const protectedValuesFile = path.join(tempDirectory, "protected.env");
  const dockerConfigFile = path.join(tempDirectory, "docker-config.json");
  const imageTarball = path.join(tempDirectory, "image.tar");
  const deployResultFile = path.join(tempDirectory, "deploy-result.json");
  const gitSha = "0123456789abcdef0123456789abcdef01234567";
  const safeImageArchive = createOciImageArchive(
    "safe image payload\n",
    "gzip",
  );
  const imageDigest = safeImageArchive.manifestDigest;
  const repository = "registry.example/acceptance/run/control-plane-api";
  const reference = `${repository}@${imageDigest}`;
  const username = `acceptance-user-${process.pid}`;
  const token = `protected-token-${process.pid}-${Date.now()}`;
  const basicAuth = Buffer.from(`${username}:${token}`, "utf8").toString(
    "base64",
  );
  const dockerConfig = `${JSON.stringify({
    auths: { "registry.example": { auth: basicAuth } },
  })}\n`;
  const encodedDockerConfig = Buffer.from(dockerConfig, "utf8").toString(
    "base64",
  );
  const sbom = '{"spdxVersion":"SPDX-2.3"}\n';
  const scan = '{"matches":[]}\n';
  const provenance = `${JSON.stringify({
    buildDefinition: {
      buildType:
        "https://bootstraplaboratory.github.io/rush-delivery/build-types/oci-image/v0.8.1",
      resolvedDependencies: [{ digest: { gitCommit: gitSha } }],
    },
    runDetails: {
      builder: {
        id: "https://github.com/BootstrapLaboratory/rush-delivery@v0.8.1",
      },
      metadata: { invocationId: `control-plane-api:${gitSha}:${imageDigest}` },
    },
  })}\n`;
  const manifest = {
    artifacts: {
      "control-plane-api": {
        digest: imageDigest,
        evidence: {
          provenance: {
            digest: sha256(provenance),
            format: "slsa-provenance-v1",
            path: ".dagger/runtime/evidence/control-plane-api/provenance.json",
            subject_digest: imageDigest,
          },
          sbom: {
            digest: sha256(sbom),
            format: "spdx-json",
            path: ".dagger/runtime/evidence/control-plane-api/sbom.spdx.json",
            subject_digest: imageDigest,
          },
          scan: {
            digest: sha256(scan),
            path: ".dagger/runtime/evidence/control-plane-api/scan.json",
            policy: ["high", "critical"],
            result: "passed",
            scanner: "grype-0.116.1",
          },
          signature: {
            kind: "sigstore",
            reference,
            verified: true,
          },
        },
        image: "control-plane-api",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        reference,
        repository,
        source_revision: gitSha,
        status: "published",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };
  const deployResult = {
    dryRun: false,
    environment: "acceptance",
    plan: {
      selectedTargets: ["control-plane-api"],
      waves: [[{ target: "control-plane-api" }]],
    },
    results: [
      {
        artifactImage: "control-plane-api",
        artifactKind: "oci_image",
        artifactReference: reference,
        output: `control-plane-api accepted immutable image: ${reference}\n`,
        status: "success",
        target: "control-plane-api",
        wave: 1,
      },
    ],
  };

  mkdirSync(evidenceDirectory, { recursive: true });
  mkdirSync(manifestDirectory, { recursive: true });
  writeFileSync(path.join(evidenceDirectory, "sbom.spdx.json"), sbom);
  writeFileSync(path.join(evidenceDirectory, "scan.json"), scan);
  writeFileSync(path.join(evidenceDirectory, "provenance.json"), provenance);
  writeFileSync(
    path.join(manifestDirectory, "package-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(path.join(outputDirectory, "safe.txt"), "safe\n");
  writeFileSync(
    protectedValuesFile,
    `RD_OCI_GHCR_USERNAME=${username}\nRD_OCI_GHCR_TOKEN=${token}\n`,
  );
  writeFileSync(dockerConfigFile, dockerConfig, { mode: 0o600 });
  writeFileSync(imageTarball, safeImageArchive.archive);
  writeFileSync(
    deployResultFile,
    `${JSON.stringify(JSON.stringify(deployResult, null, 2))}\n`,
  );

  try {
    const success = spawnSync(
      process.execPath,
      [
        verifierPath,
        outputDirectory,
        gitSha,
        protectedValuesFile,
        repository,
        imageTarball,
        deployResultFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const successOutput = `${success.stdout}${success.stderr}`;
    assert.equal(successOutput.includes(token), false);
    assert.equal(successOutput.includes(basicAuth), false);
    assert.equal(successOutput.includes(encodedDockerConfig), false);
    assert.equal(success.status, 0);
    assert.match(success.stdout, /signed evidence and digest-only Deploy/);

    const wrongImageArchive = createOciImageArchive(
      "different safe image payload\n",
      "zstd",
    );
    writeFileSync(imageTarball, wrongImageArchive.archive);
    const rejectedWrongImage = spawnSync(
      process.execPath,
      [
        verifierPath,
        outputDirectory,
        gitSha,
        protectedValuesFile,
        repository,
        imageTarball,
        deployResultFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const wrongImageOutput = `${rejectedWrongImage.stdout}${rejectedWrongImage.stderr}`;

    assert.notEqual(rejectedWrongImage.status, 0);
    assert.equal(wrongImageOutput.includes(token), false);
    assert.match(wrongImageOutput, /does not bind the published digest/);
    writeFileSync(imageTarball, safeImageArchive.archive);

    writeFileSync(path.join(outputDirectory, "safe.txt"), `${token}\n`);
    const rejected = spawnSync(
      process.execPath,
      [
        verifierPath,
        outputDirectory,
        gitSha,
        protectedValuesFile,
        repository,
        imageTarball,
        deployResultFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const combined = `${rejected.stdout}${rejected.stderr}`;

    assert.notEqual(rejected.status, 0);
    assert.equal(combined.includes(token), false);
    assert.match(combined, /package bundle contains a credential sentinel/);

    writeFileSync(path.join(outputDirectory, "safe.txt"), `${basicAuth}\n`);
    const rejectedBasicAuth = spawnSync(
      process.execPath,
      [
        verifierPath,
        outputDirectory,
        gitSha,
        protectedValuesFile,
        repository,
        imageTarball,
        deployResultFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const basicAuthOutput = `${rejectedBasicAuth.stdout}${rejectedBasicAuth.stderr}`;

    assert.notEqual(rejectedBasicAuth.status, 0);
    assert.equal(basicAuthOutput.includes(basicAuth), false);
    assert.equal(basicAuthOutput.includes(token), false);

    writeFileSync(
      path.join(outputDirectory, "safe.txt"),
      `${encodedDockerConfig}\n`,
    );
    const rejectedDockerConfig = spawnSync(
      process.execPath,
      [
        verifierPath,
        outputDirectory,
        gitSha,
        protectedValuesFile,
        repository,
        imageTarball,
        deployResultFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const dockerConfigOutput = `${rejectedDockerConfig.stdout}${rejectedDockerConfig.stderr}`;

    assert.notEqual(rejectedDockerConfig.status, 0);
    assert.equal(dockerConfigOutput.includes(encodedDockerConfig), false);
    assert.equal(dockerConfigOutput.includes(token), false);

    writeFileSync(path.join(outputDirectory, "safe.txt"), "safe\n");
    const protectedHistoryArchive = createOciImageArchive(
      "safe image payload\n",
      "gzip",
      token,
    );
    writeFileSync(imageTarball, protectedHistoryArchive.archive);
    const rejectedHistory = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--assert-image-protected-absent",
        imageTarball,
        protectedValuesFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const historyOutput = `${rejectedHistory.stdout}${rejectedHistory.stderr}`;

    assert.notEqual(rejectedHistory.status, 0);
    assert.equal(historyOutput.includes(token), false);
    assert.match(
      historyOutput,
      /image config\/history contains a credential sentinel/,
    );

    for (const compression of ["gzip", "zstd"] as const) {
      const protectedLayerArchive = createOciImageArchive(
        `${token}\n`,
        compression,
      );
      writeFileSync(imageTarball, protectedLayerArchive.archive);
      const rejectedLayer = spawnSync(
        process.execPath,
        [
          verifierPath,
          "--assert-image-protected-absent",
          imageTarball,
          protectedValuesFile,
          dockerConfigFile,
        ],
        { encoding: "utf8" },
      );
      const layerOutput = `${rejectedLayer.stdout}${rejectedLayer.stderr}`;

      assert.notEqual(rejectedLayer.status, 0, compression);
      assert.equal(layerOutput.includes(token), false, compression);
      assert.match(
        layerOutput,
        /image filesystem contains a credential sentinel/,
        compression,
      );
    }

    writeFileSync(imageTarball, `${basicAuth}\n`);
    const rejectedCapturedOutput = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--assert-protected-absent",
        imageTarball,
        protectedValuesFile,
        dockerConfigFile,
      ],
      { encoding: "utf8" },
    );
    const capturedOutput = `${rejectedCapturedOutput.stdout}${rejectedCapturedOutput.stderr}`;

    assert.notEqual(rejectedCapturedOutput.status, 0);
    assert.equal(capturedOutput.includes(basicAuth), false);
    assert.equal(capturedOutput.includes(token), false);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});
