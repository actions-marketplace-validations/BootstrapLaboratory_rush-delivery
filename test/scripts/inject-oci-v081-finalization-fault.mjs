#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";

const [sourcePath, target] = process.argv.slice(2);

if (!sourcePath || target !== "matrix-worker") {
  throw new Error(
    "Finalization fault injection requires the fixed matrix-worker target.",
  );
}

const source = await readFile(sourcePath, "utf8");
const anchor = ["  let provenance: File;"].join("\n");
const injection = [
  "  // Private v0.8.1 live-acceptance fault: the subject is already published.",
  '  if (prepared.target === "matrix-worker") {',
  "    throw new OciPackageOperationError(",
  '      "injected post-publication acceptance failure",',
  "      published.reference,",
  "    );",
  "  }",
  "",
  anchor,
].join("\n");
const occurrences = source.split(anchor).length - 1;

if (
  occurrences !== 1 ||
  source.includes("Private v0.8.1 live-acceptance fault")
) {
  throw new Error("Finalization fault injection source anchor is not exact.");
}

const temporaryPath = `${sourcePath}.v081-fault-patch`;
await writeFile(temporaryPath, source.replace(anchor, injection), {
  encoding: "utf8",
  flag: "wx",
  mode: 0o644,
});
await rename(temporaryPath, sourcePath);
