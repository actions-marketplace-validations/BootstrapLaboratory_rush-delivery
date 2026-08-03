---
id: "metadata"
title: "Metadata"
sidebar_label: "Metadata"
---

Project-specific behavior lives under `.dagger` in the caller's Rush
repository. This module treats those files as the public extension contract.

Exact field validation is defined by JSON schemas under
[`../schemas`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas).

For editor integration in external projects, prefer exact versioned schema
URLs. For example:

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.7.0/deploy-target.schema.json
```

The root `https://bootstraplaboratory.github.io/rush-delivery/schemas/` URLs
track the current release. Exact paths such as `/schemas/v0.7.0/...` are the
stable contract for projects pinned to that Rush Delivery version.

## Package Release

Package release metadata lives in `.dagger/release/npm.yaml`. It is separate
from deploy target metadata because npm package releases are registry side
effects, not deploy mesh targets.

Repositories that only use `release-packages` do not need deploy metadata such
as `.dagger/deploy/services-mesh.yaml`. Rush cache metadata is only required
when a Rush cache provider such as `github` is enabled.

The first supported release strategy uses Rush change files. Rush remains the
source of truth for package selection, version changes, changelogs, and
publishable package rules.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.7.0/npm-release.schema.json

kind: npm

versioning:
  strategy: rush-change-files
  target_branch: main

auth:
  kind: token
  token_env: NPM_TOKEN

publish:
  registry: https://registry.npmjs.org/
  tag: latest
  access: public
  provenance: false
```

Fields:

- `kind`: currently `npm`.
- `versioning.strategy`: currently `rush-change-files`.
- `versioning.target_branch`: branch Rush publishes the generated version
  commit back to, usually `main`.
- `auth.kind`: currently `token`.
- `auth.token_env`: release env key containing the npm token, usually
  `NPM_TOKEN`.
- `publish.registry`: optional npm registry URL passed to `rush publish`.
- `publish.tag`: npm dist-tag, defaulting to `latest`.
- `publish.access`: optional npm access level, `public` or `restricted`.
- `publish.provenance`: optional boolean, defaulting to `false`.

For token auth, keep the npm token in the release env file and reference it
from `common/config/rush/.npmrc-publish`, for example:

```text
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

The repository still owns Rush and npm package policy. For example, LabKit uses
a Rush version policy:

```json
[
  {
    "definitionName": "individualVersion",
    "policyName": "labkit"
  }
]
```

and each publishable Rush project references it from `rush.json`:

```json
{
  "packageName": "@omgjs/labkit-webapp-ui",
  "projectFolder": "packages/webapp-ui",
  "versionPolicyName": "labkit"
}
```

Package-level npm metadata remains package-owned:

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": ["dist/**/*", "README.md"]
}
```

Private tooling packages can stay in the Rush repo for build and lint support
without becoming part of the public release contract. Rush and npm decide what
is publishable from package metadata and Rush publish behavior; Rush Delivery
does not maintain a separate package allowlist.

`publish.provenance` defaults to `false`. Keep it omitted or set to `false`
for the default Dagger-contained release flow, because npm automatic provenance
needs to detect a supported CI/OIDC provider from inside the publishing
environment. Set `publish.provenance: true` only when that release runtime is
explicitly wired for a supported npm provenance provider.

Pull-request validation runs Rush change-file verification when npm release
metadata is present. Live `releasePackages` runs the shared Rush lifecycle in
build-first order (`build`, `lint`, `test`, `verify`), lets Rush apply the
change files, publishes packages, and pushes the generated version commit back
to `versioning.target_branch`. In Git source mode, Rush Delivery prepares that
target branch locally before invoking `rush publish` so Rush can check it out
for the final merge.

Schema:
[`../schemas/npm-release.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/npm-release.schema.json)

## Deploy Services Mesh

`.dagger/deploy/services-mesh.yaml` defines deploy target ordering:

- `services.<target>.deploy_after` lists targets that must finish first.
- Targets with no dependency can run in the same deploy wave.
- Service names must match deploy target metadata names.

