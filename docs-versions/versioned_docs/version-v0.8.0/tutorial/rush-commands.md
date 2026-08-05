---
title: "Rush Commands"
sidebar_label: "Rush Commands"
---

Rush Delivery uses Rush commands to validate and build selected projects. The
example repository defines repo-level commands in
[`common/config/rush/command-line.json`](https://github.com/BootstrapLaboratory/typescript_monorepo_nestjs_relay_trunk/blob/main/common/config/rush/command-line.json).

The important commands are:

- `verify`
- `lint`
- `test`
- `build`

`build` is Rush's normal build command. The others are custom bulk commands.
Rush Delivery can run them against affected projects instead of blindly running
the whole repository.

## Validation Commands

The example configures `verify`, `lint`, and `test` as bulk commands. Each
command runs an npm script from each selected project folder when the project
defines that script.

The useful pattern is:

```json
{
  "commandKind": "bulk",
  "name": "lint",
  "shellCommand": "npm run lint --if-present",
  "enableParallelism": true,
  "ignoreMissingScript": true
}
```

This lets library, server, and webapp projects participate differently while
sharing one CI path.

## Build Command

Rush Delivery uses Rush build selection to build the projects needed for deploy
targets. A deploy target does not have to map one-to-one to a single app, but
the example keeps the mapping simple:

- deploy target `server` builds project `server`
- deploy target `webapp` builds project `webapp`

## Contract Drift Checks

The example server has a `verify` script that regenerates a GraphQL schema and
fails if the committed API contract changed unexpectedly. That is not required
by Rush Delivery, but it shows the kind of project-specific check that belongs
behind a Rush command.

The transferable rule is simple: put project checks in project scripts, expose
shared command names through Rush, and let Rush Delivery call Rush.

## Checklist

- Projects that need CI validation expose `verify`, `lint`, or `test` scripts.
- Projects that produce deploy artifacts expose `build`.
- Custom Rush commands use `ignoreMissingScript` when not every project has the
  script.
- Commands are safe to run from a clean CI checkout.

Next: [Dagger Metadata Map](../dagger-metadata-map).
