import * as assert from "node:assert/strict";
import { test } from "node:test";

import { packagePlansRequireRushInstall } from "../src/stages/package-stage/package-install.ts";

test("OCI-only packaging does not run Rush install or lifecycle commands", () => {
  assert.equal(
    packagePlansRequireRushInstall([
      {
        plan: {
          commands: [],
          oci: {
            context: ".",
            dockerfile: "Dockerfile",
            image: "api",
            platform: "linux/amd64",
            scan: { fail_on: ["critical"] },
          },
          validations: [],
        },
      },
    ]),
    false,
  );
});

test("Rush deploy archive packaging still requests Rush install", () => {
  assert.equal(
    packagePlansRequireRushInstall([
      {
        plan: {
          artifact: {
            deploy_path: "common/deploy/server",
            kind: "archive",
            path: "server.tgz",
          },
          commands: [
            {
              args: ["common/scripts/install-run-rush.js", "deploy"],
              command: "node",
            },
          ],
          validations: [],
        },
      },
    ]),
    true,
  );
});
