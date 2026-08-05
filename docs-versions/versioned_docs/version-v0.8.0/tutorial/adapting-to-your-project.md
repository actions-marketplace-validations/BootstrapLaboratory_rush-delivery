---
title: "Adapt To Your Project"
sidebar_label: "Adapt To Your Project"
---

The example repository is intentionally concrete, but your project does not
need to copy its cloud providers or application stack. Copy the contracts and
adapt the details.

## Choose Target Names

Start with the deployable things in your product:

- `api`
- `worker`
- `webapp`
- `admin`
- `docs`
- `migrations`

Use the same names consistently across `.dagger/deploy`,
`.dagger/package`, and `.dagger/validate` where those targets exist.

## Choose Package Shapes

Use `rush_deploy_archive` when the target needs a runtime bundle with package
dependencies. Backend services often fit this shape.

Use `directory` when the target already builds to a deployable directory.
Static sites and frontend assets often fit this shape.

## Choose Deploy Scripts

Rush Delivery is provider-neutral. A deploy script can call:

- `gcloud`
- `wrangler`
- `kubectl`
- `helm`
- `aws`
- `az`
- an internal deployment CLI

Keep cloud-specific logic in the script and runtime metadata. Keep the Rush
Delivery metadata shape the same.

## Choose Runtime Files

Runtime files are for deploy-only file inputs:

- cloud credentials
- kubeconfig
- signing keys
- service account JSON
- generated certificates

Do not commit those files. Prepare them in CI and pass them with
`runtime-file-map`.

## Choose Validation Depth

Start with Rush commands:

- `verify`
- `lint`
- `test`
- `build`

Add validation targets only when you need service orchestration. A database,
message broker, long-running server, or smoke check is a good reason.

## Common Mistakes

Mismatched target names:

- The service mesh says `api`.
- The package target file says `server`.
- The deploy target file says `backend`.

Pick one name and use it everywhere.

Stale Rush install cache:

- Rush Delivery restores the configured cache snapshot and then runs
  `rush install`, so normal lockfile and package changes should be reconciled by
  Rush.
- If you intentionally want to discard the existing install snapshot, bump
  `cache.version` in `.dagger/rush-cache/providers.yaml`.

Publishing from PRs:

- PR workflows should use `packages: read` and `pull-or-build`.
- Trusted release workflows can use `packages: write` and default `lazy`.

Credential files in source:

- Use runtime files instead.
- Mount them only into targets that need them.

Deploy scripts depending on the whole repo:

- Prefer narrow runtime workspaces.
- Add only the dirs and files the script truly needs.

Package release mixed into deploy metadata:

- Keep npm package release in `.dagger/release/npm.yaml`.
- Keep deploy targets in `.dagger/deploy` and `.dagger/package`.
- Use `release-env` for npm credentials and `deploy-env` for deploy/build
  inputs.

## Final Checklist

- Rush projects are stable and buildable.
- Rush commands cover validation and build.
- `.dagger/package` defines deploy artifacts and any build-time env allowlists.
- `.dagger/deploy` defines deploy ordering and runtime behavior.
- `.dagger/release` defines npm package release behavior when the repository
  publishes packages.
- `.dagger/validate` defines only orchestration-heavy checks.
- Provider metadata is configured.
- PR and release workflows use different permissions and policies.
- Local dry-runs work before live deployment.

Next: [NPM Package Release Baseline](../npm-package-release-baseline).

For editor validation, point metadata files at exact published schema versions
such as
`https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.0/deploy-target.schema.json`.