Schema:
[`../schemas/deploy-services-mesh.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/deploy-services-mesh.schema.json)

## Deploy Targets

Deploy targets live in `.dagger/deploy/targets`.

Each target declares:

- `name`: target name. It should match the metadata filename and Rush package.
- `deploy_script`: repository-relative script executed by the target runtime.
- `runtime.image`: base image for the executor container.
- `runtime.install`: toolchain preparation commands.
- `runtime.pass_env`: allowed 1:1 host-to-container environment variables.
- `runtime.map_env`: allowed renamed environment variables, written as
  `TARGET_ENV: SOURCE_ENV`.
- `runtime.env`: static container environment values.
- `runtime.dry_run_defaults`: safe defaults used during dry-runs.
- `runtime.required_host_env`: host environment keys required for live runs.
- `runtime.file_mounts`: files mounted into the runtime container from the
  deploy runtime files bundle, or from host env paths for compatibility.
- `runtime.workspace`: directories and files mounted under `/workspace`.

If `runtime.workspace.mode` is `full`, the whole prepared repository is mounted.
If mode is omitted, only listed `dirs` and `files` are mounted.

Runtime file mounts use a `source` path relative to the `runtimeFiles` bundle.
`target` is optional and defaults to `/runtime-files/<source>`.

```yaml
runtime:
  env:
    GOOGLE_APPLICATION_CREDENTIALS: /runtime-files/gcp-credentials.json
  file_mounts:
    - source: gcp-credentials.json
```

The `source` path must stay inside the runtime files bundle: no absolute paths
and no `..` segments. Live deploys that reference `source` mounts require the
`runtimeFiles` Dagger input. Dry-runs report the intended mount and do not
require the file.

Compatibility mounts can still read a host path from an allowlisted environment
variable and mount it at an explicit target:

```yaml
runtime:
  required_host_env:
    - GOOGLE_GHA_CREDS_PATH
  file_mounts:
    - source_var: GOOGLE_GHA_CREDS_PATH
      target: /tmp/gcp-credentials.json
```

For renamed deploy env with `runtime.map_env`, `runtime.dry_run_defaults` are
keyed by the source variable name.

`runtime.pass_env`, `runtime.map_env`, and static `runtime.env` share one output
environment namespace and have no precedence order. If they resolve the same
output name with different values, Rush Delivery fails instead of silently
overriding one value with another.

Schema:
[`../schemas/deploy-target.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/deploy-target.schema.json)

## Package Targets

Package targets live in `.dagger/package/targets`.

Package targets can also declare build-time environment for the generic Rush
`verify`, `lint`, `test`, and `build` stage:

- `build.pass_env`: allowed 1:1 variables from the deploy env file.
- `build.map_env`: allowed renamed variables, written as
  `TARGET_ENV: SOURCE_ENV`.
- `build.dry_run_defaults`: safe values used when workflow dry-run mode is
  enabled and a source variable is not present.

```yaml
build:
  pass_env:
    - WEBAPP_URL
  map_env:
    VITE_GRAPHQL_HTTP: WEBAPP_VITE_GRAPHQL_HTTP
  dry_run_defaults:
    WEBAPP_URL: https://webapp.example.test
    WEBAPP_VITE_GRAPHQL_HTTP: https://api.example.test/graphql
```

Rush Delivery merges build env from all selected package targets into the
shared Rush build container. If two selected targets resolve the same target
environment variable to different values, the build fails with a metadata error.
For `map_env`, `dry_run_defaults` are keyed by the source variable name.

`build.pass_env` and `build.map_env` also have no precedence order. Both add
explicit build environment variables. If they resolve the same output name with
different values, Rush Delivery fails instead of silently overriding one value
with another.

Supported artifact types:

- `directory`: an already-built repository directory.
- `rush_deploy_archive`: a Rush deploy output packaged for a deploy target.

Schema:
[`../schemas/package-target.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/package-target.schema.json)

## Validation Targets

Validation targets live in `.dagger/validate/targets`.

They declare optional backing services and ordered validation steps. This keeps
target-specific smoke checks in metadata while the runner stays generic.

Schema:
[`../schemas/validation-target.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/validation-target.schema.json)

## Toolchain Images

Toolchain image provider metadata lives in
`.dagger/toolchain-images/providers.yaml`.

It declares optional registry providers for reusable framework toolchain images.
Provider `off` needs no metadata. Provider `github` uses GHCR with environment
keys for repository, username, and token.

Schema:
[`../schemas/toolchain-image-providers.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/toolchain-image-providers.schema.json)

## Rush Cache

Rush cache metadata lives in `.dagger/rush-cache/providers.yaml`.

The `cache` section defines:

- `version`: user-controlled cache snapshot tag. Bump it when you intentionally
  want to start a fresh Rush install cache namespace.
- `paths`: repository-relative Rush install cache paths restored into the
  Dagger-owned source.

The `providers` section declares optional storage adapters.

Schema:
[`../schemas/rush-cache-providers.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas/rush-cache-providers.schema.json)
