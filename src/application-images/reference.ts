import type { OciRegistryProviderDefinition } from "../model/application-image.ts";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FULL_GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export type PublishedImageReference = {
  digest: string;
  reference: string;
  repository: string;
  tagReference: string;
};

export function buildApplicationImageRepository(
  provider: OciRegistryProviderDefinition,
  image: string,
): string {
  return `${provider.registry}/${provider.repository_prefix}/${image}`;
}

export function buildApplicationImageTagReference(
  repository: string,
  gitSha: string,
): string {
  if (!FULL_GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error(
      "Application image publication requires a full lowercase Git commit SHA.",
    );
  }

  return `${repository}:sha-${gitSha}`;
}

export function normalizePublishedImageReference(
  repository: string,
  tagReference: string,
  publishedReference: string,
): PublishedImageReference {
  const separator = publishedReference.lastIndexOf("@");

  if (separator === -1) {
    throw new Error(
      `OCI registry publication returned mutable reference "${publishedReference}" without a digest.`,
    );
  }

  const publishedName = publishedReference.slice(0, separator);
  const digest = publishedReference.slice(separator + 1);

  if (publishedName !== repository && publishedName !== tagReference) {
    throw new Error(
      `OCI registry publication returned unexpected repository "${publishedName}".`,
    );
  }

  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `OCI registry publication returned malformed digest "${digest}".`,
    );
  }

  return {
    digest,
    reference: `${repository}@${digest}`,
    repository,
    tagReference,
  };
}
