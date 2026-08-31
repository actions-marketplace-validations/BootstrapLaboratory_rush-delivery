---
title: "Provider Artifacts"
sidebar_label: "Provider Artifacts"
---

Provider artifacts are the reusable pieces that make Rush Delivery fast in CI:

- toolchain images
- Rush install cache

The example stores both in GitHub Container Registry through metadata in:

- [`.dagger/toolchain-images/providers.yaml`](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk/blob/main/.dagger/toolchain-images/providers.yaml)
- [`.dagger/rush-cache/providers.yaml`](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk/blob/main/.dagger/rush-cache/providers.yaml)

## Toolchain Images

Toolchain images are built from runtime metadata. For example, the Rush workflow
toolchain contains Node and Git, while deploy target toolchains can include
cloud CLIs, Docker CLI, or other deploy tools.

The metadata points Rush Delivery at GHCR:

```yaml
providers:
  github:
    kind: github_container_registry
    registry: ghcr.io
    image_namespace: rush-delivery-toolchains
    repository_env: GITHUB_REPOSITORY
    token_env: GITHUB_TOKEN
    username_env: GITHUB_ACTOR
```

Rush Delivery derives content-addressed tags from the normalized toolchain spec.
Changing install commands, base image, or runtime identity creates a different
tag.

## Rush Install Cache

The Rush cache stores selected install directories in a compressed OCI image.
The cache identity is a stable project snapshot, controlled by `cache.version`:

```yaml
cache:
  version: v1
  paths:
    - common/temp/install-run
    - common/temp/node_modules
    - common/temp/pnpm-store
```

Rush Delivery restores the `v1` snapshot when it exists, runs `rush install`,
and lets Rush reconcile lockfile or package-manager changes. If you want to
discard the old snapshot intentionally, bump `version` to a new OCI tag such as
`v2`.

## Policies

Use different policies for pull requests and trusted release workflows.

For pull requests:

```yaml
permissions:
  contents: read
  packages: read

with:
  entrypoint: validate
  toolchain-image-provider: github
  toolchain-image-policy: pull-or-build
  rush-cache-provider: github
  rush-cache-policy: pull-or-build
```

`pull-or-build` pulls existing artifacts. On miss, it builds or installs
locally and does not publish. This keeps PRs read-only.

For trusted release workflows:

```yaml
permissions:
  contents: write
  packages: write

with:
  toolchain-image-provider: github
  rush-cache-provider: github
```

`lazy` is the trusted workflow policy. Toolchain images are published when they
are missing. Rush cache is restored when available, then the post-install cache
is published after a successful install.

## Checklist

- Configure provider metadata in `.dagger`.
- Pass `GITHUB_ACTOR`, `GITHUB_REPOSITORY`, and `GITHUB_TOKEN` through CI env.
- Use `packages: read` for PR validation.
- Use `packages: write` only in trusted workflows.
- Bump `cache.version` only when you intentionally want a fresh Rush install
  cache snapshot.

Next: [Package Targets](../package-targets).
