---
id: "oci-application-images"
title: "OCI Application Images"
sidebar_label: "OCI Application Images"
description: "Publish verified application images and deploy immutable digests."
---

Rush Delivery `v0.9.0` can package a deploy target as a single-platform OCI
image, publish it, sign and attest the immutable digest, and hand that digest to
project-owned Deploy code. This page is the production contract and operator
runbook. Follow the [end-to-end tutorial](../tutorial/oci-application-images)
for a first deployment, use the [registry recipes](../oci-registry-recipes) to
configure a provider, and use the
[troubleshooting guide](../oci-application-image-troubleshooting) during an
incident.

Application images are opt-in. Projects whose selected artifacts are only
`directory` or `rush_deploy_archive` do not need an application-image provider,
OCI credentials, or a configuration change. For the complete compatibility
boundary, see the [v0.8.1 to v0.9.0 upgrade guide](../upgrade-v0-9-0).

## Architecture And Trust Boundaries

```text
project source
    |
    v
Source acquisition --> initial metadata validation (provider file skipped)
    |
    v
Detect --> selected package targets --> conditional provider activation
    |                                    (metadata and names only)
    v
Rush install + Rush Build
    |
    v
Package barrier
    |-- validate/materialize every selected filesystem artifact
    |-- one offline Cosign key-pair preflight per selected provider
    `-- prepare every selected OCI target in parallel
          build --> export exact subject --> SPDX SBOM --> Grype scan
    |
    | starts only after every preparation succeeds
    v
ordered OCI finalization, one selected target at a time
    publish --> validate returned digest --> provenance --> sign
            --> attest SPDX + provenance --> verify all three
    |
    v
packaged directory (trusted release-control bundle)
    |-- .dagger/runtime/package-manifest.json       unsigned
    |-- .dagger/runtime/application-image-credential-capability.json
    |                         names only; internal; named providers only
    `-- .dagger/runtime/evidence/<target>/*         locally hashed
    |
    v
Deploy preflight for every selected target
    manifest invariants --> expected source SHA --> credential-name boundary
                        --> local evidence hashes
    |
    v
project-owned Deploy script
    `-- consumes repository@sha256:...; no rebuild or tag lookup
```

There are three separate trust claims:

1. Package uses the configured public key to cryptographically verify the
   digest-bound signature and the SPDX and provenance attestations in the
   registry.
2. Deploy validates an already supplied manifest and local evidence bundle. It
   does not contact the registry, resolve provider credential values, or run
   Cosign again. For an accepted named-provider planned OCI artifact or a
   published OCI artifact, it uses the names-only boundary frozen by Package so
   provider credential names cannot be projected into project Deploy code.
   Older bundles without that internal handoff fall back to provider metadata.
3. The operator protects the complete packaged directory and supplies an
   independently trusted full Git SHA and bundle identity. Rush Delivery cannot
   detect an attacker who can replace both an unsigned manifest and all evidence
   consistently.

## Metadata Contract

### OCI package target

Declare one artifact in `.dagger/package/targets/<target>.yaml`. The target name
must agree with the Rush project, services mesh, package filename, and Deploy
target. The complete constraints are in the immutable
[`v0.9.0` package-target schema](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/schemas/v0.9.0/package-target.schema.json).

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/package-target.schema.json
name: control-plane-api
artifact:
  kind: oci_image
  context: apps/control-plane-api
  dockerfile: apps/control-plane-api/Dockerfile
  image: control-plane-api
  platform: linux/amd64
  scan:
    fail_on:
      - high
      - critical
    ignore_file: .dagger/application-images/grype.yaml
```

| Field                       | Required | Contract                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                      | Yes      | One evidence-safe path segment made from ASCII letters, digits, `@`, `.`, `_`, or `-`, but not `.` or `..`. It must match the metadata filename and a Rush project during metadata-contract validation. OCI names containing `/`, `\\`, whitespace, or another path separator fail during metadata parsing/planning before Rush Build. |
| `artifact.kind`             | Yes      | Exactly `oci_image` for this artifact contract.                                                                                                                                                                                                                                                                                        |
| `artifact.context`          | Yes      | Normalized repository-relative directory, or `.` for the repository root.                                                                                                                                                                                                                                                              |
| `artifact.dockerfile`       | Yes      | Normalized repository-relative file contained by `context`; it cannot be the context directory itself.                                                                                                                                                                                                                                 |
| `artifact.image`            | Yes      | Lowercase relative repository suffix. It contains no registry, tag, or digest. `/`, `.`, `_`, and `-` are allowed only in normalized name segments.                                                                                                                                                                                    |
| `artifact.platform`         | Yes      | One normalized OCI platform such as `linux/amd64`. `v0.9.0` supports exactly one platform.                                                                                                                                                                                                                                             |
| `artifact.scan.fail_on`     | Yes      | Non-empty unique list drawn from `critical`, `high`, `medium`, `low`, and `negligible`. This is an exact set, not a threshold.                                                                                                                                                                                                         |
| `artifact.scan.ignore_file` | No       | Normalized repository-relative path to a Grype YAML configuration. Rush Delivery passes it to Grype with `--config`.                                                                                                                                                                                                                   |
| `build.pass_env`            | No       | Host names projected unchanged into Rush Build. Active application-provider credential names are forbidden.                                                                                                                                                                                                                            |
| `build.map_env`             | No       | Output name to host-source-name mapping. Both sides are checked against active provider credential names.                                                                                                                                                                                                                              |
| `build.dry_run_defaults`    | No       | Dry-run fallback values for Build inputs. Active provider credential names are forbidden.                                                                                                                                                                                                                                              |

All paths resolve from the repository root. The normal `workflow` and
`buildAndPackageDeployTargets` entrypoints run Rush Build before Package, so the
Dockerfile can consume compiled output. Standalone `packageDeployTargets`
accepts an already-built directory and does not run Build. That directory is a
trusted input: Package snapshots the provider credential-name boundary it sees
at invocation and cannot recover metadata from before an independently run
Build. Prefer `buildAndPackageDeployTargets`, which captures the boundary before
Build and carries it through Package.

