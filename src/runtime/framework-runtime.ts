import type { Directory, ExistsType } from "@dagger.io/dagger";

const DIRECTORY_TYPE = "DIRECTORY_TYPE" as ExistsType;
const REGULAR_TYPE = "REGULAR_TYPE" as ExistsType;
const SYMLINK_TYPE = "SYMLINK_TYPE" as ExistsType;

export const FRAMEWORK_METADATA_PATH = ".dagger";
export const FRAMEWORK_RUNTIME_PATH = `${FRAMEWORK_METADATA_PATH}/runtime`;
export const FRAMEWORK_EVIDENCE_PATH = `${FRAMEWORK_RUNTIME_PATH}/evidence`;

async function withoutPath(
  directory: Directory,
  path: string,
): Promise<Directory> {
  if (
    await directory.exists(path, {
      doNotFollowSymlinks: true,
      expectedType: DIRECTORY_TYPE,
    })
  ) {
    return directory.withoutDirectory(path);
  }

  if (
    (await directory.exists(path, {
      doNotFollowSymlinks: true,
      expectedType: REGULAR_TYPE,
    })) ||
    (await directory.exists(path, {
      doNotFollowSymlinks: true,
      expectedType: SYMLINK_TYPE,
    }))
  ) {
    return directory.withoutFile(path);
  }

  return directory;
}

async function requireFrameworkMetadataDirectory(
  repo: Directory,
  rejectSymlink: boolean,
): Promise<Directory> {
  if (
    rejectSymlink &&
    (await repo.exists(FRAMEWORK_METADATA_PATH, {
      doNotFollowSymlinks: true,
      expectedType: SYMLINK_TYPE,
    }))
  ) {
    throw new Error(
      `Rush Delivery metadata path "${FRAMEWORK_METADATA_PATH}" must not be a symbolic link.`,
    );
  }

  if (
    !(await repo.exists(FRAMEWORK_METADATA_PATH, {
      expectedType: DIRECTORY_TYPE,
    }))
  ) {
    throw new Error(
      `Rush Delivery metadata path "${FRAMEWORK_METADATA_PATH}" must resolve to a directory.`,
    );
  }

  return repo.directory(FRAMEWORK_METADATA_PATH);
}

/**
 * Materializes the packaged metadata directory and starts with an empty
 * framework runtime directory.
 *
 * Materializing the post-Build metadata subtree through `withDirectory`
 * preserves project-owned build outputs below `.dagger` while making
 * `.dagger` concrete. Removing `runtime` before any new write makes the
 * framework-owned runtime concrete as well and prevents a caller-controlled
 * symlink from redirecting manifests, credential capabilities, or evidence.
 */
export async function canonicalizeFrameworkRuntime(
  _frameworkMetadataRepo: Directory,
  outputRepo: Directory,
): Promise<Directory> {
  const metadata = await withoutPath(
    await requireFrameworkMetadataDirectory(outputRepo, false),
    "runtime",
  );
  const outputWithoutMetadata = await withoutPath(
    outputRepo,
    FRAMEWORK_METADATA_PATH,
  );

  return outputWithoutMetadata.withDirectory(FRAMEWORK_METADATA_PATH, metadata);
}

/**
 * Rejects framework-owned runtime paths that are symbolic links.
 *
 * Package replaces these paths with concrete directories before writing a new
 * bundle. Deploy treats an already supplied bundle as immutable and therefore
 * fails closed instead of following an alias into another project directory.
 */
async function inspectFrameworkRuntimePaths(
  repo: Directory,
): Promise<{ metadata: Directory; runtime?: Directory }> {
  const metadata = await requireFrameworkMetadataDirectory(repo, true);

  if (
    await metadata.exists("runtime", {
      doNotFollowSymlinks: true,
      expectedType: SYMLINK_TYPE,
    })
  ) {
    throw new Error(
      `Rush Delivery runtime path "${FRAMEWORK_RUNTIME_PATH}" must not be a symbolic link.`,
    );
  }

  if (
    !(await metadata.exists("runtime", {
      expectedType: DIRECTORY_TYPE,
    }))
  ) {
    return { metadata };
  }

  const runtime = metadata.directory("runtime");

  if (
    await runtime.exists("evidence", {
      doNotFollowSymlinks: true,
      expectedType: SYMLINK_TYPE,
    })
  ) {
    throw new Error(
      `Rush Delivery evidence path "${FRAMEWORK_EVIDENCE_PATH}" must not be a symbolic link.`,
    );
  }

  return { metadata, runtime };
}

export async function assertFrameworkRuntimePathsAreCanonical(
  repo: Directory,
): Promise<void> {
  await inspectFrameworkRuntimePaths(repo);
}

/**
 * Removes framework evidence while rebuilding its ancestor directories as
 * concrete directories. This prevents a `.dagger` or `.dagger/runtime`
 * symlink from bypassing evidence filtering in a Deploy workspace.
 */
export async function withoutFrameworkEvidence(
  repo: Directory,
): Promise<Directory> {
  const { metadata, runtime } = await inspectFrameworkRuntimePaths(repo);

  const metadataWithoutRuntime = await withoutPath(metadata, "runtime");
  const outputWithoutMetadata = await withoutPath(
    repo,
    FRAMEWORK_METADATA_PATH,
  );

  if (runtime === undefined) {
    return outputWithoutMetadata.withDirectory(
      FRAMEWORK_METADATA_PATH,
      metadataWithoutRuntime,
    );
  }

  const runtimeWithoutEvidence = await withoutPath(runtime, "evidence");
  const canonicalMetadata = metadataWithoutRuntime.withDirectory(
    "runtime",
    runtimeWithoutEvidence,
  );

  return outputWithoutMetadata.withDirectory(
    FRAMEWORK_METADATA_PATH,
    canonicalMetadata,
  );
}
