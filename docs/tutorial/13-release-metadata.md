# Release Metadata

Package release metadata lives in `.dagger/release/npm.yaml`. It is intentionally
small because Rush and npm already own most package release policy.

LabKit uses this shape:

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.1/npm-release.schema.json

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

## Versioning

`versioning.strategy` is currently `rush-change-files`. Rush Delivery uses this
metadata in two places:

- PR validation runs `rush change --verify --target-branch <target_branch>`.
- Live package release runs `rush publish --apply --target-branch
<target_branch> --publish`.

For live Git source releases, Rush Delivery fetches and prepares
`target_branch` locally before invoking `rush publish`. Rush can then check out
that branch and push its generated version commit.

## Auth

`auth.kind: token` means Rush Delivery reads the token from the release env
file and exposes it to the release runtime under `auth.token_env`.

The project wires that env into npm through
`common/config/rush/.npmrc-publish`:

```text
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

Use `release-env` or `release-env-file` for package publishing credentials.
Do not put npm credentials in `deploy-env`; deploy env belongs to build/deploy
targets and has a different trust boundary.

## Publish Options

The `publish` block passes npm-specific policy to Rush publish:

- `registry`: npm registry URL.
- `tag`: npm dist-tag, defaulting to `latest`.
- `access`: `public` or `restricted`.
- `provenance`: npm provenance toggle, defaulting to `false`.

Keep `provenance` omitted or set to `false` for the default Dagger-contained
token flow. Enable it only after the release runtime is wired so npm can detect
a supported provenance provider from inside the publishing environment.

## Provider Metadata

Package-only repositories do not need deploy metadata. They also do not need
Rush Delivery provider metadata unless they opt into provider-backed
toolchain images or Rush install cache.

LabKit keeps providers off in the release workflow:

```yaml
with:
  toolchain-image-provider: off
  rush-cache-provider: off
```

Use provider `github` only when the repository has matching
`.dagger/toolchain-images` or `.dagger/rush-cache` metadata and the workflow
has package registry permissions.

## Checklist

- Add `.dagger/release/npm.yaml`.
- Point the schema comment at the exact Rush Delivery version.
- Keep `target_branch` aligned with the branch Rush should update.
- Add `common/config/rush/.npmrc-publish`.
- Store `NPM_TOKEN` as a CI secret.
- Keep npm credentials in release env, not deploy env.
- Leave provenance disabled unless the runtime supports it.

Next: [Package Release Workflow](14-package-release-workflow.md).
