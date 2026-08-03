import * as assert from "node:assert/strict";
import { test } from "node:test";

import { buildPackageActionPlan } from "../src/stages/package-stage/package-action-plan.ts";

test("builds package plan for a directory artifact", () => {
  assert.deepStrictEqual(
    buildPackageActionPlan(
      "webapp",
      {
        artifact: {
          kind: "directory",
          path: "apps/webapp/dist",
        },
        build: {
          dry_run_defaults: {},
          map_env: {},
          pass_env: [],
        },
        name: "webapp",
      },
      "deploy-target",
    ),
    {
      artifact: {
        deploy_path: "apps/webapp/dist",
        kind: "directory",
        path: "apps/webapp/dist",
      },
      commands: [],
      validations: [
        {
          kind: "directory",
          path: "apps/webapp/dist",
        },
      ],
    },
  );
});

test("builds package plan for a Rush deploy archive artifact", () => {
  assert.deepStrictEqual(
    buildPackageActionPlan(
      "server",
      {
        artifact: {
          kind: "rush_deploy_archive",
          output: "common/deploy/server",
          project: "server",
          scenario: "server",
        },
        build: {
          dry_run_defaults: {},
          map_env: {},
          pass_env: [],
        },
        name: "server",
      },
      "deploy-target",
    ),
    {
      artifact: {
        deploy_path: "common/deploy/server",
        kind: "archive",
        path: "deploy-target-server.tgz",
      },
      commands: [
        {
          args: [
            "common/scripts/install-run-rush.js",
            "deploy",
            "-p",
            "server",
            "-s",
            "server",
            "-t",
            "common/deploy/server",
            "--overwrite",
          ],
          command: "node",
        },
        {
          args: [
            "-czf",
            "deploy-target-server.tgz",
            "-C",
            "common/deploy",
            "server",
          ],
          command: "tar",
        },
      ],
      validations: [],
    },
  );
});

test("builds a typed OCI image package plan", () => {
  assert.deepStrictEqual(
    buildPackageActionPlan(
      "server",
      {
        artifact: {
          context: "apps/server",
          dockerfile: "apps/server/Dockerfile",
          image: "services/server",
          kind: "oci_image",
          platform: "linux/amd64",
          scan: {
            fail_on: ["high", "critical"],
            ignore_file: ".dagger/application-images/grype.yaml",
          },
        },
        build: {
          dry_run_defaults: {},
          map_env: {},
          pass_env: [],
        },
        name: "server",
      },
      "deploy-target",
    ),
    {
      commands: [],
      oci: {
        context: "apps/server",
        dockerfile: "Dockerfile",
        image: "services/server",
        platform: "linux/amd64",
        scan: {
          fail_on: ["high", "critical"],
          ignore_file: ".dagger/application-images/grype.yaml",
        },
      },
      validations: [
        { kind: "directory", path: "apps/server" },
        { kind: "file", path: "apps/server/Dockerfile" },
        {
          kind: "file",
          path: ".dagger/application-images/grype.yaml",
        },
      ],
    },
  );
});

test("fails when package metadata name does not match target", () => {
  assert.throws(
    () =>
      buildPackageActionPlan(
        "server",
        {
          artifact: {
            kind: "directory",
            path: "apps/webapp/dist",
          },
          build: {
            dry_run_defaults: {},
            map_env: {},
            pass_env: [],
          },
          name: "webapp",
        },
        "deploy-target",
      ),
    /Package target metadata for "server" must declare name "server", got "webapp"\./,
  );
});
