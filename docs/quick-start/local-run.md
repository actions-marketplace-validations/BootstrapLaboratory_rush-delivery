# Local Runs

For local testing, pass the working tree explicitly. This keeps unpushed edits
available to Dagger and avoids relying on a remote Git ref that does not contain
your latest changes.

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.8.1

dagger -m "${RUSH_DELIVERY_MODULE}" call workflow \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='[]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off \
  --source-mode=local_copy
```

If the forced selection includes an OCI target, this dry run reports the
relative image and platform but does not build, scan, publish, sign, or resolve
credentials. Select a named application-image provider only when you also want
to validate its planned repository.

For local PR-style validation only:

```sh
dagger -m "${RUSH_DELIVERY_MODULE}" call validate \
  --repo=. \
  --event-name=pull_request \
  --pr-base-sha="$(git merge-base HEAD origin/main)" \
  --source-mode=local_copy
```

For a local package-release dry-run:

```sh
dagger -m "${RUSH_DELIVERY_MODULE}" call release-packages \
  --repo=. \
  --git-sha="$(git rev-parse HEAD)" \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --source-mode=local_copy
```

This reads `.dagger/release/npm.yaml`, runs the release build lifecycle, and
executes the non-publishing Rush publish path. It does not require `NPM_TOKEN`,
does not push the generated version commit, and does not publish packages.

Avoid live package publishing from a local workstation unless you are
deliberately testing the release path with disposable packages. Live package
release expects Git source mode, release env credentials, and a clean CI-style
source ref.

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
