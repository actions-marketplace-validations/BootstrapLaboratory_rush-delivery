---
title: "Validation Targets"
sidebar_label: "Validation Targets"
---

Rush Delivery always runs Rush validation for affected projects. Validation
targets add product-specific runtime checks when a selected project needs more
than `verify`, `lint`, `test`, and `build`.

The example has a backend validation target in
`.dagger/validate/targets/server.yaml`.

## Services

The backend validation target starts Postgres and Redis:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - 5432

  redis:
    image: redis:7-alpine
    ports:
      - 6379
```

Services are available by name from validation steps. The migration step can use
`postgres` as `DATABASE_HOST`, and the server can use `redis` in `REDIS_URL`.

## Steps

The example validates the backend in three phases:

1. run database migrations
2. start the production server
3. run a smoke check against the server

The long-running server step is declared as a service step, while migrations
and smoke checks are command steps.

## What Belongs In Validation Metadata

Put checks here when they need runtime dependencies or multi-step orchestration.
Good candidates:

- migration checks
- service startup checks
- API smoke tests
- contract checks that need a real service
- broker, database, or cache integration checks

Keep fast project-local checks in Rush commands. A TypeScript compile, unit
test, or linter usually belongs in the project scripts called by Rush.

## PR Behavior

In PRs, validation should be read-only against provider artifacts:

```yaml
with:
  entrypoint: validate
  toolchain-image-provider: github
  rush-cache-provider: github
```

This still reuses toolchain images and Rush cache when they exist, but it does
not publish from a PR.

## Checklist

- Add validation target metadata only for checks that need orchestration.
- Keep service names stable and use them in step env.
- Prefer production-like commands where practical.
- Make smoke checks deterministic and bounded by timeouts.
- Keep PR provider policies read-only.

Next: [GitHub Actions](../github-actions).
