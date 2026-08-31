export type OciPackageOperation<T> = {
  run: () => Promise<T>;
  target: string;
};

export type OciPackageFinalization<T> = {
  publishedReference: string;
  result: T;
};

export type OciPackageBatchOperation<TPrepared, TResult> = {
  finalize: (prepared: TPrepared) => Promise<OciPackageFinalization<TResult>>;
  prepare: () => Promise<TPrepared>;
  target: string;
};

export const OCI_PUBLICATION_BOUNDARY_MESSAGE =
  "[package] OCI publication boundary crossed; ordered finalization is starting.";

export class OciPackageOperationError extends Error {
  readonly publishedReference?: string;
  readonly stage: string;

  constructor(stage: string, publishedReference?: string) {
    super(`OCI package operation failed during ${stage}.`);
    this.name = "OciPackageOperationError";
    this.stage = stage;
    this.publishedReference = publishedReference;
  }
}

function operationStage(error: unknown, fallback: string): string {
  return error instanceof OciPackageOperationError ? error.stage : fallback;
}

function operationPublishedReference(error: unknown): string | undefined {
  return error instanceof OciPackageOperationError
    ? error.publishedReference
    : undefined;
}

export async function collectOciPackageResults<T>(
  operations: OciPackageOperation<T>[],
): Promise<Array<{ result: T; target: string }>> {
  const settled = await Promise.allSettled(
    operations.map(async ({ run, target }) => ({
      result: await run(),
      target,
    })),
  );
  const failures: string[] = [];
  const results: Array<{ result: T; target: string }> = [];

  for (const [index, outcome] of settled.entries()) {
    const target = operations[index].target;

    if (outcome.status === "rejected") {
      failures.push(
        `OCI package target "${target}" failed during ${operationStage(outcome.reason, "preparation")}.`,
      );
    } else {
      results.push(outcome.value);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      ["OCI application image preparation failed:", ...failures].join("\n"),
    );
  }

  return results;
}

export async function finalizeOciPackageResults<T>(
  operations: OciPackageOperation<OciPackageFinalization<T>>[],
): Promise<Array<{ result: T; target: string }>> {
  const completed: Array<{ publishedReference: string; target: string }> = [];
  const results: Array<{ result: T; target: string }> = [];

  for (const [index, operation] of operations.entries()) {
    try {
      const finalized = await operation.run();
      completed.push({
        publishedReference: finalized.publishedReference,
        target: operation.target,
      });
      results.push({ result: finalized.result, target: operation.target });
    } catch (error) {
      const failedReference = operationPublishedReference(error);
      const lines = [
        "OCI application image finalization failed:",
        `OCI package target "${operation.target}" failed during ${operationStage(error, "finalization")}.`,
        ...completed.map(
          ({ publishedReference, target }) =>
            `Earlier published target "${target}": ${publishedReference}`,
        ),
        ...(failedReference === undefined
          ? []
          : [
              `Failed target "${operation.target}" published reference: ${failedReference}`,
            ]),
        ...operations
          .slice(index + 1)
          .map(({ target }) => `Later target "${target}" was not started.`),
        "OCI publication is nontransactional. Inspect the registry and clean up any published digest, signature, and attestation artifacts before retrying.",
      ];

      throw new Error(lines.join("\n"));
    }
  }

  return results;
}

export async function executeOciPackageBatch<TPrepared, TResult>(
  operations: OciPackageBatchOperation<TPrepared, TResult>[],
  preflight: () => Promise<void>,
  publicationBoundary: () => void = () => undefined,
): Promise<Array<{ result: TResult; target: string }>> {
  if (operations.length === 0) {
    return [];
  }

  await preflight();
  const prepared = await collectOciPackageResults(
    operations.map(({ prepare, target }) => ({ run: prepare, target })),
  );
  publicationBoundary();

  return finalizeOciPackageResults(
    prepared.map(({ result, target }, index) => ({
      run: () => operations[index].finalize(result),
      target,
    })),
  );
}
