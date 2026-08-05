import * as assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { Container, Directory } from "@dagger.io/dagger";

import { collectApplicationImageCredentialNames } from "../src/application-images/environment-boundary.ts";
import type { ApplicationImageProvidersDefinition } from "../src/model/application-image.ts";
import type { PackageActionPlan } from "../src/stages/package-stage/package-action-plan.ts";

const daggerStubSource = `
export class Container {}
export class Directory {}
export const ExistsType = {
  DirectoryType: "DIRECTORY_TYPE",
  RegularType: "REGULAR_TYPE",
};
export const daggerTestState = {
  containerCalls: 0,
  directoryCalls: 0,
  setSecretCalls: [],
  reset() {
    this.containerCalls = 0;
    this.directoryCalls = 0;
    this.setSecretCalls = [];
  },
};
export const dag = {
  container() {
    daggerTestState.containerCalls += 1;
    throw new Error("OCI provider preflight started unexpectedly.");
  },
  directory() {
    daggerTestState.directoryCalls += 1;
    throw new Error("OCI finalization started unexpectedly.");
  },
  setSecret(name) {
    daggerTestState.setSecretCalls.push(name);
    return { name };
  },
};
`;
const daggerStubUrl = `data:text/javascript,${encodeURIComponent(daggerStubSource)}`;
const resolverSource = `
const daggerStubUrl = ${JSON.stringify(daggerStubUrl)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@dagger.io/dagger") {
    return {
      format: "module",
      shortCircuit: true,
      url: daggerStubUrl,
    };
  }

  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(resolverSource)}`);

const { daggerTestState } = (await import("@dagger.io/dagger")) as unknown as {
  daggerTestState: {
    containerCalls: number;
    directoryCalls: number;
    reset: () => void;
    setSecretCalls: string[];
  };
};
const { executePackagePlans } =
  await import("../src/stages/package-stage/execute-package-plans.ts");

const providers: ApplicationImageProvidersDefinition = {
  providers: {
    release: {
      kind: "oci_registry",
      registry: "registry.example.test",
      repository_prefix: "example/platform",
      signing_key_env: "OCI_SIGNING_KEY",
      signing_password_env: "OCI_SIGNING_PASSWORD",
      token_env: "OCI_TOKEN",
      username_env: "OCI_USERNAME",
      verification_key_env: "OCI_SIGNING_PUBLIC_KEY",
    },
  },
};

const hostEnv = {
  OCI_SIGNING_KEY: [
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "opaque-test-value",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
  ].join("\\n"),
  OCI_SIGNING_PASSWORD: "test-password",
  OCI_SIGNING_PUBLIC_KEY: [
    "-----BEGIN PUBLIC KEY-----",
    "opaque-test-value",
    "-----END PUBLIC KEY-----",
  ].join("\\n"),
  OCI_TOKEN: "test-token",
  OCI_USERNAME: "test-user",
};

const ociPlan: PackageActionPlan = {
  commands: [],
  oci: {
    context: "apps/api",
    dockerfile: "apps/api/Dockerfile",
    image: "services/api",
    platform: "linux/amd64",
    scan: { fail_on: ["critical"] },
  },
  validations: [
    { kind: "directory", path: "apps/api" },
    { kind: "file", path: "apps/api/Dockerfile" },
  ],
};

type ContainerEvent = {
  args?: string[];
  operation: string;
  path?: string;
};

function rejectingSourceRepo(accesses: string[]): Directory {
  return new Proxy({} as Directory, {
    get(_target, property): never {
      accesses.push(String(property));
      throw new Error(
        "source repository was consumed before the package barrier",
      );
    },
  });
}

