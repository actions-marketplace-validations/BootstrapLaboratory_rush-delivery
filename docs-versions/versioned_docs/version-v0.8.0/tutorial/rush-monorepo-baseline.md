---
title: "Rush Monorepo Baseline"
sidebar_label: "Rush Monorepo Baseline"
---

Rush Delivery starts from Rush. Before adding `.dagger` metadata, make sure the
monorepo has stable Rush project names, project folders, package scripts, and a
committed lockfile.

The example repository declares its projects in
[`rush.json`](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk/blob/main/rush.json).

```json
{
  "projects": [
    { "packageName": "api-contract", "projectFolder": "libs/api" },
    { "packageName": "webapp", "projectFolder": "apps/webapp" },
    { "packageName": "server", "projectFolder": "apps/server" }
  ]
}
```

Those package names become the vocabulary used by Rush Delivery. A deploy target
can be named `server`, a package target can build the Rush project `server`, and
validation can run Rush commands against affected projects.

## Project Names Matter

Keep Rush project names short, stable, and meaningful. They appear in:

- `rush.json`
- package metadata such as `.dagger/package/targets/server.yaml`
- deploy metadata such as `.dagger/deploy/targets/server.yaml`
- validation metadata such as `.dagger/validate/targets/server.yaml`
- Rush affected-project output

The names do not have to match folder names, but doing so makes the metadata
much easier to scan. In the example, `server` lives in `apps/server`, and
`webapp` lives in `apps/webapp`.

## Lockfile And Package Manager

Rush Delivery expects normal Rush install behavior. In the example, Rush uses
PNPM and tracks the install state with:

- `common/config/rush/pnpm-lock.yaml`
- `common/config/rush/pnpm-config.json`
- `common/config/rush/version-policies.json`

Rush Delivery restores the configured install cache snapshot first, then Rush
reconciles the actual dependency state during `rush install`.

## Root Scripts Are Optional

The example root `package.json` offers convenience scripts such as:

```sh
npm run rush:install
npm run rush:build
npm run webapp:build:pages
```

Rush Delivery does not require those exact scripts. What matters is that the
repo can be installed and built through Rush from the repository root.

## Checklist

- `rush.json` exists and lists every project.
- Each project has a `package.json`.
- Rush can install dependencies from the repo root.
- Buildable projects have a `build` script.
- The lockfile is committed.
- Project names are stable enough to reference from `.dagger` metadata.

Next: [Rush Commands](../rush-commands).
