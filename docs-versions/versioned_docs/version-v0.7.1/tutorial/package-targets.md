---
title: "Package Targets"
sidebar_label: "Package Targets"
---

Package targets describe the deploy artifact for each deploy target. Rush
Delivery builds selected Rush projects first, then materializes the artifacts
declared in `.dagger/package/targets`.

The example has two package styles.

## Rush Deploy Archive

The backend target uses a Rush deploy archive:

```yaml
name: server

artifact:
  kind: rush_deploy_archive
  project: server
  scenario: server
  output: common/deploy/server
```

This points at:

- Rush project `server`
- Rush deploy scenario `server`
- output directory `common/deploy/server`

The deploy scenario lives in
[`common/config/rush/deploy-server.json`](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk/blob/main/common/config/rush/deploy-server.json).
It tells Rush deploy how to gather the server package and its production
dependencies into a deployable directory.

Use this style when a backend service needs its package, transitive runtime
dependencies, and local workspace dependencies collected into one bundle.

## Directory Artifact

The frontend target uses a directory artifact:

```yaml
name: webapp

artifact:
  kind: directory
  path: apps/webapp/dist
```

Use this style when the build already produces a deployable directory. Static
frontend assets are the common case.

## Build Environment

Package metadata can allow build-time environment variables for the generic Rush
`verify`, `lint`, `test`, and `build` stage.

Use `pass_env` when the variable name should stay the same inside the build
container. Use `map_env` when CI stores the value under one name, but the build
tool expects another:

```yaml
name: webapp

build:
  pass_env:
    - WEBAPP_URL
  map_env:
    VITE_GRAPHQL_HTTP: WEBAPP_VITE_GRAPHQL_HTTP
  dry_run_defaults:
    WEBAPP_URL: https://webapp.example.test
    WEBAPP_VITE_GRAPHQL_HTTP: https://api.example.test/graphql

artifact:
  kind: directory
  path: apps/webapp/dist
```

The source values come from the same deploy env file that the action prepares
from `deploy-env`. Rush Delivery applies only the variables allowed by selected
package targets.

The Rush build stage is shared for selected targets. If two selected package
targets resolve the same target variable to different values, Rush Delivery
fails instead of choosing one silently.

There is no precedence between `pass_env` and `map_env`. Both add variables to
the build container. If they produce the same output name with different values,
the run fails so build configuration cannot be changed by a silent override.

## Artifact Paths In Deploy Scripts

Rush Delivery passes the selected artifact path to deploy scripts through
`ARTIFACT_PATH`.

For the backend, the deploy script expects an extracted Rush deploy bundle with
`apps/server` inside it. For the frontend, the deploy script expects a static
assets directory.

Keep deploy scripts defensive. They should fail early if `ARTIFACT_PATH` does
not point at the expected shape.

## Checklist

- Create one package target for every deploy target.
- Use `rush_deploy_archive` for backend/runtime bundles.
- Use `directory` for already-built static assets.
- Allow build-time env with `build.pass_env` and `build.map_env` only when the
  Rush build really needs it.
- Keep artifact paths relative to the repository root.
- Make deploy scripts validate the artifact shape before deploying.

Next: [Deploy Mesh](../deploy-mesh).
