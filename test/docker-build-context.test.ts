import * as assert from "node:assert/strict";
import { test } from "node:test";

import { dockerfilePathInsideBuildContext } from "../src/application-images/docker-build-context.ts";
import { buildPackageActionPlan } from "../src/stages/package-stage/package-action-plan.ts";

test("resolves Dockerfile paths relative to the selected Dagger build context", () => {
  assert.equal(
    dockerfilePathInsideBuildContext(
      "apps/control-plane-api",
      "apps/control-plane-api/Dockerfile",
    ),
    "Dockerfile",
  );
  assert.equal(
    dockerfilePathInsideBuildContext(
      "apps/control-plane-api",
      "apps/control-plane-api/docker/release.Dockerfile",
    ),
    "docker/release.Dockerfile",
  );
  assert.equal(
    dockerfilePathInsideBuildContext(".", "deploy/api.Dockerfile"),
    "deploy/api.Dockerfile",
  );
});

test("converts a parsed package action plan Dockerfile exactly once", () => {
  const action = buildPackageActionPlan(
    "control-plane-api",
    {
      artifact: {
        context: "apps/control-plane-api",
        dockerfile: "apps/control-plane-api/Dockerfile",
        image: "control-plane-api",
        kind: "oci_image",
        platform: "linux/amd64",
        scan: { fail_on: ["high", "critical"] },
      },
      build: {
        dry_run_defaults: {},
        map_env: {},
        pass_env: [],
      },
      name: "control-plane-api",
    },
    "deploy-target",
  );

  assert.equal("oci" in action, true);

  if (!("oci" in action)) {
    return;
  }

  assert.equal(action.oci.dockerfile, "apps/control-plane-api/Dockerfile");
  assert.equal(
    dockerfilePathInsideBuildContext(action.oci.context, action.oci.dockerfile),
    "Dockerfile",
  );
});

test("rejects direct-call Dockerfile paths outside the build context", () => {
  for (const dockerfile of [
    "apps/other/Dockerfile",
    "Dockerfile",
    "apps/control-plane-api",
  ]) {
    assert.throws(
      () =>
        dockerfilePathInsideBuildContext("apps/control-plane-api", dockerfile),
      /must stay inside its build context/,
    );
  }
});

test("rejects non-normalized direct-call context and Dockerfile coordinates", () => {
  for (const [context, dockerfile, expected] of [
    ["../outside", "../outside/Dockerfile", /build context/],
    ["/outside", "/outside/Dockerfile", /build context/],
    ["apps/../outside", "outside/Dockerfile", /build context/],
    ["apps//api", "apps/api/Dockerfile", /build context/],
    ["apps\\api", "apps/api/Dockerfile", /build context/],
    ["apps/api", "apps/api/../outside/Dockerfile", /Dockerfile/],
    ["apps/api", "/apps/api/Dockerfile", /Dockerfile/],
    ["apps/api", "apps//api/Dockerfile", /Dockerfile/],
    [".", "../Dockerfile", /Dockerfile/],
  ] as const) {
    assert.throws(
      () => dockerfilePathInsideBuildContext(context, dockerfile),
      expected,
    );
  }
});
