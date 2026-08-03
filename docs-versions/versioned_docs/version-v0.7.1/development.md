---
id: "development"
title: "Development"
sidebar_label: "Development"
description: "Maintain this repository and generated documentation."
---

This page is for maintaining the Rush Delivery repository itself. User-facing
setup lives in the [Quick Start](../quick-start/github-actions).

## Local Checks

Run the Dagger self-check before changing metadata, schemas, or module source:

```sh
dagger call self-check
```

Run the TypeScript and test suite from the repository root:

```sh
npm run typecheck
npm test
```

## Website Checks

The public GitHub Pages site currently builds from
[`../website-docusaurus`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website-docusaurus). It uses Docusaurus, generates
docs pages from `website-docusaurus/docs-tree.yaml`, and is deployed by
[`../.github/workflows/pages.yml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/.github/workflows/pages.yml).

```sh
npm run site:docusaurus:check
npm run site:docusaurus:build
```

The Astro + Starlight comparison site remains under [`../website`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website).

```sh
npm run site:check
npm run site:build
```

## Generated Site Inputs

The root [`docs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/docs) directory is the source of truth for generated website
docs. When adding or renaming public docs pages, update both:

- [`../website-docusaurus/docs-tree.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website-docusaurus/docs-tree.yaml)
- [`../website/docs-tree.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website/docs-tree.yaml)

Schemas under [`../schemas`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/schemas) are copied into the static site during
website builds and are published under `/rush-delivery/schemas/`. Exact release
schemas also live under versioned subdirectories such as
`/rush-delivery/schemas/v0.7.0/`.

When releasing a version that changes schema behavior, keep the versioned
schema directory immutable and update the root schemas to the current release
shape.

## Versioned Docusaurus Docs

Docusaurus is the canonical versioned documentation site. The current editable
docs stay in [`docs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/docs), while released snapshots are committed under
[`../docs-versions`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/docs-versions).

Docusaurus expects `versions.json`, `versioned_docs`, and `versioned_sidebars`
inside the website directory, so
[`../website-docusaurus/scripts/sync-versioned-inputs.mjs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website-docusaurus/scripts/sync-versioned-inputs.mjs)
copies the canonical root snapshots into Docusaurus-local generated inputs
before `start`, `build`, and `check`.

After a docs-bearing release:

1. Update the current docs version in
   [`../website-docusaurus/docusaurus.config.ts`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website-docusaurus/docusaurus.config.ts).
2. Add the previous current version to `publishedVersions` in
   [`../website-docusaurus/scripts/sync-versioned-docs.mjs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/website-docusaurus/scripts/sync-versioned-docs.mjs)
   when the release changed public docs.
3. Run:

   ```sh
   npm --prefix website-docusaurus run sync-versioned-docs
   npm --prefix website-docusaurus run sync-versioned-inputs
   npm run site:docusaurus:check
   ```

4. Confirm the generated versioned docs and sidebars match the released tag.

When preparing documentation for the next release line, snapshot the latest
released documentation before editing root [`docs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.7.1/docs). In practice, finish and
tag the release, run the versioned docs sync so `docs-versions` contains a
directory for that released tag, and only then update current docs for the next
version. This keeps published docs stable for users pinned to older module
versions.

Patch releases do not need a new docs snapshot when user-facing docs did not
change. Versioned docs should point users at exact versioned schema URLs where
editor stability matters, while root schema URLs continue to track the current
release.