The final repository is:

```text
<provider.registry>/<provider.repository_prefix>/<artifact.image>
```

Image suffixes selected together must not collide in the same provider
namespace. Rush Delivery uses the deterministic navigation tag
`sha-<full-git-sha>`; a collision would make two targets contend for one tag.
Deploy never consumes that tag.

### Application-image provider

Providers live only at `.dagger/application-images/providers.yaml`. They are
independent of source, toolchain-image, Rush-cache, npm, and deployment-platform
authentication. See the immutable
[`v0.9.0` provider schema](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/schemas/v0.9.0/application-image-providers.schema.json).

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  release:
    kind: oci_registry
    registry: ghcr.io
    repository_prefix: example/rush-delivery-images
    username_env: RD_OCI_USERNAME
    token_env: RD_OCI_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

| Field                                         | Required | Contract                                                                                                                                                                                               |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providers.<name>`                            | Yes      | Normalized lowercase provider name; `off` is reserved. One named provider is selected for all OCI targets in an invocation.                                                                            |
| `kind`                                        | Yes      | Exactly `oci_registry`.                                                                                                                                                                                |
| `registry` / `registry_env`                   | XOR      | Choose a static lowercase authority or the name of a public Package routing value. Authorities allow an optional port but no scheme/path.                                                              |
| `repository_prefix` / `repository_prefix_env` | XOR      | Choose a static normalized lowercase repository path or the name of a public Package routing value. Values contain no registry, tag, digest, or interpolation.                                         |
| `username_env`                                | Yes      | Globally unique environment name containing the registry username. The value is a framework-owned non-secret string required by Dagger registry authentication and is never projected to project code. |
| `token_env`                                   | Yes      | Environment name containing the registry token/password. The selected live value becomes a Dagger secret immediately.                                                                                  |
| `signing_key_env`                             | Yes      | Environment name containing a password-protected Cosign private key. Literal `\n` sequences are decoded.                                                                                               |
| `signing_password_env`                        | Yes      | Environment name containing the Cosign private-key password.                                                                                                                                           |
| `verification_key_env`                        | Yes      | Environment name containing the matching Cosign public key. Literal `\n` sequences are decoded.                                                                                                        |

All five credential names must be distinct within a provider and globally
unique across every declared provider. Public coordinate names must be distinct
from one another and every application/Rush-cache/toolchain/npm/source
credential capability, `GIT_SHA`, `DRY_RUN`, and `ARTIFACT_*`. Validation
rejects aliases before reading any value;
this prevents a secret role from being reused through Dagger's non-secret
registry-username channel and keeps diagnostics names-only. Rush Delivery also
detects a provider name projected into project Build, npm Release, or Deploy
code, but it cannot detect the same underlying secret value copied under a
different name.

### Provider activation

Provider activation follows the selected artifacts, not a global option that
may be unused.

| Selected package artifacts | Provider option                           | Run         | Result                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No OCI artifact            | Any value, including malformed or unknown | Dry or live | Ignore the unused option. Do not load provider metadata or credentials and do not run OCI tools.                                                                                                                   |
| OCI artifact               | `off`                                     | Dry         | Emit relative planned image intent. Do not load provider metadata or credentials.                                                                                                                                  |
| OCI artifact               | Named                                     | Dry         | Load and validate the provider file, resolve only required public coordinates, validate the planned repository and cross-file boundary. Do not resolve/use provider credentials, create secrets, or run OCI tools. |
| OCI artifact               | `off`                                     | Live        | Fail before Rush Build, image build, destination-registry access, or Deploy. Source acquisition may already have run.                                                                                              |
| OCI artifact               | Named                                     | Live        | Resolve/validate public coordinates and cross-file ownership before Build; resolve only the selected provider's five credential values when live Package starts.                                                   |

Invocation-scoped execution initially validates the repository without parsing
the provider file, then Detect and package planning decide whether OCI is
selected. This keeps filesystem-only execution independent of unused OCI
metadata. The explicit `validateMetadataContract` entrypoint is intentionally
stricter: it validates every provider file that is present and checks all
provider credential-name collisions across repository metadata, even without a
particular invocation selection.

For `workflow`, coordinates come from the equal-only merge of `workflowEnvFile`
and `deployEnvFile`; conflicting duplicates fail. Standalone Package producers
use only `deployEnvFile`. Package normalizes the coordinates once and threads
the canonical repository through publication, evidence, manifest, and cleanup.
Deploy never reloads provider metadata or the current environment to rebuild a
repository. Follow the
[environment-profile tutorial](../tutorial/oci-application-images/environment-profiles).

Standalone `deployRelease` applies the same principle to the supplied manifest.
After manifest/source preflight succeeds, if no selected artifact is a published
OCI artifact or a planned OCI artifact with `repository`, it does not read
application-provider metadata. If any selected artifact meets either condition,
Deploy uses the names-only credential capability that Package wrote after Build
and protects the five credential names from **every** provider that was declared
before a composed Build, across all selected Deploy targets. A planned artifact
can reach this boundary only in a dry run. Deploy does not select a provider,
resolve a credential value, authenticate to a registry, or run Cosign. For
compatibility with an older package bundle that has no capability handoff,
Deploy reconstructs the same names-only boundary from
`.dagger/application-images/providers.yaml`. A provider-off planned OCI bundle
has no `repository` and remains provider-independent. Never edit or selectively
copy `.dagger/runtime` files between Package and Deploy; transport the complete
packaged directory under one externally protected identity.

## Entrypoints

The public Dagger API uses camelCase names; the CLI renders them in kebab case.
All directory-returning package entrypoints write
`.dagger/runtime/package-manifest.json` into the returned directory.

| Entrypoint                     | OCI inputs                                                                                                           | Output and production use                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`                     | `gitSha`, `applicationImageProvider`, source coordinates, and workflow/deploy env files                              | Composes Source, Detect, Build, Package, and Deploy. It is the normal all-in-one path and returns Deploy JSON text. OCI publication completes before Deploy starts.                                                                                                                                                                                                                                                                          |
| `packageDeployTargets`         | Already-built `repo`, CI-plan file, full `gitSha`, optional source URL, deploy env file, provider, and dry/live mode | Packages selected artifacts and returns a Dagger directory. It never runs Rush Build. The already-built directory and its provider/deploy metadata are trusted inputs at Package invocation; prefer the combined producer when Build could modify metadata.                                                                                                                                                                                  |
| `buildAndPackageDeployTargets` | Source `repo`, CI-plan file, full `gitSha`, optional source URL, deploy env file, provider, and dry/live mode        | Runs Build then Package and returns one packaged directory. This is the preferred split-stage producer.                                                                                                                                                                                                                                                                                                                                      |
| `deployRelease`                | Packaged `repo`, full expected `gitSha`, selected targets, package-manifest file, deploy env, and dry/live mode      | Validates the supplied bundle and returns Deploy JSON text. It neither rebuilds nor resolves a tag. `applicationImageProvider` is not an input because registry publishing is already complete. For a selected named-provider plan or published OCI artifact, it uses Package's frozen names-only capability (or the provider-metadata fallback for an older bundle) and rejects every selected Deploy projection of a protected credential. |

