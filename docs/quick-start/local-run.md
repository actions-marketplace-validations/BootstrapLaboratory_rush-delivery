# Local Runs

For local testing, pass the working tree explicitly. This keeps unpushed edits
available to Dagger and avoids relying on a remote Git ref that does not contain
your latest changes.

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. \
  -- \
  workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='[]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off
```

If the forced selection includes an OCI target, this dry run reports the
relative image and platform but does not build, scan, publish, sign, or resolve
credentials. Select a named application-image provider only when you also want
to validate its planned repository.

For local PR-style validation only:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. \
  -- \
  validate \
  --event-name=pull_request \
  --pr-base-sha="$(git merge-base HEAD origin/main)"
```

For a local package-release dry-run:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. \
  -- \
  release-packages \
  --git-sha="$(git rev-parse HEAD)" \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

This reads `.dagger/release/npm.yaml`, runs the release build lifecycle, and
executes the non-publishing Rush publish path. It does not require `NPM_TOKEN`,
does not push the generated version commit, and does not publish packages.

Avoid live package publishing from a local workstation unless you are
deliberately testing the release path with disposable packages. Live package
release expects Git source mode, release env credentials, and a clean CI-style
source ref.

The launcher applies bounded source exclusions before Dagger uploads the
worktree. Install and verify the release asset, review defaults, and add narrow
inclusions through `.dagger/source-import.ignore` by following the
[bounded local-copy guide](../local-copy-source-imports.md). Direct top-level
`dagger call ... --source-mode=local_copy` remains the legacy-compatible path,
but cannot honor repository-controlled pre-import inclusions.

Keep live deploy credentials out of source. If a local live deploy needs files
such as cloud credentials, pass them through a runtime files directory and refer
to them from target metadata.

For deployment and release metadata, see [Metadata contracts](../metadata.md).
For workflow shape and release behavior, see the [Workflow Guide](../workflows.md).
For OCI-specific local planning and live rollout, use the
[OCI application images tutorial](../tutorial/oci-application-images/README.md),
[production guide](../oci-application-images.md),
[registry recipes](../oci-registry-recipes.md), and
[troubleshooting guide](../oci-application-image-troubleshooting.md).
