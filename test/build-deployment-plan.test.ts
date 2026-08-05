import * as assert from "node:assert/strict";
import { test } from "node:test";

import { buildDeploymentPlan } from "../src/planning/build-deployment-plan.ts";
import { parseReleaseTargets } from "../src/planning/parse-release-targets.ts";
import { parseServicesMesh } from "../src/planning/parse-services-mesh.ts";

test("plans a single selected target without its unselected dependency", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after: []
  webapp:
    deploy_after:
      - server
`);

  const plan = buildDeploymentPlan(mesh, parseReleaseTargets('["webapp"]'));

  assert.deepStrictEqual(plan, {
    selectedTargets: ["webapp"],
    waves: [[{ target: "webapp" }]],
  });
});

test("plans ordered waves when server and webapp are both selected", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after: []
  webapp:
    deploy_after:
      - server
`);

  const plan = buildDeploymentPlan(
    mesh,
    parseReleaseTargets('["server","webapp"]'),
  );

  assert.deepStrictEqual(plan, {
    selectedTargets: ["server", "webapp"],
    waves: [[{ target: "server" }], [{ target: "webapp" }]],
  });
});

test("plans a future parallel wave after server", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after: []
  webapp:
    deploy_after:
      - server
  mobile:
    deploy_after:
      - server
`);

  const plan = buildDeploymentPlan(
    mesh,
    parseReleaseTargets('["server","webapp","mobile"]'),
  );

  assert.deepStrictEqual(plan, {
    selectedTargets: ["server", "webapp", "mobile"],
    waves: [
      [{ target: "server" }],
      [{ target: "mobile" }, { target: "webapp" }],
    ],
  });
});

test("fails when a selected target is not present in the services mesh", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after: []
`);

  assert.throws(
    () => buildDeploymentPlan(mesh, parseReleaseTargets('["webapp"]')),
    /Unknown release target "webapp" in services mesh\./,
  );
});

test("does not treat inherited object keys as declared services", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after: []
`);

  assert.throws(
    () => buildDeploymentPlan(mesh, parseReleaseTargets('["constructor"]')),
    /Unknown release target "constructor" in services mesh\./,
  );
});

test("plans explicitly declared prototype-shaped service names", () => {
  const mesh = parseServicesMesh(`
services:
  constructor:
    deploy_after: []
  __proto__:
    deploy_after:
      - constructor
`);

  assert.deepStrictEqual(
    buildDeploymentPlan(
      mesh,
      parseReleaseTargets('["constructor","__proto__"]'),
    ),
    {
      selectedTargets: ["constructor", "__proto__"],
      waves: [[{ target: "constructor" }], [{ target: "__proto__" }]],
    },
  );
});

test("fails when a selected target depends on an unknown service", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after:
      - database
`);

  assert.throws(
    () => buildDeploymentPlan(mesh, parseReleaseTargets('["server"]')),
    /Unknown dependency "database" referenced by "server"\./,
  );
});

test("fails on cycles in the selected deploy graph", () => {
  const mesh = parseServicesMesh(`
services:
  server:
    deploy_after:
      - webapp
  webapp:
    deploy_after:
      - server
`);

  assert.throws(
    () => buildDeploymentPlan(mesh, parseReleaseTargets('["server","webapp"]')),
    /Cycle detected in services mesh deploy_after graph\./,
  );
});