See [Entrypoints](../entrypoints) for every general input. A package operation
requires a full 40-character hexadecimal Git SHA for OCI intent, including dry
runs, and normalizes it to lowercase. Live publication also uses the normalized
SHA for the source label, provenance, and navigation tag.

The optional source repository locator is public provenance and label data, not
an authentication channel. Rush Delivery accepts absolute Git, HTTP(S), or SSH
repository URLs and narrowly validated `git@host:path` locators. It rejects URL
password/userinfo (except the literal SSH user `git`), query strings, fragments,
whitespace, control characters, and arbitrary SCP-like strings without echoing
the rejected value. Supply source authentication only through the explicit
Source capability.

## Capability And Environment Ownership

Supplying an env file makes values available to framework coordination; it does
not authorize every stage to project every value. Metadata and explicit adapter
inputs define the capability boundary.

| Capability                          | Values it may consume                                                                                           | Application-provider credential rule                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source acquisition                  | The explicitly named source auth token and optional username                                                    | May read a provider-named variable only if the caller separately names it as Source auth. No automatic reuse occurs. Prefer a dedicated read-only source token.                                                                                                                                                                                            |
| Toolchain-image adapter             | Names declared by the selected toolchain provider                                                               | Framework-owned explicit use is retained. It does not project application credentials into project code. Prefer separate credentials.                                                                                                                                                                                                                      |
| Rush-cache adapter                  | Names declared by the selected cache provider                                                                   | Framework-owned explicit use is retained. Prefer a separately scoped cache credential.                                                                                                                                                                                                                                                                     |
| Rush Build                          | Only `build.pass_env`, `build.map_env`, and dry-run defaults                                                    | Every credential name declared by every provider in the active provider file is rejected on both sides of mappings and in pass/default fields.                                                                                                                                                                                                             |
| OCI Package tools                   | Exactly the selected provider's username, token, private key, password, public key, and generated Docker config | The token, key material, password, public key, and Docker config are Dagger secrets. The username remains framework-owned and is not projected or returned, but Dagger's progress graph may display it because registry auth accepts a plain username. Preparation receives no provider secrets.                                                           |
| npm Release                         | The npm `auth.token_env` and npm lifecycle environment                                                          | In a composed workflow that activates an application provider, an application-provider credential name is rejected as npm auth.                                                                                                                                                                                                                            |
| Deploy-tag and release-Git adapters | The explicitly configured Git token                                                                             | Framework-owned explicit use is retained. It is not automatic application-provider projection.                                                                                                                                                                                                                                                             |
| Project Deploy script               | Only its runtime metadata plus Rush Delivery's artifact/control variables                                       | Provider credential names are rejected from all runtime projection and host-file channels. Package freezes the pre-Build name-only boundary for composed and split-stage Deploy; an older bundle without that internal handoff falls back to current provider metadata. Registry publishing credentials never become deployment-platform pull credentials. |

The protected-name check covers `username_env`, `token_env`,
`signing_key_env`, `signing_password_env`, and `verification_key_env` from every
declared provider once a provider is active, or once standalone Deploy selects
a named-provider/published OCI artifact. Errors identify the provider, target,
metadata field, and environment name, but never read or print the value.

Public entrypoints parse a supplied aggregate env file for every configured
capability. Consequently, a dry/no-OCI invocation that receives such a file may
read its bytes while parsing it; the application-provider subsystem does not
index, resolve, use, log, or convert provider-named entries into Dagger secrets.
For the narrowest boundary, omit live OCI values—and preferably the entire env
file—from dry/no-OCI calls. Registry usernames must be non-secret because
Dagger's client progress/call graph can show the plain registry-auth username.

### Framework-owned Deploy variables

Rush Delivery reserves all names beginning with `ARTIFACT_`, including names it
may add later, plus `GIT_SHA` and `DRY_RUN`. Deploy metadata cannot declare a
reserved name in `runtime.env`, `runtime.pass_env`, a `runtime.map_env` output,
`runtime.dry_run_defaults`, `runtime.required_host_env`, or a host-path
`runtime.file_mounts[].source_var`. Equal values are still an ownership
collision. A `map_env` source name is a host lookup rather than a project output,
but it remains subject to provider credential protection when OCI is active.

