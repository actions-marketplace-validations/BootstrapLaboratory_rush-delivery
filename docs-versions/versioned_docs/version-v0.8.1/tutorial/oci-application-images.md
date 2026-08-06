---
title: "Overview"
sidebar_label: "Overview"
description: "Publish, inspect, deploy, hand off, and roll back a signed image."
---

This tutorial takes one minimal Rush project from a credential-free image plan
to a signed GHCR publication, local evidence inspection, digest-only deploy,
GitHub Actions, split-stage handoff, and rollback. The checked-in
[canonical example](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo) is the
single source for the project files used throughout the tutorial.

Rush Delivery `v0.8.1` keeps OCI application images opt-in. A repository whose
selected package artifacts are only `directory` or `rush_deploy_archive` does
not need an application-image provider or OCI credentials.

## Prerequisites

For Chapters 1 and 2:

- a Unix-like workstation with Git, Bash, `tar`, and `jq`;
- Node.js 24 if you run the example directly outside Dagger;
- Dagger CLI `v0.20.7` and a working Dagger engine;
- network access for the initial module, base-image, Rush, and package pulls.

Chapters 3 and later add Python 3, Cosign `3.1.2`, the GitHub CLI, a GHCR
namespace, and trusted release credentials. Chapter 7 requires Python 3.12 or
newer for safe archive extraction.

All commands are runnable shell commands unless a block is explicitly labelled
as sanitized output, a manifest example, or a platform-specific excerpt.
Run commands from the tutorial repository root.

## Create A Clean Tutorial Repository

Export the tracked example from the immutable release, then give it its own Git
history. This avoids copying generated `common/temp`, `dist`, or `node_modules`
state from another checkout.

```bash
set -euo pipefail

TUTORIAL_PARENT="${TMPDIR:-/tmp}/rush-delivery-oci-tutorial"
SOURCE_CHECKOUT="${TMPDIR:-/tmp}/rush-delivery-v0.8.1-source"

test ! -e "${TUTORIAL_PARENT}"
test ! -e "${SOURCE_CHECKOUT}"
git clone --depth=1 --branch=v0.8.1 \
  https://github.com/BootstrapLaboratory/rush-delivery.git \
  "${SOURCE_CHECKOUT}"
mkdir -p "${TUTORIAL_PARENT}"
git -C "${SOURCE_CHECKOUT}" archive HEAD \
  examples/oci-application-image-rush-repo \
  | tar --extract --directory="${TUTORIAL_PARENT}" --strip-components=2

cd "${TUTORIAL_PARENT}"
git init
git config user.name "Rush Delivery tutorial"
git config user.email "rush-delivery-tutorial@example.invalid"
git add --all
git commit -m "chore: initialize OCI image tutorial"

export RUSH_DELIVERY_MODULE="github.com/BootstrapLaboratory/rush-delivery@v0.8.1"
export TUTORIAL_REPOSITORY="${TUTORIAL_PARENT}"
```

Sanitized expected output:

```text
Cloning into '/tmp/rush-delivery-v0.8.1-source'...
Initialized empty Git repository in /tmp/rush-delivery-oci-tutorial/.git/
[main (root-commit) <sha>] chore: initialize OCI image tutorial
```

If `git clone` cannot resolve `v0.8.1`, the release has not been published to
the selected remote. If `git commit` reports no files, confirm that
`examples/oci-application-image-rush-repo` exists in that tag and that GNU or
compatible `tar` honored `--strip-components=2`.

The example's final image is `scratch` and contains one deterministic payload.
It proves build, evidence, publication, and immutable handoff without hiding a
framework or operating-system runtime in the subject. It is deliberately not a
network service, has no shell, and is not directly usable as a Cloud Run,
Kubernetes, or Swarm application. Replace the Dockerfile with a production
runtime image when adapting the tutorial to a real service.

## Learning Path

1. [Build And Scan Target](build-and-scan-target)
2. [Provider-Off Dry Run](provider-off-dry-run)
3. [Registry And Cosign Bootstrap](registry-and-cosign-bootstrap)
4. [Publish And Inspect](publish-and-inspect)
5. [Deploy The Digest](deploy-the-digest)
6. [GitHub Actions](github-actions)
7. [Split Stages And Rollback](split-stages-and-rollback)

## Checkpoint

```bash
test -f rush.json
test -f .dagger/package/targets/control-plane-api.yaml
test -f .dagger/application-images/providers.yaml
test "$(git status --porcelain)" = ""
dagger version
```

The last command should report `dagger v0.20.7`. A different CLI/engine version
is outside the release's validated toolchain until the project explicitly
certifies it.

Next: [Build And Scan Target](build-and-scan-target).
