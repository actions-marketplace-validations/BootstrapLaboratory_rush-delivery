---
title: "Local Dry Runs"
sidebar_label: "Local Dry Runs"
---

CI should usually use Git source mode. Local development often needs a different
path because your latest changes may not be pushed yet. For that, use the
checksummed `rush-delivery-local` launcher described in the
[bounded local-copy guide](../../local-copy-source-imports).

## Workflow Dry Run

Run the full workflow without publishing provider artifacts or deploying:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='[]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off
```

Provider-off local runs are slower than provider-backed CI, but they are simple
and safe. They do not need GHCR permissions.

## Targeted Dry Run

To exercise one target, force it:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='["server"]' \
  --environment=prod \
  --dry-run=true
```

Dry-run defaults from deploy target metadata supply harmless values for missing
runtime env.
If the target is an OCI image, provider `off` reports the planned relative image
and platform without requiring or resolving provider credentials or producing a
digest. A supplied aggregate env file is still parsed for other configured
capabilities, so omit live OCI values from dry-run calls.

## Local PR-Style Validation

To validate local changes against your main branch:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- validate \
  --event-name=pull_request \
  --pr-base-sha="$(git merge-base HEAD origin/main)"
```

This is useful before opening a PR or when debugging validation target metadata.

## Package Release Dry Run

To test npm release metadata inside the composed workflow without publishing:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --release-targets-json='["npm"]' \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

To test only the standalone npm release entrypoint:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- release-packages \
  --git-sha="$(git rev-parse HEAD)" \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

This path reads `.dagger/release/npm.yaml` and runs the release build
lifecycle. It does not require `NPM_TOKEN`, does not push a version commit, and
does not publish packages.

## When To Use Provider-Backed Local Runs

Provider-backed local runs are possible, but they need the same env values as
CI. Start with provider-off dry-runs unless you are specifically debugging
provider metadata, GHCR access, or cache behavior.

## Checklist

- Use the version-matched, checksummed launcher for unpushed changes.
- Keep bounded imports and add only narrow required inclusions.
- Use `--dry-run=true` while developing deploy metadata.
- Use `release-packages --dry-run=true` while developing package release
  metadata.
- Use provider-off settings first.
- Use forced targets to shorten feedback loops.

Next: [Adapt To Your Project](../adapting-to-your-project).
