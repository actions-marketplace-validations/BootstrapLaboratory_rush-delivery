# Fix Non-Root Test Temp Root And Add Direct CI

Status: accepted for implementation.

Baseline: `v0.9.1` release commit
`db35bb8eefef173aa052b1264b973bdb0794912d`; working baseline
`2e65be81527dbb4e4fa99c3775715b7c1be7aa72`.

This is a repository QA and test-harness maintenance change. It does not alter
the Rush Delivery module, Action, metadata, schema, or consumer configuration
contract, and it must not retarget or republish `v0.9.1`.

## Context

A clean direct `npm test` run as an ordinary non-root user exposes one harness
failure in the v0.8.1 OCI compatibility archive-helper test. The test sources
[`../test/scripts/lib/oci-v081-acceptance-matrix.sh`](../test/scripts/lib/oci-v081-acceptance-matrix.sh)
without the matrix runner that normally initializes
`OCI_V081_MATRIX_TEMP_ROOT`. The unset value produces root-level
`/rush-delivery-v081-*` `mktemp` templates, which a root Dagger test container
can create but an ordinary user correctly cannot.

Setting the private variable to `/tmp` is a diagnostic workaround, not an
acceptable repository or CI requirement. The helper library must own a safe
standard fallback, and CI must exercise the unconfigured non-root path directly.

## Decisions And Constraints

- [x] Preserve the production matrix runner's existing `TMPDIR` then `/tmp`
      default and its cleanup-bound temporary namespace.
- [x] Make direct library use resolve the same default without requiring a
      caller-specific environment workaround.
- [x] Do not expose `OCI_V081_MATRIX_TEMP_ROOT` as a Rush Delivery consumer
      setting or add it to project documentation and examples.
- [x] Keep archive member/link validation, exact-file cleanup, and failure
      behavior unchanged.
- [x] Add automatic pull-request and `main` push CI with `contents: read` only,
      immutable third-party Action pins, the project-pinned Node runtime, and the
      existing frozen Yarn install.
- [x] Run direct `npm test` with `OCI_V081_MATRIX_TEMP_ROOT` explicitly absent;
      never configure the workaround in CI.
- [x] Keep this work release-neutral: no version, schema snapshot, provenance,
      site-version, release, or tag changes.

## Phase 1: Repair And Prove Temp-Root Ownership

- [x] Initialize the library's task-specific temp root from an existing explicit
      value, otherwise standard `TMPDIR`, otherwise `/tmp`.
- [x] Update the archive-helper regression to remove the task-specific variable,
      provide an isolated standard temp directory, and prove scratch files are
      cleaned.
- [x] Reproduce the old failure as a non-root user before the fix and prove the
      corrected focused suite succeeds without the private override.

### Phase 1 Exit Gate

- [x] Direct archive-helper use is portable for non-root callers and retains the
      existing bounded cleanup contract.

## Phase 2: Add Direct Repository CI

- [x] Add a dedicated CI workflow for pull requests and pushes to `main`.
- [x] Install with `yarn install --frozen-lockfile`, run direct `npm test` with
      the private override absent, run `yarn typecheck`, and fail on generated or
      tracked-file drift.
- [x] Add workflow contract tests for triggers, least privilege, immutable Action
      pins, pinned Node version, direct command path, unset override, and clean
      tree verification.
- [x] Keep credentialed/mutating OCI acceptance manual and separate from this
      ordinary non-secret CI job.

### Phase 2 Exit Gate

- [x] An ordinary GitHub-hosted runner will catch the original regression on
      every proposed change without registry credentials or package-write
      permission.

## Phase 3: Validation And Handoff

- [x] Run the focused matrix and CI workflow contract tests.
- [x] Run a clean archived `npm test` as a non-root user with both
      `OCI_V081_MATRIX_TEMP_ROOT` and `TMPDIR` initially absent.
- [ ] Run the complete direct test suite, `yarn typecheck`, workflow/shell lint,
      `git diff --check`, and the clean Dagger self-check.
- [x] Review the final diff for unrelated changes, mutable pins, secret access,
      excessive permissions, and release/version drift.
- [ ] Commit and push reviewable changes, then open a draft pull request through
      the normal repository flow.
- [ ] Record validation and pull-request evidence, mark every item complete, and
      move this file to `tasks/completed` without changing a released tag.

## Completion Criteria

- [ ] A clean non-root direct `npm test` passes without the private matrix temp
      override.
- [ ] Direct CI runs automatically and cannot silently reintroduce the override.
- [ ] Production acceptance behavior and all consumer contracts remain
      unchanged.
- [ ] `v0.9.1` remains immutable.

## Validation Evidence

- Before the repair, a clean direct test run as `nobody`, with the task-specific
  override absent, reproduced the single archive-helper failure: 446 passed and
  1 failed out of 447 tests.
- After the repair, the same clean non-root path, with both the task-specific
  override and `TMPDIR` initially absent, passed all 448 tests.
- The focused OCI matrix, CI workflow, and documentation contract suites passed
  all 30 tests.
- `yarn install --frozen-lockfile`, `yarn typecheck`, repository-wide Trunk
  checks, shell syntax validation, and `git diff --check` passed.
