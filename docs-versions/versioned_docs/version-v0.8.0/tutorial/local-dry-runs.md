---
title: "Local Dry Runs"
sidebar_label: "Local Dry Runs"
---

CI should usually use Git source mode. Local development often needs a different
path because your latest changes may not be pushed yet. For that, pass the
working tree with `--repo=.` and use `source-mode=local_copy`.

## Workflow Dry Run

Run the full workflow without publishing provider artifacts or deploying:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.8.0 call workflow \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='[]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off \
  --source-mode=local_copy
```

Provider-off local runs are slower than provider-backed CI, but they are simple
and safe. They do not need GHCR permissions.

## Targeted Dry Run

To exercise one target, force it:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.8.0 call workflow \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='["server"]' \
  --environment=prod \
  --dry-run=true \
  --source-mode=local_copy
```

Dry-run defaults from deploy target metadata supply harmless values for missing
runtime env.
If the target is an OCI image, provider `off` reports the planned relative image
and platform without reading credentials or producing a digest.

## Local PR-Style Validation

To validate local changes against your main branch:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.8.0 call validate \
  --repo=. \
  --event-name=pull_request \
  --pr-base-sha="$(git merge-base HEAD origin/main)" \
  --source-mode=local_copy
```

This is useful before opening a PR or when debugging validation target metadata.

## Package Release Dry Run

To test npm release metadata inside the composed workflow without publishing:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.8.0 call workflow \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --release-targets-json='["npm"]' \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --source-mode=local_copy
```

To test only the standalone npm release entrypoint:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.8.0 call release-packages \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --source-mode=local_copy
```

This path reads `.dagger/release/npm.yaml` and runs the release build
lifecycle. It does not require `NPM_TOKEN`, does not push a version commit, and
does not publish packages.

## When To Use Provider-Backed Local Runs

Provider-backed local runs are possible, but they need the same env values as
CI. Start with provider-off dry-runs unless you are specifically debugging
provider metadata, GHCR access, or cache behavior.

## Checklist

- Use `--repo=.` for unpushed changes.
- Use `--source-mode=local_copy` with local runs.
- Use `--dry-run=true` while developing deploy metadata.
- Use `release-packages --dry-run=true` while developing package release
  metadata.
- Use provider-off settings first.
- Use forced targets to shorten feedback loops.

Next: [Adapt To Your Project](../adapting-to-your-project).