| Variable                        | Filesystem artifact        | Planned OCI in a Deploy dry run        | Published OCI                                  |
| ------------------------------- | -------------------------- | -------------------------------------- | ---------------------------------------------- |
| `ARTIFACT_PATH`                 | `/workspace/<deploy_path>` | Absent                                 | Absent                                         |
| `ARTIFACT_KIND`                 | Absent                     | `oci_image`                            | `oci_image`                                    |
| `ARTIFACT_IMAGE_NAME`           | Absent                     | Relative `artifact.image`              | Relative `artifact.image`                      |
| `ARTIFACT_IMAGE_REFERENCE`      | Absent                     | Absent                                 | Exact `repository@sha256:<digest>`             |
| `ARTIFACT_IMAGE_REPOSITORY`     | Absent                     | Present only for a named-provider plan | Present                                        |
| `ARTIFACT_IMAGE_DIGEST`         | Absent                     | Absent                                 | Lowercase `sha256:<64 hex>`                    |
| `ARTIFACT_IMAGE_PLATFORMS_JSON` | Absent                     | JSON array containing one platform     | JSON array containing one platform             |
| `ARTIFACT_SOURCE_REVISION`      | Absent                     | Full source SHA                        | Full source SHA                                |
| `ARTIFACT_EVIDENCE_DIR`         | Absent                     | Absent                                 | `/workspace/.dagger/runtime/evidence/<target>` |
| `GIT_SHA`                       | Current invocation SHA     | Current invocation SHA                 | Independently supplied expected SHA            |
| `DRY_RUN`                       | `1` or `0`                 | `1`                                    | `0`                                            |

Rush Delivery constructs project and framework environments separately, rejects
collisions, and applies framework values last. Each result and dry-run summary
comes from that invocation's final environment. Dry and live summaries are not
byte-identical because `DRY_RUN`, defaults, published identity, and evidence
differ.

### Workspace and evidence isolation

For `runtime.workspace.mode: full`, Deploy receives the full packaged workspace
except `.dagger/runtime/evidence`. For a partial workspace, every requested
file/directory is selected from the same evidence-filtered view. Explicitly
requesting the evidence directory or one of its descendants is rejected; asking
for a parent such as `.dagger` is allowed, but the framework evidence subtree is
still removed.

After generic workspace assembly, Rush Delivery mounts only the current
published OCI target's already-verified evidence at
`ARTIFACT_EVIDENCE_DIR`. Other OCI targets' evidence is unavailable, and
filesystem or planned OCI targets receive no evidence mount. Deploy-platform
credentials can be supplied through `runtimeFiles` and `runtime.file_mounts`,
but OCI registry tokens and Cosign keys must never be placed there.
Repository-backed host-path sources are normalized before use and cannot point
at `.dagger/runtime/evidence` or any descendant. File resolution also uses an
evidence-stripped repository view, so a safe-looking symlink cannot resolve
back into another target's evidence. Ordinary symlinks whose targets remain
outside that subtree continue to work. Package materializes the post-Build
non-runtime `.dagger` tree as a concrete directory, preserving project-owned
outputs there, and creates a fresh `.dagger/runtime` before writing the
manifest, frozen credential-name capability, or evidence. Deploy fails closed
if a supplied bundle aliases
`.dagger`, `.dagger/runtime`, or `.dagger/runtime/evidence` through a symlink.
The destination of either file
mount form is normalized independently and cannot equal, descend from, or be a
parent that could mask `/workspace/.dagger/runtime/evidence`. These checks run
in the schema/parser where representable and again at execution for direct or
legacy internal callers.

## Package Security Pipeline

### Key normalization and offline preflight

Flat env files contain one `NAME=value` per line. Public examples therefore
store PEM line breaks as the two characters `\n`; Rush Delivery decodes them.
Raw multiline PEM is accepted by internal normalization but is not a valid
multiline flat-env record.
If a physical record is malformed, its diagnostic contains only the line number
and a redaction marker; it never repeats the raw line, invalid name, or value.

Rush Delivery first materializes the pinned Cosign image and a digest-pinned
static BusyBox shell helper without attaching provider secrets. It copies only
the BusyBox binary into the Cosign container. Pull, DNS, or TLS failure for
either image at that point is a sanitized preflight-tool availability error,
not a credential-role diagnosis. After normal Rush Build and selected
filesystem package materialization, but before any selected application image
is built, scanned, authenticated to its destination, or published, it runs one
Cosign preflight for the selected live provider. The preflight:

1. decrypts the password-protected private key;
2. derives its public key;
3. signs a fixed local challenge;
4. verifies the challenge with the derived key; and
5. verifies it with the configured public key.

This proves that the private key is usable with the supplied password and that
the public key matches. Failures expose only the provider and credential role.
The four Cosign commands run in one shell exec so the challenge, derived public
key, signature bundle, and captured tool diagnostics exist only on one temporary
mount. The operation is cryptographically offline, but Dagger may need ordinary
network access to pull both pinned preflight tool images before it runs.

