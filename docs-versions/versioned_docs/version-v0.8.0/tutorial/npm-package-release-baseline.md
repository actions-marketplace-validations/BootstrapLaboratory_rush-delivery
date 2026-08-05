---
title: "NPM Package Release Baseline"
sidebar_label: "NPM Package Release Baseline"
---

Rush Delivery package release assumes Rush already owns package identity,
project graph, package commands, and versioning inputs. The framework does not
invent a second package registry model. It calls Rush from an isolated Dagger
runtime and lets Rush decide which packages should publish.

This chapter uses
[BootstrapLaboratory/labkit](https://github.com/BootstrapLaboratory/labkit) as
the reference shape. LabKit is a package-only Rush monorepo that publishes
public npm packages through Rush Delivery `v0.7.0`.

## Rush Projects

Each publishable package is a Rush project in `rush.json`:

```json
{
  "packageName": "@omgjs/labkit-webapp-ui",
  "projectFolder": "packages/webapp-ui",
  "reviewCategory": "libraries",
  "versionPolicyName": "labkit"
}
```

Rush project names and folders are the source of truth for package selection.
Rush Delivery does not maintain a separate list of npm packages.

## Version Policies

LabKit uses a Rush version policy in
`common/config/rush/version-policies.json`:

```json
[
  {
    "definitionName": "individualVersion",
    "policyName": "labkit"
  }
]
```

This is normal Rush configuration. Choose the version policy shape that matches
your package lifecycle. Rush Delivery only passes the configured target branch
to Rush change-file verification and Rush publishing.

## Package Publish Shape

Each package still owns its npm package metadata:

```json
{
  "name": "@omgjs/labkit-webapp-ui",
  "version": "0.1.1",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "main": "./dist/src/index.js",
  "module": "./dist/esm/src/index.js",
  "types": "./dist/src/index.d.ts",
  "files": ["dist/**/*", "README.md"]
}
```

Keep package entrypoints, files, `publishConfig`, README files, and private
package settings in package `package.json` files. That keeps npm behavior
reviewable by package maintainers.

## Rush Commands

`release-packages` runs the shared Rush lifecycle before publishing:

```text
build
lint
test
verify
```

Make those commands meaningful for packages. LabKit uses package scripts behind
repo-level Rush commands so the release runtime builds package output before
npm publish starts.

## Change Files

With `versioning.strategy: rush-change-files`, PRs should include Rush change
files when package behavior changes. Rush Delivery `validate` runs
`rush change --verify` when `.dagger/release/npm.yaml` exists, so PRs can fail
before they reach `main` if release notes or version bumps are missing.

## Checklist

- Every publishable package is a Rush project.
- Rush projects that publish use the intended version policy.
- Package `package.json` files define publishable files and entrypoints.
- Package build scripts produce the files listed in `files`.
- PRs include Rush change files for package changes.
- `build`, `lint`, `test`, and `verify` are ready to run before publish.

Next: [Release Metadata](../release-metadata).
