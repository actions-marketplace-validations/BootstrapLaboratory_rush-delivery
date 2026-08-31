# Upgrade From v0.9.0 To v0.9.1

Rush Delivery `v0.9.1` is a compatibility patch for bounded local-copy runs
through the GitHub Action. It does not change `.dagger` metadata, Dagger
entrypoints, package manifests, provider activation, OCI publication, or Rush
toolchain behavior.

## Who Must Upgrade

Upgrade if a workflow uses all three of these settings:

- the Rush Delivery Action is pinned to `v0.9.0`;
- `source-mode: local_copy`; and
- `source-import-policy: bounded`, including its default value.

That `v0.9.0` Action combination can fail before Dagger starts because its
generated Dagger Shell contains quoted exclusion patterns that cannot safely
cross the pinned `dagger-for-github` shell-input transport. The standalone
`rush-delivery-local` release asset, the remote Dagger module, Git source mode,
and explicit `source-import-policy: legacy` are not affected.

## Upgrade

Change only the Rush Delivery pin:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    source-mode: local_copy
    source-import-policy: bounded
```

For direct module or launcher use, keep both components on the same patch:

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.9.1
RUSH_DELIVERY_LOCAL_URL=https://github.com/BootstrapLaboratory/rush-delivery/releases/download/v0.9.1/rush-delivery-local
```

The `v0.9.1` launcher also materializes env files, runtime directories, and the
optional Docker socket as typed host objects before calling the module. Its
checksum therefore differs from `v0.9.0`; always verify the checksum published
for `v0.9.1`. The release asset remains byte-identical to the launcher bundled
with the `v0.9.1` Action.

No `.dagger/source-import.ignore` edit is required. Existing static providers,
environment-backed coordinates, provider-off behavior, and project-owned Rush
toolchains keep the `v0.9.0` contract. Exact editor schemas may be advanced to
the byte-equivalent `v0.9.1` snapshot:

```text
https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.1/<schema>.schema.json
```

## Canary

Run one non-publishing workflow with the same source mode and import policy as
production:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    source-mode: local_copy
    source-import-policy: bounded
    application-image-provider: off
    toolchain-image-provider: off
    rush-cache-provider: off
    dry-run: true
```

Confirm that:

- the Action reaches Dagger instead of failing while assembling its command;
- excluded dependency/cache trees are absent from the imported directory;
- every required re-inclusion from `.dagger/source-import.ignore` is present;
- filesystem-only and provider-off OCI plans match the `v0.9.0` result; and
- no registry, deploy-tag, or package-release mutation occurs.

Then promote the unchanged `v0.9.1` pin to trusted release workflows.

## Recovery

If the canary fails inside project Build, Package, or Deploy logic, return to
the last successful pin and compare the generated plan; the patch does not
change those stages. If bounded filtering removed a required generated path,
add the narrowest `!` inclusion described in the
[bounded local-copy guide](local-copy-source-imports.md).

`source-import-policy: legacy` remains an explicit short-term transfer fallback,
but it restores the larger `v0.8.1` import boundary. Do not move or recreate the
immutable `v0.9.0` tag; pin `v0.9.1` for the corrected bounded Action path.

For the feature-level migration from `v0.8.1`, continue with the
[v0.9.0 upgrade guide](upgrade-v0.9.0.md).