Keep the private key and password in a protected secret manager. Keep old public
keys and the release bundles that they verified for at least as long as the
associated image can be deployed or audited. The v2 manifest does not record a
key fingerprint, so key inventory, activation time, rotation, revocation, and
release-to-key mapping are operator records. Losing the private key prevents new
signatures; losing the matching public-key history weakens later auditability.
Use Sigstore's current
[self-managed-key guidance](https://docs.sigstore.dev/cosign/key_management/signing_with_self-managed_keys/)
for key generation and custody, while retaining Rush Delivery's stricter
password-protected PEM and flat-env encoding requirements.

### Preparation barrier and ordered finalization

Live packaging reaches the OCI phases only after normal Rush Build and all
selected filesystem package validation/commands have materialized successfully:

- Preparation builds each selected image, exports that exact container subject,
  validates the SPDX document, and scans the subject. OCI preparations run in
  parallel and all started work is awaited. Selected directory/archive
  validations and materialization also complete before publication.
- Finalization runs one target at a time in stable selected-target order. It
  publishes, validates the returned reference, creates provenance, signs,
  attaches SPDX and provenance attestations, verifies them, and constructs local
  evidence.

If any preparation fails, no selected application image is published. If a
finalization fails, later targets are not started. The error reports earlier
known published siblings, a canonical reference for the failed target when one
is known, later skipped targets, and a sanitized cleanup warning. All operations
already started are awaited.

Publication is not transactional. Rush Delivery does not attempt
provider-specific deletion and does not write a successful package manifest or
start Deploy after finalization failure. A registry can still contain an image,
the `sha-<full-git-sha>` navigation tag, a signature, or one of the attestations.
Inspect before retrying.

### Vulnerability policy

`scan.fail_on` is the exact set of rejected normalized severities. It is not a
threshold:

- `[high]` rejects High and does not reject Critical;
- `[critical]` rejects Critical and does not reject High; and
- production policy commonly uses `[high, critical]` to reject both.

Rush Delivery fails closed if Grype output is not an object with a `matches`
array, or if an evaluated match lacks a non-empty vulnerability ID or a
supported severity. An explicit empty `matches` array is valid. `unknown` is not
a selectable severity.

`scan.ignore_file` is an ordinary repository-owned Grype configuration passed
through `--config`; it is not a Rush Delivery suppression format. A minimal
configuration is:

```yaml
# Owner: platform-security
# Reason: no active exception; add only a narrow supported Grype rule.
# Review/expiry: not applicable
# Removal follow-up: delete each rule when its remediation ships.
ignore: []
```

For a real exception, use only fields supported by the pinned Grype
configuration, and record reason, owner, review/expiry date, and removal action
in adjacent comments or a governed external record. The canonical example is
[`grype.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/examples/oci-application-image-rush-repo/.dagger/application-images/grype.yaml).

The Grype executable is immutable, but its vulnerability database is not. The
container uses a cache keyed by the Grype version and may check/download
network-supplied database data. Findings can change between otherwise identical
runs as feeds and mappings change. Production runners need outbound access to
the database service or a deliberately governed cache/mirror, sufficient
download time, and monitoring for freshness. Database unavailability, stale-age
enforcement, malformed output, or unsupported severity fails the Package gate;
do not reinterpret it as a clean scan.

### Tool and Cosign mode

| Tool                     | Version       | Digest-pinned image                                                                                      |
| ------------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| Syft                     | `1.50.0`      | `anchore/syft@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026`                   |
| Grype                    | `0.116.1`     | `anchore/grype@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db`                  |
| Cosign                   | `3.1.2`       | `ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849` |
| BusyBox preflight helper | `1.37.0-musl` | `busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`            |

Signing, challenge signing, and both attestations use
`--use-signing-config=false` to pin the explicit offline key flow and
`--tlog-upload=false` to disable transparency-log upload. Signature and
attestation verification use the configured key with
`--insecure-ignore-tlog`.

All six registry commands (sign, two attestations, signature verification, and
two attestation verifications) also pin `--new-bundle-format=false`. With the
pinned Cosign `3.1.2`, this deliberately selects digest-derived legacy `.sig`
and `.att` tag attachments rather than the OCI 1.1 Referrers API. The two
attestations share the current `.att` image: the second operation reads the
existing attachment, appends provenance, and writes the combined attachment.
A registry may retain the superseded first-attestation manifest as an untagged
historical version, so object counts are inventory—not proof of completeness.
Package verifies the signature and each attestation type independently. This
flag does not apply to the local preflight challenge bundle, enable legacy
Docker media types, or permit insecure transport.

The compatibility mode is pinned to Cosign `3.1.2`; that CLI marks the flag as
deprecated. A future Cosign upgrade must re-prove the flag contract, registry
storage behavior, cleanup, and live acceptance before changing the pin. Do not
run concurrent Package finalization or key rotation for the same digest: the
shared `.att` attachment is a read/append/write object. Serialize publishers for
one subject to avoid lost updates or mixed-key verification failures.

For the six registry Cosign commands, Rush Delivery redirects stdout to distinct
regular files under `/tmp/rush-delivery-cosign-*.stdout` inside the ephemeral
Cosign container. Dagger `v0.20.7` cannot use `/dev/null` for its
`redirectStdout` option: it rejects that special path before starting Cosign.
The temporary stdout files are not exported, retained, or treated as evidence;
the validated local evidence documents and successful independent verification
remain the Package contract.

This private-registry-friendly mode proves that the configured key verified the
digest-bound subject signature and the required attestations during Package. It
does not prove Rekor inclusion, keyless workload identity, public transparency,
trusted timestamping, public auditability, or a new cryptographic verification
during Deploy.

### Dagger execution and caching

Rush Delivery gives every public Dagger function an explicit cache scope.
Session-stable inspection calls may reuse results within one session;
state-sensitive calls that execute project code, observe mutable external state,
or can create side effects opt out of Dagger function-result caching.

Function caching and container layer caching are separate. To make repeated,
otherwise identical invocations actually rerun mutable or security-sensitive
operations, Rush Delivery injects a fresh random **non-secret** input before
Cosign preflight/publication, each Grype scan, project Deploy execution, and npm
release. Normal deterministic image-build and safe container-layer caching still
apply; this is not a claim that the whole graph is uncached. See Dagger's
official [function-caching](https://docs.dagger.io/extending/function-caching/)
and [secret-handling](https://docs.dagger.io/extending/secrets/) guidance.

Secrets and derived authorization values must never be written into a cached
filesystem layer. The npm release path therefore uses a static Git askpass
helper whose file contains environment-variable names only; the token is read
from a Dagger secret environment by the Git process and is not stored as a
Basic header in `.git/config`. Cosign preflight's challenge, derived public key,
signature bundle/output, and suppressed tool diagnostics live within one exec on
a dedicated temporary mount rather than a persisted execution layer.

## Evidence And Deploy Verification

Each published artifact points at three local files:

| Evidence           | Local file        | Registry object                      | Meaning                                                                                                                   |
| ------------------ | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| SPDX SBOM          | `sbom.spdx.json`  | Signed `spdxjson` attestation        | Syft-produced SPDX 2.3 JSON for the exact prepared subject. Package validates its minimum document shape.                 |
| Vulnerability scan | `scan.json`       | None                                 | Grype JSON for the prepared subject after the exact-set policy passed. This report is local evidence, not an attestation. |
| Provenance         | `provenance.json` | Signed `slsaprovenance1` attestation | Source revision, source URI, target/build parameters, builder identity, and published subject digest.                     |

`evidence.signature.verified: true` records successful Package-time verification
of the subject signature and required attestations with the configured public
key. `signature.reference` is the immutable image subject used for Cosign
lookup, not a portable address for a standalone signature object.

| Check                                                                        | Package                                  | Deploy                                                    | Operator/platform                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Registry returned a lowercase digest for the expected repository             | Yes                                      | Rechecks manifest agreement only                          | Retain that digest.                                                                        |
| Subject signature is cryptographically valid under the configured public key | Yes, with Cosign                         | No; requires the strict `verified: true` assertion        | Retain key history and the registry signature attachment.                                  |
| SPDX and provenance attestations are cryptographically valid                 | Yes, with Cosign                         | No; requires manifest assertions and local files          | Retain the combined attestation attachment and evidence.                                   |
| Local evidence bytes match manifest SHA-256 values                           | When constructing manifest               | Yes, before any live deploy wave                          | Protect the complete bundle from coordinated replacement.                                  |
| Artifact source revision matches release revision                            | Builds provenance/manifest from full SHA | Compares every selected OCI artifact to supplied `gitSha` | Supply the expected SHA from protected metadata outside the bundle.                        |
| Deployment platform pulls the same image                                     | Provides digest reference                | Passes reference to project script unchanged              | Configure target-platform registry read identity and enforce digest pulls.                 |
| Portable bundle is authentic                                                 | No signed bundle contract                | No                                                        | Store immutably/access-controlled and record its checksum or artifact identity externally. |

Deploy parses strict v2 manifests, requires lowercase digest-only references,
checks exact repository/reference and source-revision agreement, validates
target-contained evidence paths, and hashes local evidence before the first live
deploy wave. A live Deploy rejects a planned OCI artifact. It performs no
registry query and no Cosign operation.

## Manifest Examples

The exact schema is
[`package-manifest.schema.json`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/schemas/v0.9.0/package-manifest.schema.json).
All hashes below are synthetic but full length.

### Legacy filesystem-only manifest

Directory/archive-only output keeps the unversioned shape:

```json
{
  "artifacts": {
    "webapp": {
      "deploy_path": "apps/webapp/dist",
      "kind": "directory",
      "path": "apps/webapp/dist"
    }
  }
}
```

### Planned OCI manifest

A named-provider dry run includes `repository`; provider `off` omits it.
Neither form contains a digest, reference, evidence, or success assertion.

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "repository": "ghcr.io/example/rush-delivery-images/control-plane-api",
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "planned"
    }
  }
}
```

### Published OCI manifest

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evidence": {
        "provenance": {
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "format": "slsa-provenance-v1",
          "path": ".dagger/runtime/evidence/control-plane-api/provenance.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "sbom": {
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "format": "spdx-json",
          "path": ".dagger/runtime/evidence/control-plane-api/sbom.spdx.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "scan": {
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "path": ".dagger/runtime/evidence/control-plane-api/scan.json",
          "policy": ["high", "critical"],
          "result": "passed",
          "scanner": "grype-0.116.1"
        },
        "signature": {
          "kind": "sigstore",
          "reference": "ghcr.io/example/rush-delivery-images/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "verified": true
        }
      },
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "reference": "ghcr.io/example/rush-delivery-images/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "repository": "ghcr.io/example/rush-delivery-images/control-plane-api",
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "published"
    }
  }
}
```

### Mixed v2 manifest

Filesystem fields stay unchanged inside the strict v2 envelope:

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "webapp": {
      "deploy_path": "apps/webapp/dist",
      "kind": "directory",
      "path": "apps/webapp/dist"
    },
    "control-plane-api": {
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "planned"
    }
  }
}
```

