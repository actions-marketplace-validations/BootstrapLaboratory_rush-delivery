import { randomUUID } from "node:crypto";

import type { Container } from "@dagger.io/dagger";

const CACHE_BUSTER_ROOT = "/tmp/rush-delivery-execution";

export function withFreshExecutionCache(
  container: Container,
  operation: string,
): Container {
  if (!/^[a-z0-9-]+$/.test(operation)) {
    throw new Error("Execution cache-buster operation name is invalid.");
  }

  return container.withNewFile(
    `${CACHE_BUSTER_ROOT}/${operation}`,
    `${randomUUID()}\n`,
  );
}
