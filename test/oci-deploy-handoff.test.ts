import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testDirectory, "fixtures/oci-rush-repo");
const digest = `sha256:${"a".repeat(64)}`;
const reference = `registry.example/example/control-plane-api@${digest}`;

test("provider-shaped scripts consume only digest and evidence handoff", async () => {
  const evidenceDirectory = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-evidence-"),
  );

  try {
    await Promise.all(
      ["sbom.spdx.json", "scan.json", "provenance.json"].map((fileName) =>
        writeFile(path.join(evidenceDirectory, fileName), "{}\n", "utf8"),
      ),
    );

    for (const scriptName of ["cloud-run.sh", "swarm.sh", "kubernetes.sh"]) {
      const { stdout } = await execFileAsync(
        "bash",
        [path.join(fixtureRoot, "deploy", scriptName)],
        {
          env: {
            ARTIFACT_EVIDENCE_DIR: evidenceDirectory,
            ARTIFACT_IMAGE_DIGEST: digest,
            ARTIFACT_IMAGE_REFERENCE: reference,
            PATH: process.env.PATH,
          },
        },
      );

      assert.match(stdout, /digest handoff verified/);
      assert.match(stdout, new RegExp(`${digest}$`, "m"));
    }
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
});