### Deploy results

A filesystem result retains `artifactPath`:

```json
{
  "artifactPath": "/workspace/apps/webapp/dist",
  "output": "webapp deployed\n",
  "status": "success",
  "target": "webapp",
  "wave": 1
}
```

A published OCI result has image identity and never fabricates
`artifactPath`:

```json
{
  "artifactImage": "control-plane-api",
  "artifactKind": "oci_image",
  "artifactReference": "ghcr.io/example/rush-delivery-images/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "output": "control-plane-api deployed\n",
  "status": "success",
  "target": "control-plane-api",
  "wave": 1
}
```

A planned OCI dry-run result has `artifactImage` and `artifactKind` but omits
`artifactReference`.

## Production Readiness Checklist

Before the first live publication:

- Pin the Action/module and editor schemas to `v0.9.0`.
- Validate metadata with `validate-metadata-contract`, then run provider-off and
  named-provider dry runs.
- Use a trusted-TLS registry whose image, signature, and attestation behavior
  has passed a pre-production live test. See
  [Registry recipes](../oci-registry-recipes).
- Create every required destination repository and give the publisher only
  image plus digest-derived signature/attestation tag push and verification-read
  access. Give cleanup to a separate operator when practical.
- Configure the target platform with a distinct pull-only identity.
- Generate a password-protected Cosign key, protect the private key/password,
  record the public-key inventory, and test rotation and recovery.
- Store PEM values with literal `\n` in flat env inputs and verify a local
  encode/decode round trip without printing them.
- Set a deliberate exact scan policy and govern every Grype ignore rule.
- Allow the pinned tool-image pulls and Grype database traffic, and monitor
  database freshness.
- Configure registry retention for digest subjects, navigation tags, signatures,
  and attestations for at least the release and rollback window.
- Store the complete packaged directory as a mode/symlink-preserving archive in
  immutable or access-controlled storage. Record its checksum/identity and full
  Git SHA in protected release metadata outside that archive.
- Make Deploy consume `ARTIFACT_IMAGE_REFERENCE` unchanged and use
  `ARTIFACT_EVIDENCE_DIR`; do not resolve the navigation tag.