function fakePackageContainer(
  events: ContainerEvent[],
  options: {
    missingPath?: string;
    syncFailure?: Error;
  },
): Container {
  const workspace = {
    dockerBuild(): never {
      events.push({ operation: "dockerBuild" });
      throw new Error("OCI preparation started unexpectedly.");
    },
    async exists(path: string): Promise<boolean> {
      events.push({ operation: "exists", path });
      return path !== options.missingPath;
    },
  };
  const container = {
    directory(path: string) {
      events.push({ operation: "directory", path });
      return workspace;
    },
    async sync() {
      events.push({ operation: "sync" });
      if (options.syncFailure !== undefined) {
        throw options.syncFailure;
      }
      return container;
    },
    withExec(args: string[]) {
      events.push({ args, operation: "withExec" });
      return container;
    },
  };

  return container as unknown as Container;
}

function liveProviderOptions() {
  return {
    applicationImageProviderActivation: {
      name: "release",
      protectedCredentials: collectApplicationImageCredentialNames(providers),
      providers,
    },
    dryRun: false,
    gitSha: "1".repeat(40),
    hostEnv,
  };
}

function assertNoOciSideEffects(
  events: ContainerEvent[],
  logs: string[],
  sourceRepoAccesses: string[],
): void {
  assert.equal(daggerTestState.setSecretCalls.length, 5);
  assert.equal(daggerTestState.containerCalls, 0);
  assert.equal(daggerTestState.directoryCalls, 0);
  assert.equal(
    events.some(({ operation }) => operation === "dockerBuild"),
    false,
  );
  assert.equal(
    logs.some((line) => line.includes("OCI publication boundary crossed")),
    false,
  );
  assert.deepEqual(sourceRepoAccesses, []);
}

test("mixed filesystem failures stop before any OCI work", async (t) => {
  await t.test(
    "a filesystem validation failure blocks OCI preflight and preparation",
    async () => {
      daggerTestState.reset();
      const events: ContainerEvent[] = [];
      const logs: string[] = [];
      const sourceRepoAccesses: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...values: unknown[]) => {
        logs.push(values.map(String).join(" "));
      };

      try {
        await assert.rejects(
          executePackagePlans(
            rejectingSourceRepo(sourceRepoAccesses),
            fakePackageContainer(events, { missingPath: "dist/web" }),
            [
              { plan: ociPlan, target: "api" },
              {
                plan: {
                  artifact: {
                    deploy_path: "dist/web",
                    kind: "directory",
                    path: "dist/web",
                  },
                  commands: [],
                  validations: [{ kind: "directory", path: "dist/web" }],
                },
                target: "web",
              },
            ],
            liveProviderOptions(),
          ),
          /Package target "web" expected directory "dist\/web" to exist/,
        );
      } finally {
        console.log = originalConsoleLog;
      }

      assertNoOciSideEffects(events, logs, sourceRepoAccesses);
      assert.equal(
        events.some(({ operation }) => operation === "sync"),
        false,
      );
    },
  );

  await t.test(
    "a filesystem command materialization failure blocks OCI preflight and preparation",
    async () => {
      daggerTestState.reset();
      const events: ContainerEvent[] = [];
      const logs: string[] = [];
      const sourceRepoAccesses: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...values: unknown[]) => {
        logs.push(values.map(String).join(" "));
      };

      try {
        await assert.rejects(
          executePackagePlans(
            rejectingSourceRepo(sourceRepoAccesses),
            fakePackageContainer(events, {
              syncFailure: new Error(
                "filesystem package materialization failed",
              ),
            }),
            [
              { plan: ociPlan, target: "api" },
              {
                plan: {
                  artifact: {
                    deploy_path: "common/deploy/worker",
                    kind: "archive",
                    path: "deploy-target-worker.tgz",
                  },
                  commands: [
                    {
                      args: [
                        "-czf",
                        "deploy-target-worker.tgz",
                        "common/deploy/worker",
                      ],
                      command: "tar",
                    },
                  ],
                  validations: [],
                },
                target: "worker",
              },
            ],
            liveProviderOptions(),
          ),
          /filesystem package materialization failed/,
        );
      } finally {
        console.log = originalConsoleLog;
      }

      assertNoOciSideEffects(events, logs, sourceRepoAccesses);
      assert.equal(
        events.filter(({ operation }) => operation === "withExec").length,
        1,
      );
      assert.equal(
        events.filter(({ operation }) => operation === "sync").length,
        1,
      );
    },
  );
});
