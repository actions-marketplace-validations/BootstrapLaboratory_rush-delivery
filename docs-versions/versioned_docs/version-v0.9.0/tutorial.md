---
id: "tutorial"
title: "Tutorial"
sidebar_label: "Tutorial"
description: "Build a Rush Delivery setup from Rush metadata to deployment."
---

This tutorial walks through a complete Rush Delivery setup for a Rush monorepo.
It uses two real public projects as worked examples:

[BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk)

is the deployment example. It is wired end to end with Rush Delivery, deploys a
NestJS backend to Google Cloud Run, deploys a React webapp to Cloudflare Pages,
and validates pull requests before changes reach `main`.

[BootstrapLaboratory/labkit](https://github.com/BootstrapLaboratory/labkit)

is the package release example. It publishes public npm packages through Rush
Delivery `release-packages`, Rush change files, `.dagger/release/npm.yaml`, and
a dedicated GitHub workflow.

The cloud providers are examples, not requirements. The reusable part is the
shape:

- Rush owns project identity, dependency graph, selected project commands, and
  deploy bundles.
- `.dagger` metadata describes deployment targets, package artifacts,
  validation targets, provider-backed cache, and provider-backed toolchains.
- GitHub Actions stays thin. It authenticates to external systems, passes env
  and runtime files, and calls the Rush Delivery action.
- Rush Delivery owns source acquisition, affected target detection, build,
  package, validation, deploy ordering, and runtime execution.

## What You Will Build

By the end of the tutorial, a project should have this shape:

```text
.
├── rush.json
├── common/config/rush/
├── .dagger/
│   ├── deploy/
│   ├── package/
│   ├── release/
│   ├── rush-cache/
│   ├── toolchains/
│   ├── toolchain-images/
│   ├── validate/
│   └── source-import.ignore
└── .github/workflows/
```

The tutorial does not teach NestJS, Relay, React, Google Cloud Run, Cloudflare
Pages, or npm package design in depth. Those are implementation details of the
example projects. The point is to teach how a Rush project becomes a Rush
Delivery project.

## Chapters

1. [Rush Monorepo Baseline](rush-monorepo-baseline)
2. [Rush Commands](rush-commands)
3. [Dagger Metadata Map](dagger-metadata-map)
4. [Provider Artifacts](provider-artifacts)
5. [Package Targets](package-targets)
6. [Deploy Mesh](deploy-mesh)
7. [Deploy Targets](deploy-targets)
8. [Validation Targets](validation-targets)
9. [GitHub Actions](github-actions)
10. [Local Dry Runs](local-dry-runs)
11. [Adapt To Your Project](adapting-to-your-project)
12. [NPM Package Release Baseline](npm-package-release-baseline)
13. [Release Metadata](release-metadata)
14. [Package Release Workflow](package-release-workflow)
15. [Mixed Node/Python Toolchain](mixed-node-python-toolchain)

For an opt-in, production-oriented OCI image path, continue with the
[OCI Application Images tutorial](oci-application-images). It starts
from a minimal Rush repository and covers credential-free planning, GHCR and
Cosign bootstrap, digest-only deployment, GitHub Actions, split-stage handoff,
rollback, and environment-selected registry profiles.

## The Deployment Example Repository

The deployment example has three Rush projects:

- `api-contract` in `libs/api`
- `server` in `apps/server`
- `webapp` in `apps/webapp`

Its deployment model has two deploy targets:

- `server`, packaged with `rush deploy` and deployed by a Cloud Run script
- `webapp`, packaged as a static build directory and deployed by a Cloudflare
  Pages script

Its validation model includes normal Rush validation plus a backend runtime
validation target that starts Postgres, Redis, runs migrations, starts the
server, and performs a smoke check.

Use the example repository as a reference implementation. Copy shapes and
contracts from it, but adapt target names, scripts, environment variables, and
provider choices to your own product.

## The Package Release Example Repository

The package release example is
[BootstrapLaboratory/labkit](https://github.com/BootstrapLaboratory/labkit). It
has a package-only Rush monorepo with public npm packages, Rush version
policies, package `publishConfig`, `.npmrc-publish`, and a
`release-packages` workflow using Rush Delivery `v0.7.0`.

Use LabKit as the reference for npm publishing shape. Copy the release
contracts from it, but adapt package names, version policy names, registry,
access level, and token handling to your own packages.
