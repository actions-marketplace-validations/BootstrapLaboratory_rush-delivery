# Bounded Local-Copy Source Imports

Rush Delivery `v0.9.0` applies local-copy exclusions before Dagger traverses and
uploads the repository. Use the bundled `rush-delivery-local` launcher for
unpushed worktrees and use Git source mode in CI whenever the source already
exists at a remote commit.

## Install The Versioned Launcher

The launcher is a release asset and the same byte-for-byte file bundled in the
GitHub Action. It requires Bash 4+, the caller-selected Dagger CLI, and standard
POSIX file tools. It does not require Node.js, `jq`, a project install, or GNU
`realpath`.

```sh
curl --fail --location \
  --output rush-delivery-local \
  https://github.com/BootstrapLaboratory/rush-delivery/releases/download/v0.9.0/rush-delivery-local
printf '%s  %s\n' \
  '802ed18dc3bce89974d64884fe3c7ca64f3e206faa4c8c8eef237757101bd391' \
  rush-delivery-local | sha256sum --check --strict
chmod 0755 rush-delivery-local
```

Keep the launcher and module on the same release:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. \
  -- \
  workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

The launcher accepts `workflow`, `validate`, and `release-packages`. It owns the
local `repo` and source-mode arguments; passing `--repo`, `--source-mode`, or
Git source coordinates after `--` is rejected.

## Default Boundary

The default `bounded` policy sends these ordered exclusions to Dagger's
`host.directory` operation:

```text
**/node_modules
**/.venv
**/__pycache__
**/.rush
**/rush-logs
.trunk/out
.trunk/logs
```

This is a transfer boundary, not only container cleanup. `.git`, `rush.json`,
and `.dagger` must remain present. The source adapter validates them before
workflow work begins. Git history is retained for affected-project comparison,
deploy-tag lookup, validation, and package release planning.

Rush Delivery deliberately does not import `.gitignore` as this contract.
Ignored build outputs can be valid Package inputs, while tracked dependencies
can still be disposable for Dagger execution.

## Repository Extensions

Create `.dagger/source-import.ignore` only when the defaults need an extension
or an intentional inclusion. The repository also provides a reviewed
[configuration fragment](../examples/deployment-environment-compatibility/source-import.ignore):

```text
# Exclude generated browser caches.
apps/web/.cache

# This generated tool is a required workflow input.
!tools/python/.venv/bin/uv
```

Rules are ordered after the defaults. An ordinary line excludes and one
leading `!` re-includes, so the later inclusion wins. Blank lines and lines
beginning with `#` are ignored. UTF-8, LF, CRLF, and a final line without a
newline are supported.

Patterns must be normalized repository-relative ignore patterns. Absolute or
parent-traversing paths, control characters, unsupported escapes, repeated
`!`, expression characters, and direct removal of `.git`, `.dagger`, or
`rush.json` are rejected. The launcher also quotes accepted repository paths,
ignore-file paths, and patterns as Dagger Shell data. Only `extra-args` remains
an explicitly trusted raw Action/CLI escape hatch.

If a required generated path is below an excluded directory, include the exact
path and test it before changing production CI. Inclusions do not make arbitrary
split-stage outputs implicit framework contracts.

## GitHub Action

Git source mode does not read local-copy settings and emits one fixed diagnostic
that they were ignored. A local-copy Action call uses the bounded policy by
default:

```yaml
- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
  with:
    fetch-depth: 0

- uses: BootstrapLaboratory/rush-delivery@v0.9.0
  with:
    source-mode: local_copy
    repo: .
    source-import-policy: bounded
    source-import-ignore-file: .dagger/source-import.ignore
    dry-run: "true"
```

The Action invokes the bundled launcher parser and passes its generated Shell
to the pinned Dagger Action. Local and Action precedence therefore cannot drift.

For emergency rollback, `source-import-policy: legacy` selects the released
top-level `dagger call` path and does not read the ignore file. Use it only while
identifying and adding the required inclusion:

```yaml
with:
  source-mode: local_copy
  repo: .
  source-import-policy: legacy
```

The standalone launcher has the equivalent
`--source-import-policy=legacy` flag. It rejects a simultaneous ignore-file
flag because legacy mode cannot apply repository-controlled filters.

## Entrypoint Data Matrix

| Entrypoint               | Git history                        | Rush source/config   | `.dagger` metadata | Installed dependencies                      | Generated/package evidence                                 |
| ------------------------ | ---------------------------------- | -------------------- | ------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `workflow`               | Required                           | Required             | Required           | Recreated in Dagger                         | Produced during the composition                            |
| `validate`               | Required                           | Required             | Required           | Recreated in Dagger                         | Not an input                                               |
| `release-packages`       | Required                           | Required             | Required           | Recreated in Dagger                         | Not an input                                               |
| `detect`                 | Required for comparisons/tags      | Required             | Required           | Not required                                | Not required                                               |
| `build-deploy-targets`   | Project-dependent                  | Required             | Required           | Recreated in Dagger                         | Produces build outputs                                     |
| `package-deploy-targets` | Provenance-dependent               | Required             | Required           | Needed only for Rush-requiring package work | Existing build outputs and `.dagger/runtime` may be inputs |
| `deploy-release`         | Deploy-tag behavior may require it | Deploy metadata only | Required           | Not required                                | Package manifest, evidence, and runtime files are inputs   |

The launcher wraps only the three source-adapter entrypoints in the first three
rows. Split-stage callers compose `host.directory` themselves and pass that
Directory directly to the required-repo stage. They must include build outputs,
the package manifest, evidence, and `.dagger/runtime` needed by that stage.

Direct calls to the old top-level `workflow`, `validate`, and
`release-packages` functions remain compatible and retain their v0.8.1 static
filters. Use the launcher when repository-controlled pre-import filtering or a
later inclusion is required; the old decorators intentionally cannot preserve a
caller re-inclusion.

## Production Verification

Run once with plain progress and inspect the first source operation:

```sh
DAGGER_NO_NAG=1 ./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. \
  -- validate \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=pull_request \
  --pr-base-sha="$(git merge-base HEAD origin/main)"
```

The `host.directory` call must contain the defaults followed by the repository
patterns. Confirm the affected-project plan still sees the expected base and
tags. For each inclusion, add a CI assertion that consumes the required output;
mere presence in a local worktree does not prove it crossed the boundary.

If bounded mode reports a missing mandatory path, restore that path rather than
excluding the validation. If workflow behavior changes only under bounded mode,
switch temporarily to `legacy`, identify the matched required path, add the
narrowest later `!` inclusion, and return to `bounded`.
