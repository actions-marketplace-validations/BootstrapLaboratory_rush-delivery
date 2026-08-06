---
id: "upgrade-v0-9-0"
title: "Upgrade To v0.9.0"
sidebar_label: "Upgrade To v0.9.0"
description: "Upgrade and recover safely from v0.8.1."
---

Rush Delivery `v0.9.0` adds environment-selected public OCI coordinates,
bounded local-copy imports, and deterministic project-owned Rush tools. It does
not change the package-manifest v2 handoff, provider-off defaults, static OCI
provider behavior, or the unconfigured Node-only toolchain.

## Compatibility Summary

| Existing project                           | Required change                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Git source mode, any existing artifact mix | Update the Action/module tag only                                                                                 |
| Static `oci_registry` provider             | Update the tag only; `registry` and `repository_prefix` remain valid                                              |
| No `.dagger/toolchains/rush.yaml`          | None; toolchain v1 spec/hash/cache behavior is preserved                                                          |
| Filesystem-only or provider-off            | None; OCI provider metadata remains optional/unused                                                               |
| Direct top-level local `dagger call`       | None; released static filters are preserved                                                                       |
| Action `local_copy` or new local launcher  | Review the seven bounded defaults; include an intentionally required matching path or temporarily choose `legacy` |

The only default behavior change is at the new caller-side boundary for Action
`local_copy`: `source-import-policy` defaults to `bounded`. This prevents large
dependency/cache trees from being uploaded. A project that intentionally uses a
matching path must declare a later inclusion in
`.dagger/source-import.ignore`.

## Pre-Upgrade Inventory

Record the current tag, source mode, provider selection, and one successful dry
run. For local-copy callers, locate required paths matching:

```text
**/node_modules
**/.venv
**/__pycache__
**/.rush
**/rush-logs
.trunk/out
.trunk/logs
```

Do not add blanket inclusions. For each required path, identify the entrypoint
that consumes it and add the narrowest `!` rule. Split-stage Package callers
must account for built outputs, `.dagger/runtime`, package manifests, and OCI
evidence explicitly.

## Upgrade References

Update Action and module references:

```yaml
uses: BootstrapLaboratory/rush-delivery@v0.9.0
```

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.9.0
```

Use exact v0.9.0 editor schemas:

```text
https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/<schema>.schema.json
```

If local worktrees are used, install the checksummed launcher exactly as shown
in the [bounded local-copy guide](../local-copy-source-imports).

## Canary Sequence

1. Run `validate-metadata-contract` against the upgraded module.
2. Run provider-off dry runs for the same forced targets used in the v0.8.1
   baseline.
3. If using local copy, run bounded mode and confirm Git history, affected
   targets, and every required re-included output.
4. If adopting environment coordinates, select a non-production profile in a
   named-provider dry run. Confirm the planned repository and that no credential
   value is needed.
5. If adopting a project toolchain, run provider off first and assert the tool
   version in Rush lifecycle scripts. Populate provider cache only from a
   trusted job.
6. Run one live non-production OCI publication. Verify signature,
   attestations, evidence, manifest repository/digest, and digest-only Deploy.
7. Promote the unchanged metadata and version pin to production.

## Optional Feature Adoption

Environment coordinates use exactly one field from each pair:

- `registry` or `registry_env`; and
- `repository_prefix` or `repository_prefix_env`.

They can be adopted independently, so static/environment mixed definitions are
valid. Coordinate values are public routing data. Credential environment names
and values retain the Package-only protections. Follow the
[environment-profile tutorial](../tutorial/oci-application-images/environment-profiles).

Project tools are opt-in through `.dagger/toolchains/rush.yaml`. Absence is the
compatibility path. Follow the [toolchain production guide](../rush-toolchain)
and [mixed-language tutorial](../tutorial/mixed-node-python-toolchain).

## Recovery

If bounded local copy omits a required path, choose `legacy` for the immediate
retry, then add and test a narrow inclusion before restoring `bounded`. Git
source mode is unaffected and never reads the ignore file.

If a configured toolchain fails, remove the new metadata to return to the exact
default toolchain, or revert the metadata to the last reviewed digest/checksum.
Do not bypass checksum or base-image pinning.

If dynamic coordinates select the wrong repository, stop before live Package,
correct the public deployment env value, and repeat the named dry run. Deploy
does not reload coordinates: a package already published and handed off by
digest continues to deploy that immutable packaged result.

Rolling the Action/module reference back to `v0.8.1` is valid only for metadata
that does not use the new coordinate or toolchain fields. Retain the v0.9.0
package manifest/evidence with any v0.9.0 publication; do not reconstruct a
repository during rollback.