- Set the GitHub Action `docker-socket: ""` for OCI-only jobs. A mounted host
  Docker socket grants project Deploy code effective control over the runner's
  Docker daemon and can bypass Dagger workspace and secret-file isolation by
  asking that daemon to mount host paths. The non-empty Action default exists
  only for compatibility with trusted legacy project deploy scripts that invoke
  Docker; never expose it to untrusted checkout code.
- Test partial-publication discovery, provider-specific cleanup, retained-digest
  rollback, and deployment-platform pull authorization.

## Failure And Side-Effect Matrix

“Manifest” below means a successful manifest for this Package invocation.
Errors and logs may include target/provider names, stages, and canonical digest
references, but never credentials or Docker auth payloads.

| Failure point                                                                                           | Registry mutation possible?                                                                          | Successful manifest from this attempt / Deploy?      | Safe diagnostic                                                                                                           | Retry and cleanup                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package provider file/selection or protected/reserved-name validation                                   | No application-image mutation                                                                        | No / No                                              | Metadata path, provider/target/field names, and validation text                                                           | Correct metadata and retry.                                                                                                                                                                    |
| Standalone Deploy frozen capability, legacy provider fallback, or credential-name boundary              | No new mutation; a prior Package can already have published                                          | Existing supplied bundle only / No target starts     | Provider/target/field/environment names only                                                                              | Restore the complete valid bundle or remove the project projection, rebuild the trusted bundle, and retry Deploy. Never remove runtime handoff or manifest identity files to bypass the check. |
| Selected credential name/value lookup                                                                   | No                                                                                                   | No / No                                              | Provider name, credential role, and secret-manager version/presence status                                                | Correct the missing named value and retry. Never print the env file.                                                                                                                           |
| Preflight tool availability before key checks                                                           | No destination mutation; pinned Cosign and BusyBox image pulls may be attempted                      | No / No                                              | Pinned image/version, provider name, sanitized network/cache stage                                                        | Restore trusted registry/DNS/TLS/cache availability and retry. Do not rotate keys based on this error.                                                                                         |
| Cosign key preflight                                                                                    | No destination mutation; both pinned preflight tools are already available                           | No / No                                              | Provider, key role, controlled key-version/fingerprint inventory, and sanitized stage                                     | Correct private key, password, or public key and retry. Do not print either key.                                                                                                               |
| Filesystem artifact validation/materialization                                                          | No OCI publication                                                                                   | No / No                                              | Target, expected relative path, validation, and sanitized filesystem error                                                | Correct the artifact and retry the batch.                                                                                                                                                      |
| Docker build                                                                                            | No destination mutation                                                                              | No / No                                              | Target, platform, context/Dockerfile paths, and sanitized build stage                                                     | Correct context/Dockerfile/build output and retry.                                                                                                                                             |
| SPDX generation or structure validation                                                                 | No                                                                                                   | No / No                                              | Target, pinned Syft identity, and sanitized stage error                                                                   | Fix subject/tool availability and retry.                                                                                                                                                       |
| Grype execution, database, report validation, or policy                                                 | No                                                                                                   | No / No                                              | Target, pinned Grype identity, database status/time, rejected IDs/severities, and sanitized error                         | Restore database availability/freshness or remediate/govern findings, then retry. Do not weaken fail-closed parsing.                                                                           |
| Registry publish request                                                                                | Yes; outcome may be unknown after interruption                                                       | No / No                                              | Expected repository, SHA tag, target, audit/event ID, and sanitized transport class                                       | Inspect the subject and every associated tagged or untagged package version first. Clean or retain deliberately; never automatically replay the whole Package flow.                            |
| Returned-reference validation                                                                           | Yes                                                                                                  | No / No                                              | Expected repository/tag and sanitized returned reference shape                                                            | Treat the namespace as mutated, inspect it, and investigate registry/Dagger compatibility before retry.                                                                                        |
| Provenance construction                                                                                 | Yes, with canonical subject known                                                                    | No / No                                              | Target, canonical subject reference, and sanitized local stage                                                            | Inspect and clean the subject/tag as policy requires; fix locally, then retry manually.                                                                                                        |
| Cosign sign                                                                                             | Yes; subject and possibly signature exist                                                            | No / No                                              | Target, canonical subject, Cosign stage, and key-version inventory; no key bytes                                          | Inspect the subject, attachment tags, and all package versions, then clean or quarantine incomplete objects before a controlled new Package attempt.                                           |
| SPDX or provenance attestation                                                                          | Yes; earlier signature/attestation may exist                                                         | No / No                                              | Target, canonical subject, failed attestation kind, and complete package-version inventory                                | Inventory the `.sig`/`.att` attachments plus untagged history, then apply provider cleanup/retention policy before retry.                                                                      |
| Signature or attestation verification                                                                   | Yes; all objects may exist but are not accepted                                                      | No / No                                              | Target, canonical subject, verification kind, key-version inventory, and sanitized failure                                | Preserve failure evidence, inspect keys and all associated package versions, and clean or quarantine before retry.                                                                             |
| Local evidence hashing/finalization                                                                     | Yes; the subject and all verified Cosign objects may exist                                           | No / No                                              | Target, canonical subject, evidence kind/path, and sanitized local stage; no evidence contents unless separately reviewed | Inspect the subject and associated package versions, diagnose local Dagger/evidence handling, and clean or quarantine before a controlled retry.                                               |
| Later target finalization                                                                               | Earlier siblings may be fully published; failed target may be partial; later targets are not started | No / No                                              | Stable earlier/failed/later target sets and canonical references supplied by the sanitized report                         | Inspect every earlier/failed target. Never assume batch rollback occurred.                                                                                                                     |
| Manifest parsing, source SHA, planned-live, repository/reference, path, or evidence-integrity preflight | No new mutation; prior Package objects remain                                                        | Existing supplied bundle only / No target starts     | External bundle identity/checksum, expected SHA, target, non-secret manifest field/path, and evidence digest              | Restore the correct trusted bundle and expected SHA. Do not edit the manifest to force acceptance.                                                                                             |
| Deploy execution                                                                                        | Registry objects and manifest already exist; deployment-platform side effects may occur              | Yes / Current and earlier wave work may have started | Target/wave, digest reference, deployment event ID, and sanitized script/platform status                                  | Inspect the target platform before retry. Reuse the same digest; do not rebuild or retag as “rollback.”                                                                                        |

