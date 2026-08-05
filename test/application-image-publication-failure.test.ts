import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRegistryPublicationFailure,
  sanitizeRegistryPublicationFailure,
  type RegistryPublicationFailureStage,
} from "../src/application-images/publication-failure.ts";

const cases: Array<{
  expected: RegistryPublicationFailureStage;
  message: string;
}> = [
  {
    expected: "registry publication authentication",
    message: "unexpected status from token service: 401 Unauthorized",
  },
  {
    expected: "registry publication authentication",
    message: "no basic auth credentials",
  },
  {
    expected: "registry publication authentication",
    message: "registry response status: 401",
  },
  {
    expected: "registry publication authentication",
    message: "registry replied HTTP/2 401",
  },
  {
    expected: "registry publication authorization",
    message: "unexpected status from token service: 403 Forbidden",
  },
  {
    expected: "registry publication authorization",
    message: "denied: requested access to the resource is denied",
  },
  {
    expected: "registry publication authorization",
    message: "insufficient_scope: authorization failed",
  },
  {
    expected: "registry publication authorization",
    message: "registry HTTP status 403",
  },
  {
    expected: "registry publication authorization",
    message: "registry replied HTTP/1.1 403",
  },
  {
    expected: "registry publication transport",
    message: "dial tcp: lookup ghcr.io: no such host",
  },
  {
    expected: "registry publication transport",
    message: "registry request failed: TLS handshake timeout",
  },
  {
    expected: "registry publication transport",
    message: "unexpected status from registry: 503 Service Unavailable",
  },
  {
    expected: "registry publication",
    message: "registry rejected a malformed manifest",
  },
];

test("classifies registry publication failures into fixed operational stages", () => {
  for (const { expected, message } of cases) {
    assert.equal(
      classifyRegistryPublicationFailure(new Error(message)),
      expected,
    );
  }

  assert.equal(classifyRegistryPublicationFailure({}), "registry publication");
});

test("never returns registry error text or an embedded secret", () => {
  const secretSentinel = "registry-token-that-must-not-escape";
  const stage = classifyRegistryPublicationFailure(
    new Error(
      `denied: requested access to the resource is denied; bearer=${secretSentinel}`,
    ),
  );

  assert.equal(stage, "registry publication authorization");
  assert.doesNotMatch(stage, new RegExp(secretSentinel));
  assert.deepEqual(
    new Set(
      cases.map(({ message }) => classifyRegistryPublicationFailure(message)),
    ),
    new Set<RegistryPublicationFailureStage>([
      "registry publication",
      "registry publication authentication",
      "registry publication authorization",
      "registry publication transport",
    ]),
  );

  const sanitizedError = sanitizeRegistryPublicationFailure(
    new Error(
      `unexpected status from registry: 403 Forbidden; bearer=${secretSentinel}`,
    ),
  );
  assert.equal(
    sanitizedError.message,
    "OCI package operation failed during registry publication authorization.",
  );
  assert.equal(sanitizedError.stage, "registry publication authorization");
  assert.equal("cause" in sanitizedError, false);
  assert.doesNotMatch(sanitizedError.message, new RegExp(secretSentinel));
});

test("fails closed when an untrusted error message cannot be read safely", () => {
  const secretSentinel = "hostile-message-getter-secret";
  const hostileError = Object.create(Error.prototype) as Error;
  Object.defineProperty(hostileError, "message", {
    get() {
      throw new Error(secretSentinel);
    },
  });
  const nonStringMessage = new Error("discarded");
  Object.defineProperty(nonStringMessage, "message", {
    value: {
      toLowerCase() {
        throw new Error(secretSentinel);
      },
    },
  });

  for (const error of [hostileError, nonStringMessage]) {
    assert.equal(
      classifyRegistryPublicationFailure(error),
      "registry publication",
    );
    const sanitizedError = sanitizeRegistryPublicationFailure(error);
    assert.equal(
      sanitizedError.message,
      "OCI package operation failed during registry publication.",
    );
    assert.equal(sanitizedError.stage, "registry publication");
    assert.doesNotMatch(sanitizedError.message, new RegExp(secretSentinel));
  }
});

test("does not treat unrelated numeric fields as HTTP status codes", () => {
  for (const message of [
    "registry rejected upload chunk 403 because its offset is stale",
    "registry rejected manifest field 401 as invalid",
  ]) {
    assert.equal(
      classifyRegistryPublicationFailure(new Error(message)),
      "registry publication",
    );
  }
});
