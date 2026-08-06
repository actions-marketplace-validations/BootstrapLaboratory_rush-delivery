# Mixed Node/Python Rush Toolchain

This tutorial adds the `uv` Python package manager to Rush Delivery's shared
Node 24 workflow image without a package-level bootstrap script. The result is
available before Rush install and every Rush lifecycle command.

Read the [toolchain production guide](../rush-toolchain.md) first for the trust,
download, extraction, and cache contract.

## 1. Add Pinned Metadata

Create `.dagger/toolchains/rush.yaml`:

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.1/rush-toolchain.schema.json
version: rush-delivery-rush-toolchain/v1
base_image: node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848
platform: linux/amd64
downloads:
  - url: https://github.com/astral-sh/uv/releases/download/0.12.2/uv-x86_64-unknown-linux-gnu.tar.gz
    sha256: d66e96b5f1ca3b99806eee283a8125d33a0bd669e6e6d9bc4ab7ffda63c41bf4
    format: tar_gz
    archive_path: uv-x86_64-unknown-linux-gnu/uv
    destination: /usr/local/bin/uv
    mode: "0755"
```

These values are a complete reviewed tuple. Do not update only the URL, tag,
checksum, member, or base digest.

## 2. Use The Tool From Rush Scripts

The project owns its Python dependency policy. A package script can verify and
use the tool before its normal build:

```json
{
  "scripts": {
    "build": "uv --version && uv sync --frozen && node scripts/build.mjs",
    "lint": "uv --version && node scripts/lint.mjs",
    "test": "uv --version && uv run pytest",
    "verify": "uv --version && uv run python -m compileall src"
  }
}
```

Commit the Python lockfile used by `uv sync --frozen`. Tool acquisition is
deterministic, but project dependency resolution is only deterministic when the
project also locks and verifies its own dependencies.

## 3. Validate Before Downloading

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.1 \
  call validate-metadata-contract --repo=.
```

This checks the strict schema/parser and cross-file contract. It does not need
toolchain-provider credentials.

## 4. Prove Provider-Off Execution

Run the same validation lifecycle without a toolchain registry:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.1 \
  --repo=. \
  -- \
  validate \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=pull_request \
  --validate-targets-json='["python-worker"]' \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

The first configured run preflights Node 24/Bash/Debian, transfers the pinned
asset, verifies SHA-256, extracts exactly the declared regular member, installs
`/usr/local/bin/uv`, then begins Rush work. A checksum or archive error stops
before installation.

## 5. Enable Cache In Trusted CI

After provider-off succeeds, a trusted release job can populate the normal
content-addressed toolchain cache:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    toolchain-image-provider: github
    toolchain-image-policy: lazy
    rush-cache-provider: github
    rush-cache-policy: lazy
```

Pull requests should keep read-only behavior:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    entrypoint: validate
    toolchain-image-provider: github
    toolchain-image-policy: pull-or-build
    rush-cache-provider: github
    rush-cache-policy: pull-or-build
```

The cache tag changes when any ordered toolchain input changes. An
authentication error is not treated as a miss; fix package permissions or
provider credentials rather than rebuilding under an ambiguous identity.

## 6. Update And Roll Back

For an upstream update, independently download and hash the new linux/amd64
asset, inspect the exact archive member, update the complete tuple, and repeat
provider-off acceptance. Populate the new provider cache from a trusted job.

To roll back, restore the previously reviewed metadata tuple. Removing
`.dagger/toolchains/rush.yaml` returns the project to Rush Delivery's unchanged
Node-only default, but only do that if lifecycle scripts no longer require the
project tool.
