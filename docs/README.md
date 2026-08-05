# Rush Delivery Documentation

Rush Delivery is a provider-adaptable Dagger module for Rush monorepos. The
framework assumes Rush is the project graph and uses `.dagger/` metadata as the
extension surface for validation, packaging, deployment, caches, and toolchains.

## Guides

- [Quick Start](quick-start/github-actions.md): recommended ways to run Rush
  Delivery from GitHub Actions, CI scripts, and local working trees.
- [GitHub Action usage](github-actions.md): GitHub CI wrapper for validation,
  deploy release workflows, and npm package release workflows.
- [Public Dagger API](api.md): callable functions and when to use them.
- [Entrypoints reference](entrypoints.md): every callable Dagger function and
  separate-use workflow.
- [Workflow guide](workflows.md): local and CI workflow shapes.
- [Metadata contracts](metadata.md): files under `.dagger/` that define target
  behavior.
- [Provider adapters](providers.md): source, registry, cache, and CI-provider
  boundaries.
- [Bounded local-copy imports](local-copy-source-imports.md): exclude disposable
  worktree data before Dagger uploads it, with tested inclusion and recovery.
- [Project-owned Rush toolchain](rush-toolchain.md): safely add digest-pinned,
  checksummed executables to every Rush lifecycle.
- [Upgrade to v0.9.0](upgrade-v0.9.0.md): compatibility, canary, and recovery
  guidance for v0.8.1 users.
- [OCI application images tutorial](tutorial/oci-application-images/README.md):
  runnable path from provider-off planning through signed publication,
  digest-only deploy, split-stage handoff, and rollback.
- [OCI application images](oci-application-images.md): build-once image
  publication, verified evidence, and digest-only deploy handoff.
- [OCI registry recipes](oci-registry-recipes.md): provider metadata,
  permissions, retention, and cleanup for common registries.
- [OCI application image troubleshooting](oci-application-image-troubleshooting.md):
  diagnosis and recovery by release phase.
- [Environment-selected OCI profiles](tutorial/oci-application-images/08-environment-profiles.md):
  route one provider definition to staging and production repositories.
- [Mixed Node/Python toolchain](tutorial/15-mixed-node-python-toolchain.md):
  install and cache a pinned Python package manager before Rush commands.
- [Development](development.md): maintainer checks, website build notes, and
  generated documentation inputs.
- [AI architecture](../.ai/architecture.md): high-level design map for future
  coding agents.
- [AI conventions](../.ai/conventions.md): contribution rules and invariants.

## Source Of Truth

The schemas under [`../schemas`](../schemas) are the field-level metadata
contract. These docs explain intent and usage; schemas define file shape.

Published schemas are available from the documentation site:

- `https://bootstraplaboratory.github.io/rush-delivery/schemas/<schema>.schema.json`
- `https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/<schema>.schema.json`

Use exact versioned schema URLs in project metadata editor hints so older
projects keep the schema contract they were written against. The root
`/schemas/` URLs point at the current release line.

## Package Release Reference

The package release docs use
[BootstrapLaboratory/labkit](https://github.com/BootstrapLaboratory/labkit) as a
real npm package publishing reference. LabKit publishes public npm packages with
Rush Delivery `v0.7.0`, Rush change files, `.dagger/release/npm.yaml`, and the
same package release contract that can run standalone or as part of
`workflow`.
