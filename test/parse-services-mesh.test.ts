import * as assert from "node:assert/strict";
import { test } from "node:test";

import { resolveService } from "../src/model/service-mesh.ts";
import { parseServicesMesh } from "../src/planning/parse-services-mesh.ts";

test("parses service metadata and normalizes duplicate dependencies", () => {
  const mesh = parseServicesMesh(`
services:
  webapp:
    deploy_after:
      - server
      - server
`);

  assert.deepStrictEqual(mesh, {
    services: {
      webapp: {
        deploy_after: ["server"],
      },
    },
  });
});

test("fails when the services mesh does not define a top-level services mapping", () => {
  assert.throws(
    () => parseServicesMesh("foo: bar\n"),
    /services-mesh\.yaml must define a top-level services mapping\./,
  );
});

test("fails when deploy_after is not an array", () => {
  assert.throws(
    () =>
      parseServicesMesh(`
services:
  server:
    deploy_after: webapp
`),
    /Service mesh deploy_after for "server" must be an array\./,
  );
});

test("service resolution requires an own service definition", () => {
  assert.throws(
    () => resolveService({ services: {} }, "constructor"),
    /Unknown release target "constructor" in services mesh\./,
  );
});