Only bounded, side-effect-free readiness/capability probes and immutable reads
are candidates for automatic retry. A transport failure after a publish request
may have crossed the mutation boundary. Classify it as unknown/partial, inspect
the unique repository namespace and all associated package versions, then decide cleanup or manual
retry.

## Trusted Split-Stage Handoff And Rollback

Treat the packaged directory, manifest, and evidence as one release-control
bundle. Persisting only the manifest is insufficient.

1. Export the complete result of `build-and-package-deploy-targets`.
2. Create a deterministic `tar.gz` (or an equivalently reviewed format) that
   preserves file modes and symlinks. Reject absolute paths, `..` members, and
   links that escape the restoration root.
3. Compute SHA-256 over the archive. Store the checksum or immutable CI artifact
   identity and the original full Git SHA in protected metadata outside the
   unsigned archive.
4. Upload the archive atomically to access-controlled immutable storage. Retain
   it for the same window as the image digest and Cosign attachment artifacts.
5. In the protected consumer job, download to a staging location, verify the
   externally recorded checksum before extraction, inspect member/link safety,
   extract into a new directory, and atomically promote the restored tree.
6. Pass the independently recorded Git SHA as `deploy-release --git-sha` and the
   restored manifest as `--package-manifest-file`. Deploy verifies the manifest
   revision, frozen credential-name capability, and evidence hashes before any
   live wave starts.

The three framework paths `.dagger`, `.dagger/runtime`, and
`.dagger/runtime/evidence` must be real directories when present in a packaged
Deploy bundle, not symbolic links. Package preserves post-Build project output
elsewhere under `.dagger`, replaces the entire old runtime path, and writes the
new manifest, names-only capability, and evidence below concrete directories.
Standalone Deploy does not repair a supplied bundle: its common preflight
rejects an alias before either a dry or live target runs.

For rollback, restore an earlier retained archive and verify it against that
release's external checksum/identity and full SHA. Call Deploy with the earlier
SHA and let the script consume the earlier `repository@digest` unchanged. Do not
edit the manifest, rebuild the source, or look up `sha-<sha>` to discover the
digest. Confirm first that the registry still retains the subject and all pull
permissions required by the target platform.

The all-in-one GitHub Action output does not automatically preserve a reusable
packaged directory. Use a raw Dagger package/export step and an explicit CI
artifact handoff for rollback-capable split workflows; the
[split-stage tutorial](../tutorial/oci-application-images/split-stages-and-rollback)
contains the complete command sequence.

## Key Rotation And Retention

Use a staged rotation:

1. Generate a new password-protected key pair in an isolated operator context.
2. Record the new public-key fingerprint, custodian, activation time, and
   affected provider outside Rush Delivery metadata.
3. Update the secret manager and public-key variable together, then run a named
   dry run. It checks metadata, not values.
4. Run a controlled live canary. The Package preflight proves the new pair
   matches before destination mutation.
5. Keep the old public key, bundle checksum/SHA records, manifest/evidence, image
   digest, signature, and attestations through every audit/rollback window for
   releases signed by the old key.
6. Revoke or destroy the old private key according to organizational policy.
   Rotation does not re-sign old releases automatically.

Registry retention must account for both the subject and its Cosign objects.
Before deleting a digest or navigation tag, discover and inventory associated
signatures and attestations with provider-supported tools. Test cleanup rules in
dry-run/preview mode where the provider supports it. Rush Delivery performs no
automatic deletion.

## Current Limitations

- One explicit platform per target; no multi-platform index.
- Dockerfile builds have no Rush Delivery metadata for build arguments, build
  secrets, SSH mounts, or Dockerfile `target` selection.
- Provider coordinates support strict static values or environment-selected
  public values. There is no interpolation, credential-bearing coordinate,
  arbitrary resolver, or Deploy-time repository reconstruction.
- Key-backed Cosign only. No keyless/OIDC identity, Rekor upload/inclusion,
  trusted timestamp, or public transparency mode.
- No public custom-CA or insecure-registry option. The destination must be
  reachable with trusted TLS from Dagger and Cosign.
- Registry support must include image push, a returned digest, and storage and
  retrieval of Cosign's digest-derived `.sig` and `.att` tag attachments. The
  OCI 1.1 Referrers API is neither required nor exercised in `v0.9.0`. OCI
  conformance alone does not prove the complete Rush Delivery path; test the
  exact service.
- No framework-owned Cloud Run, Kubernetes, Swarm, or other vendor deployment.
  Project Deploy code owns platform rollout and pull authentication.
- No automatic deletion or transactional registry rollback.
- No signed portable package manifest and no Deploy-time registry/Cosign
  verification.
- No key fingerprint in the manifest.
- The local Grype report is not a registry attestation, and its database is a
  mutable network/cache input.
- The Action's Docker-socket default is retained for legacy project deploy
  scripts. First-class OCI Package operations do not require that socket.

## Upgrade To v0.9.0

Static providers, provider-off/filesystem projects, package-manifest v2, and
digest-only Deploy remain compatible. Environment-selected coordinates are
additive and opt-in. The one migration-sensitive area is Action local-copy,
whose new caller-side policy defaults to bounded exclusions.

Use the complete [v0.8.1 to v0.9.0 upgrade guide](../upgrade-v0-9-0) for the
compatibility matrix, local-copy inclusion/`legacy` recovery, canary sequence,
new metadata fields, and checksummed launcher installation. Use the
[environment-profile tutorial](../tutorial/oci-application-images/environment-profiles)
when adopting dynamic public coordinates.
