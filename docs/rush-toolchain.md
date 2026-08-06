# Project-Owned Rush Toolchain

Rush Delivery `v0.9.0` lets a repository add deterministic executables to the
shared Rush workflow image through `.dagger/toolchains/rush.yaml`. The contract
is intentionally narrow: immutable base image, checksummed HTTPS downloads, and
fixed executable destinations. It is not a general container build script.

Projects without this file keep the exact existing Node-only toolchain spec,
hash, provider cache reference, and provider-off behavior.

## Contract

Use the exact versioned
[`rush-toolchain` schema](../schemas/v0.9.0/rush-toolchain.schema.json). The same
metadata is available as a tested
[configuration fragment](../examples/deployment-environment-compatibility/rush-toolchain.yaml):

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/rush-toolchain.schema.json
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

The configured base must be digest-pinned Linux/amd64 and provide Bash,
Node.js 24, `apt-get`, and the Debian behavior needed by the standard Rush
bootstrap. The supported pattern is a pinned `node:24-bookworm-slim` image.
Rush Delivery runs capability/version preflight before contacting project
download URLs.

Each of 1–16 ordered downloads has:

- an HTTPS URL without userinfo, query, fragment, credentials, or interpolation;
- a lowercase SHA-256 digest;
- `raw` or `tar_gz` format;
- one normalized `archive_path` exactly when using `tar_gz`;
- a unique direct child of `/usr/local/bin` as its destination; and
- executable mode fixed to the string `"0755"`.

See the schema for the exact syntax. Unknown fields are rejected. Shells,
commands, environment maps, package-manager hooks, arbitrary destinations, and
secret injection are not part of this metadata version.

## Download And Extraction Guarantees

Rush Delivery transfers each URL in a framework-owned, digest-pinned helper
container. It enforces HTTPS on the first request and every redirect, at most
five redirects, a 30-second connection timeout, a 300-second total timeout, and
a 256 MiB compressed-byte limit.

The declared SHA-256 is verified before extraction or installation. For a tar
archive, the named member must occur exactly once, be a regular file rather
than a link, and declare no more than 256 MiB before extraction. The extracted
file is checked again for regular-file/link status and size, then copied to its
fixed destination with mode `0755`.

Download data never becomes a module-process string. No workflow/deploy host
environment, runtime file, application-image provider value, or arbitrary
secret is supplied to project toolchain construction.

## Lifecycle And Cache Identity

Configured metadata produces `rush-delivery-toolchain-image/v2`. The toolchain
image hash includes metadata version, pinned base, platform, and every field of
every download in order, plus the framework's fixed Rush bootstrap. Reordering
downloads or changing any checksum changes the cache reference.

The installed tools are available before Rush install, Detect, Build,
validation, Rush-requiring Package work, and npm package Release. OCI-only
Package work does not construct a Rush toolchain it does not use.

Provider behavior remains the same:

- provider `off` builds the configured image in the current Dagger run;
- `github` with `lazy` pulls by spec hash, builds on miss, and publishes after a
  trusted successful path; and
- `github` with `pull-or-build` pulls or builds locally without publishing.

Toolchain-provider registry credentials remain explicit framework capabilities.
They do not become toolchain environment variables and are never hashed.

## Safe Update Procedure

1. Select the upstream release and `linux/amd64` asset from an authenticated
   operator workstation.
2. Download the asset independently and calculate SHA-256. Do not copy a digest
   from an untrusted mirror or from the same transport without verification.
3. For `tar_gz`, list the archive and record the exact regular-file member.
4. Update URL, checksum, archive path, and destination together in a reviewed
   change.
5. Validate metadata before a build:

   ```sh
   dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
     call validate-metadata-contract --repo=.
   ```

6. Run a provider-off validation and assert the tool's version before the first
   package command that needs it.
7. In a trusted non-production run, use the normal `lazy` toolchain provider to
   populate the new content-addressed cache. PR jobs can then use
   `pull-or-build` without write permission.
8. Promote the same reviewed metadata to production. Do not copy a cache tag
   between different metadata hashes.

## Failure Guide

| Failure                               | Meaning                                                  | Operator action                                                                                                              |
| ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Base preflight fails                  | The selected base is outside the Node 24 Debian contract | Choose a supported digest-pinned base; do not add arbitrary bootstrap commands                                               |
| HTTPS/redirect/timeout/size failure   | Transfer did not satisfy framework bounds                | Verify upstream availability and asset size; mirror only under an approved HTTPS origin and update the URL/checksum together |
| Checksum mismatch                     | Downloaded bytes are not the reviewed asset              | Stop; inspect upstream provenance or compromise before changing the digest                                                   |
| Member missing/duplicated/not regular | Archive layout or type is unsafe or changed              | Inspect the new archive independently and update to one exact regular member                                                 |
| Tool missing in Rush scripts          | Destination or selected metadata is wrong                | Validate `.dagger/toolchains/rush.yaml` and run provider off to avoid a stale provider diagnosis                             |
| Provider auth error                   | Cache registry capability failed                         | Fix provider credentials/permissions; do not treat auth failure as a cache miss                                              |

Follow the [mixed Node/Python tutorial](tutorial/15-mixed-node-python-toolchain.md)
for a complete first rollout and the [upgrade guide](upgrade-v0.9.0.md) for
compatibility and recovery.
