# Development

This page is for maintaining the Rush Delivery repository itself. User-facing
setup lives in the [Quick Start](quick-start/github-actions.md).

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

OCI application-image changes also need the live disposable-registry
acceptance path. It creates temporary Cosign keys, publishes a short-lived
scratch image, and verifies the digest manifest and evidence:

```sh
test/scripts/run-oci-acceptance.sh
```

The acceptance script requires Dagger but no host Docker or Podman CLI, socket,
or daemon. It creates temporary Cosign material and performs framework image
build/publication through Dagger.
The Package implementation pins Syft 1.50.0, Grype 0.116.1, and Cosign 3.1.2 by
immutable image digest. Update each version and digest together, then rerun the
unit, Dagger self-check, and live acceptance paths. Cosign `3.1.2` also pins the
deprecated `--new-bundle-format=false` registry-storage contract. A Cosign bump
must first prove the replacement CLI flags, signature/attestation storage,
independent three-way verification, full tagged/untagged cleanup, and exact live
registry acceptance; never update only the version/digest and assume compatible
artifact semantics.

The pinned Dagger `v0.20.7` engine requires `Container.withExec` stdout
redirection to resolve to a writable regular file in the container filesystem.
It rejects `redirectStdout: "/dev/null"` before starting the command with
`Error: open redirect stdout file: cannot resolve path "/dev/null"`. Keep the
six registry Cosign commands on their distinct
`/tmp/rush-delivery-cosign-*.stdout` sinks. Those files exist only in the
ephemeral Cosign container and are neither exported nor retained as release
evidence. Engine or Cosign upgrades must retain the engine regression proving a
real regular-file redirect works; a failure at a named Cosign stage does not by
itself prove that the Cosign process started.

Every public Dagger function must declare an intentional cache scope. Calls that
observe mutable external state, execute project code, or create side effects use
`cache: "never"`; inspection-only functions may use session caching. Because
that setting does not disable container layer caching, Cosign preflight and
publication, Grype scans, Deploy scripts, and npm release also receive a fresh
non-secret execution input. Keep those checks aligned with Dagger's official
[function-caching](https://docs.dagger.io/extending/function-caching/) and
[secret-handling](https://docs.dagger.io/extending/secrets/) guidance. Never
write raw or derived credentials into a container filesystem layer.

## Website Checks

The public GitHub Pages site currently builds from
[`../website-docusaurus`](../website-docusaurus). It uses Docusaurus, generates
docs pages from `website-docusaurus/docs-tree.yaml`, and is deployed by
[`../.github/workflows/pages.yml`](../.github/workflows/pages.yml).

The two sites have independent lockfiles and are not root Yarn workspaces. From
a clean checkout, install each site exactly before running its checks:

```sh
npm ci --prefix website
npm ci --prefix website-docusaurus
```

```sh
npm run site:docusaurus:check
npm run site:docusaurus:build
```

The Astro + Starlight comparison site remains under [`../website`](../website).

```sh
npm run site:check
npm run site:build
```

## Generated Site Inputs

The root [`docs`](.) directory is the source of truth for generated website
docs. When adding or renaming public docs pages, update both:

- [`../website-docusaurus/docs-tree.yaml`](../website-docusaurus/docs-tree.yaml)
- [`../website/docs-tree.yaml`](../website/docs-tree.yaml)

Schemas under [`../schemas`](../schemas) are copied into the static site during
website builds and are published under `/rush-delivery/schemas/`. Exact release
schemas also live under versioned subdirectories such as
`/rush-delivery/schemas/v0.8.1/`.

When releasing a version that changes schema behavior, create a new versioned
schema snapshot such as `schemas/v0.8.1`, keep earlier directories immutable,
and update the root schemas to the current release shape.

## Versioned Docusaurus Docs

Docusaurus is the canonical versioned documentation site. The current editable
docs stay in [`docs`](.), while released snapshots are committed under
[`../docs-versions`](../docs-versions).

Docusaurus expects `versions.json`, `versioned_docs`, and `versioned_sidebars`
inside the website directory, so
[`../website-docusaurus/scripts/sync-versioned-inputs.mjs`](../website-docusaurus/scripts/sync-versioned-inputs.mjs)
copies the canonical root snapshots into Docusaurus-local generated inputs
before `start`, `build`, and `check`.

After a docs-bearing release:

1. Update the current docs version in
   [`../website-docusaurus/docusaurus.config.ts`](../website-docusaurus/docusaurus.config.ts).
2. Add the previous current version to `publishedVersions` in
   [`../website-docusaurus/scripts/sync-versioned-docs.mjs`](../website-docusaurus/scripts/sync-versioned-docs.mjs)
   when the release changed public docs.
3. Run:

   ```sh
   npm --prefix website-docusaurus run sync-versioned-docs
   npm --prefix website-docusaurus run sync-versioned-inputs
   npm run site:docusaurus:check
   ```

4. Confirm the generated versioned docs and sidebars match the released tag.

When preparing documentation for the next release line, snapshot the latest
released documentation before editing root [`docs`](.). In practice, finish and
tag the release, run the versioned docs sync so `docs-versions` contains a
directory for that released tag, and only then update current docs for the next
version. This keeps published docs stable for users pinned to older module
versions.

Patch releases do not need a new docs snapshot when user-facing docs did not
change. Versioned docs should point users at exact versioned schema URLs where
editor stability matters, while root schema URLs continue to track the current
release.
