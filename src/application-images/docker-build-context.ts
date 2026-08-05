import path from "node:path";

function assertNormalizedRepositoryPath(
  value: string,
  label: string,
  allowRepositoryRoot: boolean,
): void {
  if (allowRepositoryRoot && value === ".") {
    return;
  }

  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(
      `OCI image ${label} must be a normalized repository-relative path.`,
    );
  }
}

export function dockerfilePathInsideBuildContext(
  context: string,
  dockerfile: string,
): string {
  assertNormalizedRepositoryPath(context, "build context", true);
  assertNormalizedRepositoryPath(dockerfile, "Dockerfile", false);

  const relativeDockerfile =
    context === "." ? dockerfile : path.posix.relative(context, dockerfile);

  if (
    relativeDockerfile.length === 0 ||
    relativeDockerfile === "." ||
    relativeDockerfile === ".." ||
    relativeDockerfile.startsWith("../") ||
    path.posix.isAbsolute(relativeDockerfile)
  ) {
    throw new Error("OCI image Dockerfile must stay inside its build context.");
  }

  return relativeDockerfile;
}
