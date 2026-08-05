import {
  chmod,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(projectDirectory, "src/payload.txt");
const outputDirectory = path.join(projectDirectory, "dist");
const outputPath = path.join(outputDirectory, "payload.txt");
const outputMode = 0o644;
const outputTimestamp = new Date("2000-01-01T00:00:00.000Z");
const providerEnvironmentNames = [
  "RD_OCI_GHCR_USERNAME",
  "RD_OCI_GHCR_TOKEN",
  "RD_OCI_COSIGN_PRIVATE_KEY",
  "RD_OCI_COSIGN_PASSWORD",
  "RD_OCI_COSIGN_PUBLIC_KEY",
];

for (const name of providerEnvironmentNames) {
  if (Object.hasOwn(process.env, name)) {
    throw new Error(
      `Tutorial Rush Build received framework-owned provider environment name ${name}.`,
    );
  }
}

const source = await readFile(sourcePath, "utf8");

if (process.argv.includes("--check")) {
  const output = await readFile(outputPath, "utf8");
  const outputStats = await stat(outputPath);

  if (output !== source) {
    throw new Error("Built tutorial payload does not match its source.");
  }
  if ((outputStats.mode & 0o777) !== outputMode) {
    throw new Error("Built tutorial payload does not have mode 0644.");
  }
  if (outputStats.mtimeMs !== outputTimestamp.getTime()) {
    throw new Error(
      "Built tutorial payload does not have its fixed timestamp.",
    );
  }

  process.stdout.write("Deterministic tutorial payload verified.\n");
} else {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, source, { encoding: "utf8", mode: outputMode });
  await chmod(outputPath, outputMode);
  await utimes(outputPath, outputTimestamp, outputTimestamp);
  process.stdout.write("Deterministic tutorial payload built.\n");
}
