---
title: "Deploy Mesh"
sidebar_label: "Deploy Mesh"
---

The deploy mesh declares deploy targets and their order. It lives at
`.dagger/deploy/services-mesh.yaml`.

The example mesh is intentionally small:

```yaml
services:
  server:
    deploy_after: []

  webapp:
    deploy_after:
      - server
```

This creates two deploy waves:

1. `server`
2. `webapp`

Rush Delivery can run independent targets in the same wave. Dependencies only
express deployment ordering, not application imports.

## Why The Webapp Waits For The Server

In the example, the webapp uses production GraphQL URLs that point to the
backend. Deploying the backend first makes the release path easier to reason
about.

Your project may have different ordering:

- frontend and backend can deploy in parallel
- a database migration target can run before services
- a documentation site can deploy after generated API docs
- a worker can deploy after a queue or service target

The mesh should describe operational ordering, not source-code dependency
graphs. Rush already knows source dependencies.

## Forced Deploys

The example also has manual workflows that force a single target:

- `force-deploy-server.yaml`
- `force-deploy-webapp.yaml`

They call the main workflow with `force_targets_json`. Rush Delivery still uses
the mesh to validate target names and ordering for selected targets.

## Checklist

- Add every deployable target to `services`.
- Use `deploy_after` only for real operational dependencies.
- Keep target names aligned with package and deploy metadata filenames.
- Use forced targets for manual redeploys, not duplicate deploy logic.

Next: [Deploy Targets](../deploy-targets).
