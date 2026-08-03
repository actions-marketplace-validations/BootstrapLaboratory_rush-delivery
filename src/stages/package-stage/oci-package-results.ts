export type OciPackageOperation<T> = {
  run: () => Promise<T>;
  target: string;
};

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
        `OCI package target "${target}" failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
      );
    } else {
      results.push(outcome.value);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      ["OCI application image packaging failed:", ...failures].join("\n"),
    );
  }

  return results;
}
